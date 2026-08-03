"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

type WorkspaceRole = "agent" | "team_lead" | "owner" | "super_admin";

type EmailPolicyRow = {
  company_id: string;
  feature_enabled: boolean;
  include_sent_mail_in_summaries: boolean;
  summary_retention_days: number;
  confidence_threshold: number;
  daily_briefing_enabled: boolean;
  daily_briefing_control: "owner_locked" | "team_lead_select";
};

const DEFAULT_POLICY: EmailPolicyRow = {
  company_id: "",
  feature_enabled: false,
  include_sent_mail_in_summaries: false,
  summary_retention_days: 180,
  confidence_threshold: 70,
  daily_briefing_enabled: true,
  daily_briefing_control: "owner_locked",
};

function buildGdprAddendum(params: { companyName: string; workspaceName: string }) {
  const company = params.companyName.trim() || "[Agency Name]";
  const workspace = params.workspaceName.trim() || "[Workspace Name]";

  return [
    "AI-Assisted Email Processing Addendum",
    "",
    `Controller/Agency: ${company}`,
    `Operational Workspace: ${workspace}`,
    "",
    "We use Versaline to process inbound and outbound business emails related to customer relationship management.",
    "Versaline may use AI model providers such as Anthropic, Google, Mistral, and xAI for triage and summarization tasks.",
    "Versaline configures provider accounts to restrict use of customer content for model training or service-improvement purposes and to minimize retention, subject to provider terms and account configuration.",
    "Model providers and specific model versions may change over time for quality, safety, availability, and cost optimization.",
    "Email content is processed automatically to classify relevance and generate concise CRM summaries for operational follow-up.",
    "Raw email bodies and attachments are not retained in Versaline databases after processing.",
    "Only limited metadata and generated summaries are retained for a time-limited period according to our retention policy.",
    "This processing is carried out under applicable GDPR legal bases for customer communication and service operations.",
    "Data subjects may exercise rights of access, rectification, deletion, and objection by contacting our privacy team.",
    "",
    "This template is provided for operational convenience and should be reviewed by legal counsel before publication.",
  ].join("\n");
}

