"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  MARKET_LANGUAGE_OPTIONS,
  MARKET_LOCALE_OPTIONS,
  MARKET_PRESETS,
  MARKET_TIMEZONE_OPTIONS,
  getMarketPresetByCountry,
} from "@/lib/market/market-presets";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";
import { useWorkspaceMembers } from "@/lib/workspace/use-workspace-members";

type WorkspaceRole = "agent" | "team_lead" | "owner" | "super_admin";
type CreditAllocationMode = "workspace_shared" | "per_person";
type CreditAllocationControl = "owner_locked" | "team_lead_select";

type WorkspacePreferences = {
  workspace_name: string;
  currency: string;
  metric_system: string;
  default_country_code: string;
  default_locale: string;
  default_language: string;
  default_timezone: string;
};

type WorkspaceManagementCardProps = {
  initialWorkspaceId?: string;
  initialWorkspaceName?: string;
  initialCurrency?: string;
  initialMetricSystem?: string;
  initialDefaultCountryCode?: string;
  initialDefaultLocale?: string;
  initialDefaultLanguage?: string;
  initialDefaultTimezone?: string;
};

function formatRoleLabel(role: WorkspaceRole) {
  return role.replace("_", " ");
}

function formatMemberName(firstName: string | null, lastName: string | null) {
  const fullName = [firstName ?? "", lastName ?? ""].join(" ").trim();
  return fullName || "Unnamed member";
}

