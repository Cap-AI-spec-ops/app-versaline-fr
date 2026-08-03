"use client";

import { useCallback, useEffect, useState } from "react";
import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type WorkspaceMember = {
  profile_id: string;
  first_name: string | null;
  last_name: string | null;
  role: "agent" | "team_lead" | "owner" | "super_admin";
  joined_at: string | null;
};

export function useWorkspaceMembers() {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setMembers([]);
      setError("Supabase is not configured.");
      setIsLoading(false);
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    setCurrentUserId(user?.id ?? null);

    setIsLoading(true);
    setError(null);

    const { data, error: membersError } = await supabase.rpc("get_workspace_members");

    if (membersError) {
      setMembers([]);
      setError(withSessionReloadFallback(membersError.message, "Could not load workspace members."));
      setIsLoading(false);
      return;
    }

    setMembers(((data ?? []) as WorkspaceMember[]).filter((member) => member.profile_id));
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { members, isLoading, error, refresh, currentUserId };
}