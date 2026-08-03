"use client";

import { useCallback, useEffect, useState } from "react";

import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type AdminWorkspace = {
  workspace_id: string;
  workspace_name: string;
  currency: string;
  metric_system: string;
  default_country_code: string;
  default_locale: string;
  default_language: string;
  default_timezone: string;
  company_id: string | null;
  company_name: string | null;
  members_count: number;
  is_current: boolean;
};

export function useAdminWorkspaces() {
  const [workspaces, setWorkspaces] = useState<AdminWorkspace[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setWorkspaces([]);
      setError("Supabase is not configured.");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: rpcError } = await supabase.rpc("get_admin_workspaces");

    if (rpcError) {
      setWorkspaces([]);
      setError(withSessionReloadFallback(rpcError.message, "Could not load workspaces."));
      setIsLoading(false);
      return;
    }

    setWorkspaces((data ?? []) as AdminWorkspace[]);
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
