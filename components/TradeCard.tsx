"use client";

import { useCallback, useMemo, useState } from "react";
import SwapPanel from "@/components/SwapPanel";
import AddLpPanel from "@/components/AddLpPanel";
import { PAIRS } from "@/lib/chain";
import {
  importedToPair,
  loadImportedTokens,
  saveImportedTokens,
  type ImportedToken,
} from "@/lib/importedTokens";

// Swap and Add LP share one card with tabs, and one imported-token list:
// a token imported in Swap is immediately available as an LP pool, and
// removing it drops it from both panels. Imports live in localStorage only.
export default function TradeCard() {
  const [tab, setTab] = useState<"swap" | "lp">("swap");
  const [imported, setImported] = useState<ImportedToken[]>(() =>
    loadImportedTokens(),
  );

  const importedPairs = useMemo(
    () =>
      imported
        .map((t) => importedToPair(t))
        .filter((p): p is NonNullable<typeof p> => p !== null),
    [imported],
  );
  const lpPairs = useMemo(() => [...PAIRS, ...importedPairs], [importedPairs]);

  const onImport = useCallback((token: ImportedToken) => {
    setImported((prev) => {
      const next = [
        ...prev.filter(
          (t) => t.address.toLowerCase() !== token.address.toLowerCase(),
        ),
        token,
      ];
      saveImportedTokens(next);
      return next;
    });
  }, []);

  const onRemoveToken = useCallback((address: string) => {
    setImported((prev) => {
      const next = prev.filter(
        (t) => t.address.toLowerCase() !== address.toLowerCase(),
      );
      saveImportedTokens(next);
      return next;
    });
  }, []);

  return (
    <section className="swap" aria-label="Trade">
      <div className="tabs" role="tablist" aria-label="Trade panels">
        <button
          role="tab"
          aria-selected={tab === "swap"}
          className={`tab${tab === "swap" ? " active" : ""}`}
          onClick={() => setTab("swap")}
        >
          Swap
        </button>
        <button
          role="tab"
          aria-selected={tab === "lp"}
          className={`tab${tab === "lp" ? " active" : ""}`}
          onClick={() => setTab("lp")}
        >
          Add LP
        </button>
      </div>
      {/* Both panels stay mounted so switching tabs keeps amounts, quotes
          and wallet state; only the active one is shown. */}
      <div hidden={tab !== "swap"}>
        <SwapPanel
          importedPairs={importedPairs}
          importedTokens={imported}
          onImport={onImport}
          onRemoveToken={onRemoveToken}
        />
      </div>
      <div hidden={tab !== "lp"}>
        <AddLpPanel pairs={lpPairs} />
      </div>
    </section>
  );
}
