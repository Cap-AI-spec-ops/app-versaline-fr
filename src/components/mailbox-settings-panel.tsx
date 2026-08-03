"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { dispatchCreditsBalanceRefresh } from "@/lib/credits/client-refresh";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

type MailProvider = "gmail" | "outlook";

type MailboxConnectionRow = {
  id: string;
  workspace_id: string;
  profile_id: string;
  provider: MailProvider;
  status: "connected" | "disconnected" | "pending" | "error";
  include_sent_mail: boolean;
  summary_language: string;
  last_synced_at: string | null;
  last_error: string | null;
  oauth_token_updated_at: string | null;
};

type Preferences = {
  includeSentMail: boolean;
  summaryLanguage: string;
};

const MAILBOX_OAUTH_PROVIDER_STORAGE_KEY = "versa_mailbox_oauth_provider";
const MAILBOX_RECONNECT_INTERVAL_DAYS = 90;

const PROVIDERS: Array<{ id: MailProvider; label: string; oauthProvider: string }> = [
  { id: "gmail", label: "Gmail", oauthProvider: "google" },
  { id: "outlook", label: "Outlook", oauthProvider: "azure" },
];

function getOtherProvider(provider: MailProvider): MailProvider {
  return provider === "gmail" ? "outlook" : "gmail";
}

function formatStatus(status: MailboxConnectionRow["status"]) {
  if (status === "connected") {
    return "Connected";
  }

  if (status === "pending") {
    return "Pending";
  }

  if (status === "error") {
    return "Error";
  }

  return "Disconnected";
}

