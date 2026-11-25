// Imported tokens: user-pasted ERC-20s, kept in the browser only.
// Nothing here is pre-imported and nothing is sent on-chain: validation is
// read-only (RPC reads + public APIs), and a token only becomes swappable
// when a real Ammora pool for it is found in the indexer.

import { getAddress, parseUnits, type Address } from "viem";
import { quoteAmmoraExactIn } from "@ammora-protocol/sdk/integrate";
import {
  ERC20_META_ABI,
  PAIRS,
  WETH,
  type Pair,
  type PairKind,
  type TokenInfo,
} from "@/lib/chain";
import { publicClient } from "@/lib/wallet";

const STORAGE_KEY = "giwa-exchange.imported-tokens.v1";

export type ImportedToken = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  // Ammora pool for this token vs WETH, when one exists.
  pool: Address | null;
  poolKind: PairKind | null;
  poolStatus: string | null;
  // True only when the pool also returned a live SDK quote at import time.
  quoteOk: boolean;
  // Explorer context (Blockscout), when the token is indexed there.
  explorerIndexed: boolean;
  holders: string | null;
  transfers: string | null;
};

export type PoolLookup = {
  pool: Address | null;
  poolKind: PairKind | null;
  poolStatus: string | null;
};

export function importedToPair(t: ImportedToken): Pair | null {
  if (!t.pool || !t.poolKind || !t.quoteOk) return null;
  const token: TokenInfo = {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
  };
  return {
    id: `imported-${t.address.toLowerCase()}`,
    label: `${t.symbol} / ETH`,
    pool: t.pool,
    poolKind: t.poolKind,
    tokenA: token,
    tokenB: WETH,
    note: `Imported token. Pool found in the Ammora indexer (${t.poolStatus ?? "ACTIVE"}), quote verified at import.`,
    verifiedQuote: "Live quote verified at import (0.001 WETH probe).",
    nativeRouter: false,
  };
}

export function loadImportedTokens(): ImportedToken[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ImportedToken[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t) => t && typeof t.address === "string" && t.address.startsWith("0x"),
    );
  } catch {
    return [];
  }
}

export function saveImportedTokens(tokens: ImportedToken[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
  } catch {
    /* storage full or unavailable: imports just do not persist */
  }
}

export function isBuiltInToken(address: Address): boolean {
  const lower = address.toLowerCase();
  if (WETH.address.toLowerCase() === lower) return true;
  return PAIRS.some((p) => p.tokenA.address.toLowerCase() === lower);
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Find an Ammora pool for a token vs WETH via the indexer (server route). */
export async function lookupPoolForToken(
  address: Address,
): Promise<PoolLookup> {
  const data = await fetchJson(
    `/api/pool-for-token?token=${address}`,
  );
  if (!data || !data.pool) return { pool: null, poolKind: null, poolStatus: null };
  const kind: PairKind =
    data.poolType === "ARLORA_CONCENTRATED_V3"
      ? "concentrated"
      : "compounding";
  return { pool: data.pool as Address, poolKind: kind, poolStatus: data.poolStatus ?? null };
}

export type ValidateResult =
  | { ok: true; token: ImportedToken }
  | { ok: false; error: string };

/**
 * Validate a pasted address, in order: checksum format, contract code on
 * GIWA Sepolia, ERC-20 metadata reads, explorer record, indexer pool
 * lookup, live SDK quote probe when a pool exists. Returns a clear error
 * string at the first failing step; never throws for bad input.
 */
export async function validateImportedToken(
  input: string,
  alreadyImported: ImportedToken[],
): Promise<ValidateResult> {
  const trimmed = input.trim();
  let address: Address;
  try {
    address = getAddress(trimmed);
  } catch {
    return {
      ok: false,
      error: "That is not a valid checksummed address (0x followed by 40 hex characters).",
    };
  }
  if (isBuiltInToken(address)) {
    return {
      ok: false,
      error: "This token is already built in (tAMM, LODOS, AUICMP or WETH). Pick it from the pair list instead.",
    };
  }
  if (
    alreadyImported.some((t) => t.address.toLowerCase() === address.toLowerCase())
  ) {
    return { ok: false, error: "This token is already imported." };
  }

  const code = await publicClient.getBytecode({ address }).catch(() => undefined);
  if (!code || code === "0x") {
    return {
      ok: false,
      error: "No contract code at this address on GIWA Sepolia. It may be an empty address or a wallet, not a token.",
    };
  }

  let name: string, symbol: string, decimals: number;
  try {
    const [n, s, d] = await Promise.all([
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "name" }),
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "symbol" }),
      publicClient.readContract({ address, abi: ERC20_META_ABI, functionName: "decimals" }),
    ]);
    name = n as string;
    symbol = s as string;
    decimals = d as number;
  } catch {
    return {
      ok: false,
      error: "The contract does not answer name(), symbol() and decimals() like an ERC-20, so it cannot be imported as a token.",
    };
  }
  if (!symbol || !name || decimals > 18) {
    return {
      ok: false,
      error: "The contract answered with empty metadata or an implausible decimals value, so it cannot be imported as a token.",
    };
  }

  // Explorer context: informational only, a missing record does not block.
  let explorerIndexed = false;
  let holders: string | null = null;
  let transfers: string | null = null;
  try {
    const rec = await fetchJson(`/api/token-record?address=${address}`);
    if (rec && rec.indexed) {
      explorerIndexed = true;
      holders = rec.holders ?? null;
      transfers = rec.transfers ?? null;
    }
  } catch {
    /* explorer unreachable: proceed without the context */
  }

  // Pool lookup: a token with no Ammora pool is still importable, but it
  // is listed as not swappable and never offered as a pair.
  let poolLookup: PoolLookup = { pool: null, poolKind: null, poolStatus: null };
  try {
    poolLookup = await lookupPoolForToken(address);
  } catch {
    poolLookup = { pool: null, poolKind: null, poolStatus: null };
  }

  let quoteOk = false;
  if (poolLookup.pool && poolLookup.poolKind) {
    try {
      const out = await quoteAmmoraExactIn(publicClient, {
        pool: poolLookup.pool,
        poolKind: poolLookup.poolKind,
        tokenIn: WETH.address,
        amountIn: parseUnits("0.001", 18),
      });
      quoteOk = out > 0n;
    } catch {
      quoteOk = false;
    }
  }

  return {
    ok: true,
    token: {
      address,
      symbol,
      name,
      decimals,
      pool: poolLookup.pool,
      poolKind: poolLookup.poolKind,
      poolStatus: poolLookup.poolStatus,
      quoteOk,
      explorerIndexed,
      holders,
      transfers,
    },
  };
}
