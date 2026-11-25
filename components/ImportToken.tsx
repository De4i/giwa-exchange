"use client";

import { useState } from "react";
import {
  validateImportedToken,
  type ImportedToken,
} from "@/lib/importedTokens";
import { EXPLORER_URL } from "@/lib/chain";
import { shortAddr } from "@/lib/wallet";

export default function ImportToken({
  imported,
  onImport,
  onRemove,
}: {
  imported: ImportedToken[];
  onImport: (token: ImportedToken) => void;
  onRemove: (address: string) => void;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  async function submit() {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError(null);
    setJustAdded(null);
    try {
      const res = await validateImportedToken(input.trim(), imported);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onImport(res.token);
      setJustAdded(res.token.address);
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap-box">
      <span className="wrap-title">Import token by contract address</span>
      <p className="note">
        Paste any ERC-20 contract address on GIWA Sepolia. The app checks the
        address format, that contract code exists, that it answers name,
        symbol and decimals, and looks up its explorer record and its Ammora
        pool. Imports stay in this browser only.
      </p>
      <div className="wrap-row">
        <input
          placeholder="0x…"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          aria-label="Token contract address"
        />
        <button className="btn small" disabled={busy || !input.trim()} onClick={submit}>
          {busy ? "Checking…" : "Import"}
        </button>
      </div>
      {error && <p className="err">{error}</p>}
      {justAdded && (
        <p className="status">Token imported. See the list below.</p>
      )}
      {imported.length > 0 && (
        <ul className="wd-list">
          {imported.map((t) => (
            <li key={t.address}>
              <div>
                <b>
                  {t.symbol} · {t.name}
                </b>
                <span className="muted">
                  <a
                    href={`${EXPLORER_URL}/address/${t.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shortAddr(t.address)}
                  </a>
                  {t.explorerIndexed &&
                    t.holders !== null &&
                    ` · ${t.holders} holders`}
                  {t.explorerIndexed &&
                    t.transfers !== null &&
                    ` · ${t.transfers} transfers`}
                  {!t.explorerIndexed && " · not indexed on the explorer yet"}
                </span>
                <span className="muted">
                  {t.pool && t.quoteOk ? (
                    <>
                      Ammora pool found, quote verified ·{" "}
                      <a
                        href={`${EXPLORER_URL}/address/${t.pool}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddr(t.pool)}
                      </a>{" "}
                      ({t.poolKind})
                    </>
                  ) : t.pool && !t.quoteOk ? (
                    "Ammora pool found, but the live quote failed, so swapping is disabled."
                  ) : (
                    "No Ammora pool found, so this token cannot be swapped here."
                  )}
                </span>
              </div>
              <button
                className="btn small"
                onClick={() => onRemove(t.address)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
