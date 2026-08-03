"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type WorkspaceAbsence = {
  id: string;
  workspace_id: string;
  profile_id: string;
  first_name: string | null;
  last_name: string | null;
  starts_on: string;
  ends_on: string;
  status: "planned" | "confirmed" | "cancelled";
  public_note: string | null;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  can_delete: boolean;
};

type CreateAbsenceInput = {
  profileId: string;
  startsOn: string;
  endsOn: string;
  publicNote: string;
};

type UpdateAbsenceInput = {
  absenceId: string;
  startsOn: string;
  endsOn: string;
  publicNote: string;
};

function toIsoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function useWorkspaceAbsences(rangeStart: Date, rangeEnd: Date) {
  const [absences, setAbsences] = useState<WorkspaceAbsence[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rangeStartIso = useMemo(() => toIsoDate(rangeStart), [rangeStart]);
  const rangeEndIso = useMemo(() => toIsoDate(rangeEnd), [rangeEnd]);

  const refresh = useCallback(async () => {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setAbsences([]);
      setIsLoading(false);
      setError("Supabase is not configured.");
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: rpcError } = await supabase.rpc("get_workspace_absences", {
      p_range_start: rangeStartIso,
      p_range_end: rangeEndIso,
    });

    if (rpcError) {
      setAbsences([]);
      setError(withSessionReloadFallback(rpcError.message, "Could not load workspace absences."));
      setIsLoading(false);
      return;
    }

    setAbsences((data ?? []) as WorkspaceAbsence[]);
    setIsLoading(false);
  }, [rangeEndIso, rangeStartIso]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createAbsence = useCallback(
    async (input: CreateAbsenceInput) => {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        throw new Error("Supabase is not configured.");
      }

      setIsMutating(true);
      setError(null);

      const { error: rpcError } = await supabase.rpc("create_workspace_absence", {
        p_profile_id: input.profileId,
        p_starts_on: input.startsOn,
        p_ends_on: input.endsOn,
        p_status: "confirmed",
        p_public_note: input.publicNote,
        p_source: "calendar_page",
      });

      if (rpcError) {
        setIsMutating(false);
        throw new Error(withSessionReloadFallback(rpcError.message, "Could not create absence."));
      }

      await refresh();
      setIsMutating(false);
    },
    [refresh],
  );

  const updateAbsence = useCallback(
    async (input: UpdateAbsenceInput) => {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        throw new Error("Supabase is not configured.");
      }

      setIsMutating(true);
      setError(null);

      const { error: rpcError } = await supabase.rpc("update_workspace_absence", {
        p_absence_id: input.absenceId,
        p_starts_on: input.startsOn,
        p_ends_on: input.endsOn,
        p_public_note: input.publicNote,
        p_source: "calendar_page",
      });

      if (rpcError) {
        setIsMutating(false);
        throw new Error(withSessionReloadFallback(rpcError.message, "Could not update absence."));
      }

      await refresh();
      setIsMutating(false);
    },
    [refresh],
  );

  const deleteAbsence = useCallback(
    async (absenceId: string) => {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        throw new Error("Supabase is not configured.");
      }

      setIsMutating(true);
      setError(null);

      const { error: rpcError } = await supabase.rpc("delete_workspace_absence", {
        p_absence_id: absenceId,
        p_source: "calendar_page",
      });

      if (rpcError) {
        setIsMutating(false);
        throw new Error(withSessionReloadFallback(rpcError.message, "Could not delete absence."));
      }

      await refresh();
      setIsMutating(false);
    },
    [refresh],
  );

  return {
    absences,
    isLoading,
    isMutating,
    error,
    refresh,
    createAbsence,
    updateAbsence,
    deleteAbsence,
  };
}
