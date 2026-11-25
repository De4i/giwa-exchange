import { NextResponse } from "next/server";
import { connection } from "next/server";

// Explorer record for one token: type, holder and transfer counts from
// Blockscout. Used as context for an imported token; a token the explorer
// has not indexed yet reports indexed: false instead of erroring.
const EXPLORER_API = "https://sepolia-explorer.giwa.io/api/v2";

export async function GET(req: Request) {
  await connection();
  const { searchParams } = new URL(req.url);
  const address = (searchParams.get("address") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return NextResponse.json({ error: "address must be a 0x address" }, { status: 400 });
  }
  try {
    const res = await fetch(`${EXPLORER_API}/tokens/${address}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) {
      return NextResponse.json({ indexed: false });
    }
    if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
    const token = await res.json();
    let transfers: string | null = null;
    try {
      const c = await fetch(`${EXPLORER_API}/tokens/${address}/counters`, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      if (c.ok) {
        const counters = await c.json();
        transfers = counters?.transfers_count != null ? String(counters.transfers_count) : null;
      }
    } catch {
      /* counters are optional context */
    }
    return NextResponse.json({
      indexed: true,
      type: (token?.type as string) ?? null,
      name: (token?.name as string) ?? null,
      symbol: (token?.symbol as string) ?? null,
      decimals: token?.decimals != null ? String(token.decimals) : null,
      holders: token?.holders_count != null ? String(token.holders_count) : null,
      transfers,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "explorer lookup failed" },
      { status: 502 },
    );
  }
}
