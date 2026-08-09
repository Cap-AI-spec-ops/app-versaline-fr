"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

type WorkspaceRole = "agent" | "team_lead" | "owner" | "super_admin";

type WorkspaceBrandingState = {
  agency_name: string;
  logo_url: string;
  primary_color: string;
  accent_color: string;
  carte_t_number: string;
  carte_t_cci: string;
  siret: string;
  rcp_policy_number: string;
  rcp_insurer: string;
  guarantor_name: string;
  guarantor_amount_eur: string;
};

const PRIMARY_BRANDING_COLOR = "#000000";

const DEFAULT_BRANDING: WorkspaceBrandingState = {
  agency_name: "",
  logo_url: "",
  primary_color: PRIMARY_BRANDING_COLOR,
  accent_color: "#3B82F6",
  carte_t_number: "",
  carte_t_cci: "",
  siret: "",
  rcp_policy_number: "",
  rcp_insurer: "",
  guarantor_name: "",
  guarantor_amount_eur: "",
};

export default function WorkspaceBrandingCard() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { workspace, currentRole, isLoading: isWorkspaceLoading, error: workspaceError } = useCurrentWorkspace();

  const [branding, setBranding] = useState<WorkspaceBrandingState>(DEFAULT_BRANDING);
  const [isCardOpen, setIsCardOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const role = (currentRole ?? "agent") as WorkspaceRole;
  const canEditBranding = role === "team_lead" || role === "owner" || role === "super_admin";
  const brandingComplete = isBrandingComplete(branding);
  const accentColor = normalizeHexColor(branding.accent_color, DEFAULT_BRANDING.accent_color);

  useEffect(() => {
    if (!supabase || !workspace?.id) {
      setIsLoading(false);
      return;
    }

    void loadBranding(workspace.id);
  }, [supabase, workspace?.id]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (window.location.hash === "#workspace-branding") {
      setIsCardOpen(true);
    }
  }, []);

  async function loadBranding(workspaceId: string) {
    if (!supabase) {
      setError("Supabase is not configured.");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: loadError } = await supabase
      .from("workspace_branding")
      .select(
        "agency_name, logo_url, primary_color, accent_color, carte_t_number, carte_t_cci, siret, rcp_policy_number, rcp_insurer, guarantor_name, guarantor_amount_eur",
      )
      .eq("workspace_id", workspaceId)
      .maybeSingle<{
        agency_name: string | null;
        logo_url: string | null;
        primary_color: string | null;
        accent_color: string | null;
        carte_t_number: string | null;
        carte_t_cci: string | null;
        siret: string | null;
        rcp_policy_number: string | null;
        rcp_insurer: string | null;
        guarantor_name: string | null;
        guarantor_amount_eur: number | null;
      }>();

    if (loadError) {
      setError(withSessionReloadFallback(loadError.message, "Could not load workspace branding."));
      setIsLoading(false);
      return;
    }

    if (!data) {
      setBranding(DEFAULT_BRANDING);
      setIsLoading(false);
      return;
    }

    setBranding({
      agency_name: data.agency_name ?? "",
      logo_url: data.logo_url ?? "",
      primary_color: PRIMARY_BRANDING_COLOR,
      accent_color: data.accent_color ?? DEFAULT_BRANDING.accent_color,
      carte_t_number: data.carte_t_number ?? "",
      carte_t_cci: data.carte_t_cci ?? "",
      siret: data.siret ?? "",
      rcp_policy_number: data.rcp_policy_number ?? "",
      rcp_insurer: data.rcp_insurer ?? "",
      guarantor_name: data.guarantor_name ?? "",
      guarantor_amount_eur:
        typeof data.guarantor_amount_eur === "number" ? String(data.guarantor_amount_eur) : "",
    });
    setIsLoading(false);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    if (!workspace?.id) {
      setError("Workspace not found.");
      return;
    }

    if (!canEditBranding) {
      setError("Only team leads, owners, and super admins can edit workspace branding.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const payload = {
      workspace_id: workspace.id,
      agency_name: branding.agency_name.trim(),
      logo_url: branding.logo_url.trim() || null,
      primary_color: PRIMARY_BRANDING_COLOR,
      accent_color: accentColor,
      carte_t_number: branding.carte_t_number.trim(),
      carte_t_cci: branding.carte_t_cci.trim(),
      siret: branding.siret.trim(),
      rcp_policy_number: branding.rcp_policy_number.trim(),
      rcp_insurer: branding.rcp_insurer.trim(),
      guarantor_name: branding.guarantor_name.trim(),
      guarantor_amount_eur: parseCurrencyAmount(branding.guarantor_amount_eur),
    };

    const { error: upsertError } = await supabase
      .from("workspace_branding")
      .upsert(payload, { onConflict: "workspace_id" });

    setIsSaving(false);

    if (upsertError) {
      setError(withSessionReloadFallback(upsertError.message, "Could not save workspace branding."));
      return;
    }

    setMessage("Workspace branding and legal identity saved.");
  }

  if (workspaceError) {
    return <p className="text-sm text-red-600">{workspaceError}</p>;
  }

  if (isWorkspaceLoading || isLoading) {
    return <p className="text-sm text-[var(--muted)]">Loading workspace branding...</p>;
  }

  return (
    <div
      id="workspace-branding"
      className="settings-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--foreground)]">Document branding and legal identity</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Configure the workspace-level agency identity used by mandates, leases, amendments, and document exports.
          </p>
          <p className="mt-2 text-xs uppercase tracking-[0.14em] text-[var(--muted)]">
            Status: <span className={brandingComplete ? "text-emerald-700" : "text-amber-700"}>{brandingComplete ? "Legal minimum complete" : "Legal minimum missing"}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsCardOpen((open) => !open)}
          className="admin-disclosure-hint"
          aria-expanded={isCardOpen}
        >
          {isCardOpen ? "Hide" : "Open"}
        </button>
      </div>

      {!isCardOpen ? <p className="mt-3 text-sm text-[var(--muted)]">This section is collapsed.</p> : null}

      {isCardOpen ? (
        <form onSubmit={(event) => void handleSave(event)} className="mt-4 space-y-4">
          {!canEditBranding ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              Your current role is {role.replace("_", " ")}. Only team leads, owners, and super admins can edit these document branding fields.
            </div>
          ) : null}

          {error ? <p className="text-sm font-medium text-red-500">{error}</p> : null}
          {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}

          <div className="grid gap-4 md:grid-cols-2">
            <LabeledField label={buildFieldLabel("Agency name", "Mandatory by law")} required>
              <input
                type="text"
                value={branding.agency_name}
                onChange={(event) => setBranding((previous) => ({ ...previous, agency_name: event.target.value }))}
                disabled={!canEditBranding || isSaving}
                className={fieldClassName}
              />
            </LabeledField>

            <LabeledField label={buildFieldLabel("Logo URL", "Recommended")}>
              <input
                type="url"
                value={branding.logo_url}
                onChange={(event) => setBranding((previous) => ({ ...previous, logo_url: event.target.value }))}
                disabled={!canEditBranding || isSaving}
                placeholder="https://..."
                className={fieldClassName}
              />
            </LabeledField>

            <LabeledField
              label={
                <>
                  Accent color
                  <FieldStatusBadge text="Recommended" />
                  <span
                    className="ml-2 inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border)] text-[10px] font-semibold text-[var(--muted)]"
                    title="Accent color is used for highlights and emphasis in generated documents."
                    aria-label="Accent color info"
                  >
                    i
                  </span>
                </>
              }
              required
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-white px-3 py-2">
                  <input
                    type="color"
                    value={accentColor}
                    onChange={(event) => setBranding((previous) => ({ ...previous, accent_color: event.target.value.toUpperCase() }))}
                    disabled={!canEditBranding || isSaving}
                    className="h-8 w-10 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0 disabled:cursor-not-allowed"
                  />
                  <input
                    type="text"
                    value={branding.accent_color}
                    onChange={(event) => setBranding((previous) => ({ ...previous, accent_color: event.target.value }))}
                    onBlur={() =>
                      setBranding((previous) => ({
                        ...previous,
                        accent_color: normalizeHexColor(previous.accent_color, DEFAULT_BRANDING.accent_color),
                      }))
                    }
                    disabled={!canEditBranding || isSaving}
                    placeholder="#3B82F6"
                    className="min-w-0 flex-1 bg-transparent font-mono text-sm text-[var(--foreground)] outline-none"
                  />
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Preview:
                  <span className="ml-2 inline-flex items-center gap-2 align-middle">
                    <span className="h-3 w-3 rounded-full border border-slate-300" style={{ backgroundColor: accentColor }} aria-hidden="true" />
                    <span className="font-mono">{accentColor}</span>
                  </span>
                </div>
              </div>
            </LabeledField>

            <LabeledField label={buildFieldLabel("Carte T number", "Mandatory by law")} required>
              <input
                type="text"
                value={branding.carte_t_number}
                onChange={(event) => setBranding((previous) => ({ ...previous, carte_t_number: event.target.value }))}
                disabled={!canEditBranding || isSaving}
                placeholder="CPI 7501 202X 000 000 000"
                className={fieldClassName}
              />
            </LabeledField>

            <LabeledField label={buildFieldLabel("Carte T issuing CCI", "Mandatory by law")} required>
              <input
                type="text"
                value={branding.carte_t_cci}
                onChange={(event) => setBranding((previous) => ({ ...previous, carte_t_cci: event.target.value }))}
                disabled={!canEditBranding || isSaving}
                placeholder="CCI Paris Ile-de-France"
                className={fieldClassName}
              />
            </LabeledField>

            <LabeledField label={buildFieldLabel("SIRET", "Mandatory by law")} required>
              <input
                type="text"
                value={branding.siret}
                onChange={(event) => setBranding((previous) => ({ ...previous, siret: event.target.value }))}
                disabled={!canEditBranding || isSaving}
                className={fieldClassName}
              />
            </LabeledField>

            <LabeledField label={buildFieldLabel("RCP policy number", "Recommended")}>
              <input
                type="text"
                value={branding.rcp_policy_number}
                onChange={(event) => setBranding((previous) => ({ ...previous, rcp_policy_number: event.target.value }))}
                disabled={!canEditBranding || isSaving}
                className={fieldClassName}
              />
            </LabeledField>

            <LabeledField label={buildFieldLabel("RCP insurer", "Mandatory by law")} required>
              <input
                type="text"
                value={branding.rcp_insurer}
                onChange={(event) => setBranding((previous) => ({ ...previous, rcp_insurer: event.target.value }))}
                disabled={!canEditBranding || isSaving}
                className={fieldClassName}
              />
            </LabeledField>

            <LabeledField label={buildFieldLabel("Financial guarantor", "Required if holding funds")}>
              <input
                type="text"
                value={branding.guarantor_name}
                onChange={(event) => setBranding((previous) => ({ ...previous, guarantor_name: event.target.value }))}
                disabled={!canEditBranding || isSaving}
                placeholder="Galian, SOCAF..."
                className={fieldClassName}
              />
            </LabeledField>

            <LabeledField label={buildFieldLabel("Guarantee amount (EUR)", "Required if holding funds")}>
              <input
                type="text"
                inputMode="decimal"
                value={branding.guarantor_amount_eur}
                onChange={(event) => setBranding((previous) => ({ ...previous, guarantor_amount_eur: event.target.value }))}
                disabled={!canEditBranding || isSaving}
                placeholder="110000"
                className={fieldClassName}
              />
            </LabeledField>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-700">
            The document generator is blocked only by "Mandatory by law" fields.
            "Required if holding funds" fields should be completed when your agency handles client funds.
            The logo remains optional. For now, logo entry uses a direct URL field rather than file upload.
          </div>

          <button
            type="submit"
            disabled={!canEditBranding || isSaving}
            className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isSaving ? "Saving..." : "Save branding"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function LabeledField(props: { label: React.ReactNode; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm text-[var(--foreground)]">
      <span className="font-medium">
        {props.label}
        {props.required ? <span className="ml-1 text-red-500">*</span> : null}
      </span>
      {props.children}
    </label>
  );
}

function parseCurrencyAmount(value: string) {
  const normalized = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(normalized) ? normalized : 0;
}

function normalizeHexColor(value: string, fallback: string) {
  const candidate = value.trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(candidate)) {
    return candidate;
  }

  return fallback;
}

function isBrandingComplete(branding: WorkspaceBrandingState) {
  return Boolean(
    branding.agency_name.trim() &&
      branding.carte_t_number.trim() &&
      branding.carte_t_cci.trim() &&
      branding.siret.trim() &&
      branding.rcp_insurer.trim(),
  );
}

function buildFieldLabel(name: string, status: "Mandatory by law" | "Required if holding funds" | "Recommended") {
  return (
    <>
      {name}
      <FieldStatusBadge text={status} />
    </>
  );
}

function FieldStatusBadge(props: { text: "Mandatory by law" | "Required if holding funds" | "Recommended" }) {
  const className = props.text === "Mandatory by law"
    ? "border border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-700/80 dark:bg-rose-900/45 dark:text-rose-100"
    : props.text === "Required if holding funds"
      ? "border border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-700/80 dark:bg-amber-900/45 dark:text-amber-100"
      : "border border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-600/80 dark:bg-slate-700/55 dark:text-slate-100";

  return <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${className}`}>{props.text}</span>;
}

const fieldClassName =
  "settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60";