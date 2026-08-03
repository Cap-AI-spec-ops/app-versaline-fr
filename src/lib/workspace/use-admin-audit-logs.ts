"use client";

import { useCallback, useEffect, useState } from "react";

import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type AdminAuditLog = {
  id: string;
  actor_id: string | null;
  actor_email_snapshot: string | null;
  actor_role_snapshot: string | null;
  action: string;
  workspace_id: string | null;
  workspace_id_snapshot: string | null;
  company_id: string | null;
  target_type: string | null;
  target_id: string | null;
  source: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export function useAdminAuditLogs(limit = 50) {
  const [logs, setLogs] = useState<AdminAuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setLogs([]);
      setError("Supabase is not configured.");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: rpcError } = await supabase.rpc("get_audit_logs", {
      p_limit: limit,
    });

    if (rpcError) {
      setLogs([]);
      setError(withSessionReloadFallback(rpcError.message, "Could not load audit logs."));
      setIsLoading(false);
      return;
    }

    setLogs((data ?? []) as AdminAuditLog[]);
    setIsLoading(false);
  }, [limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    logs,
    isLoading,
    error,
    refresh,
  };
}
