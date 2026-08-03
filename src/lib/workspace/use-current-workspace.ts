"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { withSessionReloadFallback } from "@/lib/auth/session-error-message";

export type CurrentWorkspace = {
  id: string;
  name: string;
  currency: string;
  metric_system: string;
  default_country_code: string;
  default_locale: string;
  default_language: string;
  default_timezone: string;
  credit_allocation_mode: "workspace_shared" | "per_person";
  credit_allocation_control: "owner_locked" | "team_lead_select";
  team_lead_credit_allocation_mode: "workspace_shared" | "per_person" | null;
  team_lead_daily_briefing_enabled: boolean | null;
  company_id: string | null;
  company_name: string | null;
};

type WorkspaceRole = "agent" | "team_lead" | "owner" | "super_admin";

type AccessibleWorkspaceRow = {
  workspace_id: string;
  workspace_name: string;
  company_id: string | null;
  company_name: string | null;
  is_current: boolean;
};

export function useCurrentWorkspace() {
  const [workspace, setWorkspace] = useState<CurrentWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentRole, setCurrentRole] = useState<WorkspaceRole | null>(null);
  const hasLoadedOnceRef = useRef(false);

  useEffect(() => {
    let isMounted = true;

    const loadWorkspace = async (options?: { background?: boolean }) => {
      const isBackground = options?.background ?? false;

      if (isMounted) {
        if (!isBackground || !hasLoadedOnceRef.current) {
          setIsLoading(true);
        }

        setError(null);
      }

      try {
        const supabase = getSupabaseBrowserClient();

        if (!supabase) {
          if (isMounted) {
            setWorkspace(null);
            setError("Supabase is not configured.");
          }

          return;
        }

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (!isMounted) {
          return;
        }

        if (userError || !user) {
          setWorkspace(null);
          setError(withSessionReloadFallback(userError?.message, "You are not signed in."));
          return;
        }

        const { data: profileData, error: profileError } = await supabase.rpc("get_current_profile");

        if (!isMounted) {
          return;
        }

        if (profileError || !profileData) {
          setWorkspace(null);
          setCurrentRole(null);
          setError(withSessionReloadFallback(profileError?.message, "Could not load current profile."));
          return;
        }

        const profile = profileData as { workspace_id?: string | null; role?: WorkspaceRole | null };
        setCurrentRole(profile.role ?? null);

        if (!profile.workspace_id) {
          setWorkspace(null);
          setError("No workspace linked to this profile.");
          return;
        }

        const { data: currentWorkspaceData, error: currentWorkspaceError } = await supabase.rpc("get_current_workspace");

        let rawWorkspace: Record<string, unknown> | null = null;
        let companyId: string | null = null;
        let companyName: string | null = null;

        if (!currentWorkspaceError && currentWorkspaceData) {
          rawWorkspace = currentWorkspaceData as Record<string, unknown>;
          companyId = typeof rawWorkspace.company_id === "string" ? rawWorkspace.company_id : null;
        } else {
          const missingCurrentWorkspaceRpc =
            currentWorkspaceError?.message?.includes("Could not find the function public.get_current_workspace") ?? false;

          if (!missingCurrentWorkspaceRpc) {
            setWorkspace(null);
            setError(withSessionReloadFallback(currentWorkspaceError?.message, "Could not load workspace."));
            return;
          }

          const { data: accessibleData, error: accessibleError } = await supabase.rpc("get_accessible_workspaces");

          if (accessibleError) {
            setWorkspace(null);
            setError(withSessionReloadFallback(accessibleError.message, "Could not load workspace."));
            return;
          }

          const accessibleRows = (accessibleData ?? []) as AccessibleWorkspaceRow[];
          const currentWorkspace =
            accessibleRows.find((row) => row.is_current) ??
            accessibleRows.find((row) => row.workspace_id === profile.workspace_id);

          if (!currentWorkspace) {
            setWorkspace(null);
            setError("Could not resolve current workspace.");
            return;
          }

          rawWorkspace = {
            id: currentWorkspace.workspace_id,
            name: currentWorkspace.workspace_name,
            company_id: currentWorkspace.company_id,
            currency: "EUR",
            metric_system: "metric",
            default_country_code: "FR",
            default_locale: "fr-FR",
            default_language: "fr",
            default_timezone: "Europe/Paris",
            credit_allocation_mode: "workspace_shared",
            credit_allocation_control: "owner_locked",
            team_lead_credit_allocation_mode: null,
            team_lead_daily_briefing_enabled: null,
          };

          companyId = currentWorkspace.company_id;
          companyName = currentWorkspace.company_name;
        }

        if (!rawWorkspace) {
          setWorkspace(null);
          setError("Could not load workspace.");
          return;
        }

        if (!companyName && companyId) {
          const { data: companyData } = await supabase
            .from("companies")
            .select("name")
            .eq("id", companyId)
            .single<{ name: string }>();

          companyName = companyData?.name ?? null;
        }

        setWorkspace({
          id: typeof rawWorkspace.id === "string" ? rawWorkspace.id : profile.workspace_id,
          name: typeof rawWorkspace.name === "string" ? rawWorkspace.name : "Workspace",
          currency: typeof rawWorkspace.currency === "string" ? rawWorkspace.currency : "EUR",
          metric_system: rawWorkspace.metric_system === "imperial" ? "imperial" : "metric",
          default_country_code:
            typeof rawWorkspace.default_country_code === "string" ? rawWorkspace.default_country_code : "FR",
          default_locale: typeof rawWorkspace.default_locale === "string" ? rawWorkspace.default_locale : "fr-FR",
          default_language: typeof rawWorkspace.default_language === "string" ? rawWorkspace.default_language : "fr",
          default_timezone:
            typeof rawWorkspace.default_timezone === "string" ? rawWorkspace.default_timezone : "Europe/Paris",
          credit_allocation_mode:
            rawWorkspace.credit_allocation_mode === "per_person" ? "per_person" : "workspace_shared",
          credit_allocation_control:
            rawWorkspace.credit_allocation_control === "team_lead_select" ? "team_lead_select" : "owner_locked",
          team_lead_credit_allocation_mode:
            rawWorkspace.team_lead_credit_allocation_mode === "workspace_shared" ||
            rawWorkspace.team_lead_credit_allocation_mode === "per_person"
              ? rawWorkspace.team_lead_credit_allocation_mode
              : null,
          team_lead_daily_briefing_enabled:
            typeof rawWorkspace.team_lead_daily_briefing_enabled === "boolean"
              ? rawWorkspace.team_lead_daily_briefing_enabled
              : null,
          company_id: companyId,
          company_name: companyName,
        });
      } catch (loadError) {
        if (isMounted) {
          setWorkspace(null);
          setCurrentRole(null);
          setError(
            withSessionReloadFallback(
              loadError instanceof Error ? loadError.message : null,
              "Unexpected workspace loading error.",
            ),
          );
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
          hasLoadedOnceRef.current = true;
        }
      }
    };

    void loadWorkspace();

    const supabase = getSupabaseBrowserClient();
    const { data: authListener } = supabase
      ? supabase.auth.onAuthStateChange(() => {
          void loadWorkspace({ background: true });
        })
      : { data: { subscription: null } };

    return () => {
      isMounted = false;

      if (authListener.subscription) {
        authListener.subscription.unsubscribe();
      }
    };
  }, []);

  return { workspace, isLoading, error, currentRole, isSuperAdmin: currentRole === "super_admin" };
}