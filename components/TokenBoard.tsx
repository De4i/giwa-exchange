"use client";

import { useEffect, useMemo, useState } from "react";
import type { TokenBoard as Board, TokenRow } from "@/lib/explorer";

const EXPLORER = "https://sepolia-explorer.giwa.io";

function fmt(n: number | null): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-US");
}

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export default function TokenBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [verdict, setVerdict] = useState("");
  const [ecoOnly, setEcoOnly] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/tokens")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j as Board;
      })
      .then((j) => {
        if (alive) setBoard(j);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : "failed to load");
      });
    return () => {
      alive = false;
    };
  }, []);

  const rows: TokenRow[] = useMemo(() => {
    if (!board) return [];
    const needle = q.toLowerCase();
    return board.rows.filter(
      (r) =>
        (!verdict || r.verdict === verdict) &&
        (!ecoOnly || r.ecosystemProject) &&
        (!needle ||
          (r.name ?? "").toLowerCase().includes(needle) ||
          (r.symbol ?? "").toLowerCase().includes(needle) ||
          r.address.toLowerCase().includes(needle)),
    );
  }, [board, q, verdict, ecoOnly]);

  return (
    <section aria-label="Token board">
      <div className="section-head">
        <h2>Live token board</h2>
        {board && (
          <span className="muted">
            {board.rows.length} tokens · {board.verdicts.ACTIVE} active ·{" "}
            {board.verdicts.WATCH} watch · {board.verdicts.DEAD} dead · updated{" "}
            {new Date(board.generatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      <div className="controls">
        <input
          type="search"
          placeholder="Search name, symbol or address…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
          <option value="">All verdicts</option>
          <option>ACTIVE</option>
          <option>WATCH</option>
          <option>DEAD</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={ecoOnly}
            onChange={(e) => setEcoOnly(e.target.checked)}
          />
          Ecosystem projects only
        </label>
      </div>

      {!board && !error && <p className="muted">Loading live data from the GIWA explorer…</p>}
      {error && <p className="err">Token board unavailable: {error}</p>}

      {board && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Token</th>
                <th>Score</th>
                <th>Verdict</th>
                <th>Transfers</th>
                <th>Holders</th>
                <th>Age</th>
                <th>Ecosystem</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.address}>
                  <td className="num">{r.rank}</td>
                  <td>
                    <a
                      className="tname"
                      href={`${EXPLORER}/token/${r.address}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {r.name || r.symbol || short(r.address)}
                    </a>
                    <div className="tsub">
                      {r.symbol ?? ""} · {short(r.address)}
                    </div>
                  </td>
                  <td className="num score">{r.score.toFixed(1)}</td>
                  <td>
                    <span className={`verd ${r.verdict}`}>{r.verdict}</span>
                  </td>
                  <td className="num">{fmt(r.transfers)}</td>
                  <td className="num">{fmt(r.holders)}</td>
                  <td className="num">{r.ageDays === null ? "—" : `${r.ageDays}d`}</td>
                  <td>
                    {r.ecosystemProject ? (
                      <a
                        className="eco"
                        href={`https://giwa.eco/en/projects/${r.ecosystemProject.slug}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.ecosystemProject.name}
                        {r.ecosystemProject.category
                          ? ` · ${r.ecosystemProject.category}`
                          : ""}
                      </a>
                    ) : (
                      <span className="tsub">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="note">
        Score = {board?.scoreFormula ?? "100 * (0.55 * ln(1+transfers)/max + 0.30 * ln(1+holders)/max + 0.15 * recency)"}.
        This is a relative <b>activity</b> ranking from the Blockscout explorer API, not a
        price signal: the explorer exposes no real prices or market caps on this testnet,
        and holder counts are visibly inflated/synthetic, so holders carry the lowest
        weight. Testnet tokens are play money.
      </p>
    </section>
  );
}
