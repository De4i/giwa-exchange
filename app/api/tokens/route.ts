import { NextResponse } from "next/server";
import { connection } from "next/server";
import { buildTokenBoard, type TokenBoard } from "@/lib/explorer";

// Live token board, served from a short in-memory cache so a burst of
// visitors does not hammer the explorer API. Data itself always comes
// fresh from the Blockscout API on cache expiry — nothing is baked in.
const CACHE_MS = 120_000;
let cache: { at: number; board: TokenBoard } | null = null;
let inflight: Promise<TokenBoard> | null = null;

export async function GET() {
  await connection(); // always run at request time, never prerender
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      if (!inflight) {
        inflight = buildTokenBoard(60)
          .then((board) => {
            cache = { at: Date.now(), board };
            return board;
          })
          .finally(() => {
            inflight = null;
          });
      }
      await inflight;
    }
    return NextResponse.json(cache!.board, {
      headers: { "cache-control": "public, max-age=60" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "failed to load token board" },
      { status: 502 },
    );
  }
}