function formatDate(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function addDays(value: string, days: number) {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  const next = new Date(parsed);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

function isReconnectRequired(oauthTokenUpdatedAt: string | null | undefined) {
  if (!oauthTokenUpdatedAt) {
    return true;
  }

  const updatedAtMs = new Date(oauthTokenUpdatedAt).getTime();

  if (Number.isNaN(updatedAtMs)) {
    return true;
  }

  const maxAgeMs = MAILBOX_RECONNECT_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() - updatedAtMs >= maxAgeMs;
}

function getOAuthReturnProvider(rowsByProvider: Record<MailProvider, MailboxConnectionRow | null>) {
  if (typeof window === "undefined") {
    return null;
  }

  let storedProvider: MailProvider | null = null;

  try {
    const storedValue = window.sessionStorage.getItem(MAILBOX_OAUTH_PROVIDER_STORAGE_KEY);
    if (storedValue === "gmail" || storedValue === "outlook") {
      storedProvider = storedValue;
    }
  } catch {
    storedProvider = null;
  }

  if (storedProvider && rowsByProvider[storedProvider]?.status === "pending") {
    return storedProvider;
  }

  const url = new URL(window.location.href);
  if (!url.searchParams.has("code")) {
    return null;
  }

  const pendingProviders = (Object.keys(rowsByProvider) as MailProvider[]).filter(
    (provider) => rowsByProvider[provider]?.status === "pending",
  );

  if (pendingProviders.length === 1) {
    return pendingProviders[0];
  }

  return null;
}

function clearOAuthReturnMarkers() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(MAILBOX_OAUTH_PROVIDER_STORAGE_KEY);
  } catch {
    // Best effort cleanup only.
  }

  const url = new URL(window.location.href);
  let didChange = false;

  for (const key of ["code", "state", "error", "error_code", "error_description"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      didChange = true;
    }
  }

  if (didChange) {
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
}

export default function MailboxSettingsPanel() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { workspace, currentRole, isLoading: isWorkspaceLoading, error: workspaceError } = useCurrentWorkspace();

  const [profileId, setProfileId] = useState<string | null>(null);
  const [rowsByProvider, setRowsByProvider] = useState<Record<MailProvider, MailboxConnectionRow | null>>({
    gmail: null,
    outlook: null,
  });
  const [selectedProvider, setSelectedProvider] = useState<MailProvider>("gmail");
  const [prefs, setPrefs] = useState<Preferences>({
    includeSentMail: false,
    summaryLanguage: "en",
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isEmailFeatureEnabled, setIsEmailFeatureEnabled] = useState(false);
  const [isPolicyLoading, setIsPolicyLoading] = useState(true);
  const [includeSentMailByPolicy, setIncludeSentMailByPolicy] = useState(false);

  useEffect(() => {
    async function loadEmailPolicy(companyId: string) {
      if (!supabase) {
        setIsEmailFeatureEnabled(false);
        setIsPolicyLoading(false);
        return;
      }

      setIsPolicyLoading(true);

      const { data, error: policyError } = await supabase
        .from("email_ingestion_policies")
        .select("feature_enabled, include_sent_mail_in_summaries")
        .eq("company_id", companyId)
        .maybeSingle();

      if (policyError) {
        setIsEmailFeatureEnabled(false);
        setIncludeSentMailByPolicy(false);
        setIsPolicyLoading(false);
        return;
      }

      const policyData = data as {
        feature_enabled?: boolean;
        include_sent_mail_in_summaries?: boolean;
      } | null;

      setIsEmailFeatureEnabled(Boolean(policyData?.feature_enabled));
      setIncludeSentMailByPolicy(Boolean(policyData?.include_sent_mail_in_summaries));
      setIsPolicyLoading(false);
    }

    const companyId = workspace?.company_id ?? null;

    if (!companyId) {
      setIsEmailFeatureEnabled(false);
      setIncludeSentMailByPolicy(false);
      setIsPolicyLoading(false);
      return;
    }

    void loadEmailPolicy(companyId);
  }, [supabase, workspace?.company_id]);

  useEffect(() => {
    if (!workspace?.id || !supabase || !isEmailFeatureEnabled) {
      return;
    }

    void loadMailboxSettings(workspace.id);
  }, [workspace?.id, supabase, isEmailFeatureEnabled]);

  async function loadMailboxSettings(workspaceId: string) {
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

    const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
    const emailPrefs = (metadata.email_summary_preferences ?? {}) as Record<string, unknown>;
    const metadataIncludeSentMail =
      typeof emailPrefs.include_sent_mail === "boolean" ? emailPrefs.include_sent_mail : null;
    const metadataSummaryLanguage =
      typeof emailPrefs.summary_language === "string" && emailPrefs.summary_language.trim()
        ? emailPrefs.summary_language.trim().toLowerCase()
        : null;

    const { data, error: rowsError } = await supabase
      .from("mailbox_connections")
      .select("id, workspace_id, profile_id, provider, status, include_sent_mail, summary_language, last_synced_at, last_error, oauth_token_updated_at")
      .eq("workspace_id", workspaceId)
      .eq("profile_id", user.id);

    if (rowsError) {
      setError(withSessionReloadFallback(rowsError.message, "Could not load mailbox connections."));
      setIsLoading(false);
      return;
    }

    const nextRows: Record<MailProvider, MailboxConnectionRow | null> = {
      gmail: null,
      outlook: null,
    };

    for (const row of (data ?? []) as MailboxConnectionRow[]) {
      if (row.provider === "gmail" || row.provider === "outlook") {
        nextRows[row.provider] = row;
      }
    }

    let resolvedRows = nextRows;
    const oauthReturnProvider = getOAuthReturnProvider(nextRows);

    if (oauthReturnProvider) {
      const { data: sessionData } = await supabase.auth.getSession();
      const providerToken = sessionData.session?.provider_token ?? null;
      const providerRefreshToken = sessionData.session?.provider_refresh_token ?? null;

      const { error: finalizeError } = await supabase
        .from("mailbox_connections")
        .update({
          status: "connected",
          last_error: null,
          oauth_access_token: providerToken,
          oauth_refresh_token: providerRefreshToken,
          oauth_token_updated_at: providerToken || providerRefreshToken ? new Date().toISOString() : null,
        })
        .eq("workspace_id", workspaceId)
        .eq("profile_id", user.id)
        .eq("provider", oauthReturnProvider)
        .eq("status", "pending");

      if (!finalizeError && nextRows[oauthReturnProvider]) {
        resolvedRows = {
          ...nextRows,
          [oauthReturnProvider]: {
            ...nextRows[oauthReturnProvider],
            status: "connected",
            last_error: null,
          },
        };

        clearOAuthReturnMarkers();
      }
    }

    setRowsByProvider(resolvedRows);

    const firstConnectionRow = (Object.values(resolvedRows).find((row) => row !== null) as MailboxConnectionRow | null) ?? null;
    const rowIncludeSentMail = firstConnectionRow?.include_sent_mail ?? null;
    const rowSummaryLanguage = firstConnectionRow?.summary_language?.trim().toLowerCase() ?? null;

    setPrefs({
      includeSentMail: metadataIncludeSentMail ?? rowIncludeSentMail ?? includeSentMailByPolicy,
      summaryLanguage: metadataSummaryLanguage ?? rowSummaryLanguage ?? "en",
    });

    setIsLoading(false);
  }

  async function syncNow(provider: MailProvider) {
    if (!supabase || !workspace?.id) {
      setError("Could not resolve current workspace.");
      return;
    }

    setIsSyncing(true);
    setError(null);
    setMessage(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const providerToken = sessionData.session?.provider_token ?? null;
      const providerRefreshToken = sessionData.session?.provider_refresh_token ?? null;

      const response = await fetch("/api/mailbox/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          provider,
          providerToken,
          providerRefreshToken,
        }),
      });

      const result = (await response.json()) as {
        processedMessages?: number;
        savedSummaries?: number;
        newBalance?: number;
        failedConnections?: Array<{ connectionId?: string; reason?: string }>;
        error?: string;
      };

      if (!response.ok) {
        setError(result.error || "Mailbox sync failed.");
        setIsSyncing(false);
        return;
      }

      if (Array.isArray(result.failedConnections) && result.failedConnections.length > 0) {
        const firstFailure = result.failedConnections[0];
        const reason = firstFailure?.reason?.trim() || "Unknown mailbox sync error.";
        await loadMailboxSettings(workspace.id);
        setError(`Sync reached mailbox API but failed to process messages: ${reason}`);
        setIsSyncing(false);
        return;
      }

      await loadMailboxSettings(workspace.id);

      if (typeof result.newBalance === "number") {
        dispatchCreditsBalanceRefresh({
          workspaceId: workspace.id,
          newBalance: result.newBalance,
          source: "mailbox-sync-now",
        });
      }

      const processed = result.processedMessages ?? 0;
      const saved = result.savedSummaries ?? 0;
      setMessage(`Sync complete: ${processed} email(s) processed, ${saved} summary(ies) saved.`);
      setIsSyncing(false);
    } catch {
      setError("Mailbox sync failed.");
      setIsSyncing(false);
    }
  }

  async function savePreferences(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!supabase || !workspace?.id || !profileId) {
      setError("Could not resolve your session.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const { error: metadataError } = await supabase.auth.updateUser({
      data: {
        email_summary_preferences: {
          include_sent_mail: includeSentMailByPolicy && prefs.includeSentMail,
          summary_language: prefs.summaryLanguage,
        },
      },
    });

    if (metadataError) {
      setIsSaving(false);
      setError(withSessionReloadFallback(metadataError.message, "Could not save mailbox preferences."));
      return;
    }

    const updates = (Object.keys(rowsByProvider) as MailProvider[])
      .filter((provider) => rowsByProvider[provider] !== null)
      .map((provider) => ({
        workspace_id: workspace.id,
        profile_id: profileId,
        provider,
        include_sent_mail: includeSentMailByPolicy && prefs.includeSentMail,
        summary_language: prefs.summaryLanguage,
      }));

    if (updates.length > 0) {
      const { error: upsertError } = await supabase
        .from("mailbox_connections")
        .upsert(updates, { onConflict: "workspace_id,profile_id,provider" });

      if (upsertError) {
        setIsSaving(false);
        setError(withSessionReloadFallback(upsertError.message, "Could not save mailbox preferences."));
        return;
      }
    }

    setIsSaving(false);
    setMessage("Preferences saved.");
  }

  async function markConnected(provider: MailProvider) {
    if (!supabase || !workspace?.id || !profileId) {
      setError("Could not resolve your session.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const { error: upsertError } = await supabase
      .from("mailbox_connections")
      .upsert(
        {
          workspace_id: workspace.id,
          profile_id: profileId,
          provider,
          status: "pending",
          include_sent_mail: includeSentMailByPolicy && prefs.includeSentMail,
          summary_language: prefs.summaryLanguage,
          last_error: null,
        },
        { onConflict: "workspace_id,profile_id,provider" },
      );

    if (upsertError) {
      setIsSaving(false);
      setError(withSessionReloadFallback(upsertError.message, "Could not start mailbox connection."));
      return;
    }

    const otherProvider = getOtherProvider(provider);
    const { error: disconnectOtherError } = await supabase
      .from("mailbox_connections")
      .update({
        status: "disconnected",
        last_error: null,
        last_synced_at: null,
      })
      .eq("workspace_id", workspace.id)
      .eq("profile_id", profileId)
      .eq("provider", otherProvider);

    if (disconnectOtherError) {
      setIsSaving(false);
      setError(withSessionReloadFallback(disconnectOtherError.message, "Could not switch mailbox provider."));
      return;
    }

    setIsSaving(false);
    setMessage(`Starting ${provider === "gmail" ? "Gmail" : "Outlook"} OAuth flow...`);

    try {
      window.sessionStorage.setItem(MAILBOX_OAUTH_PROVIDER_STORAGE_KEY, provider);
    } catch {
      // Best effort only.
    }

    const oauthProvider = provider === "gmail" ? "google" : "azure";
    window.location.assign(`/api/mailbox/connect?provider=${oauthProvider}&workspaceId=${encodeURIComponent(workspace.id)}`);
  }

  async function disconnect(provider: MailProvider) {
    if (!supabase || !workspace?.id || !profileId) {
      setError("Could not resolve your session.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const { error: updateError } = await supabase
      .from("mailbox_connections")
      .update({
        status: "disconnected",
        last_error: null,
        last_synced_at: null,
      })
      .eq("workspace_id", workspace.id)
      .eq("profile_id", profileId)
      .eq("provider", provider);

    if (updateError) {
      setIsSaving(false);
      setError(withSessionReloadFallback(updateError.message, "Could not disconnect mailbox."));
      return;
    }

    await loadMailboxSettings(workspace.id);
    setIsSaving(false);
    setMessage(`${provider === "gmail" ? "Gmail" : "Outlook"} disconnected.`);
  }

  if (workspaceError) {
    return <p className="text-sm text-red-600">{workspaceError}</p>;
  }

  if (isWorkspaceLoading || isPolicyLoading || (isEmailFeatureEnabled && isLoading)) {
    return <p className="text-sm text-[var(--muted)]">Loading mailbox settings...</p>;
  }

  if (!isEmailFeatureEnabled) {
    const canManagePolicy = currentRole === "super_admin" || currentRole === "owner";

    return (
      <section className="settings-surface mx-auto w-full max-w-5xl space-y-6">
        <div className="rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-5">
          <p className="text-sm font-semibold text-amber-800">Email automation is disabled</p>
          <p className="mt-2 text-sm text-amber-700">
            Your company admin has disabled the email triage and summary feature for all roles.
          </p>
          {canManagePolicy ? (
            <div className="mt-4">
              <Link
                href="/admin"
                className="inline-flex rounded-xl border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-800 transition hover:bg-amber-100"
              >
                Manage policy in Admin
              </Link>
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="settings-surface mx-auto w-full max-w-5xl space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Mailbox</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">Inbox connections</h1>
        <p className="mt-4 text-base leading-7 text-[var(--muted)]">
          Connect your mailbox providers so Versaline can triage and summarize client emails into CRM timelines.
        </p>
      </div>

      <div className="space-y-4">
        <div className="inline-flex rounded-2xl border border-[var(--border)] bg-white p-1 shadow-sm">
          {PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() => setSelectedProvider(provider.id)}
              className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                selectedProvider === provider.id
                  ? "bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] text-white shadow-md shadow-[rgba(59,130,246,0.2)]"
                  : "text-[var(--foreground)] hover:bg-slate-100"
              }`}
            >
              {provider.label}
            </button>
          ))}
        </div>

        {(() => {
          const provider = PROVIDERS.find((entry) => entry.id === selectedProvider) ?? PROVIDERS[0];
          const row = rowsByProvider[provider.id];
          const connected = row?.status === "connected";
          const isPending = row?.status === "pending";
          const reconnectRequired = connected ? isReconnectRequired(row?.oauth_token_updated_at) : false;
          const reconnectBy = row?.oauth_token_updated_at ? addDays(row.oauth_token_updated_at, MAILBOX_RECONNECT_INTERVAL_DAYS) : null;

          return (
            <article className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">{provider.label}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.14em] text-[var(--muted)]">{formatStatus(row?.status ?? "disconnected")}</p>
                </div>
                <span
                  className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                    connected && !reconnectRequired
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : reconnectRequired
                        ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-slate-200 bg-slate-100 text-slate-600"
                  }`}
                >
                  {connected ? (reconnectRequired ? "reconnect required" : "connected") : "inactive"}
                </span>
              </div>

              <div className="mt-4 space-y-1 text-sm text-[var(--muted)]">
                <p>Last sync: {formatDate(row?.last_synced_at ?? null)}</p>
                <p>Reconnect by: {reconnectBy ? formatDate(reconnectBy) : "Required now"}</p>
                <p>Active errors: {row?.last_error ? "1" : "0"}</p>
                {reconnectRequired ? (
                  <p className="text-xs text-amber-700">
                    Reconnect required every {MAILBOX_RECONNECT_INTERVAL_DAYS} days before mailbox sync can continue.
                  </p>
                ) : null}
                {row?.last_error ? <p className="text-xs text-red-600">{row.last_error}</p> : null}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void markConnected(provider.id)}
                  disabled={isSaving || isPending || (connected && !reconnectRequired)}
                  className="rounded-xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-3 py-2 text-sm font-semibold text-white shadow-md shadow-[rgba(59,130,246,0.2)] disabled:opacity-70"
                >
                  {connected ? (reconnectRequired ? "Reconnect now" : "Connected") : isPending ? "Connecting..." : "Connect"}
                </button>
                <button
                  type="button"
                  onClick={() => void disconnect(provider.id)}
                  disabled={isSaving || !row}
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:opacity-60"
                >
                  Disconnect
                </button>
                <button
                  type="button"
                  onClick={() => void syncNow(provider.id)}
                  disabled={isSaving || isSyncing || !connected || reconnectRequired}
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:opacity-60"
                >
                  {isSyncing ? "Syncing..." : "Sync now"}
                </button>
              </div>
            </article>
          );
        })()}
      </div>

      <form
        onSubmit={(event) => void savePreferences(event)}
        className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] p-5 shadow-sm"
      >
        <p className="text-sm font-semibold text-[var(--foreground)]">Personal preferences</p>
        <p className="mt-1 text-sm text-[var(--muted)]">Summary language applies to your own mailbox summaries.</p>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)]">
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={includeSentMailByPolicy && prefs.includeSentMail}
                disabled={!includeSentMailByPolicy}
                onChange={(event) =>
                  setPrefs((previous) => ({
                    ...previous,
                    includeSentMail: event.target.checked,
                  }))
                }
                className="h-4 w-4"
              />
              Include sent mail in summaries
            </span>
            <p className="text-xs text-[var(--muted)]">
              Admin policy: <span className="font-semibold text-[var(--foreground)]">{includeSentMailByPolicy ? "Allowed" : "Disabled"}</span>
            </p>
            <p className="text-xs text-[var(--muted)]">
              When enabled, summaries are usually better due to extra context, with an additional 0.1 credit per summary.
            </p>
            {includeSentMailByPolicy ? (
              <p className="text-xs text-[var(--muted)]">You can disable this for your mailbox at any time.</p>
            ) : (
              <p className="text-xs text-[var(--muted)]">Your admin must enable this before you can use it.</p>
            )}
          </label>

          <label className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
            <span className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Summary language</span>
            <select
              value={prefs.summaryLanguage}
              onChange={(event) => setPrefs((previous) => ({ ...previous, summaryLanguage: event.target.value }))}
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            >
              <option value="en">English</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
              <option value="de">German</option>
            </select>
          </label>
        </div>

        {error ? <p className="mt-3 text-sm font-medium text-red-600">{error}</p> : null}
        {message ? <p className="mt-3 text-sm font-medium text-emerald-700">{message}</p> : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={isSaving}
            className="rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:opacity-60"
          >
            Save preferences
          </button>
          <Link
            href="/settings"
            className="rounded-xl border border-transparent px-3 py-2 text-sm font-semibold text-[var(--muted)] transition hover:bg-slate-100"
          >
            Back to settings
          </Link>
        </div>
      </form>
    </section>
  );
}
