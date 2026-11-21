"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
} from "viem";
import { CHAIN_ID, EXPLORER_URL, RPC_URL, giwaSepolia } from "@/lib/chain";

declare global {
  interface Window {
    ethereum?: unknown;
  }
}

export const publicClient = createPublicClient({
  chain: giwaSepolia,
  transport: http(RPC_URL),
});

export function getWalletClient() {
  if (typeof window === "undefined" || !window.ethereum) return null;
  return createWalletClient({
    chain: giwaSepolia,
    transport: custom(window.ethereum as never),
  });
}

export function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function errText(e: unknown): string {
  const err = e as { code?: number; shortMessage?: string; message?: string };
  if (err?.code === 4001 || /user rejected|denied/i.test(err?.message ?? "")) {
    return "Rejected in the wallet. Nothing was sent.";
  }
  return err?.shortMessage ?? err?.message ?? "Something went wrong.";
}

export type WalletState = {
  account: Address | null;
  walletChain: number | null;
  wrongChain: boolean;
  connect: () => Promise<void>;
  ensureChain: () => Promise<boolean>;
  connectError: string | null;
};

export function useWallet(): WalletState {
  const [account, setAccount] = useState<Address | null>(null);
  const [walletChain, setWalletChain] = useState<number | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const refreshWallet = useCallback(async () => {
    const wc = getWalletClient();
    if (!wc) return;
    try {
      const [addrs, chainId] = await Promise.all([
        wc.getAddresses(),
        wc.getChainId(),
      ]);
      setAccount(addrs[0] ?? null);
      setWalletChain(chainId);
    } catch {
      /* wallet locked or unavailable */
    }
  }, []);

  useEffect(() => {
    refreshWallet();
    const eth = window.ethereum as
      | {
          on?: (ev: string, fn: () => void) => void;
          removeListener?: (ev: string, fn: () => void) => void;
        }
      | undefined;
    eth?.on?.("accountsChanged", refreshWallet);
    eth?.on?.("chainChanged", refreshWallet);
    return () => {
      eth?.removeListener?.("accountsChanged", refreshWallet);
      eth?.removeListener?.("chainChanged", refreshWallet);
    };
  }, [refreshWallet]);

  const connect = useCallback(async () => {
    const wc = getWalletClient();
    if (!wc) {
      setConnectError(
        "No browser wallet found. Install MetaMask or another injected wallet first.",
      );
      return;
    }
    try {
      const addrs = await wc.requestAddresses();
      setAccount(addrs[0] ?? null);
      setWalletChain(await wc.getChainId());
      setConnectError(null);
    } catch (e) {
      setConnectError(errText(e));
    }
  }, []);

  const ensureChain = useCallback(async (): Promise<boolean> => {
    const wc = getWalletClient();
    if (!wc) return false;
    if ((await wc.getChainId()) === CHAIN_ID) return true;
    try {
      await wc.switchChain({ id: CHAIN_ID });
      return true;
    } catch {
      // Chain unknown to the wallet: offer to add it.
      try {
        await (
          window.ethereum as {
            request: (args: unknown) => Promise<unknown>;
          }
        ).request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: `0x${CHAIN_ID.toString(16)}`,
              chainName: "GIWA Sepolia",
              nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              rpcUrls: [RPC_URL],
              blockExplorerUrls: [EXPLORER_URL],
            },
          ],
        });
        return (await wc.getChainId()) === CHAIN_ID;
      } catch (e) {
        setConnectError(errText(e));
        return false;
      }
    }
  }, []);

  return {
    account,
    walletChain,
    wrongChain: walletChain !== null && walletChain !== CHAIN_ID,
    connect,
    ensureChain,
    connectError,
  };
}
