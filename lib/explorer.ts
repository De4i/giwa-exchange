// Server-side data plane: Blockscout explorer API + giwa.eco.
// Adapted from ~/workspace/token-radar-giwa/index.js (same fetch logic,
// pagination quirk handling, scoring formula and giwa.eco RSC parsing).
// Everything here is read-only public data — no keys, no signing.

import { cacheLife } from "next/cache";

const EXPLORER = "https://sepolia-explorer.giwa.io";
const API = `${EXPLORER}/api/v2`;
const GIWA_PROJECTS_URL = "https://giwa.eco/en/projects";
const GIWA_HOME_URL = "https://giwa.eco/en";
const TAMM_ADDRESS = "0x10B3Cc2fc981277Ada576891CF649D0ABA768B06";
const TIMEOUT_MS = 12000;
const CONCURRENCY = 10;

async function fetchJson(url: string, tries = 2): Promise<any> {
  let lastErr: unknown;
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { accept: "text/html" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// --------------------------------------------------------------------- types

export type TokenRow = {
  rank: number;
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  holders: number | null;
  transfers: number | null;
  ageDays: number | null;
  score: number;
  verdict: "ACTIVE" | "WATCH" | "DEAD";
  ecosystemProject: { name: string; slug: string; category: string | null } | null;
};

export type TokenBoard = {
  generatedAt: string;
  rows: TokenRow[];
  verdicts: { ACTIVE: number; WATCH: number; DEAD: number };
  scoreFormula: string;
};

export type Project = {
  position: number | null;
  name: string;
  slug: string;
  category: string | null;
  description: string | null;
  x: string | null;
  url: string;
  website: string | null;
  country: string | null;
  stage: string | null;
};

export type NetworkStats = {
  totalBlocks: number | null;
  totalTransactions: number | null;
  transactionsToday: number | null;
  totalAddresses: number | null;
  blockTimeDisplay: string | null;
  source: string;
};

// ------------------------------------------------------------- token universe

type RawToken = {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  holders_count: number | null;
  transfers_count: number | null;
  age_days: number | null;
};

async function fetchTokenUniverse(limit: number): Promise<RawToken[]> {
  // Blockscout pagination quirk (verified): the cursor only advances when
  // EVERY next_page_params field is sent back, nulls as empty strings.
  const tokens: RawToken[] = [];
  const seen = new Set<string>();
  let params: Record<string, unknown> = { type: "ERC-20" };
  while (tokens.length < limit) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params))
      qs.set(k, v === null || v === undefined ? "" : String(v));
    const page = await fetchJson(`${API}/tokens?${qs}`);
    let added = 0;
    for (const it of page.items ?? []) {
      if (seen.has(it.address_hash)) continue;
      seen.add(it.address_hash);
      added++;
      tokens.push({
        address: it.address_hash,
        name: it.name ?? null,
        symbol: it.symbol ?? null,
        decimals: it.decimals != null ? Number(it.decimals) : null,
        holders_count: it.holders_count != null ? Number(it.holders_count) : null,
        transfers_count: null,
        age_days: null,
      });
      if (tokens.length >= limit) break;
    }
    if (!page.next_page_params || added === 0) break;
    params = { type: "ERC-20", ...page.next_page_params };
  }
  return tokens;
}

async function enrichToken(tok: RawToken): Promise<RawToken> {
  try {
    const c = await fetchJson(`${API}/tokens/${tok.address}/counters`);
    tok.transfers_count = c.transfers_count !== undefined ? Number(c.transfers_count) : null;
  } catch {
    tok.transfers_count = null;
  }
  try {
    const addr = await fetchJson(`${API}/addresses/${tok.address}`);
    const hash = addr.creation_transaction_hash;
    if (hash) {
      const tx = await fetchJson(`${API}/transactions/${hash}`);
      if (tx.timestamp) {
        tok.age_days = Math.max(
          0,
          Math.floor((Date.now() - Date.parse(tx.timestamp)) / 86400000),
        );
      }
    }
  } catch {
    /* age stays null; scoring treats it neutrally */
  }
  return tok;
}

// ------------------------------------------------------------------- scoring
// Same transparent activity score as token-radar-giwa (NOT a price signal):
//   score = 100 * (0.55 * ln(1+transfers)/max + 0.30 * ln(1+holders)/max
//                + 0.15 * recency),  recency = 1 / (1 + age_days/30)

const W_TRANSFERS = 0.55;
const W_HOLDERS = 0.3;
const W_RECENCY = 0.15;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

const norm = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const KNOWN_PROJECT_BY_ADDRESS: Record<string, string> = {
  [TAMM_ADDRESS.toLowerCase()]: "ammora",
};

