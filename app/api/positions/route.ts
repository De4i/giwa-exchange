import { NextResponse } from "next/server";
import { connection } from "next/server";

// LP positions for one wallet in one pool. Ammora pool positions are
// ERC-721 NFTs minted to the liquidity provider: the explorer indexes the
// pool as an ERC-721 token, so its transfer history reconstructs who holds
// which position tokenIds right now. The panel then reads each position
// on-chain (ownerOf, getPosition, previewRemoveLiquidity); this route only
// returns candidate tokenIds, never amounts.
const EXPLORER_API = "https://sepolia-explorer.giwa.io/api/v2";
const ZERO = "0x0000000000000000000000000000000000000000";
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; body: unknown }>();

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
  return res.json();
}

export async function GET(req: Request) {
  await connection();
  const { searchParams } = new URL(req.url);
  const pool = (searchParams.get("pool") ?? "").toLowerCase();
  const address = (searchParams.get("address") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(pool) || !/^0x[0-9a-f]{40}$/.test(address)) {
    return NextResponse.json(
      { error: "pool and address must be 0x addresses" },
      { status: 400 },
    );
  }
  const key = `${pool}:${address}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json(hit.body);
  }
  try {
    // Transfers come newest first; walk pages oldest-first by collecting
    // then replaying in reverse so the last transfer per tokenId wins.
    const transfers: { tokenId: string; to: string }[] = [];
    let url: string | null = `${EXPLORER_API}/tokens/${pool}/transfers`;
    for (let page = 0; page < 10 && url; page++) {
      const data = await fetchJson(url);
      for (const t of data?.items ?? []) {
        const tokenId = t?.total?.token_id;
        const to = t?.to?.hash as string | undefined;
        if (tokenId != null && to) {
          transfers.push({ tokenId: String(tokenId), to: to.toLowerCase() });
        }
      }
      const next = data?.next_page_params;
      url = next
        ? `${EXPLORER_API}/tokens/${pool}/transfers?${new URLSearchParams(
            Object.fromEntries(
              Object.entries(next).map(([k, v]) => [k, String(v)]),
            ),
          ).toString()}`
        : null;
    }
    const owner = new Map<string, string>();
    for (const t of transfers.reverse()) {
      if (t.to === ZERO) owner.delete(t.tokenId);
      else owner.set(t.tokenId, t.to);
    }
    const tokenIds = [...owner.entries()]
      .filter(([, o]) => o === address)
      .map(([id]) => id)
      .sort((a, b) => Number(a) - Number(b));
    const body = { pool, address, tokenIds };
    cache.set(key, { at: Date.now(), body });
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "positions lookup failed" },
      { status: 502 },
    );
  }
}
