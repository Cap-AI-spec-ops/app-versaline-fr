"use client";

import { useCallback, useEffect, useState } from "react";

import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type AccessibleWorkspace = {
  workspace_id: string;
  workspace_name: string;
  company_id: string | null;
  company_name: string | null;
  user_role: "agent" | "team_lead" | "owner" | "super_admin";
  is_current: boolean;
};

export function useAccessibleWorkspaces() {
  const [workspaces, setWorkspaces] = useState<AccessibleWorkspace[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setWorkspaces([]);
      setIsLoading(false);
      setError("Supabase is not configured.");
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: rpcError } = await supabase.rpc("get_accessible_workspaces");

    if (rpcError) {
      setWorkspaces([]);
      setError(withSessionReloadFallback(rpcError.message, "Could not load accessible workspaces."));
      setIsLoading(false);
      return;
    }

    setWorkspaces((data ?? []) as AccessibleWorkspace[]);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    workspaces,
    isLoading,
    error,
    refresh,
  };
}
