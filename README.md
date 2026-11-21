# GIWA Exchange

A working mini exchange for the **GIWA Sepolia** testnet (chainId 91342),
built with the **Ammora SDK** for the Ammora Builder mission ("Ship an
exchange or launchpad with the Ammora SDK"). It provides live quotes and real
swaps against Ammora pools (paid in native ETH), tAMM staking against the
Season 2 staking contract, a live token board, and the giwa.eco ecosystem
directory — all from public data and the visitor's own browser wallet.

Built with Next.js (App Router) + TypeScript + viem +
[`@ammora-protocol/sdk`](https://www.npmjs.com/package/@ammora-protocol/sdk).

## How the Ammora SDK is used

The swap panel uses the SDK's lightweight integration entry
(`@ammora-protocol/sdk/integrate`) for quotes and pool calldata, plus the
main entry's native-router builders for ETH settlement (see "ETH swaps"):

- **Quote** — `quoteAmmoraExactIn(publicClient, { pool, poolKind, tokenIn, amountIn })`
  reads the pool's own `quoteExactIn` / `quoteExactInDetailed` on-chain and
  returns the exact output amount. The UI debounces amount input and shows
  the live quote, the implied price, and the minimum received for the chosen
  slippage. No price is ever hardcoded or fabricated: if the pool cannot
  quote, the UI shows the error.
- **Calldata** — `buildAmmoraExactInCalldata({ pool, poolKind, tokenIn, amountIn, minimumAmountOut, recipient, deadline })`
  returns `{ to, data, value, approvalSpender, approvalAmount }`.
- **Pull-based execution** — Ammora pools pull the input token themselves, so
  the flow is: read the ERC-20 `allowance(owner, pool)`; if it is below the
  input amount, send `approve(pool, amountIn)` first and wait for the
  receipt; then send the swap transaction and wait for its receipt. The UI
  links every transaction hash to the explorer.
- **Wallet** — the injected browser wallet (`window.ethereum`) via a viem
  wallet client. The app prompts a switch to chain 91342 (and offers to add
  the chain if the wallet does not know it). Signing happens only in the
  visitor's wallet; the site never sees a key.
- **WETH handling** — pools are WETH-based, but the UI presents ETH as the
  quote currency. See "ETH swaps" below for the two settlement routes.

### ETH swaps: native router where verified, wrap-assisted elsewhere

The pair selector shows ETH, never WETH. Quotes are always read with
`quoteAmmoraExactIn` against WETH (ETH and WETH are 1:1), but execution
takes one of two routes, per pool:

- **Native route (tAMM / ETH only).** Ammora runs a native-ETH router at
  `0x4FC91b90087288520A7bB4aA7Ab5441bb4E9C496`, the contract ammora.org's own
  swap sends native trades to. Buys call `swapPoolExactInNative` (payable,
  ETH is the transaction value) and sells call `swapPoolExactInForNative`
  (the router pulls the token after an `approve` to the router, then pays
  out native ETH). Calldata is built by the SDK's own
  `buildV3NativePoolExactInput` / `buildV3PoolExactInputForNative` from
  `@ammora-protocol/sdk` (ABI: the SDK's `ammoraV3NativeRouterAbi`).
  Evidence gathered before shipping: the router appears in real on-chain
  swaps in both directions (e.g. tx
  `0x12e0b69482c0e963e8737e57f1714952fe787ae6079d7eb07b47cf262d6529c4`, a
  1 ETH buy), and an `eth_call` simulation of a 0.01 ETH buy returns exactly
  the SDK's WETH quote (2.754032 tAMM at last check, matching to the raw
  unit).
- **Wrap-assisted route (LODOS, AUICMP).** Native-router calls for these
  pools revert in simulation on every variant tried (both routers in the
  SDK's deployment catalog, both native function families, and direct pool
  calls), so they settle through WETH with the wrapping done inside the
  swap flow, in the same panel: a buy wraps only the shortfall between the
  amount and the wallet's existing WETH balance (`WETH.deposit()` with
  value), then approves the pool and swaps via the SDK; a sell swaps into
  WETH and immediately unwraps the received amount (`WETH.withdraw()`), so
  the user starts and ends with native ETH. The UI says this out loud:
  "ETH is wrapped to WETH under the hood, Ammora pools are WETH based." A
  leftover WETH balance (for example if the unwrap step is rejected) can be
  unwrapped from the same panel.

### Verified pools

Every listed pair was verified at build time by calling
`quoteAmmoraExactIn` against the public RPC. Pools were discovered through
the Ammora indexer API (`https://api-ec2.ammora.org/v1/pools?chainId=91342`,
the same API the Ammora web app uses) and cross-checked on-chain.

| Pair | Pool | Kind | Route | Build-time quote check |
| --- | --- | --- | --- | --- |
| tAMM / ETH | `0x1ef92a6a9bb4bbed2b385dd5e688f88e7965bcf8` | compounding | native router | 0.01 ETH → 2.752525 tAMM (native simulation = pool quote) |
| LODOS / ETH | `0x220ffcc366dec58bfbc48589a2ee9457c0fc46eb` | concentrated | wrap-assisted | 0.01 WETH → 98,704.1797 LODOS; 100 LODOS → 0.0000098882 WETH |
| AUICMP / ETH | `0x253c3e5519ed19a1b0eda86ce7676fa973157830` | compounding | wrap-assisted | 0.001 WETH → 842.8267 AUICMP |

Pairs without a verified pool are not listed at all — the selector only
contains markets that quoted successfully.

## Staking (Stake tAMM panel)

The panel under the network stats talks directly to the Ammora Season 2
staking contract, `0x091d0B15121DD466e67DBE080E62C30D05b93C27`, the contract
behind the "Stake $tAMM" mission on ammora.org. The contract is **not
verified on the explorer**, so its ABI was reconstructed from evidence, in
this order:

1. **On-chain history.** The contract receives `deposit(uint256)` (selector
   `0xb6b55f25`) from many users; a known staker's deposit of exactly
   10,000,000 raw (10 tAMM, 6 decimals) in tx
   `0x418bbfca666d0a4c0c7d230da477699394389ac5a656d7f26d1cfc63aa005262` was
   preceded by an `approve` of tAMM to the staking contract, so staking is
   approve-then-deposit. `claim()` (`0x4e71d92d`) and
   `requestWithdrawal(uint256)` (`0x9ee679e8`) also appear in successful
   on-chain transactions.
2. **ammora.org's own frontend.** The site's public JS ships a human-readable
   ABI for this contract (`accounts`, `claimable`, `pendingWithdrawalIds`,
   `withdrawals`, `deposit`, `requestWithdrawal`, `withdraw`,
   `claim`, `preview`, `totalWeight`, `periodEnd`, ...), and its UI copy
   states the unstake terms: the requested amount stops earning immediately
   and the principal unlocks 24 hours after the request.
3. **Live read probes.** Every function the panel uses was called against
   the public RPC: `accounts(staker)` returns `active = 10,000,000` raw for
   the known staker (exactly his 10 tAMM deposit, the acceptance check),
   `token()` returns the tAMM address, `totalPrincipal()` returns the
   contract-wide staked total (about 101,450,000 tAMM at last check),
   `claimable()` returns 0 for a staker with nothing pending, and
   `withdrawals(user, id)` returns `(amount, unlockAt)` with `unlockAt`
   exactly 24 hours after the observed request. Selectors were additionally
   cross-checked against the contract bytecode and the 4byte directory.
   `withdraw(id)` was confirmed to exist with lock semantics: simulating it
   for a still-locked request reverts with the contract's own custom error
   instead of succeeding or being an unknown selector.

The panel therefore ships the full flow: stake (approve + `deposit`), claim
rewards (`claim`, enabled only when `claimable` is above zero, since the
contract reverts on an empty claim), request unstake
(`requestWithdrawal`), and withdraw each matured request (`withdraw(id)`,
button unlocks at the request's own `unlockAt`). No APY is displayed: the
contract's reward rate does not translate into a promised yield, so the UI
shows only live balances (wallet, staked, claimable, total staked).

## Layout

The top section is a two-column grid: hero copy, the Stake tAMM panel and a
verified-pools card fill the left column; the swap panel sits in the right
column and sticks while scrolling. On mobile everything stacks in reading
order (intro, swap, stake, pools).

## Data sources (all public, read-only, no keys)

- **Swap quotes/execution** — Ammora pools on GIWA Sepolia via the SDK and
  the public RPC `https://sepolia-rpc.giwa.io` (override with
  `NEXT_PUBLIC_RPC_URL`).
- **Token board** — Blockscout v2 API at
  `https://sepolia-explorer.giwa.io/api/v2` (`/tokens?type=ERC-20`,
  `/tokens/{address}/counters`, creation timestamps for age), served through
  `app/api/tokens` with a 120-second in-memory cache. Ranking uses the same
  transparent activity score as the token-radar tool
  (`0.55·ln(transfers) + 0.30·ln(holders) + 0.15·recency`, normalized).
  Caveats, also shown in the UI: the explorer exposes no real prices or
  market caps on this testnet, and holder counts are visibly
  inflated/synthetic — the score ranks relative activity, not value.
- **Ecosystem + network stats** — parsed server-side from
  [giwa.eco](https://giwa.eco/en) and its
  [projects directory](https://giwa.eco/en/projects) (embedded JSON-LD/RSC
  payload), cached with Next.js cache lifetimes.

## Local development

```bash
npm install
npm run dev        # http://localhost:3000
```

No environment variables are required. Optional: `NEXT_PUBLIC_RPC_URL` to
use a different GIWA Sepolia RPC endpoint.

Production build:

```bash
npm run build
npm start
```

## Deploy to Vercel

Option A — import the repository in the Vercel dashboard (framework preset:
Next.js; no env vars needed).

Option B — Vercel CLI from this directory:

```bash
npm i -g vercel
vercel        # preview deployment
vercel --prod # production deployment
```

## Disclaimer

Testnet only. All tokens are play money with no real-world value, quotes
come from on-chain Ammora pools at request time, and nothing here is
financial advice.