export default function WorkspaceManagementCard({
  initialWorkspaceId,
  initialWorkspaceName,
  initialCurrency,
  initialMetricSystem,
  initialDefaultCountryCode,
  initialDefaultLocale,
  initialDefaultLanguage,
  initialDefaultTimezone,
}: WorkspaceManagementCardProps) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { workspace } = useCurrentWorkspace();
  const { members: workspaceMembers, isLoading: isMembersLoading, error: membersError } = useWorkspaceMembers();
  const marketPreset = getMarketPresetByCountry(
    workspace?.default_country_code ?? initialDefaultCountryCode,
  );

  const [workspacePrefs, setWorkspacePrefs] = useState<WorkspacePreferences>({
    workspace_name: initialWorkspaceName?.trim() || workspace?.name?.trim() || "",
    currency: initialCurrency || workspace?.currency || "EUR",
    metric_system: initialMetricSystem || workspace?.metric_system || "metric",
    default_country_code:
      workspace?.default_country_code || initialDefaultCountryCode || marketPreset.countryCode,
    default_locale: workspace?.default_locale || initialDefaultLocale || marketPreset.defaultLocale,
    default_language:
      workspace?.default_language || initialDefaultLanguage || marketPreset.defaultLanguage,
    default_timezone:
      workspace?.default_timezone || initialDefaultTimezone || marketPreset.defaultTimezone,
  });
  const [currentRole, setCurrentRole] = useState<WorkspaceRole>("agent");
  const [isWorkspaceCardOpen, setIsWorkspaceCardOpen] = useState(false);
  const [inviterName, setInviterName] = useState("A teammate");
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [creditPolicyMessage, setCreditPolicyMessage] = useState<string | null>(null);
  const [isSavingCreditPolicy, setIsSavingCreditPolicy] = useState(false);
  const [creditAllocationMode, setCreditAllocationMode] = useState<CreditAllocationMode>(
    workspace?.credit_allocation_mode ?? "workspace_shared",
  );
  const [creditAllocationControl, setCreditAllocationControl] = useState<CreditAllocationControl>(
    workspace?.credit_allocation_control ?? "owner_locked",
  );
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("agent");
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isInviting, setIsInviting] = useState(false);

  const resolvedWorkspaceId = workspace?.id || initialWorkspaceId || null;
  const resolvedWorkspaceName = workspace?.name?.trim() || initialWorkspaceName?.trim() || "";
  const resolvedCurrency = workspace?.currency || initialCurrency || "EUR";
  const resolvedMetricSystem = workspace?.metric_system || initialMetricSystem || "metric";
  const resolvedDefaultCountryCode =
    workspace?.default_country_code || initialDefaultCountryCode || marketPreset.countryCode;
  const resolvedDefaultLocale =
    workspace?.default_locale || initialDefaultLocale || marketPreset.defaultLocale;
  const resolvedDefaultLanguage =
    workspace?.default_language || initialDefaultLanguage || marketPreset.defaultLanguage;
  const resolvedDefaultTimezone =
    workspace?.default_timezone || initialDefaultTimezone || marketPreset.defaultTimezone;
  const workspaceSyncKey = `${resolvedWorkspaceId ?? ""}|${resolvedWorkspaceName}|${resolvedCurrency}|${resolvedMetricSystem}|${resolvedDefaultCountryCode}|${resolvedDefaultLocale}|${resolvedDefaultLanguage}|${resolvedDefaultTimezone}`;

  useEffect(() => {
    setCreditAllocationMode(workspace?.credit_allocation_mode ?? "workspace_shared");
    setCreditAllocationControl(workspace?.credit_allocation_control ?? "owner_locked");
  }, [workspace?.credit_allocation_mode, workspace?.credit_allocation_control]);

  useEffect(() => {
    if (!resolvedWorkspaceName) {
      return;
    }

    setWorkspacePrefs((previous) => ({
      workspace_name: resolvedWorkspaceName || previous.workspace_name,
      currency: resolvedCurrency || previous.currency,
      metric_system: resolvedMetricSystem || previous.metric_system,
      default_country_code: resolvedDefaultCountryCode || previous.default_country_code,
      default_locale: resolvedDefaultLocale || previous.default_locale,
      default_language: resolvedDefaultLanguage || previous.default_language,
      default_timezone: resolvedDefaultTimezone || previous.default_timezone,
    }));
  }, [workspaceSyncKey]);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    const loadProfile = async () => {
      const { data: profileData, error: profileError } = await supabase.rpc("get_current_profile");

      if (profileError || !profileData) {
        return;
      }

      const profile = profileData as { role?: WorkspaceRole; first_name?: string | null; last_name?: string | null };
      const fullName = `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim();
      setInviterName(fullName || "A teammate");

      if (!profile.role) {
        return;
      }

      setCurrentRole(profile.role);

      if (profile.role === "owner" && inviteRole === "super_admin") {
        setInviteRole("agent");
      }
    };

    void loadProfile();
  }, [inviteRole, supabase]);

  const canManageWorkspace = currentRole === "super_admin" || currentRole === "owner";
  const canInviteMembers = canManageWorkspace;

  const handleWorkspaceSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setWorkspaceMessage("Supabase is not configured.");
      return;
    }

    if (!canManageWorkspace) {
      setWorkspaceMessage("Only super admins and owners can change workspace settings.");
      return;
    }

    if (!resolvedWorkspaceId) {
      setWorkspaceMessage("Workspace not found.");
      return;
    }

    setIsSaving(true);
    setWorkspaceMessage(null);

    const { error: updateError } = await supabase.rpc("update_workspace_settings", {
      p_workspace_id: resolvedWorkspaceId,
      p_name: workspacePrefs.workspace_name,
      p_currency: workspacePrefs.currency,
      p_metric_system: workspacePrefs.metric_system,
      p_default_country_code: workspacePrefs.default_country_code,
      p_default_locale: workspacePrefs.default_locale,
      p_default_language: workspacePrefs.default_language,
      p_default_timezone: workspacePrefs.default_timezone,
    });

    setIsSaving(false);

    if (updateError) {
      setWorkspaceMessage(updateError.message);
      return;
    }

    setWorkspaceMessage("Workspace settings saved.");
  };

  const handleInviteSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setInviteMessage("Supabase is not configured.");
      return;
    }

    if (!canInviteMembers) {
      setInviteMessage("Only super admins and owners can invite teammates from admin.");
      return;
    }

    if (!resolvedWorkspaceId) {
      setInviteMessage("You need an assigned workspace before you can invite teammates.");
      return;
    }

    if (currentRole === "owner" && inviteRole === "super_admin") {
      setInviteMessage("Only super admins can invite super admins.");
      return;
    }

    const trimmedEmail = inviteEmail.trim();

    if (!trimmedEmail) {
      setInviteMessage("Please enter an email address.");
      return;
    }

    setIsInviting(true);
    setInviteMessage(null);
    setInviteLink(null);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user?.id) {
      setIsInviting(false);
      setInviteMessage(userError?.message ?? "Unable to resolve your current session.");
      return;
    }

    const { data: inviteData, error: inviteError } = await supabase.rpc("create_workspace_invite", {
      p_workspace_id: resolvedWorkspaceId,
      p_email: trimmedEmail,
      p_role: inviteRole,
      p_invited_by: user.id,
    });

    setIsInviting(false);

    if (inviteError) {
      setInviteMessage(inviteError.message);
      return;
    }

    const inviteRecord = inviteData as { token?: string } | null;

    if (!inviteRecord?.token) {
      setInviteMessage("Invitation created, but the token was not returned.");
      return;
    }

    const generatedLink = `${window.location.origin}/invite/${inviteRecord.token}`;
    const workspaceName = workspacePrefs.workspace_name.trim() || "your workspace";

    const sendResponse = await fetch("/api/invitations/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: trimmedEmail,
        role: inviteRole,
        inviteToken: inviteRecord.token,
        workspaceName,
        inviterName,
      }),
    });

    if (!sendResponse.ok) {
      const sendError = (await sendResponse.json()) as { error?: string };
      setInviteLink(generatedLink);
      setInviteMessage(
        `Invitation created, but email sending failed${sendError.error ? `: ${sendError.error}` : "."}`,
      );
      return;
    }

    setInviteEmail("");
    setInviteLink(generatedLink);
    setInviteMessage(`Invitation sent to ${trimmedEmail}.`);
  };

  const handleCreditPolicySave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setCreditPolicyMessage("Supabase is not configured.");
      return;
    }

    if (!canManageWorkspace) {
      setCreditPolicyMessage("Only super admins and owners can change credit policy.");
      return;
    }

    if (!resolvedWorkspaceId) {
      setCreditPolicyMessage("Workspace not found.");
      return;
    }

    setIsSavingCreditPolicy(true);
    setCreditPolicyMessage(null);

    const { error: policyError } = await supabase.rpc("update_workspace_credit_policy", {
      p_workspace_id: resolvedWorkspaceId,
      p_credit_allocation_mode: creditAllocationMode,
      p_credit_allocation_control: creditAllocationControl,
      p_source: "admin_page",
    });

    setIsSavingCreditPolicy(false);

    if (policyError) {
      setCreditPolicyMessage(policyError.message);
      return;
    }

    setCreditPolicyMessage("Credit policy saved.");
  };

  return (
    <div className="settings-card admin-card admin-current-workspace-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--foreground)]">Current workspace</p>
          <p className="mt-1 text-sm text-[var(--muted)]">Manage workspace defaults and invite teammates from the admin area.</p>
        </div>
        <button
          type="button"
          onClick={() => setIsWorkspaceCardOpen((open) => !open)}
          className="admin-disclosure-hint"
          aria-expanded={isWorkspaceCardOpen}
        >
          {isWorkspaceCardOpen ? "Hide" : "Open"}
        </button>
      </div>

      {!isWorkspaceCardOpen ? (
        <p className="mt-3 text-sm text-[var(--muted)]">This section is collapsed. Open it to edit workspace defaults, credit policy, or invitations.</p>
      ) : null}

      {isWorkspaceCardOpen ? (
        <>

      <div className="mt-4 rounded-2xl border border-[var(--border)] bg-white/70 p-4">
        <p className="text-sm font-semibold text-[var(--foreground)]">Team members</p>
        <p className="mt-1 text-sm text-[var(--muted)]">People currently in this workspace.</p>
        <div className="mt-3 space-y-2">
          {isMembersLoading ? (
            <p className="text-sm text-[var(--muted)]">Loading members...</p>
          ) : workspaceMembers.length > 0 ? (
            workspaceMembers.map((member) => (
              <div key={member.profile_id} className="flex flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="truncate text-sm font-medium text-[var(--foreground)]">{formatMemberName(member.first_name, member.last_name)}</p>
                <p className="text-xs capitalize tracking-[0.12em] text-[var(--muted)]">{formatRoleLabel(member.role)}</p>
              </div>
            ))
          ) : (
            <p className="text-sm text-[var(--muted)]">No members found.</p>
          )}
          {membersError ? <p className="text-sm font-medium text-red-500">{membersError}</p> : null}
        </div>
      </div>

      <form onSubmit={handleWorkspaceSave} className="mt-4 space-y-3">
        <div>
          <label htmlFor="admin-workspace-name" className="mb-2 block text-xs font-medium text-[var(--muted)]">Workspace name</label>
          <input id="admin-workspace-name" type="text" value={workspacePrefs.workspace_name || resolvedWorkspaceName} onChange={(event) => setWorkspacePrefs((previous) => ({ ...previous, workspace_name: event.target.value }))} placeholder="Workspace name" className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" />
        </div>
        <div>
          <label htmlFor="admin-currency" className="mb-2 block text-xs font-medium text-[var(--muted)]">Currency</label>
          <select id="admin-currency" value={workspacePrefs.currency} onChange={(event) => setWorkspacePrefs((previous) => ({ ...previous, currency: event.target.value }))} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]">
            <option value="USD">USD - US Dollar</option>
            <option value="EUR">EUR - Euro</option>
            <option value="GBP">GBP - British Pound</option>
            <option value="JPY">JPY - Japanese Yen</option>
            <option value="CAD">CAD - Canadian Dollar</option>
            <option value="AUD">AUD - Australian Dollar</option>
            <option value="CHF">CHF - Swiss Franc</option>
            <option value="CNY">CNY - Chinese Yuan</option>
            <option value="INR">INR - Indian Rupee</option>
            <option value="BRL">BRL - Brazilian Real</option>
          </select>
        </div>
        <div>
          <label htmlFor="admin-metric-system" className="mb-2 block text-xs font-medium text-[var(--muted)]">Metric system</label>
          <select id="admin-metric-system" value={workspacePrefs.metric_system} onChange={(event) => setWorkspacePrefs((previous) => ({ ...previous, metric_system: event.target.value }))} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]">
            <option value="metric">Metric (m², m, kg)</option>
            <option value="imperial">Imperial (ft², ft, lbs)</option>
          </select>
        </div>
        <div>
          <label htmlFor="admin-default-country" className="mb-2 block text-xs font-medium text-[var(--muted)]">Default market country</label>
          <select
            id="admin-default-country"
            value={workspacePrefs.default_country_code}
            onChange={(event) => {
              const selectedPreset = getMarketPresetByCountry(event.target.value);

              setWorkspacePrefs((previous) => ({
                ...previous,
                default_country_code: selectedPreset.countryCode,
                default_locale: selectedPreset.defaultLocale,
                default_language: selectedPreset.defaultLanguage,
                default_timezone: selectedPreset.defaultTimezone,
              }));
            }}
            className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
          >
            {MARKET_PRESETS.map((preset) => (
              <option key={preset.countryCode} value={preset.countryCode}>{`${preset.countryCode} - ${preset.countryName}`}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="admin-default-locale" className="mb-2 block text-xs font-medium text-[var(--muted)]">Default locale</label>
          <select
            id="admin-default-locale"
            value={workspacePrefs.default_locale}
            onChange={(event) =>
              setWorkspacePrefs((previous) => ({ ...previous, default_locale: event.target.value }))
            }
            className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
          >
            {MARKET_LOCALE_OPTIONS.map((option) => (
              <option key={option.code} value={option.code}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="admin-default-language" className="mb-2 block text-xs font-medium text-[var(--muted)]">Default language</label>
            <select
              id="admin-default-language"
              value={workspacePrefs.default_language}
              onChange={(event) =>
                setWorkspacePrefs((previous) => ({ ...previous, default_language: event.target.value }))
              }
              className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            >
              {MARKET_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="admin-default-timezone" className="mb-2 block text-xs font-medium text-[var(--muted)]">Default timezone</label>
            <select
              id="admin-default-timezone"
              value={workspacePrefs.default_timezone}
              onChange={(event) =>
                setWorkspacePrefs((previous) => ({ ...previous, default_timezone: event.target.value }))
              }
              className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            >
              {MARKET_TIMEZONE_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
          </div>
        </div>
        {workspaceMessage ? <p className={`text-sm font-medium ${workspaceMessage === "Workspace settings saved." ? "text-emerald-700" : "text-red-500"}`}>{workspaceMessage}</p> : null}
        <button type="submit" disabled={isSaving || !canManageWorkspace} className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70">Save workspace</button>
      </form>

      <form onSubmit={handleCreditPolicySave} className="mt-4 space-y-3 border-t border-[var(--border)] pt-5">
        <p className="text-sm font-semibold text-[var(--foreground)]">Credits policy</p>
        <p className="mt-1 text-sm text-[var(--muted)]">Pick how credits are allocated, and whether team leads can override the mode for this workspace.</p>
        <select
          value={creditAllocationMode}
          onChange={(event) => setCreditAllocationMode(event.target.value as CreditAllocationMode)}
          className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
          disabled={!canManageWorkspace || isSavingCreditPolicy}
        >
          <option value="workspace_shared">Credits mode: Shared across workspace</option>
          <option value="per_person">Credits mode: Per person</option>
        </select>
        <select
          value={creditAllocationControl}
          onChange={(event) => setCreditAllocationControl(event.target.value as CreditAllocationControl)}
          className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
          disabled={!canManageWorkspace || isSavingCreditPolicy}
        >
          <option value="owner_locked">Mode control: Owner locked</option>
          <option value="team_lead_select">Mode control: Team lead can choose for this workspace</option>
        </select>
        {creditPolicyMessage ? (
          <p className={`text-sm font-medium ${creditPolicyMessage === "Credit policy saved." ? "text-emerald-700" : "text-red-500"}`}>
            {creditPolicyMessage}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={isSavingCreditPolicy || !canManageWorkspace}
          className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isSavingCreditPolicy ? "Saving credit policy..." : "Save credit policy"}
        </button>
      </form>

      <div className="mt-6 border-t border-[var(--border)] pt-5">
        <p className="text-sm font-semibold text-[var(--foreground)]">Invite teammates</p>
        <p className="mt-1 text-sm text-[var(--muted)]">Send a workspace invitation by email from the admin page.</p>
        <form onSubmit={handleInviteSubmit} className="mt-4 space-y-3">
          <input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} disabled={!canInviteMembers} placeholder="coworker@example.com" className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50" />
          <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as WorkspaceRole)} disabled={!canInviteMembers} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50">
            <option value="agent">Role: Agent</option>
            <option value="team_lead">Role: Team lead</option>
            <option value="owner">Role: Owner</option>
            {currentRole === "super_admin" ? <option value="super_admin">Role: Super admin</option> : null}
          </select>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
            {currentRole === "super_admin" ? "You can invite agents, team leads, owners, or super admins." : "You can invite agents, team leads, or owners."}
          </p>
          {inviteMessage ? <p className={`text-sm font-medium ${inviteMessage.startsWith("Invitation sent") ? "text-emerald-700" : "text-red-500"}`}>{inviteMessage}</p> : null}
          {inviteLink ? <div className="rounded-2xl border border-[var(--border)] bg-white/80 p-4"><p className="text-sm font-semibold text-[var(--foreground)]">Share this invite link</p><a href={inviteLink} className="mt-2 block break-all text-sm text-[var(--accent)] underline">{inviteLink}</a></div> : null}
          <button type="submit" disabled={isInviting || isSaving || !canInviteMembers} className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70">{isInviting ? "Sending invite..." : "Send invite"}</button>
        </form>
      </div>
        </>
      ) : null}
    </div>
  );
}