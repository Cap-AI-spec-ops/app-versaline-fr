"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { dispatchCreditsBalanceRefresh } from "@/lib/credits/client-refresh";
import { MARKET_LANGUAGE_OPTIONS, MARKET_LOCALE_OPTIONS, MARKET_TIMEZONE_OPTIONS } from "@/lib/market/market-presets";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

type WorkspaceRole = "agent" | "team_lead" | "owner" | "super_admin";

type DailyBriefingControl = "owner_locked" | "team_lead_select";

type DailyBriefingPolicyRow = {
  daily_briefing_enabled?: boolean;
  daily_briefing_control?: DailyBriefingControl;
};

type WorkspaceDailyBriefingScopeRow = {
  team_lead_daily_briefing_enabled: boolean | null;
};

type DailyBriefingPreferenceRow = {
  id: string;
  workspace_id: string;
  profile_id: string;
  is_enabled: boolean;
  send_weekdays: number[];
  send_time_local: string;
  timezone: string;
  language: string;
  locale: string;
  include_workspace_snapshot: boolean;
  include_email_delivery: boolean;
};

type DailyBriefingPreferences = {
  isEnabled: boolean;
  sendWeekdays: number[];
  sendTimeLocal: string;
  timezone: string;
  language: string;
  locale: string;
  includeWorkspaceSnapshot: boolean;
  includeEmailDelivery: boolean;
};

type PreviewPayload = {
  creditsUsed?: number;
  newBalance?: number;
  aiBriefing?: {
    headline?: string;
    briefing?: string;
    topActions?: Array<{
      title: string;
      reason: string;
      dueHint: string | null;
    }>;
    workspacePulse?: string;
  };
  sectionCounts?: {
    assignedFollowUpsDueToday?: number;
    assignedHighPriorityContacts?: number;
    todaysTimelineMeetingsAndVisits?: number;
    todaysEmailSummaries?: number;
  };
  localDate?: string;
  timezone?: string;
  language?: string;
};

const WEEKDAY_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, index) => index.toString().padStart(2, "0"));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => index.toString().padStart(2, "0"));

function normalizeWeekdays(value: number[] | null | undefined) {
  const fallback = [1, 2, 3, 4, 5];

  if (!Array.isArray(value) || value.length === 0) {
    return fallback;
  }

  const set = Array.from(new Set(value.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)));

  if (set.length === 0) {
    return fallback;
  }

  return set.sort((left, right) => {
    const order = [1, 2, 3, 4, 5, 6, 0];
    return order.indexOf(left) - order.indexOf(right);
  });
}

