"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits, type Hash } from "viem";
import {
  ERC20_ABI,
  EXPLORER_URL,
  STAKING,
  STAKING_ABI,
  TAMM,
} from "@/lib/chain";
import {
  errText,
  getWalletClient,
  publicClient,
  shortAddr,
  useWallet,
} from "@/lib/wallet";

function fmt(amount: bigint, decimals = 6, maxFrac = 6): string {
  const s = formatUnits(amount, decimals);
  const [int, frac = ""] = s.split(".");
  const trimmed = frac.slice(0, maxFrac).replace(/0+$/, "");
  return trimmed ? `${int}.${trimmed}` : int;
}

type Withdrawal = { id: bigint; amount: bigint; unlockAt: number };

type StakeData = {
  walletBalance: bigint;
  staked: bigint;
  claimable: bigint;
  totalStaked: bigint | null;
  depositsPaused: boolean;
  withdrawals: Withdrawal[];
};

export default function StakePanel() {
  const { account, wrongChain, connect, ensureChain, connectError } =
    useWallet();
  const [data, setData] = useState<StakeData | null>(null);
  const [stakeAmt, setStakeAmt] = useState("10");
  const [unstakeAmt, setUnstakeAmt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const t = setInterval(tick, 30000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const totalStaked = (await publicClient.readContract({
        address: STAKING,
        abi: STAKING_ABI,
        functionName: "totalPrincipal",
      })) as bigint;
      const depositsPaused = (await publicClient.readContract({
        address: STAKING,
        abi: STAKING_ABI,
        functionName: "depositsPaused",
      })) as boolean;
      if (!account) {
        setData({
          walletBalance: 0n,
          staked: 0n,
          claimable: 0n,
          totalStaked,
          depositsPaused,
          withdrawals: [],
        });
        return;
      }
      const [walletBalance, acct, claimable, ids] = await Promise.all([
        publicClient.readContract({
          address: TAMM.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: STAKING,
          abi: STAKING_ABI,
          functionName: "accounts",
          args: [account],
        }) as Promise<readonly bigint[]>,
        publicClient.readContract({
          address: STAKING,
          abi: STAKING_ABI,
          functionName: "claimable",
          args: [account],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: STAKING,
          abi: STAKING_ABI,
          functionName: "pendingWithdrawalIds",
          args: [account],
        }) as Promise<readonly bigint[]>,
      ]);
      const withdrawals = await Promise.all(
        ids.map(async (id) => {
          const w = (await publicClient.readContract({
            address: STAKING,
            abi: STAKING_ABI,
            functionName: "withdrawals",
            args: [account, id],
          })) as readonly [bigint, bigint];
          return { id, amount: w[0], unlockAt: Number(w[1]) };
        }),
      );
      setData({
        walletBalance,
        staked: acct[0], // accounts().active, the live staked principal
        claimable,
        totalStaked,
        depositsPaused,
        withdrawals,
      });
    } catch {
      /* leave previous data */
    }
  }, [account]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const stakeAmount = useMemo(() => {
    try {
      const v = parseUnits(stakeAmt || "0", TAMM.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [stakeAmt]);

  const unstakeAmount = useMemo(() => {
    try {
      const v = parseUnits(unstakeAmt || "0", TAMM.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [unstakeAmt]);

  async function run(label: string, fn: (wc: NonNullable<ReturnType<typeof getWalletClient>>) => Promise<Hash>) {
    const wc = getWalletClient();
    if (!wc || !account) return;
    setTxHash(null);
    setStatusMsg(null);
    setBusy(label);
    try {
      if (!(await ensureChain())) return;
      const hash = await fn(wc);
      setTxHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      setStatusMsg("Confirmed on-chain.");
      refresh();
    } catch (e) {
      setStatusMsg(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function stake() {
    if (!account || stakeAmount === null) return;
    await run("stake", async (wc) => {
      const allowance = (await publicClient.readContract({
        address: TAMM.address,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account, STAKING],
      })) as bigint;
      if (allowance < stakeAmount) {
        setStatusMsg("Approving the staking contract to pull your tAMM…");
        const approveHash = await wc.writeContract({
          address: TAMM.address,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [STAKING, stakeAmount],
          account,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }
      setStatusMsg("Confirm the stake in your wallet…");
      return wc.writeContract({
        address: STAKING,
        abi: STAKING_ABI,
        functionName: "deposit",
        args: [stakeAmount],
        account,
      });
    });
  }

  async function claim() {
    if (!account) return;
    await run("claim", async (wc) => {
      setStatusMsg("Confirm the claim in your wallet…");
      return wc.writeContract({
        address: STAKING,
        abi: STAKING_ABI,
        functionName: "claim",
        account,
      });
    });
  }

  async function requestUnstake() {
    if (!account || unstakeAmount === null) return;
    await run("unstake", async (wc) => {
      setStatusMsg("Confirm the unstake request in your wallet…");
      return wc.writeContract({
        address: STAKING,
        abi: STAKING_ABI,
        functionName: "requestWithdrawal",
        args: [unstakeAmount],
        account,
      });
    });
  }

  async function withdraw(id: bigint) {
    if (!account) return;
    await run(`withdraw-${id}`, async (wc) => {
      setStatusMsg("Confirm the withdrawal in your wallet…");
      return wc.writeContract({
        address: STAKING,
        abi: STAKING_ABI,
        functionName: "withdraw",
        args: [id],
        account,
      });
    });
  }

  return (
    <section className="stake" aria-label="Stake tAMM">
      <div className="swap-head">
        <h2>Stake tAMM</h2>
        <span className="chip">
          contract:{" "}
          <a
            href={`${EXPLORER_URL}/address/${STAKING}`}
            target="_blank"
            rel="noreferrer"
          >
            <b>{shortAddr(STAKING)}</b>
          </a>
        </span>
      </div>

      <p className="note">
        The same staking contract as the Ammora Season 2 stake mission. Stake
        tAMM, earn tAMM rewards, claim them any time. Unstake requests stop
        earning immediately and unlock the principal 24 hours later.
      </p>

      <div className="kv">
        <div>
          <span>Total staked in contract</span>
          <b>
            {data?.totalStaked != null
              ? `${fmt(data.totalStaked)} tAMM`
              : "loading…"}
          </b>
        </div>
        {account && data && (
          <>
            <div>
              <span>Your wallet</span>
              <b>{fmt(data.walletBalance)} tAMM</b>
            </div>
            <div>
              <span>Your staked</span>
              <b>{fmt(data.staked)} tAMM</b>
            </div>
            <div>
              <span>Claimable rewards</span>
              <b>{fmt(data.claimable)} tAMM</b>
            </div>
          </>
        )}
      </div>

      {!account ? (
        <button className="btn primary wide" onClick={connect}>
          Connect wallet to stake
        </button>
      ) : (
        <>
          {data?.depositsPaused && (
            <p className="err">Deposits are currently paused on the contract.</p>
          )}
          <label className="field">
            <span>
              Amount to stake
              {data && <em>balance {fmt(data.walletBalance)}</em>}
            </span>
            <div className="amount-row">
              <input
                inputMode="decimal"
                placeholder="0.0"
                value={stakeAmt}
                onChange={(e) =>
                  setStakeAmt(e.target.value.replace(/[^0-9.]/g, ""))
                }
              />
              <span className="sym">tAMM</span>
            </div>
          </label>
          <button
            className="btn primary wide"
            disabled={
              wrongChain ||
              busy !== null ||
              stakeAmount === null ||
              data === null ||
              data.depositsPaused ||
              stakeAmount > data.walletBalance
            }
            onClick={stake}
          >
            {busy === "stake" ? "Staking…" : "Stake tAMM"}
          </button>
          {data !== null && stakeAmount !== null && stakeAmount > data.walletBalance && (
            <p className="err">Insufficient tAMM balance for this amount.</p>
          )}

          <button
            className="btn wide"
            disabled={wrongChain || busy !== null || !data || data.claimable === 0n}
            onClick={claim}
          >
            {busy === "claim"
              ? "Claiming…"
              : data && data.claimable > 0n
                ? `Claim ${fmt(data.claimable)} tAMM rewards`
                : "Claim rewards"}
          </button>

          <div className="wrap-box">
            <span className="wrap-title">Unstake</span>
            <label className="field">
              <span>
                Amount to unstake
                {data && <em>staked {fmt(data.staked)}</em>}
              </span>
              <div className="amount-row">
                <input
                  inputMode="decimal"
                  placeholder="0.0"
                  value={unstakeAmt}
                  onChange={(e) =>
                    setUnstakeAmt(e.target.value.replace(/[^0-9.]/g, ""))
                  }
                />
                <span className="sym">tAMM</span>
              </div>
            </label>
            <button
              className="btn wide"
              disabled={
                wrongChain ||
                busy !== null ||
                unstakeAmount === null ||
                data === null ||
                unstakeAmount > data.staked
              }
              onClick={requestUnstake}
            >
              {busy === "unstake" ? "Requesting…" : "Request unstake"}
            </button>
            <p className="note">
              The requested amount stops earning right away and can be
              withdrawn from the list below once its 24 hour unlock passes.
            </p>

            {data && data.withdrawals.length > 0 && (
              <ul className="wd-list">
                {data.withdrawals.map((w) => {
                  const ready = now >= w.unlockAt;
                  return (
                    <li key={w.id.toString()}>
                      <div>
                        <b>{fmt(w.amount)} tAMM</b>
                        <span className="muted">
                          {ready
                            ? "Ready to withdraw"
                            : `Unlocks ${new Date(w.unlockAt * 1000).toLocaleString("en-GB")}`}
                        </span>
                      </div>
                      <button
                        className="btn small"
                        disabled={!ready || busy !== null}
                        onClick={() => withdraw(w.id)}
                      >
                        {busy === `withdraw-${w.id}` ? "…" : "Withdraw"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
      {connectError && <p className="err">{connectError}</p>}
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
        Reads and writes go straight to the staking contract from your wallet.
        The contract is not verified on the explorer; this panel uses the same
        interface as ammora.org's own Season 2 pages, checked against live
        on-chain reads. No APY is shown: rewards accrue in tAMM at the
        contract's own rate. Testnet only.
      </p>
    </section>
  );
}
