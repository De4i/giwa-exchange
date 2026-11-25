import { NextResponse } from "next/server";
import { connection } from "next/server";
import { INDEXER_URL, WETH } from "@/lib/chain";

// Find an Ammora pool for one token vs WETH. The indexer supports a
// baseToken filter, so this is a single query, not a scan of all pools.
// Only a pool whose quote side is WETH counts: the app only trades
// token/WETH markets.
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; body: unknown }>();

export async function GET(req: Request) {
  await connection();
  const { searchParams } = new URL(req.url);
  const token = (searchParams.get("token") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token)) {
    return NextResponse.json({ error: "token must be a 0x address" }, { status: 400 });
  }
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json(hit.body);
  }
  try {
    const res = await fetch(
      `${INDEXER_URL}/pools?chainId=91342&baseToken=${token}`,
      { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
    const data = await res.json();
    const items = (data?.items ?? []) as any[];
    const match = items.find(
      (p) =>
        p?.quoteToken?.toLowerCase() === WETH.address.toLowerCase() &&
        p?.poolStatus === "ACTIVE",
    ) ?? items.find(
      (p) => p?.quoteToken?.toLowerCase() === WETH.address.toLowerCase(),
    );
    const body = match
      ? {
          pool: match.address as string,
          poolType: match.poolType as string,
          poolStatus: (match.poolStatus as string) ?? null,
          baseToken: match.baseToken as string,
          quoteToken: match.quoteToken as string,
          factory: (match.factoryAddress as string) ?? null,
        }
      : { pool: null };
    cache.set(token, { at: Date.now(), body });
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "indexer lookup failed" },
      { status: 502 },
    );
  }
}