export default function DailyBriefingSettingsPanel({ embedded = false }: { embedded?: boolean }) {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { workspace, currentRole, isLoading: isWorkspaceLoading, error: workspaceError } = useCurrentWorkspace();
  const surfaceClassName = embedded
    ? "settings-surface w-full space-y-6"
    : "settings-surface mx-auto w-full max-w-5xl space-y-6";

  const [profileId, setProfileId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<DailyBriefingPreferences>({
    isEnabled: false,
    sendWeekdays: [1, 2, 3, 4, 5],
    sendTimeLocal: "08:30",
    timezone: "Europe/Paris",
    language: "en",
    locale: "en-US",
    includeWorkspaceSnapshot: true,
    includeEmailDelivery: true,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isTestSending, setIsTestSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastSuccessAction, setLastSuccessAction] = useState<"save" | "preview" | "test-send" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [isPolicyLoading, setIsPolicyLoading] = useState(true);
  const [isTeamLeadScopeSaving, setIsTeamLeadScopeSaving] = useState(false);
  const [dailyBriefingPolicy, setDailyBriefingPolicy] = useState<{
    enabled: boolean;
    control: DailyBriefingControl;
  }>({
    enabled: true,
    control: "owner_locked",
  });
  const [teamLeadWorkspaceEnabled, setTeamLeadWorkspaceEnabled] = useState<boolean | null>(
    workspace?.team_lead_daily_briefing_enabled ?? null,
  );

  const role = (currentRole ?? "agent") as WorkspaceRole;
  const canTeamLeadControlWorkspace = role === "team_lead" && dailyBriefingPolicy.control === "team_lead_select";

  const effectiveWorkspaceBriefingEnabled =
    dailyBriefingPolicy.control === "team_lead_select"
      ? teamLeadWorkspaceEnabled ?? dailyBriefingPolicy.enabled
      : dailyBriefingPolicy.enabled;

  const controlsDisabled = !effectiveWorkspaceBriefingEnabled;
  const currentBriefingState = !effectiveWorkspaceBriefingEnabled
    ? "Disabled by workspace policy."
    : prefs.isEnabled
      ? "Automation enabled for your account."
      : "Automation not enabled yet for your account.";
  const briefingNextAction = !effectiveWorkspaceBriefingEnabled
    ? "Ask an admin to enable daily briefing for this workspace."
    : prefs.isEnabled
      ? "Run Preview briefing or Send test email to validate your setup."
      : "Enable daily briefing automation, choose schedule, then save.";

  useEffect(() => {
    if (!workspace?.id || !supabase) {
      return;
    }

    void loadPreferences(workspace.id);
  }, [workspace?.id, supabase]);

  useEffect(() => {
    setTeamLeadWorkspaceEnabled(workspace?.team_lead_daily_briefing_enabled ?? null);
  }, [workspace?.team_lead_daily_briefing_enabled]);

  useEffect(() => {
    const companyId = workspace?.company_id;

    if (!supabase || !workspace?.id || !companyId) {
      setIsPolicyLoading(false);
      setDailyBriefingPolicy({ enabled: true, control: "owner_locked" });
      return;
    }

    void loadCompanyPolicy(companyId, workspace.id);
  }, [supabase, workspace?.company_id, workspace?.id]);

  async function loadCompanyPolicy(companyId: string, workspaceId: string) {
    if (!supabase) {
      setIsPolicyLoading(false);
      return;
    }

    setIsPolicyLoading(true);

    const [policyResult, workspaceScopeResult] = await Promise.all([
      supabase
        .from("email_ingestion_policies")
        .select("daily_briefing_enabled, daily_briefing_control")
        .eq("company_id", companyId)
        .maybeSingle<DailyBriefingPolicyRow>(),
      supabase
        .from("workspaces")
        .select("team_lead_daily_briefing_enabled")
        .eq("id", workspaceId)
        .maybeSingle<WorkspaceDailyBriefingScopeRow>(),
    ]);

    if (!policyResult.error) {
      const nextPolicy: { enabled: boolean; control: DailyBriefingControl } = {
        enabled: policyResult.data?.daily_briefing_enabled ?? true,
        control: policyResult.data?.daily_briefing_control === "team_lead_select" ? "team_lead_select" : "owner_locked",
      };
      setDailyBriefingPolicy(nextPolicy);
    }

    if (!workspaceScopeResult.error) {
      setTeamLeadWorkspaceEnabled(workspaceScopeResult.data?.team_lead_daily_briefing_enabled ?? null);
    }

    setIsPolicyLoading(false);
  }

  async function loadPreferences(workspaceId: string) {
    if (!supabase) {
      setError("Supabase is not configured.");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      setError(withSessionReloadFallback(userError?.message, "You are not signed in."));
      setIsLoading(false);
      return;
    }

    setProfileId(user.id);

    const { data, error: preferenceError } = await supabase
      .from("daily_briefing_preferences")
      .select("id, workspace_id, profile_id, is_enabled, send_weekdays, send_time_local, timezone, language, locale, include_workspace_snapshot, include_email_delivery")
      .eq("workspace_id", workspaceId)
      .eq("profile_id", user.id)
      .maybeSingle<DailyBriefingPreferenceRow>();

    if (preferenceError) {
      setError(withSessionReloadFallback(preferenceError.message, "Could not load daily briefing preferences."));
      setIsLoading(false);
      return;
    }

    setPrefs({
      isEnabled: data?.is_enabled ?? false,
      sendWeekdays: normalizeWeekdays(data?.send_weekdays),
      sendTimeLocal: normalizeTimeForInput(data?.send_time_local) ?? "08:30",
      timezone: data?.timezone?.trim() || workspace?.default_timezone || "Europe/Paris",
      language: data?.language?.trim() || workspace?.default_language || "en",
      locale: data?.locale?.trim() || workspace?.default_locale || "en-US",
      includeWorkspaceSnapshot: data?.include_workspace_snapshot ?? true,
      includeEmailDelivery: data?.include_email_delivery ?? true,
    });

    setIsLoading(false);
  }

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!supabase || !workspace?.id || !profileId) {
      setError("Could not resolve your session.");
      return;
    }

    if (!effectiveWorkspaceBriefingEnabled) {
      setError("Daily briefing is disabled by company policy for this workspace.");
      return;
    }

    setIsSaving(true);
    setMessage(null);
    setLastSuccessAction(null);
    setError(null);

    const payload = {
      workspace_id: workspace.id,
      profile_id: profileId,
      is_enabled: prefs.isEnabled,
      send_weekdays: normalizeWeekdays(prefs.sendWeekdays),
      send_time_local: prefs.sendTimeLocal,
      timezone: prefs.timezone,
      language: prefs.language,
      locale: prefs.locale,
      include_workspace_snapshot: prefs.includeWorkspaceSnapshot,
      include_email_delivery: prefs.includeEmailDelivery,
    };

    const { error: upsertError } = await supabase
      .from("daily_briefing_preferences")
      .upsert(payload, { onConflict: "workspace_id,profile_id" });

    setIsSaving(false);

    if (upsertError) {
      setError(withSessionReloadFallback(upsertError.message, "Could not save daily briefing preferences."));
      return;
    }

    setMessage("Daily email briefing settings saved.");
    setLastSuccessAction("save");
  }

  async function updateTeamLeadWorkspaceScope(nextEnabled: boolean) {
    if (!supabase || !workspace?.id) {
      setError("Could not resolve workspace scope.");
      return;
    }

    if (!canTeamLeadControlWorkspace) {
      setError("Only team leads can change workspace daily briefing scope when delegation is enabled.");
      return;
    }

    setIsTeamLeadScopeSaving(true);
    setMessage(null);
    setError(null);

    const { data, error: rpcError } = await supabase.rpc("set_workspace_daily_briefing_by_team_lead", {
      p_workspace_id: workspace.id,
      p_is_enabled: nextEnabled,
      p_source: "daily_briefing_settings",
    });

    setIsTeamLeadScopeSaving(false);

    if (rpcError) {
      setError(withSessionReloadFallback(rpcError.message, "Could not update workspace daily briefing scope."));
      return;
    }

    const payload = data as { effective_daily_briefing_enabled?: boolean; team_lead_daily_briefing_enabled?: boolean | null } | null;
    const resolvedValue =
      typeof payload?.team_lead_daily_briefing_enabled === "boolean"
        ? payload.team_lead_daily_briefing_enabled
        : typeof payload?.effective_daily_briefing_enabled === "boolean"
          ? payload.effective_daily_briefing_enabled
          : nextEnabled;

    setTeamLeadWorkspaceEnabled(resolvedValue);
    setMessage(resolvedValue ? "Daily briefing enabled for this workspace." : "Daily briefing disabled for this workspace.");
  }

  async function runPreview() {
    setIsPreviewLoading(true);
    setMessage(null);
    setLastSuccessAction(null);
    setError(null);

    try {
      const response = await fetch("/api/daily-briefing/preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "preview" }),
      });

      const payload = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        const message = formatApiErrorMessage(payload, "Could not build preview.");
        setError(message);
        setIsPreviewLoading(false);
        return;
      }

      if (workspace?.id && typeof payload.newBalance === "number") {
        dispatchCreditsBalanceRefresh({
          workspaceId: workspace.id,
          newBalance: payload.newBalance,
          source: "daily-briefing-preview",
        });
      }

      setPreview(payload as unknown as PreviewPayload);
      setMessage("Preview generated.");
      setLastSuccessAction("preview");
    } catch (previewError) {
      setError(withSessionReloadFallback(previewError instanceof Error ? previewError.message : null, "Could not build preview."));
    } finally {
      setIsPreviewLoading(false);
    }
  }

  async function runTestSend() {
    setIsTestSending(true);
    setMessage(null);
    setLastSuccessAction(null);
    setError(null);

    try {
      const response = await fetch("/api/daily-briefing/preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "test-send" }),
      });

      const payload = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        const message = formatApiErrorMessage(payload, "Could not send test email.");
        setError(message);
        setIsTestSending(false);
        return;
      }

      if (workspace?.id && typeof payload.newBalance === "number") {
        dispatchCreditsBalanceRefresh({
          workspaceId: workspace.id,
          newBalance: payload.newBalance,
          source: "daily-briefing-test-send",
        });
      }

      setMessage("Test briefing email sent to your account inbox.");
      setLastSuccessAction("test-send");
    } catch (sendError) {
      setError(withSessionReloadFallback(sendError instanceof Error ? sendError.message : null, "Could not send test email."));
    } finally {
      setIsTestSending(false);
    }
  }

  function toggleWeekday(day: number) {
    setPrefs((previous) => {
      const hasDay = previous.sendWeekdays.includes(day);
      const next = hasDay
        ? previous.sendWeekdays.filter((value) => value !== day)
        : [...previous.sendWeekdays, day];

      return {
        ...previous,
        sendWeekdays: normalizeWeekdays(next),
      };
    });
  }

  const { hour: sendHour, minute: sendMinute } = splitTimeForSelects(prefs.sendTimeLocal);

  if (workspaceError) {
    return <p className="text-sm text-red-600">{workspaceError}</p>;
  }

  if (isWorkspaceLoading || isLoading || isPolicyLoading) {
    return <p className="text-sm text-[var(--muted)]">Loading daily email briefing settings...</p>;
  }

  return (
    <section className={surfaceClassName}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Daily Email Briefing</p>
        {embedded ? (
          <>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Daily email briefing</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              Choose when your daily email briefing is generated and delivered, then test it before turning it on.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">Daily email briefing</h1>
            <p className="mt-4 text-base leading-7 text-[var(--muted)]">
              Choose when your AI daily email briefing is created and delivered, and preview content before automation runs.
            </p>
          </>
        )}
      </div>

      <form onSubmit={savePreferences} className="settings-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
        <div className="rounded-2xl border border-[var(--border)] bg-white px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Communication - Step 2</p>
          <h3 className="mt-2 text-lg font-semibold text-[var(--foreground)]">Configure briefing delivery</h3>
          <div className="mt-2 space-y-2 text-sm">
            <p className="text-[var(--foreground)]"><span className="font-semibold">Current state:</span> {currentBriefingState}</p>
            <p className="text-[var(--foreground)]"><span className="font-semibold">Why it matters:</span> A reliable briefing schedule keeps your team aligned on urgent follow-ups before the day starts.</p>
            <p className="text-[var(--foreground)]"><span className="font-semibold">Next action:</span> {briefingNextAction}</p>
          </div>
        </div>

        <p className="text-sm font-semibold text-[var(--foreground)]">Schedule and delivery</p>
        <p className="mt-1 text-sm text-[var(--muted)]">These preferences are scoped to your user account in the current workspace.</p>

        <div
          className={`mt-4 rounded-2xl border px-4 py-3 ${
            effectiveWorkspaceBriefingEnabled
              ? "border-[var(--border)] bg-white"
              : "briefing-policy-alert"
          }`}
        >
          <p
            className={`text-xs font-semibold uppercase tracking-[0.14em] ${
              effectiveWorkspaceBriefingEnabled ? "text-[var(--muted)]" : "policy-title"
            }`}
          >
            Company policy
          </p>
          <p className={`mt-2 text-sm ${effectiveWorkspaceBriefingEnabled ? "text-[var(--foreground)]" : "policy-body"}`}>
            {effectiveWorkspaceBriefingEnabled
              ? "Daily briefing is allowed in this workspace."
              : "Daily briefing is currently disabled for this workspace by policy."}
          </p>
          <p className={`mt-1 text-xs ${effectiveWorkspaceBriefingEnabled ? "text-[var(--muted)]" : "policy-meta"}`}>
            {effectiveWorkspaceBriefingEnabled
              ? `Control mode: ${dailyBriefingPolicy.control === "team_lead_select" ? "Team lead delegated" : "Admin locked"}`
              : "Ask your admin to enable the feature if you want to use it."}
          </p>

          {canTeamLeadControlWorkspace ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={isTeamLeadScopeSaving || effectiveWorkspaceBriefingEnabled}
                onClick={() => void updateTeamLeadWorkspaceScope(true)}
                className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isTeamLeadScopeSaving ? "Saving..." : "Enable for workspace"}
              </button>
              <button
                type="button"
                disabled={isTeamLeadScopeSaving || !effectiveWorkspaceBriefingEnabled}
                onClick={() => void updateTeamLeadWorkspaceScope(false)}
                className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isTeamLeadScopeSaving ? "Saving..." : "Disable for workspace"}
              </button>
            </div>
          ) : null}
        </div>

        <div className="mt-4 space-y-4">
          <label className="flex items-center gap-3 text-sm text-[var(--foreground)]">
            <input
              type="checkbox"
              checked={prefs.isEnabled}
              onChange={(event) => setPrefs((previous) => ({ ...previous, isEnabled: event.target.checked }))}
              disabled={controlsDisabled}
              className="h-4 w-4"
            />
            Enable daily briefing automation
          </label>

          <label className="flex items-center gap-3 text-sm text-[var(--foreground)]">
            <input
              type="checkbox"
              checked={prefs.includeEmailDelivery}
              onChange={(event) => setPrefs((previous) => ({ ...previous, includeEmailDelivery: event.target.checked }))}
              disabled={controlsDisabled}
              className="h-4 w-4"
            />
            Send by email
          </label>

          <label className="flex items-center gap-3 text-sm text-[var(--foreground)]">
            <input
              type="checkbox"
              checked={prefs.includeWorkspaceSnapshot}
              onChange={(event) => setPrefs((previous) => ({ ...previous, includeWorkspaceSnapshot: event.target.checked }))}
              disabled={controlsDisabled}
              className="h-4 w-4"
            />
            Include compact workspace snapshot
          </label>

          <div>
            <p className="text-sm font-medium text-[var(--foreground)]">Send days</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {WEEKDAY_OPTIONS.map((option) => {
                const active = prefs.sendWeekdays.includes(option.value);

                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => toggleWeekday(option.value)}
                    disabled={controlsDisabled}
                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--foreground)]"
                        : "border-[var(--border)] bg-white text-[var(--muted)] hover:bg-slate-50"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-[var(--foreground)]">
              <span className="mb-1 block font-medium">Send time</span>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                <select
                  aria-label="Send hour"
                  value={sendHour}
                  onChange={(event) =>
                    setPrefs((previous) => ({
                      ...previous,
                      sendTimeLocal: buildTimeFromParts(event.target.value, sendMinute),
                    }))
                  }
                  disabled={controlsDisabled}
                  className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
                >
                  {HOUR_OPTIONS.map((hour) => (
                    <option key={hour} value={hour}>
                      {hour}
                    </option>
                  ))}
                </select>
                <span className="text-sm font-semibold text-[var(--muted)]">:</span>
                <select
                  aria-label="Send minute"
                  value={sendMinute}
                  onChange={(event) =>
                    setPrefs((previous) => ({
                      ...previous,
                      sendTimeLocal: buildTimeFromParts(sendHour, event.target.value),
                    }))
                  }
                  disabled={controlsDisabled}
                  className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
                >
                  {MINUTE_OPTIONS.map((minute) => (
                    <option key={minute} value={minute}>
                      {minute}
                    </option>
                  ))}
                </select>
              </div>
              <p className="mt-1 text-xs text-[var(--muted)] settings-helper">Select when your briefing should be generated in your local timezone.</p>
            </label>

            <label className="text-sm text-[var(--foreground)]">
              <span className="mb-1 block font-medium">Timezone</span>
              <select
                value={prefs.timezone}
                onChange={(event) => setPrefs((previous) => ({ ...previous, timezone: event.target.value }))}
                disabled={controlsDisabled}
                className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              >
                {MARKET_TIMEZONE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-[var(--muted)] settings-helper">Used to interpret the send time above for this workspace context.</p>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-[var(--foreground)]">
              <span className="mb-1 block font-medium">Language</span>
              <select
                value={prefs.language}
                onChange={(event) => setPrefs((previous) => ({ ...previous, language: event.target.value }))}
                disabled={controlsDisabled}
                className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              >
                {MARKET_LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-[var(--muted)] settings-helper">Controls the language used in generated briefing content.</p>
            </label>
          </div>

          {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
          {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}

          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <button
                type="submit"
                disabled={isSaving || controlsDisabled}
                className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isSaving ? "Saving..." : "Save changes"}
              </button>
              {lastSuccessAction === "save" ? <p className="text-xs font-medium text-emerald-700">Saved successfully.</p> : null}
            </div>
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => void runPreview()}
                disabled={isPreviewLoading || controlsDisabled}
                className="rounded-2xl bg-[linear-gradient(135deg,#16a34a_0%,#15803d_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(22,163,74,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isPreviewLoading ? "Running test..." : "Test"}
              </button>
              {lastSuccessAction === "preview" ? <p className="text-xs font-medium text-emerald-700">Preview is ready.</p> : null}
            </div>
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => void runTestSend()}
                disabled={isTestSending || controlsDisabled}
                className="rounded-2xl bg-[linear-gradient(135deg,#16a34a_0%,#15803d_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(22,163,74,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isTestSending ? "Sending test..." : "Test email"}
              </button>
              {lastSuccessAction === "test-send" ? <p className="text-xs font-medium text-emerald-700">Test email sent.</p> : null}
            </div>
          </div>
        </div>
      </form>

      {preview ? (
        <div className="settings-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Latest preview</p>
          <p className="mt-2 text-sm font-semibold text-[var(--foreground)]">{preview.aiBriefing?.headline ?? "No headline"}</p>
          <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[var(--muted)]">{preview.aiBriefing?.briefing ?? "No briefing text"}</p>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Local day {preview.localDate ?? "n/a"} - {preview.timezone ?? "n/a"} - language {preview.language ?? "n/a"}
          </p>
        </div>
      ) : null}
    </section>
  );
}

function normalizeTimeForInput(value: string | null | undefined) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const match = value.match(/^(\d{2}:\d{2})/);
  return match ? match[1] : null;
}

function splitTimeForSelects(value: string) {
  const normalized = normalizeTimeForInput(value) ?? "08:30";
  const [hour = "08", minute = "30"] = normalized.split(":");

  return {
    hour: HOUR_OPTIONS.includes(hour) ? hour : "08",
    minute: MINUTE_OPTIONS.includes(minute) ? minute : "30",
  };
}

function buildTimeFromParts(hour: string, minute: string) {
  const safeHour = HOUR_OPTIONS.includes(hour) ? hour : "08";
  const safeMinute = MINUTE_OPTIONS.includes(minute) ? minute : "30";

  return `${safeHour}:${safeMinute}`;
}

function formatApiErrorMessage(payload: Record<string, unknown>, fallback: string) {
  const error = typeof payload.error === "string" ? payload.error : fallback;
  const details = typeof payload.details === "string" ? payload.details : null;

  if (!details) {
    return error;
  }

  return `${error}: ${details}`;
}
