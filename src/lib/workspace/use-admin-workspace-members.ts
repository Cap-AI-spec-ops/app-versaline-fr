"use client";

import { useCallback, useEffect, useState } from "react";

import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type AdminWorkspaceMember = {
  profile_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  role: "agent" | "team_lead" | "owner" | "super_admin";
  workspace_id: string;
  workspace_name: string;
  company_id: string | null;
  company_name: string | null;
};

export function useAdminWorkspaceMembers() {
  const [members, setMembers] = useState<AdminWorkspaceMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setMembers([]);
      setError("Supabase is not configured.");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: rpcError } = await supabase.rpc("get_admin_workspace_members");

    if (rpcError) {
      setMembers([]);
      setError(withSessionReloadFallback(rpcError.message, "Could not load workspace members."));
      setIsLoading(false);
      return;
    }

    setMembers((data ?? []) as AdminWorkspaceMember[]);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    members,
    isLoading,
    error,
    refresh,
  };
}