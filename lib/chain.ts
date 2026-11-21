import type { Address, Chain } from "viem";

export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://sepolia-rpc.giwa.io";
export const EXPLORER_URL = "https://sepolia-explorer.giwa.io";
export const CHAIN_ID = 91342;

export const giwaSepolia = {
  id: CHAIN_ID,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "GIWA Sepolia Explorer", url: EXPLORER_URL },
  },
  testnet: true,
} as const satisfies Chain;

export type TokenInfo = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
};

export const WETH: TokenInfo = {
  address: "0x4200000000000000000000000000000000000006",
  symbol: "WETH",
  name: "Wrapped Ether",
  decimals: 18,
};

// What the UI presents as the quote currency. Pools are WETH-based, so ETH
// amounts are quoted 1:1 against WETH; how a swap actually settles depends on
// the pair's route (see Pair.nativeRouter).
export const ETH: TokenInfo = {
  address: WETH.address, // quote substitution only; native ETH has no address
  symbol: "ETH",
  name: "Ether (native)",
  decimals: 18,
};

// Ammora's native-ETH router on GIWA Sepolia: the contract ammora.org's own
// swap sends native swaps to (swapPoolExactInNative / swapPoolExactInForNative,
// ABI taken from @ammora-protocol/sdk's ammoraV3NativeRouterAbi). Verified
// against live eth_call simulations and real on-chain swaps; see README.
export const NATIVE_ROUTER: Address =
  "0x4FC91b90087288520A7bB4aA7Ab5441bb4E9C496";

export const ZERO_ADDRESS: Address =
  "0x0000000000000000000000000000000000000000";

export const TAMM: TokenInfo = {
  address: "0x10B3Cc2fc981277Ada576891CF649D0ABA768B06",
  symbol: "tAMM",
  name: "tAmm Coin",
  decimals: 6,
};

export type PairKind = "concentrated" | "compounding";

export type Pair = {
  id: string;
  label: string;
  pool: Address;
  poolKind: PairKind;
  tokenA: TokenInfo;
  tokenB: TokenInfo;
  note: string;
  verifiedQuote: string; // human-readable record of the build-time verification
  // True when swaps for this pool were verified to work through the Ammora
  // native router (pay/receive real ETH, no wrapping). False means the ETH
  // flow is wrap-assisted: the pool itself only trades WETH.
  nativeRouter: boolean;
};

// Every pool below was verified at build time by calling the SDK's
// quoteAmmoraExactIn against the public RPC (see README). Pairs without a
// verified pool are simply not listed — the UI never invents a quote.
export const PAIRS: Pair[] = [
  {
    id: "tamm-eth",
    label: "tAMM / ETH",
    pool: "0x1ef92a6a9bb4bbed2b385dd5e688f88e7965bcf8",
    poolKind: "compounding",
    tokenA: TAMM,
    tokenB: WETH,
    note: "The Ammora Season 2 pool: the deepest ETH market on GIWA Sepolia.",
    verifiedQuote: "0.01 ETH -> 2.752525 tAMM (native router simulation, matches the pool quote)",
    nativeRouter: true,
  },
  {
    id: "lodos-eth",
    label: "LODOS / ETH",
    pool: "0x220ffcc366dec58bfbc48589a2ee9457c0fc46eb",
    poolKind: "concentrated",
    tokenA: {
      address: "0xfB972A93CEf268D96949DF380a85FC0244e1fa8E",
      symbol: "LODOS",
      name: "LODOs",
      decimals: 9,
    },
    tokenB: WETH,
    note: "Concentrated-liquidity pool from the Ammora concentrated factory.",
    verifiedQuote: "0.01 WETH -> 98,704.1797 LODOS; 100 LODOS -> 0.0000098882 WETH",
    nativeRouter: false,
  },
  {
    id: "auicmp-eth",
    label: "AUICMP / ETH",
    pool: "0x253c3e5519ed19a1b0eda86ce7676fa973157830",
    poolKind: "compounding",
    tokenA: {
      address: "0xd034C409Aa90D396D987d6718e723b4962852Ac6",
      symbol: "AUICMP",
      name: "Ammora UI Acceptance compounding",
      decimals: 9,
    },
    tokenB: WETH,
    note: "Compounding pool used by Ammora's own UI acceptance tests.",
    verifiedQuote: "0.001 WETH -> 842.8267 AUICMP",
    nativeRouter: false,
  },
];

// ------------------------------------------------------------ tAMM staking
// The Ammora Season 2 staking contract (the one behind the "Stake $tAMM"
// mission on ammora.org). It is NOT verified on the explorer; the ABI below
// is the one ammora.org's own web app ships for this contract, and every
// entry was checked against live reads / on-chain transactions before being
// used here (see README "Staking"). Position acceptance check: accounts()
// for the first known staker returns active = 10,000,000 raw = 10 tAMM.
export const STAKING: Address = "0x091d0B15121DD466e67DBE080E62C30D05b93C27";

export const STAKING_ABI = [
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "accounts",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "active", type: "uint256" },
      { name: "weight", type: "uint256" },
      { name: "paid", type: "uint256" },
      { name: "earned", type: "uint256" },
      { name: "remainder", type: "uint256" },
      { name: "claimed", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalPrincipal",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "depositsPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "pendingWithdrawalIds",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "withdrawals",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [
      { name: "amount", type: "uint256" },
      { name: "unlockAt", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "requestWithdrawal",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export const WETH_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;
