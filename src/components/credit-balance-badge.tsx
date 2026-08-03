"use client";

import { useEffect, useMemo, useState } from "react";

import { onCreditsBalanceRefresh } from "@/lib/credits/client-refresh";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type CreditBalanceBadgeProps = {
  workspaceId: string | null | undefined;
  className?: string;
  onTopUpClick?: () => void;
};

const LOW_BALANCE_THRESHOLD = 10;

type WorkspaceBalanceRow = {
  credit_balance: number;
};

type WorkspaceBalanceResponse = {
  credit_balance?: number | null;
  effective_credit_allocation_mode?: "workspace_shared" | "per_person";
};

/**
 * Client-side workspace credit badge.
 *
 * This uses a lightweight initial read plus a Supabase Realtime subscription so the
 * balance updates quickly after generation flows change the workspaces row.
 * It is a better fit than a pure server component here because the value needs to
 * stay fresh without waiting for a full route revalidation cycle.
 */
export function CreditBalanceBadge({
  workspaceId,
  className = "",
  onTopUpClick,
}: CreditBalanceBadgeProps) {
  const [balance, setBalance] = useState<number | null>(null);
  const [mode, setMode] = useState<"workspace_shared" | "per_person">("workspace_shared");
  const [isLoading, setIsLoading] = useState(true);

  const isLowBalance = balance !== null && balance < LOW_BALANCE_THRESHOLD;

  useEffect(() => {
    if (!workspaceId) {
      setBalance(null);
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setBalance(null);
      setIsLoading(false);
      return;
    }

    const loadBalance = async (withLoading = true) => {
      if (withLoading) {
        setIsLoading(true);
      }

      const { data: rpcData, error: rpcError } = await supabase.rpc("get_workspace_credit_balance", {
        p_workspace_id: workspaceId,
      });

      let nextBalance: number | null = null;

      if (!rpcError && rpcData) {
        nextBalance = (rpcData as WorkspaceBalanceResponse).credit_balance ?? 0;
        const effectiveMode = (rpcData as WorkspaceBalanceResponse).effective_credit_allocation_mode;

        if (effectiveMode === "workspace_shared" || effectiveMode === "per_person") {
          setMode(effectiveMode);
        }
      } else {
        const { data, error } = await supabase
          .from("workspaces")
          .select("credit_balance")
          .eq("id", workspaceId)
          .single<WorkspaceBalanceRow>();

        if (!error && data) {
          nextBalance = data.credit_balance ?? 0;
        }
      }

      if (!isMounted) {
        return;
      }

      if (nextBalance === null) {
        setBalance(null);
      } else {
        setBalance(nextBalance);
      }

      setIsLoading(false);
    };

    void loadBalance();

    const disposeRefreshListener = onCreditsBalanceRefresh((detail) => {
      if (detail.workspaceId && detail.workspaceId !== workspaceId) {
        return;
      }

      if (typeof detail.newBalance === "number") {
        setBalance(detail.newBalance);
      }

      void loadBalance(false);
    });

    const channel = supabase
      .channel(`workspace-credit-balance-${workspaceId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "workspaces",
          filter: `id=eq.${workspaceId}`,
        },
        (payload) => {
          const nextBalance = (payload.new as WorkspaceBalanceRow | null)?.credit_balance;

          if (typeof nextBalance === "number") {
            setBalance(nextBalance);
          }
        },
      )
      .subscribe();

    return () => {
      isMounted = false;
      disposeRefreshListener();
      void supabase.removeChannel(channel);
    };
  }, [workspaceId]);

  const balanceLabel = useMemo(() => {
    if (isLoading) {
      return "Loading credits...";
    }

    if (balance === null) {
      return "Credits unavailable";
    }

    return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(balance)} credits`;
  }, [balance, isLoading]);

  const balanceScopeLabel = mode === "per_person" ? "Your credits" : "Workspace credits";

  return (
    <div
      className={`inline-flex items-center gap-3 rounded-2xl border px-4 py-2 text-sm shadow-sm transition ${
        isLowBalance
          ? "border-cyan-300/30 bg-[linear-gradient(135deg,rgba(8,20,36,0.98)_0%,rgba(12,28,48,0.96)_100%)] text-cyan-50 shadow-[0_10px_24px_rgba(8,20,36,0.18)]"
          : "border-white/10 bg-[linear-gradient(135deg,rgba(8,18,34,0.95)_0%,rgba(15,23,42,0.92)_100%)] text-white shadow-[0_10px_24px_rgba(10,17,40,0.14)]"
      } ${className}`}
      aria-live="polite"
    >
      <span className={`h-2.5 w-2.5 rounded-full ${isLowBalance ? "bg-cyan-300 shadow-[0_0_0_4px_rgba(34,211,238,0.12)]" : "bg-cyan-400 shadow-[0_0_0_4px_rgba(34,211,238,0.08)]"}`} />

      <div className="flex min-w-0 flex-col leading-tight">
        <span className="text-[11px] uppercase tracking-[0.18em] text-white/55">
          {balanceScopeLabel}
        </span>
        <span className={`font-semibold ${isLoading ? "text-white/72" : "text-white"}`}>
          {balanceLabel}
        </span>
      </div>

      {isLowBalance ? (
        <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2 py-1 text-[11px] font-medium text-cyan-100">
          Low balance
        </span>
      ) : null}

      <button
        type="button"
        onClick={onTopUpClick ?? (() => undefined)}
        className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-400/18 hover:text-white"
      >
        Top up
      </button>
    </div>
  );
}
