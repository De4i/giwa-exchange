"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits, zeroAddress } from "viem";
import {
  buildAmmoraExactInCalldata,
  quoteAmmoraExactIn,
} from "@ammora-protocol/sdk/integrate";
import {
  buildV3NativePoolExactInput,
  buildV3PoolExactInputForNative,
} from "@ammora-protocol/sdk";
import {
  ERC20_ABI,
  ETH,
  EXPLORER_URL,
  NATIVE_ROUTER,
  PAIRS,
  WETH,
  WETH_ABI,
  type Pair,
  type TokenInfo,
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

type Phase =
  | "idle"
  | "wrapping"
  | "approving"
  | "approve-confirming"
  | "swapping"
  | "swap-confirming"
  | "unwrapping"
  | "done";

type Balances = { native: bigint; weth: bigint; token: bigint };

export default function SwapPanel() {
  const { account, wrongChain, connect, ensureChain, connectError } =
    useWallet();
  const [pair, setPair] = useState<Pair>(PAIRS[0]);
  const [side, setSide] = useState<"buy" | "sell">("buy"); // buy = pay ETH
  const [amount, setAmount] = useState("0.01");
  const [slippage, setSlippage] = useState("1");
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const quoteSeq = useRef(0);

  const tokenIn: TokenInfo = side === "buy" ? ETH : pair.tokenA;
  const tokenOut: TokenInfo = side === "buy" ? pair.tokenA : ETH;
  // Pools only know WETH, so the ETH side is quoted against WETH (1:1).
  const quoteTokenIn = side === "buy" ? WETH.address : pair.tokenA.address;
  const busy = phase !== "idle" && phase !== "done";

  const amountIn = useMemo(() => {
    try {
      const v = parseUnits(amount || "0", tokenIn.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amount, tokenIn]);

  const slippageBps = useMemo(() => {
    const v = Number(slippage);
    if (!Number.isFinite(v) || v < 0 || v > 50) return 100;
    return Math.round(v * 100);
  }, [slippage]);

  const minOut = useMemo(() => {
    if (quote === null) return null;
    return (quote * BigInt(10000 - slippageBps)) / 10000n;
  }, [quote, slippageBps]);

  const price = useMemo(() => {
    if (quote === null || amountIn === null || amountIn === 0n) return null;
    const inF = Number(formatUnits(amountIn, tokenIn.decimals));
    const outF = Number(formatUnits(quote, tokenOut.decimals));
    if (!inF) return null;
    return outF / inF;
  }, [quote, amountIn, tokenIn, tokenOut]);

  const balanceIn = useMemo(() => {
    if (!balances) return null;
    if (side === "sell") return balances.token;
    // Buying with ETH: the native route spends ETH directly; the
    // wrap-assisted route can also spend WETH already in the wallet.
    return pair.nativeRouter
      ? balances.native
      : balances.native + balances.weth;
  }, [balances, side, pair]);

  const insufficient =
    balanceIn !== null && amountIn !== null && balanceIn < amountIn;

  // --------------------------------------------------------------- balances
  const refreshBalances = useCallback(async () => {
    if (!account) {
      setBalances(null);
      return;
    }
    try {
      const [native, weth, token] = await Promise.all([
        publicClient.getBalance({ address: account }),
        publicClient.readContract({
          address: WETH.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account],
        }),
        publicClient.readContract({
          address: pair.tokenA.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account],
        }),
      ]);
      setBalances({
        native,
        weth: weth as bigint,
        token: token as bigint,
      });
    } catch {
      /* leave previous balances */
    }
  }, [account, pair]);

  useEffect(() => {
    refreshBalances();
  }, [refreshBalances]);

  // ------------------------------------------------------------------ quote
  useEffect(() => {
    if (amountIn === null) {
      setQuote(null);
      setQuoteErr(null);
      return;
    }
    const seq = ++quoteSeq.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const out = await quoteAmmoraExactIn(publicClient, {
          pool: pair.pool,
          poolKind: pair.poolKind,
          tokenIn: quoteTokenIn,
          amountIn,
        });
        if (quoteSeq.current !== seq) return;
        setQuote(out);
        setQuoteErr(null);
      } catch (e) {
        if (quoteSeq.current !== seq) return;
        setQuote(null);
        setQuoteErr(errText(e));
      } finally {
        if (quoteSeq.current === seq) setQuoting(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [amountIn, pair, quoteTokenIn]);

  // ---------------------------------------------------------------- helpers
  async function readAllowance(token: string, spender: string) {
    return (await publicClient.readContract({
      address: token as never,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account!, spender as never],
    })) as bigint;
  }

  async function approveIfNeeded(
    token: TokenInfo,
    spender: string,
    needed: bigint,
  ) {
    const allowance = await readAllowance(token.address, spender);
    if (allowance >= needed) return;
    const wc = getWalletClient();
    if (!wc || !account) throw new Error("Wallet unavailable.");
    setPhase("approving");
    setStatusMsg(
      `Approving ${shortAddr(spender)} to pull ${fmt(needed, token.decimals)} ${token.symbol}…`,
    );
    const hash = await wc.writeContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender as never, needed],
      account,
    });
    setPhase("approve-confirming");
    await publicClient.waitForTransactionReceipt({ hash });
  }

  function deadline() {
    return BigInt(Math.floor(Date.now() / 1000) + 1200);
  }

  // ---------------------------------------------------------------- execute
  async function executeSwap() {
    const wc = getWalletClient();
    if (!wc || !account || amountIn === null || minOut === null) return;
    setTxHash(null);
    setStatusMsg(null);
    try {
      if (!(await ensureChain())) return;

      if (pair.nativeRouter) {
        // True native route: one transaction to the Ammora native router.
        if (side === "buy") {
          setPhase("swapping");
          setStatusMsg("Confirm the swap in your wallet. You pay native ETH…");
          const call = buildV3NativePoolExactInput(
            pair.pool,
            amountIn,
            minOut,
            account,
            deadline(),
            zeroAddress,
          );
          const hash = await wc.sendTransaction({
            account,
            to: NATIVE_ROUTER,
            data: call.data,
            value: call.value,
          });
          setTxHash(hash);
          setPhase("swap-confirming");
          setStatusMsg("Swap sent. Waiting for confirmation…");
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
          });
          if (receipt.status !== "success")
            throw new Error("Swap transaction reverted on-chain.");
        } else {
          // Selling: the router pulls the token, then pays out native ETH.
          await approveIfNeeded(pair.tokenA, NATIVE_ROUTER, amountIn);
          setPhase("swapping");
          setStatusMsg(
            "Confirm the swap in your wallet. You receive native ETH…",
          );
          const call = buildV3PoolExactInputForNative(
            pair.pool,
            pair.tokenA.address,
            amountIn,
            minOut,
            account,
            deadline(),
            zeroAddress,
          );
          const hash = await wc.sendTransaction({
            account,
            to: NATIVE_ROUTER,
            data: call.data,
          });
          setTxHash(hash);
          setPhase("swap-confirming");
          setStatusMsg("Swap sent. Waiting for confirmation…");
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
          });
          if (receipt.status !== "success")
            throw new Error("Swap transaction reverted on-chain.");
        }
        setPhase("done");
        setStatusMsg("Swap confirmed.");
        refreshBalances();
        return;
      }

      // Wrap-assisted route: the pool itself only trades WETH.
      let wethBefore = 0n;
      if (side === "buy") {
        const wethNow = (await publicClient.readContract({
          address: WETH.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account],
        })) as bigint;
        const shortfall = amountIn > wethNow ? amountIn - wethNow : 0n;
        if (shortfall > 0n) {
          setPhase("wrapping");
          setStatusMsg(
            `Step 1 of 3: wrapping ${fmt(shortfall, 18)} ETH into WETH…`,
          );
          const wrapHash = await wc.writeContract({
            address: WETH.address,
            abi: WETH_ABI,
            functionName: "deposit",
            account,
            value: shortfall,
          });
          await publicClient.waitForTransactionReceipt({ hash: wrapHash });
        }
        await approveIfNeeded(WETH, pair.pool, amountIn);
      } else {
        await approveIfNeeded(pair.tokenA, pair.pool, amountIn);
        wethBefore = (await publicClient.readContract({
          address: WETH.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account],
        })) as bigint;
      }

      setPhase("swapping");
      setStatusMsg("Confirm the swap in your wallet…");
      const call = buildAmmoraExactInCalldata({
        pool: pair.pool,
        poolKind: pair.poolKind,
        tokenIn: quoteTokenIn,
        amountIn,
        minimumAmountOut: minOut,
        recipient: account,
        deadline: deadline(),
      });
      const hash = await wc.sendTransaction({
        account,
        to: call.to,
        data: call.data,
        value: call.value,
      });
      setTxHash(hash);
      setPhase("swap-confirming");
      setStatusMsg("Swap sent. Waiting for confirmation…");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new Error("Swap transaction reverted on-chain.");

      if (side === "sell") {
        // Unwrap what the swap paid out so the user ends with native ETH.
        const wethAfter = (await publicClient.readContract({
          address: WETH.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account],
        })) as bigint;
        const received = wethAfter > wethBefore ? wethAfter - wethBefore : 0n;
        if (received > 0n) {
          setPhase("unwrapping");
          setStatusMsg(
            `Final step: unwrapping ${fmt(received, 18)} WETH back to ETH…`,
          );
          const unwrapHash = await wc.writeContract({
            address: WETH.address,
            abi: WETH_ABI,
            functionName: "withdraw",
            args: [received],
            account,
          });
          await publicClient.waitForTransactionReceipt({ hash: unwrapHash });
        }
      }
      setPhase("done");
      setStatusMsg("Swap confirmed. You hold native ETH.");
      refreshBalances();
    } catch (e) {
      setPhase("idle");
      setStatusMsg(errText(e));
      refreshBalances();
    }
  }

  async function unwrapAll() {
    const wc = getWalletClient();
    if (!wc || !account || !balances || balances.weth === 0n) return;
    setTxHash(null);
    setStatusMsg(null);
    try {
      if (!(await ensureChain())) return;
      setPhase("unwrapping");
      const hash = await wc.writeContract({
        address: WETH.address,
        abi: WETH_ABI,
        functionName: "withdraw",
        args: [balances.weth],
        account,
      });
      setTxHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      setPhase("done");
      setStatusMsg("Unwrapped WETH back to ETH.");
      refreshBalances();
    } catch (e) {
      setPhase("idle");
      setStatusMsg(errText(e));
    }
  }

  // -------------------------------------------------------------------- UI
  return (
    <section className="swap" aria-label="Swap">
      <div className="swap-head">
        <h2>Swap</h2>
        <span className="chip">
          {pair.nativeRouter ? (
            <>
              route: <b>native ETH</b>
            </>
          ) : (
            <>
              route: <b>wrap-assisted</b>
            </>
          )}
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
        <span>Pair (verified Ammora pools only)</span>
        <select
          value={pair.id}
          onChange={(e) => {
            setPair(PAIRS.find((p) => p.id === e.target.value) ?? PAIRS[0]);
            setQuote(null);
          }}
        >
          {PAIRS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} · {p.poolKind}
            </option>
          ))}
        </select>
      </label>
      <p className="note">{pair.note}</p>
      <p className="note">
        Pool{" "}
        <a
          href={`${EXPLORER_URL}/address/${pair.pool}`}
          target="_blank"
          rel="noreferrer"
        >
          {shortAddr(pair.pool)}
        </a>{" "}
        · verified quote: {pair.verifiedQuote}
      </p>
      {pair.nativeRouter ? (
        <p className="note">
          This pool trades through the Ammora native router (
          <a
            href={`${EXPLORER_URL}/address/${NATIVE_ROUTER}`}
            target="_blank"
            rel="noreferrer"
          >
            {shortAddr(NATIVE_ROUTER)}
          </a>
          ), the same contract the Ammora app itself uses: you pay native ETH
          and receive native ETH, in one transaction.
        </p>
      ) : (
        <p className="note">
          ETH is wrapped to WETH under the hood, Ammora pools are WETH based.
          Buys wrap only the shortfall, sells unwrap what you receive in the
          same flow, so you start and end with native ETH.
        </p>
      )}

      <label className="field">
        <span>
          You pay · {tokenIn.symbol}
          {balanceIn !== null && (
            <em>balance {fmt(balanceIn, tokenIn.decimals)}</em>
          )}
        </span>
        <div className="amount-row">
          <input
            inputMode="decimal"
            placeholder="0.0"
            value={amount}
            onChange={(e) =>
              setAmount(e.target.value.replace(/[^0-9.]/g, ""))
            }
          />
          <span className="sym">{tokenIn.symbol}</span>
        </div>
      </label>

      <button
        className="flip"
        onClick={() => {
          setSide(side === "buy" ? "sell" : "buy");
          setQuote(null);
        }}
        aria-label="Flip direction"
      >
        ⇅
      </button>

      <label className="field">
        <span>You receive · {tokenOut.symbol} (estimated)</span>
        <div className="amount-row readonly">
          <input
            readOnly
            placeholder={quoting ? "quoting…" : "0.0"}
            value={quote !== null ? fmt(quote, tokenOut.decimals) : ""}
          />
          <span className="sym">{tokenOut.symbol}</span>
        </div>
      </label>

      <div className="meta-grid">
        <div>
          <span>Price</span>
          <b>
            {price !== null
              ? `1 ${tokenIn.symbol} ≈ ${price.toPrecision(6)} ${tokenOut.symbol}`
              : "—"}
          </b>
        </div>
        <div>
          <span>Slippage %</span>
          <input
            className="slip"
            inputMode="decimal"
            value={slippage}
            onChange={(e) =>
              setSlippage(e.target.value.replace(/[^0-9.]/g, ""))
            }
          />
        </div>
        <div>
          <span>Minimum received</span>
          <b>
            {minOut !== null
              ? `${fmt(minOut, tokenOut.decimals)} ${tokenOut.symbol}`
              : "—"}
          </b>
        </div>
      </div>

      {quoteErr && <p className="err">Quote failed: {quoteErr}</p>}
      {insufficient && (
        <p className="err">
          Insufficient {tokenIn.symbol} balance for this amount.
        </p>
      )}

      <button
        className="btn primary wide"
        disabled={
          !account ||
          wrongChain ||
          amountIn === null ||
          quote === null ||
          insufficient ||
          busy
        }
        onClick={executeSwap}
      >
        {phase === "wrapping"
          ? "Wrapping ETH…"
          : phase === "approving"
            ? "Approving…"
            : phase === "approve-confirming"
              ? "Approval confirming…"
              : phase === "swapping"
                ? "Confirm in wallet…"
                : phase === "swap-confirming"
                  ? "Swap confirming…"
                  : phase === "unwrapping"
                    ? "Unwrapping to ETH…"
                    : !account
                      ? "Connect wallet to swap"
                      : wrongChain
                        ? "Wrong network"
                        : side === "buy"
                          ? `Buy ${pair.tokenA.symbol} with ETH`
                          : `Sell ${pair.tokenA.symbol} for ETH`}
      </button>

      {!pair.nativeRouter && balances && balances.weth > 0n && (
        <div className="wrap-box">
          <div className="wrap-row">
            <span className="wrap-title">
              WETH balance: {fmt(balances.weth, 18)} WETH
            </span>
            <button
              className="btn small"
              disabled={!account || wrongChain || busy}
              onClick={unwrapAll}
            >
              Unwrap all to ETH
            </button>
          </div>
        </div>
      )}

      {statusMsg && <p className="status">{statusMsg}</p>}
      {txHash && (
        <p className="status">
          Tx:{" "}
          <a
            href={`${EXPLORER_URL}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {shortAddr(txHash)}
          </a>
        </p>
      )}
      <p className="note">
        Quotes come from <code>@ammora-protocol/sdk</code> (
        <code>quoteAmmoraExactIn</code>). Native calldata is built by the SDK's{" "}
        <code>buildV3NativePoolExactInput</code> /{" "}
        <code>buildV3PoolExactInputForNative</code>; wrap-assisted swaps use{" "}
        <code>buildAmmoraExactInCalldata</code> and are pull-based: you approve
        the pool itself, then send the swap. Testnet only, tokens are play
        money.
      </p>
    </section>
  );
}
