# GIWA Exchange

A working mini exchange for the **GIWA Sepolia** testnet (chainId 91342),
built with the **Ammora SDK** for the Ammora Builder mission ("Ship an
exchange or launchpad with the Ammora SDK"). It provides live quotes and real
swaps against Ammora pools (paid in native ETH), adding liquidity to the same
pools, importing any ERC-20 by contract address, tAMM staking against the
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

## Add LP (Add Liquidity panel)

The "Add LP" tab next to Swap adds liquidity to the same verified pools
(tAMM, LODOS, AUICMP vs WETH/ETH), plus any imported pair that has a pool
(see "Import token" below). The flow is pull-based, like the swaps: approve
the pool for both tokens, then call `addLiquidity` on the pool itself with
the SDK's pool interface (`ammCompoundingPoolV3Abi` /
`ammConcentratedPoolV3Abi` from `@ammora-protocol/sdk`).

- **Amounts.** You type one side; the other is filled in from the pool's
  live reserve ratio (`reserveBase` / `reserveQuote` read on-chain), and
  `previewAddLiquidity` then shows the exact amounts the pool will take and
  the liquidity you will receive. Minimum liquidity applies the chosen
  slippage (default 1%) to the preview.
- **ETH side.** The pool only accepts WETH, even for the tAMM pool, so ETH
  in your wallet is wrapped to WETH for the shortfall inside the flow (the
  same wrap-assisted pattern as the swaps). The panel says this out loud.
  There is no native-ETH LP route: the Ammora native router only covers
  swaps, not liquidity.
- **Pool kinds.** Compounding pools take `(maxBase, maxQuote, minLiquidity,
  recipient, lockDuration, permanentLock, deadline)`; this app passes lock
  duration 0 and permanent lock false (an unlocked position). Concentrated
  pools take `(maxBase, maxQuote, minLiquidity, recipient, deadline)` with
  **no tick range**: the ABI has no tick arguments, so a concentrated add
  mints a full-range position covering the pool's whole price range, and the
  panel says so instead of showing a fake range picker.
- **Your LP position.** Positions are ERC-721 NFTs minted by the pool. The
  panel lists yours per pool: tokenIds come from the explorer's ERC-721
  transfer history for the pool (`/api/positions`, which replays transfers
  and keeps only tokenIds still owned by your address), then each position
  is read on-chain (`ownerOf`, `getPosition`, `previewRemoveLiquidity`), so
  the amounts shown are the live redeemable amounts for that position's
  liquidity. No APY is shown.
- **Success.** The transaction hash links to the explorer, and the minted
  position NFT id is read back from the receipt's Transfer mint log.

### How the add-liquidity calldata was evidenced (before shipping)

The SDK has no `buildV3*Mint` / `addLiquidity` calldata builder for these
pools (its `buildV3PermitAddPoolLiquidity` targets the permit router, not
the pools), so the panel encodes `addLiquidity` directly against the SDK's
own pool ABIs. That shape was evidenced two independent ways:

1. **On-chain transactions (compounding).** The AUICMP pool has successful
   `addLiquidity` calls with exactly this shape: tx
   `0x5955a4573fc4992a6418758f582c9fa7be34d913b42918d7b41462084c6ed601`
   and `0x6ca5b7b842c07c3a1a9c15af0056bcbfc3753b2badb5e7724cf74a0ed500d2a6`,
   both selector `0xaba41a33`, lock duration 0, permanent lock false, and
   both minted a position NFT (tokenIds 5 and 4). The tAMM pool uses the
   same compounding ABI and selector.
2. **eth_call dry-run with state override (all three pools).** For each
   pool, `addLiquidity` was simulated against the live RPC from a test
   caller whose token balances and pool allowances were supplied via
   `eth_call` state override (token storage slots verified first: balances
   slot 6 / allowances slot 7 for the tAMM-family tokens, WETH slots 0/1).
   All three returned success with the expected four values
   (tokenId, liquidity, baseUsed, quoteUsed): LODOS (concentrated,
   selector `0xc4dbea95`) minted tokenId 3 with 100 LODOS + 0.00006359 WETH
   used; tAMM minted tokenId 3 with 100 tAMM + 0.44158 WETH; AUICMP minted
   tokenId 6 with 100 AUICMP + 0.00004997 WETH. The next tokenIds line up
   with the pools' existing positions (LODOS has 1-2, tAMM has 1-2, AUICMP
   has 1-5), which cross-checks the simulation. `previewAddLiquidity`
   agrees with the dry-run amounts to the raw unit.

Honest limits: the LODOS and tAMM pools have never had a direct user
`addLiquidity` before (their only positions came from migration at pool
creation), so the concentrated evidence is the dry-run plus the shared ABI,
not a prior user transaction; and the app does not route LP adds through
the Ammora zap router, so single-sided (zap-in) adds are not offered.

## Remove LP

