"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import {
  ERC20_ABI,
  EXPLORER_URL,
  PAIRS,
  TRANSFER_TOPIC,
  WETH,
  WETH_ABI,
  ZERO_TOPIC,
  poolAbi,
  type Pair,
} from "@/lib/chain";
import {
  errText,
  getWalletClient,
  publicClient,
  shortAddr,
  useWallet,
} from "@/lib/wallet";

function fmt(amount: bigint, decimals: number, maxFrac = 6): string {
  const s = formatUnits(amount, decimals);
  const [int, frac = ""] = s.split(".");
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}

function trimNum(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function parseAmount(s: string, decimals: number): bigint | null {
  try {
    const v = parseUnits(s || "0", decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

type Phase =
  | "idle"
  | "wrapping"
  | "approving"
  | "approve-confirming"
  | "adding"
  | "add-confirming"
  | "done";

type Preview = { liquidity: bigint; baseUsed: bigint; quoteUsed: bigint };
type Position = {
  tokenId: bigint;
  liquidity: bigint;
  baseAmount: bigint;
  quoteAmount: bigint;
  lockReleasePoint: number;
  permanentlyLocked: boolean;
};

export default function AddLpPanel({ pairs }: { pairs: Pair[] }) {
  const { account, wrongChain, connect, ensureChain, connectError } =
    useWallet();
  const [pair, setPair] = useState<Pair>(PAIRS[0]);
  const [baseAmt, setBaseAmt] = useState("100");
  const [quoteAmt, setQuoteAmt] = useState("");
  const [lastEdited, setLastEdited] = useState<"base" | "quote">("base");
  const [slippage, setSlippage] = useState("1");
  const [reserves, setReserves] = useState<{ base: bigint; quote: bigint } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [balances, setBalances] = useState<{ native: bigint; weth: bigint; base: bigint } | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [positionsErr, setPositionsErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [mintedId, setMintedId] = useState<string | null>(null);
  const quoteSeq = useRef(0);

  const baseDec = pair.tokenA.decimals;
  const busy = phase !== "idle" && phase !== "done";

  const maxBase = useMemo(() => parseAmount(baseAmt, baseDec), [baseAmt, baseDec]);
  const maxQuote = useMemo(() => parseAmount(quoteAmt, 18), [quoteAmt]);

  const slippageBps = useMemo(() => {
    const v = Number(slippage);
    if (!Number.isFinite(v) || v < 0 || v > 50) return 100;
    return Math.round(v * 100);
  }, [slippage]);

  const minLiquidity = useMemo(() => {
    if (!preview) return null;
    return (preview.liquidity * BigInt(10000 - slippageBps)) / 10000n;
  }, [preview, slippageBps]);

  // ------------------------------------------------------------ live reads
  const refreshReserves = useCallback(async () => {
    try {
      const abi = poolAbi(pair.poolKind);
      const [base, quote] = await Promise.all([
        publicClient.readContract({ address: pair.pool, abi, functionName: "reserveBase" }),
        publicClient.readContract({ address: pair.pool, abi, functionName: "reserveQuote" }),
      ]);
      setReserves({ base: base as bigint, quote: quote as bigint });
    } catch {
      /* leave previous reserves */
    }
  }, [pair]);

  const refreshBalances = useCallback(async () => {
    if (!account) {
      setBalances(null);
      return;
    }
    try {
      const [native, weth, base] = await Promise.all([
        publicClient.getBalance({ address: account }),
        publicClient.readContract({ address: WETH.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
        publicClient.readContract({ address: pair.tokenA.address, abi: ERC20_ABI, functionName: "balanceOf", args: [account] }),
      ]);
      setBalances({ native, weth: weth as bigint, base: base as bigint });
    } catch {
      /* leave previous balances */
    }
  }, [account, pair]);

  const refreshPositions = useCallback(async () => {
    if (!account) {
      setPositions(null);
      return;
    }
    setPositionsErr(null);
    try {
      const res = await fetch(
        `/api/positions?pool=${pair.pool}&address=${account}`,
      );
      if (!res.ok) throw new Error(`positions lookup HTTP ${res.status}`);
      const data = await res.json();
      const ids = (data?.tokenIds ?? []) as string[];
      const abi = poolAbi(pair.poolKind);
      const out: Position[] = [];
      for (const id of ids) {
        try {
          const tokenId = BigInt(id);
          const owner = (await publicClient.readContract({
            address: pair.pool, abi, functionName: "ownerOf", args: [tokenId],
          })) as string;
          if (owner.toLowerCase() !== account.toLowerCase()) continue;
          const pos = (await publicClient.readContract({
            address: pair.pool, abi, functionName: "getPosition", args: [tokenId],
          })) as any;
          const liquidity = BigInt(pos.liquidity ?? pos[0] ?? 0);
          if (liquidity === 0n) continue;
          const amounts = (await publicClient.readContract({
            address: pair.pool, abi, functionName: "previewRemoveLiquidity", args: [liquidity],
          })) as readonly [bigint, bigint];
          out.push({
            tokenId,
            liquidity,
            baseAmount: amounts[0],
            quoteAmount: amounts[1],
            lockReleasePoint: Number(pos.lockReleasePoint ?? 0),
            permanentlyLocked: Boolean(pos.permanentlyLocked ?? false),
          });
        } catch {
          // Position moved or burned between the explorer read and this
          // call; skip it rather than failing the whole list.
          continue;
        }
      }
      setPositions(out);
    } catch (e) {
      setPositionsErr(e instanceof Error ? e.message : "Could not load positions.");
      setPositions(null);
    }
  }, [account, pair]);

  useEffect(() => {
    refreshReserves();
    refreshBalances();
    refreshPositions();
  }, [refreshReserves, refreshBalances, refreshPositions]);

  // ------------------------------------------- auto-fill the other amount
  // The pool only accepts amounts at its current reserve ratio, so editing
  // one side fills the other from live reserves. previewAddLiquidity then
  // confirms the exact amounts the pool will take.
  useEffect(() => {
    if (!reserves || reserves.base === 0n) return;
    if (lastEdited === "base") {
      const b = parseAmount(baseAmt, baseDec);
      if (b === null) return;
      const q = (b * reserves.quote) / reserves.base;
      setQuoteAmt(trimNum(formatUnits(q, 18)));
    } else {
      const q = parseAmount(quoteAmt, 18);
      if (q === null) return;
      const b = (q * reserves.base) / reserves.quote;
      setBaseAmt(trimNum(formatUnits(b, baseDec)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reserves, pair]);

  // Debounced amount echo: typing in one field refills the other once the
  // user pauses, without fighting keystrokes.
  useEffect(() => {
    if (!reserves || reserves.base === 0n || reserves.quote === 0n) return;
    const t = setTimeout(() => {
      if (lastEdited === "base") {
        const b = parseAmount(baseAmt, baseDec);
        if (b === null) return;
        const q = (b * reserves.quote) / reserves.base;
        setQuoteAmt(trimNum(formatUnits(q, 18)));
      } else {
        const q = parseAmount(quoteAmt, 18);
        if (q === null) return;
        const b = (q * reserves.base) / reserves.quote;
        setBaseAmt(trimNum(formatUnits(b, baseDec)));
      }
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseAmt, quoteAmt, lastEdited, reserves]);

  // -------------------------------------------------------------- preview
  useEffect(() => {
    if (maxBase === null || maxQuote === null) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    const seq = ++quoteSeq.current;
    const t = setTimeout(async () => {
      try {
        const abi = poolAbi(pair.poolKind);
        const res = (await publicClient.readContract({
          address: pair.pool,
          abi,
          functionName: "previewAddLiquidity",
          args: [maxBase, maxQuote],
        })) as readonly [bigint, bigint, bigint];
        if (quoteSeq.current !== seq) return;
        setPreview({ liquidity: res[0], baseUsed: res[1], quoteUsed: res[2] });
        setPreviewErr(null);
      } catch (e) {
        if (quoteSeq.current !== seq) return;
        setPreview(null);
        setPreviewErr(errText(e));
      }
    }, 450);
    return () => clearTimeout(t);
  }, [maxBase, maxQuote, pair]);

  // --------------------------------------------------------------- execute
  async function approveIfNeeded(token: string, spender: string, needed: bigint) {
    const allowance = (await publicClient.readContract({
      address: token as never,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account!, spender as never],
    })) as bigint;
    if (allowance >= needed) return;
    const wc = getWalletClient();
    if (!wc || !account) throw new Error("Wallet unavailable.");
    setPhase("approving");
    setStatusMsg(`Approving the pool to pull the tokens…`);
    const hash = await wc.writeContract({
      address: token as never,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender as never, needed],
      account,
    });
    setPhase("approve-confirming");
    await publicClient.waitForTransactionReceipt({ hash });
  }

  async function addLiquidity() {
    const wc = getWalletClient();
    if (!wc || !account || maxBase === null || maxQuote === null || minLiquidity === null) return;
    setTxHash(null);
    setMintedId(null);
    setStatusMsg(null);
    try {
      if (!(await ensureChain())) return;
      const abi = poolAbi(pair.poolKind);

      // The pool only accepts WETH on the ETH side, so wrap the shortfall
      // first (same wrap-assisted pattern as the swap panel).
      const wethNow = (await publicClient.readContract({
        address: WETH.address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account],
      })) as bigint;
      const shortfall = maxQuote > wethNow ? maxQuote - wethNow : 0n;
      if (shortfall > 0n) {
        setPhase("wrapping");
        setStatusMsg(`Step 1 of 3: wrapping ${fmt(shortfall, 18)} ETH into WETH…`);
        const wrapHash = await wc.writeContract({
          address: WETH.address,
          abi: WETH_ABI,
          functionName: "deposit",
          account,
          value: shortfall,
        });
        await publicClient.waitForTransactionReceipt({ hash: wrapHash });
      }

      await approveIfNeeded(pair.tokenA.address, pair.pool, maxBase);
      await approveIfNeeded(WETH.address, pair.pool, maxQuote);

      setPhase("adding");
      setStatusMsg("Confirm adding liquidity in your wallet…");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
      const args =
        pair.poolKind === "concentrated"
          ? [maxBase, maxQuote, minLiquidity, account, deadline]
          : [maxBase, maxQuote, minLiquidity, account, 0, false, deadline];
      const hash = await wc.writeContract({
        address: pair.pool,
        abi,
        functionName: "addLiquidity",
        args: args as never,
        account,
      });
      setTxHash(hash);
      setPhase("add-confirming");
      setStatusMsg("Liquidity transaction sent. Waiting for confirmation…");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new Error("Add liquidity transaction reverted on-chain.");
      // The pool mints a position NFT: find its tokenId in the receipt.
      const mint = receipt.logs.find(
        (l) =>
          l.address.toLowerCase() === pair.pool.toLowerCase() &&
          l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
          l.topics[1]?.toLowerCase() === ZERO_TOPIC,
      );
      if (mint?.topics[3]) setMintedId(BigInt(mint.topics[3]).toString());
      setPhase("done");
      setStatusMsg("Liquidity added. Your new position is listed below.");
      refreshBalances();
      refreshReserves();
      refreshPositions();
    } catch (e) {
      setPhase("idle");
      setStatusMsg(errText(e));
      refreshBalances();
    }
  }

  const insufficientBase =
    balances !== null && maxBase !== null && balances.base < maxBase;
  const insufficientQuote =
    balances !== null &&
    maxQuote !== null &&
    balances.weth + balances.native < maxQuote;

  return (
    <div aria-label="Add LP">
      <div className="swap-head">
        <h2>Add LP</h2>
        <span className="chip">
          pool: <b>{pair.poolKind}</b>
        </span>
      </div>

      {!account ? (
        <button className="btn primary wide" onClick={connect}>
          Connect wallet
        </button>
      ) : (
        <div className="wallet-row">
          <span className="chip">
            <b>{shortAddr(account)}</b>
          </span>
          {balances && (
            <span className="muted">{fmt(balances.native, 18)} ETH</span>
          )}
          {wrongChain && (
            <button className="btn small" onClick={() => ensureChain()}>
              Switch to GIWA Sepolia
            </button>
          )}
        </div>
      )}
      {connectError && <p className="err">{connectError}</p>}

      <label className="field">
        <span>Pool (verified Ammora pools, plus your imported pairs)</span>
        <select
          value={pair.id}
          onChange={(e) => {
            setPair(pairs.find((p) => p.id === e.target.value) ?? pairs[0]);
            setPreview(null);
          }}
        >
          {pairs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} · {p.poolKind}
            </option>
          ))}
        </select>
      </label>
      <p className="note">{pair.note}</p>
      <p className="note">
        Pool{" "}
        <a href={`${EXPLORER_URL}/address/${pair.pool}`} target="_blank" rel="noreferrer">
          {shortAddr(pair.pool)}
        </a>
        {pair.poolKind === "concentrated" ? (
          <>
            {" "}· Concentrated pools on Ammora V3 mint a full-range position:
            the pool's addLiquidity takes no tick range, so there is no range
            to choose and the position covers the pool's whole price range.
          </>
        ) : (
          <>
            {" "}· Compounding pool. Your position is unlocked (lock duration
            0, no permanent lock), the same as the adds already on-chain for
            this pool type.
          </>
        )}
      </p>
      <p className="note">
        The pool only accepts WETH on the ETH side, even for the tAMM pool:
        ETH in your wallet is wrapped to WETH for the shortfall inside this
        flow, and the position itself is an NFT minted to your wallet.
      </p>

      <label className="field">
        <span>
          {pair.tokenA.symbol}
          {balances !== null && <em>balance {fmt(balances.base, baseDec)}</em>}
        </span>
        <div className="amount-row">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={baseAmt}
            onChange={(e) => {
              setBaseAmt(e.target.value.replace(/[^0-9.]/g, ""));
              setLastEdited("base");
            }}
          />
          <span className="sym">{pair.tokenA.symbol}</span>
        </div>
      </label>

      <label className="field">
        <span>
          ETH (as WETH)
          {balances !== null && (
            <em>
              balance {fmt(balances.weth, 18)} WETH + {fmt(balances.native, 18)} ETH
            </em>
          )}
        </span>
        <div className="amount-row">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={quoteAmt}
            onChange={(e) => {
              setQuoteAmt(e.target.value.replace(/[^0-9.]/g, ""));
              setLastEdited("quote");
            }}
          />
          <span className="sym">ETH</span>
        </div>
      </label>
      <p className="note">
        The second amount is filled in from the pool's live reserve ratio, so
        you do not have to guess it. The preview below is what the pool will
        actually take.
      </p>

      <div className="meta-grid">
        <div>
          <span>Pool ratio</span>
          <b>
            {reserves && reserves.base > 0n
              ? `1 ${pair.tokenA.symbol} ≈ ${fmt((reserves.quote * 10n ** BigInt(baseDec)) / reserves.base, 18)} ETH`
              : "loading…"}
          </b>
        </div>
        <div>
          <span>Slippage %</span>
          <input
            className="slip"
            inputMode="decimal"
            value={slippage}
            onChange={(e) => setSlippage(e.target.value.replace(/[^0-9.]/g, ""))}
          />
        </div>
        <div>
          <span>Minimum liquidity</span>
          <b>{minLiquidity !== null ? minLiquidity.toString() : "—"}</b>
        </div>
      </div>

      {preview && (
        <div className="wrap-box">
          <span className="wrap-title">Preview (live, from the pool)</span>
          <p className="note">
            Liquidity {preview.liquidity.toString()}
            <br />
            Pool will take {fmt(preview.baseUsed, baseDec)} {pair.tokenA.symbol}{" "}
            and {fmt(preview.quoteUsed, 18)} WETH.
          </p>
        </div>
      )}
      {previewErr && <p className="err">Preview failed: {previewErr}</p>}
      {insufficientBase && (
        <p className="err">Insufficient {pair.tokenA.symbol} balance for this amount.</p>
      )}
      {insufficientQuote && (
        <p className="err">Insufficient ETH plus WETH balance for this amount.</p>
      )}

      <button
        className="btn primary wide"
        disabled={
          !account ||
          wrongChain ||
          maxBase === null ||
          maxQuote === null ||
          preview === null ||
          insufficientBase ||
          insufficientQuote ||
          busy
        }
        onClick={addLiquidity}
      >
        {phase === "wrapping"
          ? "Wrapping ETH…"
          : phase === "approving"
            ? "Approving…"
            : phase === "approve-confirming"
              ? "Approval confirming…"
              : phase === "adding"
                ? "Confirm in wallet…"
                : phase === "add-confirming"
                  ? "Adding confirming…"
                  : !account
                    ? "Connect wallet to add liquidity"
                    : wrongChain
                      ? "Wrong network"
                      : `Add ${pair.tokenA.symbol} + ETH liquidity`}
      </button>

      {statusMsg && <p className="status">{statusMsg}</p>}
      {txHash && (
        <p className="status">
          Tx:{" "}
          <a href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer">
            {shortAddr(txHash)}
          </a>
          {mintedId !== null && <> · position NFT #{mintedId}</>}
        </p>
      )}

      <div className="wrap-box">
        <span className="wrap-title">Your LP position</span>
        {!account ? (
          <p className="note">Connect a wallet to see your positions in this pool.</p>
        ) : positionsErr ? (
          <p className="err">Could not load positions: {positionsErr}</p>
        ) : positions === null ? (
          <p className="note">Loading positions…</p>
        ) : positions.length === 0 ? (
          <p className="note">
            No position in this pool yet. Positions are NFTs minted by the
            pool when you add liquidity.
          </p>
        ) : (
          <ul className="wd-list">
            {positions.map((p) => (
              <li key={p.tokenId.toString()}>
                <div>
                  <b>Position #{p.tokenId.toString()}</b>
                  <span className="muted">
                    {fmt(p.baseAmount, baseDec)} {pair.tokenA.symbol} +{" "}
                    {fmt(p.quoteAmount, 18)} WETH
                    {pair.poolKind === "compounding" &&
                      (p.permanentlyLocked
                        ? " · permanently locked"
                        : p.lockReleasePoint > 0
                          ? ` · locked until ${new Date(p.lockReleasePoint * 1000).toLocaleString("en-GB")}`
                          : " · unlocked")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="note">
          Amounts come from the pool's own previewRemoveLiquidity for each
          position's live liquidity, so they move with the pool. No APY is
          shown: the pool does not promise a yield.
        </p>
      </div>

      <p className="note">
        Liquidity is added straight to the pool contract with the SDK's pool
        interface (previewAddLiquidity, addLiquidity). You approve the pool
        itself for both tokens, then send the add. Compounding pools take a
        lock duration and permanent-lock flag (0 and false here); concentrated
        pools take no range argument. Testnet only, tokens are play money.
      </p>
    </div>
  );
}