export default function AdminEmailPolicyPanel() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { workspace, currentRole, isLoading: isWorkspaceLoading, error: workspaceError } = useCurrentWorkspace();

  const [policy, setPolicy] = useState<EmailPolicyRow>(DEFAULT_POLICY);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isAddendumInfoOpen, setIsAddendumInfoOpen] = useState(false);
  const [isPolicyCardOpen, setIsPolicyCardOpen] = useState(false);

  const role = (currentRole ?? "agent") as WorkspaceRole;
  const canManagePolicy = role === "super_admin" || role === "owner";
  const companyId = workspace?.company_id ?? "";

  useEffect(() => {
    if (!supabase || !companyId) {
      return;
    }

    void loadPolicy(companyId);
  }, [supabase, companyId]);

  async function loadPolicy(targetCompanyId: string) {
    if (!supabase) {
      setError("Supabase is not configured.");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from("email_ingestion_policies")
      .select("company_id, feature_enabled, include_sent_mail_in_summaries, summary_retention_days, confidence_threshold, daily_briefing_enabled, daily_briefing_control")
      .eq("company_id", targetCompanyId)
      .maybeSingle();

    if (fetchError) {
      setError(withSessionReloadFallback(fetchError.message, "Could not load email policy."));
      setIsLoading(false);
      return;
    }

    if (!data) {
      setPolicy({
        ...DEFAULT_POLICY,
        company_id: targetCompanyId,
      });
      setIsLoading(false);
      return;
    }

    const loaded = data as Partial<EmailPolicyRow>;

    setPolicy({
      company_id: targetCompanyId,
      feature_enabled: loaded.feature_enabled ?? DEFAULT_POLICY.feature_enabled,
      include_sent_mail_in_summaries:
        loaded.include_sent_mail_in_summaries ?? DEFAULT_POLICY.include_sent_mail_in_summaries,
      summary_retention_days: loaded.summary_retention_days ?? DEFAULT_POLICY.summary_retention_days,
      confidence_threshold: loaded.confidence_threshold ?? DEFAULT_POLICY.confidence_threshold,
      daily_briefing_enabled: loaded.daily_briefing_enabled ?? DEFAULT_POLICY.daily_briefing_enabled,
      daily_briefing_control:
        loaded.daily_briefing_control === "team_lead_select" ? "team_lead_select" : "owner_locked",
    });
    setIsLoading(false);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!supabase || !companyId) {
      setError("Could not resolve current company scope.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const payload: EmailPolicyRow = {
      company_id: companyId,
      feature_enabled: policy.feature_enabled,
      include_sent_mail_in_summaries: policy.include_sent_mail_in_summaries,
      summary_retention_days: Math.max(30, Math.min(365, Math.round(policy.summary_retention_days))),
      confidence_threshold: Math.max(0, Math.min(100, Math.round(policy.confidence_threshold))),
      daily_briefing_enabled: policy.daily_briefing_enabled,
      daily_briefing_control: policy.daily_briefing_control,
    };

    const { error: upsertError } = await supabase
      .from("email_ingestion_policies")
      .upsert(payload, { onConflict: "company_id" });

    if (upsertError) {
      setIsSaving(false);
      setError(withSessionReloadFallback(upsertError.message, "Could not save email policy."));
      return;
    }

    setPolicy(payload);
    setIsSaving(false);
    setMessage("Email policy saved.");
  }

  function downloadAddendum() {
    const addendum = buildGdprAddendum({
      companyName: workspace?.company_name ?? "",
      workspaceName: workspace?.name ?? "",
    });

    const blob = new Blob([addendum], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `gdpr-addendum-${(workspace?.name ?? "workspace").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (workspaceError) {
    return <p className="text-sm text-red-600">{workspaceError}</p>;
  }

  if (!companyId) {
    return (
      <div className="admin-banner rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-5">
        <p className="text-sm font-semibold text-amber-800">Company scope unavailable</p>
        <p className="mt-2 text-sm text-amber-700">
          This policy is company-wide, but your current workspace is not linked to a company.
        </p>
      </div>
    );
  }

  if (isWorkspaceLoading || isLoading) {
    return <p className="text-sm text-[var(--muted)]">Loading email policy...</p>;
  }

  if (!canManagePolicy) {
    return (
      <div className="admin-banner rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-5">
        <p className="text-sm font-semibold text-amber-800">Owner or super admin access required</p>
        <p className="mt-2 text-sm text-amber-700">
          Your current role is {role.replace("_", " ")}. Only owners and super admins can update company-wide email policy.
        </p>
      </div>
    );
  }

  return (
    <div className="settings-card admin-card admin-policy-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--foreground)]">Company email triage policy</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            This feature classifies inbound emails with AI, keeps only useful summaries, and links them to CRM contacts.
          </p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Scope: all workspaces under {workspace?.company_name || "your company"}. Turning this off disables processing for everyone in the company.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsPolicyCardOpen((open) => !open)}
          className="admin-disclosure-hint"
          aria-expanded={isPolicyCardOpen}
        >
          {isPolicyCardOpen ? "Hide" : "Open"}
        </button>
      </div>

      {!isPolicyCardOpen ? <p className="mt-3 text-sm text-[var(--muted)]">This section is collapsed.</p> : null}

      {isPolicyCardOpen ? (
      <form onSubmit={(event) => void handleSave(event)} className="mt-4">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)]">
            <input
              type="checkbox"
              checked={policy.feature_enabled}
              onChange={(event) => setPolicy((previous) => ({ ...previous, feature_enabled: event.target.checked }))}
              className="h-4 w-4"
            />
            Enable email triage and summary feature
          </label>

          <label className="flex flex-col gap-1 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)]">
            <span className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={policy.include_sent_mail_in_summaries}
                onChange={(event) =>
                  setPolicy((previous) => ({
                    ...previous,
                    include_sent_mail_in_summaries: event.target.checked,
                  }))
                }
                className="h-4 w-4"
              />
              Include sent mail in summaries
            </span>
            <span className="text-xs text-[var(--muted)]">
              Improves summary quality with more context, with an additional 0.1 credit per summary action.
            </span>
          </label>

          <label className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
            <span className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Summary retention (days)</span>
            <input
              type="number"
              min={30}
              max={365}
              value={policy.summary_retention_days}
              onChange={(event) =>
                setPolicy((previous) => ({
                  ...previous,
                  summary_retention_days: Number(event.target.value || 180),
                }))
              }
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
            <span className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">AI confidence threshold</span>
            <input
              type="range"
              min={0}
              max={100}
              value={policy.confidence_threshold}
              onChange={(event) =>
                setPolicy((previous) => ({
                  ...previous,
                  confidence_threshold: Number(event.target.value || 70),
                }))
              }
            />
            <span className="text-xs text-[var(--muted)]">{policy.confidence_threshold}%</span>
          </label>

          <div className="rounded-xl border border-[var(--border)] bg-white px-3 py-3 md:col-span-2">
            <p className="text-sm font-semibold text-[var(--foreground)]">Daily briefing governance</p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Control whether email daily briefings are available company-wide, or delegated to team leads per workspace.
            </p>

            <label className="mt-3 flex items-center gap-2 text-sm text-[var(--foreground)]">
              <input
                type="checkbox"
                checked={policy.daily_briefing_enabled}
                onChange={(event) =>
                  setPolicy((previous) => ({
                    ...previous,
                    daily_briefing_enabled: event.target.checked,
                  }))
                }
                className="h-4 w-4"
              />
              Allow email daily briefing for this company
            </label>

            <fieldset className="mt-3 grid gap-2 text-sm text-[var(--foreground)]">
              <legend className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Decision mode</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="daily-briefing-control"
                  checked={policy.daily_briefing_control === "owner_locked"}
                  onChange={() =>
                    setPolicy((previous) => ({
                      ...previous,
                      daily_briefing_control: "owner_locked",
                    }))
                  }
                  className="h-4 w-4"
                />
                Admin locked (owners decide company availability)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="daily-briefing-control"
                  checked={policy.daily_briefing_control === "team_lead_select"}
                  onChange={() =>
                    setPolicy((previous) => ({
                      ...previous,
                      daily_briefing_control: "team_lead_select",
                    }))
                  }
                  className="h-4 w-4"
                />
                Delegate to team leads (each workspace lead can enable or disable for their workspace)
              </label>
            </fieldset>
          </div>

        </div>

        {error ? <p className="mt-3 text-sm font-medium text-red-600">{error}</p> : null}
        {message ? <p className="mt-3 text-sm font-medium text-emerald-700">{message}</p> : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={isSaving}
            className="rounded-xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[rgba(59,130,246,0.2)] disabled:opacity-70"
          >
            {isSaving ? "Saving..." : "Save policy"}
          </button>
          <button
            type="button"
            onClick={() => setIsAddendumInfoOpen(true)}
            className="rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
          >
            IMPORTANT: Download GDPR
          </button>
        </div>
      </form>
      ) : null}

      {isAddendumInfoOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 px-4"
          role="dialog"
          aria-modal="true"
          aria-label="Why GDPR addendum matters"
        >
          <div className="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-white p-5 shadow-xl">
            <p className="text-sm font-semibold text-[var(--foreground)]">Why this addendum exists</p>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              The GDPR addendum explains how your company uses AI on email content, what is retained, and what is not retained.
              It helps you communicate privacy practices clearly to clients and internal teams.
            </p>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              It is important for compliance readiness, contract discussions, and reducing legal ambiguity when deploying
              AI-assisted email workflows.
            </p>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              Versaline may use providers such as Anthropic, Google, Mistral, and xAI. Versaline configures provider
              accounts to restrict use of customer content for model training or service-improvement purposes and to
              minimize retention, subject to provider terms and account configuration.
            </p>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
              Providers and model versions may change over time for quality, safety, availability, and cost.
            </p>
            <p className="mt-2 text-xs text-[var(--muted)]">
              This is a template and should be reviewed by legal counsel before use.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={downloadAddendum}
                className="rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
              >
                Download template
              </button>
              <button
                type="button"
                onClick={() => setIsAddendumInfoOpen(false)}
                className="rounded-xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[rgba(59,130,246,0.2)]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