Each position in "Your LP positions" has remove controls: 25% / 50% /
75% / 100% buttons plus a custom percentage input, a live preview of
exactly what you get back (both token amounts, from
`previewRemoveLiquidity` for the chosen share of the position's
liquidity, with minimums after the panel's slippage), and a Remove
button. Removing sends the pool's `removeLiquidity(tokenId, liquidity,
minimumBaseAmount, minimumQuoteAmount, recipient, deadline)` (selector
`0xf7f4925d`) straight to the pool as the position owner. A 100%
removal burns the position NFT; the list refreshes after the transaction
confirms. Payouts are in the pool's two tokens (base token + WETH);
there is no automatic unwrap to native ETH.

- **No NFT approval step, on purpose.** The real on-chain remove on
  the AUICMP pool (see evidence below) was preceded only by the ERC-20
  approves for its add; no position-NFT approval exists in the flow, and
  Ammora's own planner builds the same straight-to-pool transaction.
- **Locked positions cannot be removed, and the panel says so.**
  Compounding positions carry `permanentlyLocked` and `lockReleasePoint`
  from `getPosition`. A permanently locked position (like the tAMM
  migration positions #1 and #2) or one still inside its lock window
  shows its lock state and the Remove button is not offered.
  Concentrated positions have no lock fields in `getPosition`, so they
  are always removable.
- **Pool kinds.** The same 6-argument `removeLiquidity` exists in both
  the compounding and concentrated pool ABIs from the SDK, so both kinds
  use the identical call; only the lock gating differs.

### How the remove-liquidity calldata was evidenced (before shipping)

1. **On-chain transaction (compounding, AUICMP).** Tx
   `0xc10fb9f69dc29b5ae5a52510aee7f5ae58a1b2eee153689d3c99e9f76656bf59`
   (2026-11-20, block 41858191) is a successful `removeLiquidity` on
   the AUICMP pool, selector `0xf7f4925d`, tokenId 5, recipient the
   caller himself, nonzero minimums (slippage-protected, like the
   panel's), and it burned the position NFT (Transfer of tokenId 5 to
   the zero address in the same transaction). The caller's transaction
   history shows no ERC-721 approval to the pool before it. A second
   real remove with the same shape exists on pool
   `0x994d835D2E8E8e1b462a4b3aC05cC23e94F7620C` (tx
   `0xfe3ec1d17291ffa649fc448d91777cc78c90cf07ad2619ef7ebc853105647332`),
   also burning its tokenId 5.
2. **Ammora's own planner (app.ammora.org JS chunks).** Their DAMM
   planner's `planRemoveLiquidity` does exactly this: it reads the
   owner and `getPosition`, throws "position is locked; recovery
   cannot bypass lock" when `permanentlyLocked` is set or the current
   time is before `lockReleasePoint`, validates the liquidity amount,
   previews with `previewRemoveLiquidity`, applies
   `preview * (10000 - slippageBps) / 10000` as the minimums, and
   builds a transaction to the pool with
   `removeLiquidity(tokenId, liquidity, minBase, minQuote, recipient,
   deadline)` and value 0. The panel follows the same rules.
3. **eth_call dry-runs (live positions).** `removeLiquidity` was
   simulated from each position's owner against the live RPC at 50%
   and 100% of the position's liquidity, with minimums 0: AUICMP #4
   (compounding) and LODOS #1 (concentrated) both returned success
   with amounts matching `previewRemoveLiquidity` to the raw unit
   (AUICMP 50%: 50,794,506,761 base + 25,386,506,861,575 quote;
   LODOS 50%: 268,893,966,070,439 base + 170,997,458,794,820,373
   quote). The tAMM pool's existing positions #1 and #2 are
   permanently locked, so their dry-runs revert with custom error
   `0xbdc99171` (not in any public signature database) — which is
   exactly why locked positions are gated off in the UI instead of
   being offered a Remove button. No unlocked tAMM position exists
   on-chain yet, so the tAMM remove path is evidenced by the shared
   compounding ABI, Ammora's planner, and the AUICMP real transaction,
   not by a direct tAMM dry-run; positions added through this app's
   Add LP panel are minted unlocked (lock duration 0, permanent lock
   false), so they are removable by the same call.

## Import token by contract address

The Swap panel has an "Import token" control, and imported pairs are shared
with the Add LP tab. Paste any `0x` contract address; the app validates it
step by step and reports the first failure inline:

1. **Format** — checksummed address via viem `getAddress`.
2. **Code** — `getBytecode` on GIWA Sepolia must be non-empty.
3. **ERC-20** — `name()`, `symbol()`, `decimals()` must all answer.
4. **Explorer record** — Blockscout token record (`/api/token-record`) for
   holder/transfer context; a token the explorer has not indexed yet is
   still importable, with that noted.
5. **Pool** — the indexer is queried with its `baseToken` filter
   (`/api/pool-for-token`) for an ACTIVE pool of this token vs WETH.
6. **Quote** — when a pool exists, a live SDK quote probe (0.001 WETH) must
   return a positive amount.

If a pool exists and quotes, the token joins the pair selector and swaps
and LP exactly like a built-in pair (wrap-assisted, same slippage and
approve flow, pool address shown). If no pool exists, the token is still
listed as imported but marked "No Ammora pool found" and cannot be selected
for swapping; if a pool exists but the quote probe fails, it is likewise
disabled with the reason shown. Duplicates (already built-in or already
imported) are rejected with a clear message. Imports persist in the
browser only (`localStorage`, key `giwa-exchange.imported-tokens.v1`), with
a remove button per token; nothing is pre-imported.

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
verified-pools card fill the left column; the Swap / Add LP tabbed card sits
in the right column and sticks while scrolling. On mobile everything stacks
in reading order (intro, trade card, stake, pools).

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
