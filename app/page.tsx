import TradeCard from "@/components/TradeCard";
import StakePanel from "@/components/StakePanel";
import TokenBoard from "@/components/TokenBoard";
import Ecosystem from "@/components/Ecosystem";
import { getNetworkStats, getProjects } from "@/lib/explorer";
import { EXPLORER_URL, PAIRS } from "@/lib/chain";

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmt(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

export default async function Home() {
  const [stats, projects] = await Promise.all([
    getNetworkStats(),
    getProjects(),
  ]);

  return (
    <div className="wrap">
      <header className="topbar">
        <div className="brand">
          GIWA <b>EXCHANGE</b>
        </div>
        <div className="brand right">
          GIWA SEPOLIA · CHAIN 91342 · TESTNET
        </div>
      </header>

      <div className="hero">
        <div className="hero-copy">
          <h1>
            A working mini exchange on <span className="hl">GIWA Sepolia</span>,
            built with the Ammora SDK
          </h1>
          <p className="sub">
            Live quotes and real swaps against Ammora pools, powered end-to-end
            by <code>@ammora-protocol/sdk</code>: quotes via{" "}
            <code>quoteAmmoraExactIn</code>, execution via the SDK's native
            router builders and <code>buildAmmoraExactInCalldata</code>.
            Connect a browser wallet, switch to GIWA Sepolia, pay with native
            ETH, add liquidity to the same pools, import any ERC-20 by
            contract address, and stake tAMM in the Season 2 staking contract,
            all against the same contracts the Ammora app itself uses.
          </p>
          <div className="stats">
            <div className="stat">
              <div className="v">{fmt(stats.totalBlocks)}</div>
              <div className="k">Total blocks</div>
            </div>
            <div className="stat">
              <div className="v">{fmt(stats.totalTransactions)}</div>
              <div className="k">Total transactions</div>
            </div>
            <div className="stat">
              <div className="v">{fmt(stats.transactionsToday)}</div>
              <div className="k">Transactions today</div>
            </div>
            <div className="stat">
              <div className="v">{stats.blockTimeDisplay ?? "—"}</div>
              <div className="k">Block time</div>
            </div>
            <div className="stat">
              <div className="v">{fmt(stats.totalAddresses)}</div>
              <div className="k">Total addresses</div>
            </div>
          </div>
          <p className="note">
            Network stats via{" "}
            <a href={stats.source} target="_blank" rel="noreferrer">
              giwa.eco
            </a>
            . Address and transaction totals on this testnet are known to be
            inflated; treat them as context, not gospel.
          </p>
        </div>
        <div className="hero-swap">
          <TradeCard />
        </div>
        <StakePanel />
        <div className="pools-card">
          <h3>Verified pools</h3>
          <ul className="pool-list">
            {PAIRS.map((p) => (
              <li key={p.id}>
                <div>
                  <b>{p.label}</b>
                  <span className="muted">
                    {p.poolKind} pool ·{" "}
                    <a
                      href={`${EXPLORER_URL}/address/${p.pool}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddr(p.pool)}
                    </a>
                  </span>
                </div>
                <span className={`route-badge ${p.nativeRouter ? "native" : "wrap"}`}>
                  {p.nativeRouter ? "Native ETH" : "Wrap-assisted"}
                </span>
              </li>
            ))}
          </ul>
          <p className="note">
            Only pools that returned a live quote are listed. Native ETH pairs
            settle through the Ammora native router; wrap-assisted pairs wrap
            ETH to WETH inside the swap flow because the pool itself only
            trades WETH.
          </p>
        </div>
      </div>

      <TokenBoard />
      <Ecosystem projects={projects} />

      <footer className="footer">
        <p>
          <b>GIWA Exchange</b> — a testnet mini exchange for the Ammora Builder
          mission. Built with{" "}
          <a
            href="https://www.npmjs.com/package/@ammora-protocol/sdk"
            target="_blank"
            rel="noreferrer"
          >
            @ammora-protocol/sdk
          </a>{" "}
          and viem. Chain: GIWA Sepolia (chainId 91342), explorer{" "}
          <a href={EXPLORER_URL} target="_blank" rel="noreferrer">
            sepolia-explorer.giwa.io
          </a>
          .
        </p>
        <p className="muted">
          Disclaimer: this is a testnet application. All tokens are play money
          with no real-world value, quotes come from on-chain Ammora pools at
          request time, and nothing here is financial advice. You sign every
          transaction in your own wallet; this site never holds keys or funds.
        </p>
      </footer>
    </div>
  );
}