export async function buildTokenBoard(limit = 60): Promise<TokenBoard> {
  const [universe, projects] = await Promise.all([
    fetchTokenUniverse(limit),
    getProjects().catch(() => [] as Project[]),
  ]);
  const rows = await pool(universe, CONCURRENCY, enrichToken);

  const maxLT = Math.max(1e-9, ...rows.map((r) => Math.log(1 + (r.transfers_count ?? 0))));
  const maxLH = Math.max(1e-9, ...rows.map((r) => Math.log(1 + (r.holders_count ?? 0))));
  const recencyOf = (r: RawToken) =>
    r.age_days === null ? null : 1 / (1 + r.age_days / 30);
  const medRecency = median(
    rows.map(recencyOf).filter((x): x is number => x !== null),
  );

  const scored: TokenRow[] = rows.map((r) => {
    const lt = Math.log(1 + (r.transfers_count ?? 0)) / maxLT;
    const lh = Math.log(1 + (r.holders_count ?? 0)) / maxLH;
    const rec = recencyOf(r) ?? medRecency;
    const score = Math.round(100 * (W_TRANSFERS * lt + W_HOLDERS * lh + W_RECENCY * rec) * 100) / 100;
    const tr = r.transfers_count ?? 0;
    const verdict: TokenRow["verdict"] =
      tr >= 10000 && score >= 55 ? "ACTIVE" : tr >= 100 && score >= 30 ? "WATCH" : "DEAD";

    let proj: Project | undefined;
    const known = KNOWN_PROJECT_BY_ADDRESS[r.address.toLowerCase()];
    if (known) proj = projects.find((p) => p.slug === known);
    if (!proj) {
      const nName = norm(r.name);
      const nSym = norm(r.symbol);
      proj = projects.find((p) => {
        const pn = norm(p.name);
        const ps = norm(p.slug);
        return (
          (pn.length >= 4 && (nName === pn || nSym === pn)) ||
          (ps.length >= 4 && (nName === ps || nSym === ps))
        );
      });
    }

    return {
      rank: 0,
      address: r.address,
      name: r.name,
      symbol: r.symbol,
      decimals: r.decimals,
      holders: r.holders_count,
      transfers: r.transfers_count,
      ageDays: r.age_days,
      score,
      verdict,
      ecosystemProject: proj
        ? { name: proj.name, slug: proj.slug, category: proj.category }
        : null,
    };
  });

  scored.sort((a, b) => b.score - a.score || (b.transfers ?? 0) - (a.transfers ?? 0));
  scored.forEach((r, i) => (r.rank = i + 1));

  return {
    generatedAt: new Date().toISOString(),
    rows: scored,
    verdicts: {
      ACTIVE: scored.filter((r) => r.verdict === "ACTIVE").length,
      WATCH: scored.filter((r) => r.verdict === "WATCH").length,
      DEAD: scored.filter((r) => r.verdict === "DEAD").length,
    },
    scoreFormula:
      "100 * (0.55 * ln(1+transfers)/max + 0.30 * ln(1+holders)/max + 0.15 * recency)",
  };
}

// --------------------------------------------------------------- giwa.eco

function extractRscPayload(html: string): string {
  let payload = "";
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      payload += JSON.parse(m[1]);
    } catch {
      /* skip malformed chunk */
    }
  }
  return payload;
}

function extractJsonLd(html: string): any[] {
  const out: any[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      /* skip */
    }
  }
  return out;
}

function braceObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  return null;
}

export async function getProjects(): Promise<Project[]> {
  "use cache";
  cacheLife("hours");
  try {
    const html = await fetchText(GIWA_PROJECTS_URL);
    const ld = extractJsonLd(html).find((d) => d["@type"] === "ItemList");
    const order = new Map<string, number>();
    if (ld && Array.isArray(ld.itemListElement)) {
      for (const el of ld.itemListElement) {
        const slug = String(el.url || "").split("/").pop();
        if (slug) order.set(slug, el.position);
      }
    }
    const payload = extractRscPayload(html);
    const bySlug = new Map<string, Project>();
    const re = /"slug":"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(payload)) !== null) {
      const slug = m[1];
      if (bySlug.has(slug)) continue;
      const start = payload.lastIndexOf("{", m.index);
      if (start < 0) continue;
      const raw = braceObjectAt(payload, start);
      if (!raw) continue;
      let obj: any;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!obj || obj.slug !== slug || typeof obj.name !== "string") continue;
      bySlug.set(slug, {
        position: order.get(slug) ?? null,
        name: obj.name,
        slug,
        category: obj.category ?? null,
        description:
          obj.description && typeof obj.description === "object"
            ? (obj.description.en ?? null)
            : (obj.description ?? null),
        x: obj.xHandle ?? null,
        url: `https://giwa.eco/en/projects/${slug}`,
        website: obj.website ?? null,
        country:
          obj.xAbout && typeof obj.xAbout === "object"
            ? (obj.xAbout.basedIn ?? null)
            : null,
        stage: obj.gasokStatus ?? null,
      });
    }
    return [...bySlug.values()].sort(
      (a, b) => (a.position ?? 999) - (b.position ?? 999),
    );
  } catch {
    return [];
  }
}

export async function getNetworkStats(): Promise<NetworkStats> {
  "use cache";
  cacheLife("minutes");
  const empty: NetworkStats = {
    totalBlocks: null,
    totalTransactions: null,
    transactionsToday: null,
    totalAddresses: null,
    blockTimeDisplay: null,
    source: GIWA_HOME_URL,
  };
  try {
    const html = await fetchText(GIWA_HOME_URL);
    const payload = extractRscPayload(html);
    const grab = (key: string): number | null => {
      const m = payload.match(new RegExp(`"${key}":"?(\\d+(?:\\.\\d+)?)"?`));
      return m ? Number(m[1]) : null;
    };
    const bt = html.match(/Block time<\/div><div[^>]*>([^<]+)</);
    return {
      totalBlocks: grab("total_blocks"),
      totalTransactions: grab("total_transactions"),
      transactionsToday: grab("transactions_today"),
      totalAddresses: grab("total_addresses"),
      blockTimeDisplay: bt ? bt[1].trim() : null,
      source: GIWA_HOME_URL,
    };
  } catch {
    return empty;
  }
}
