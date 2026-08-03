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
import AdminEmailPolicyPanel from "@/components/admin-email-policy-panel";
import WorkspaceManagementCard from "@/components/workspace-management-card";
import { useAdminAuditLogs } from "@/lib/workspace/use-admin-audit-logs";
import { useAdminWorkspaceMembers } from "@/lib/workspace/use-admin-workspace-members";
import { useAccessibleWorkspaces } from "@/lib/workspace/use-accessible-workspaces";
import { useAdminWorkspaces } from "@/lib/workspace/use-admin-workspaces";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

type AdminRole = "agent" | "team_lead" | "owner" | "super_admin";

function formatRoleLabel(role: AdminRole) {
  return role.replace("_", " ");
}

function formatAdminMemberName(firstName: string | null, lastName: string | null) {
  const fullName = [firstName ?? "", lastName ?? ""].join(" ").trim();
  return fullName || "Unnamed coworker";
}

export default function AdminManagementPanel() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { workspace: currentWorkspace } = useCurrentWorkspace();
  const { workspaces: accessibleWorkspaces, refresh: refreshAccessibleWorkspaces } = useAccessibleWorkspaces();
  const { workspaces: adminWorkspaces, isLoading, error, refresh: refreshAdminWorkspaces } = useAdminWorkspaces();
  const { members: adminMembers, isLoading: isMembersLoading, error: membersError, refresh: refreshAdminMembers } = useAdminWorkspaceMembers();
  const [isAuditOpen, setIsAuditOpen] = useState(false);
  const [isLifecycleSectionOpen, setIsLifecycleSectionOpen] = useState(false);
  const [isTraceabilitySectionOpen, setIsTraceabilitySectionOpen] = useState(false);
  const [isCreateWorkspaceCardOpen, setIsCreateWorkspaceCardOpen] = useState(false);
  const [isCompanySettingsCardOpen, setIsCompanySettingsCardOpen] = useState(false);
  const [isMoveCoworkersCardOpen, setIsMoveCoworkersCardOpen] = useState(false);
  const { logs: auditLogs, isLoading: isAuditLoading, error: auditError, refresh: refreshAuditLogs } = useAdminAuditLogs(isAuditOpen ? 120 : 20);

  const currentWorkspaceEntry = accessibleWorkspaces.find((item) => item.is_current) ?? accessibleWorkspaces[0];
  const currentRole = (currentWorkspaceEntry?.user_role ?? "agent") as AdminRole;
  const isAdminRole = currentRole === "super_admin" || currentRole === "owner";
  const companyScopeWorkspaceId = currentWorkspace?.id ?? currentWorkspaceEntry?.workspace_id ?? "";

  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceCurrency, setWorkspaceCurrency] = useState("EUR");
  const [workspaceMetricSystem, setWorkspaceMetricSystem] = useState("metric");
  const [workspaceDefaultCountryCode, setWorkspaceDefaultCountryCode] = useState("FR");
  const [workspaceDefaultLocale, setWorkspaceDefaultLocale] = useState("fr-FR");
  const [workspaceDefaultLanguage, setWorkspaceDefaultLanguage] = useState("fr");
  const [workspaceDefaultTimezone, setWorkspaceDefaultTimezone] = useState("Europe/Paris");
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [companyName, setCompanyName] = useState("");
  const [companyMessage, setCompanyMessage] = useState<string | null>(null);
  const [isSavingCompany, setIsSavingCompany] = useState(false);

  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  const [deletingWorkspaceId, setDeletingWorkspaceId] = useState<string | null>(null);
  const [pendingDeleteWorkspaceId, setPendingDeleteWorkspaceId] = useState<string | null>(null);
  const [pendingDeleteWorkspaceName, setPendingDeleteWorkspaceName] = useState("");
  const [deleteConfirmationName, setDeleteConfirmationName] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [targetWorkspaceId, setTargetWorkspaceId] = useState("");
  const [moveMessage, setMoveMessage] = useState<string | null>(null);
  const [movingMemberId, setMovingMemberId] = useState<string | null>(null);

  useEffect(() => {
    const selected = adminWorkspaces.find((item) => item.workspace_id === companyScopeWorkspaceId);

    if (selected?.company_name) {
      setCompanyName(selected.company_name);
      return;
    }

    if (currentWorkspace?.id === companyScopeWorkspaceId && currentWorkspace.company_name) {
      setCompanyName(currentWorkspace.company_name);
    }
  }, [adminWorkspaces, companyScopeWorkspaceId, currentWorkspace]);

  useEffect(() => {
    if (!selectedMemberId && adminMembers.length > 0) {
      setSelectedMemberId(adminMembers[0].profile_id);
    }
  }, [adminMembers, selectedMemberId]);

  useEffect(() => {
    const selectedMember = adminMembers.find((member) => member.profile_id === selectedMemberId);

    if (!selectedMember) {
      return;
    }

    const firstAvailableTarget = adminWorkspaces.find((workspace) => workspace.workspace_id !== selectedMember.workspace_id);

    if (!targetWorkspaceId || targetWorkspaceId === selectedMember.workspace_id) {
      setTargetWorkspaceId(firstAvailableTarget?.workspace_id ?? "");
    }
  }, [adminMembers, adminWorkspaces, selectedMemberId, targetWorkspaceId]);

  const emitWorkspaceListUpdated = () => {
    window.dispatchEvent(new Event("workspace-list-updated"));
  };

  const handleMoveMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setMoveMessage("Supabase is not configured.");
      return;
    }

    if (!selectedMemberId) {
      setMoveMessage("Select a coworker to move.");
      return;
    }

    if (!targetWorkspaceId) {
      setMoveMessage("Select a destination workspace.");
      return;
    }

    const selectedMember = adminMembers.find((member) => member.profile_id === selectedMemberId);

    if (!selectedMember) {
      setMoveMessage("Selected coworker was not found.");
      return;
    }

    if (selectedMember.workspace_id === targetWorkspaceId) {
      setMoveMessage("Choose a different destination workspace.");
      return;
    }

    setMovingMemberId(selectedMemberId);
    setMoveMessage(null);

    const { error: moveError } = await supabase.rpc("move_workspace_member", {
      p_profile_id: selectedMemberId,
      p_target_workspace_id: targetWorkspaceId,
      p_idempotency_key: crypto.randomUUID(),
      p_source: "admin_page",
    });

    setMovingMemberId(null);

    if (moveError) {
      setMoveMessage(moveError.message);
      return;
    }

    setMoveMessage("Coworker moved.");
    await refreshAdminMembers();
    await refreshAdminWorkspaces();
    await refreshAccessibleWorkspaces();
    await refreshAuditLogs();
    emitWorkspaceListUpdated();
  };

  const handleCreateWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setCreateMessage("Supabase is not configured.");
      return;
    }

    const trimmedName = workspaceName.trim();

    if (!trimmedName) {
      setCreateMessage("Workspace name is required.");
      return;
    }

    setIsCreating(true);
    setCreateMessage(null);

    const { error: createError } = await supabase.rpc("create_workspace", {
      p_name: trimmedName,
      p_currency: workspaceCurrency,
      p_metric_system: workspaceMetricSystem,
      p_default_country_code: workspaceDefaultCountryCode,
      p_default_locale: workspaceDefaultLocale,
      p_default_language: workspaceDefaultLanguage,
      p_default_timezone: workspaceDefaultTimezone,
      p_idempotency_key: crypto.randomUUID(),
      p_source: "admin_page",
    });

    setIsCreating(false);

    if (createError) {
      setCreateMessage(createError.message);
      return;
    }

    setWorkspaceName("");
    const resetMarketPreset = getMarketPresetByCountry("FR");
    setWorkspaceDefaultCountryCode(resetMarketPreset.countryCode);
    setWorkspaceDefaultLocale(resetMarketPreset.defaultLocale);
    setWorkspaceDefaultLanguage(resetMarketPreset.defaultLanguage);
    setWorkspaceDefaultTimezone(resetMarketPreset.defaultTimezone);
    setCreateMessage("Workspace created.");
    await refreshAdminWorkspaces();
    await refreshAccessibleWorkspaces();
    await refreshAuditLogs();
    emitWorkspaceListUpdated();
  };

  const handleCompanySave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setCompanyMessage("Supabase is not configured.");
      return;
    }

    const trimmedCompanyName = companyName.trim();

    if (!companyScopeWorkspaceId) {
      setCompanyMessage("Current workspace not found.");
      return;
    }

    if (!trimmedCompanyName) {
      setCompanyMessage("Company name is required.");
      return;
    }

    setIsSavingCompany(true);
    setCompanyMessage(null);

    const { error: companyError } = await supabase.rpc("update_company_settings", {
      p_workspace_id: companyScopeWorkspaceId,
      p_company_name: trimmedCompanyName,
    });

    setIsSavingCompany(false);

    if (companyError) {
      setCompanyMessage(companyError.message);
      return;
    }

    setCompanyMessage("Company settings saved.");
    await refreshAdminWorkspaces();
    await refreshAccessibleWorkspaces();
    await refreshAuditLogs();
    emitWorkspaceListUpdated();
  };

  const beginDeleteWorkspace = (workspaceId: string, workspaceDisplayName: string) => {
    setPendingDeleteWorkspaceId(workspaceId);
    setPendingDeleteWorkspaceName(workspaceDisplayName);
    setDeleteConfirmationName("");
    setDeleteMessage(null);
  };

  const cancelDeleteWorkspace = () => {
    setPendingDeleteWorkspaceId(null);
    setPendingDeleteWorkspaceName("");
    setDeleteConfirmationName("");
  };

  const handleDeleteWorkspace = async (workspaceId: string, workspaceDisplayName: string) => {
    if (!supabase) {
      setDeleteMessage("Supabase is not configured.");
      return;
    }

    const typedName = deleteConfirmationName.trim();

    if (typedName !== workspaceDisplayName.trim()) {
      setDeleteMessage("Workspace confirmation name does not match.");
      return;
    }

    setDeletingWorkspaceId(workspaceId);
    setDeleteMessage(null);

    const { error: deleteError } = await supabase.rpc("delete_workspace", {
      p_workspace_id: workspaceId,
      p_confirm_workspace_name: typedName.trim(),
      p_idempotency_key: crypto.randomUUID(),
      p_source: "admin_page",
    });

    setDeletingWorkspaceId(null);

    if (deleteError) {
      setDeleteMessage(deleteError.message);
      return;
    }

    cancelDeleteWorkspace();
    setDeleteMessage("Workspace archived.");
    await refreshAdminWorkspaces();
    await refreshAccessibleWorkspaces();
    await refreshAuditLogs();
    emitWorkspaceListUpdated();
  };

  if (!isAdminRole) {
    return (
      <section className="settings-surface admin-surface mx-auto w-full max-w-4xl space-y-5">
        <div className="admin-banner rounded-[24px] border border-amber-200 bg-amber-50 px-5 py-5">
          <p className="text-sm font-semibold text-amber-800">Admin access required</p>
          <p className="mt-2 text-sm text-amber-700">
            Your current role is {formatRoleLabel(currentRole)}. Only super admins and owners can access admin controls.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="settings-surface admin-surface mx-auto w-full max-w-5xl space-y-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Admin</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">Company and workspace admin</h1>
        <p className="mt-4 text-base leading-7 text-[var(--muted)]">
          Manage companies, create workspaces, and control workspace lifecycle.
        </p>
      </div>

      <div className="admin-section space-y-4">
        <div className="admin-section-header">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Automation and policy</p>
          <p className="mt-1 text-sm text-[var(--muted)]">Company-wide controls for email triage and daily briefing governance.</p>
        </div>

        <AdminEmailPolicyPanel />
      </div>

      <div className="admin-section space-y-4">
        <div className="admin-section-header">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Workspace basics</p>
          <p className="mt-1 text-sm text-[var(--muted)]">Core workspace settings and company-level updates.</p>
        </div>

        <WorkspaceManagementCard
          initialWorkspaceId={currentWorkspace?.id ?? currentWorkspaceEntry?.workspace_id}
          initialWorkspaceName={currentWorkspaceEntry?.workspace_name}
          initialCurrency={currentWorkspace?.currency}
          initialMetricSystem={currentWorkspace?.metric_system}
          initialDefaultCountryCode={currentWorkspace?.default_country_code}
          initialDefaultLocale={currentWorkspace?.default_locale}
          initialDefaultLanguage={currentWorkspace?.default_language}
          initialDefaultTimezone={currentWorkspace?.default_timezone}
        />

        <div className="grid gap-4 lg:grid-cols-2">
        <form onSubmit={handleCreateWorkspace} className="settings-card admin-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[var(--foreground)]">Create workspace</p>
              <p className="mt-1 text-sm text-[var(--muted)]">Create a new workspace under your current company scope.</p>
            </div>
            <button type="button" onClick={() => setIsCreateWorkspaceCardOpen((open) => !open)} className="admin-disclosure-hint" aria-expanded={isCreateWorkspaceCardOpen}>
              {isCreateWorkspaceCardOpen ? "Hide" : "Open"}
            </button>
          </div>
          {!isCreateWorkspaceCardOpen ? <p className="mt-3 text-sm text-[var(--muted)]">This section is collapsed.</p> : null}
          {isCreateWorkspaceCardOpen ? <div className="mt-4 space-y-3">
            <input
              type="text"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="Workspace name"
              className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            />
            <select
              value={workspaceCurrency}
              onChange={(event) => setWorkspaceCurrency(event.target.value)}
              className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            >
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
            <select
              value={workspaceMetricSystem}
              onChange={(event) => setWorkspaceMetricSystem(event.target.value)}
              className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            >
              <option value="metric">Metric (m², m, kg)</option>
              <option value="imperial">Imperial (ft², ft, lbs)</option>
            </select>
            <select
              value={workspaceDefaultCountryCode}
              onChange={(event) => {
                const preset = getMarketPresetByCountry(event.target.value);
                setWorkspaceDefaultCountryCode(preset.countryCode);
                setWorkspaceDefaultLocale(preset.defaultLocale);
                setWorkspaceDefaultLanguage(preset.defaultLanguage);
                setWorkspaceDefaultTimezone(preset.defaultTimezone);
              }}
              className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            >
              {MARKET_PRESETS.map((preset) => (
                <option key={preset.countryCode} value={preset.countryCode}>{`${preset.countryCode} - ${preset.countryName}`}</option>
              ))}
            </select>
            <select
              value={workspaceDefaultLocale}
              onChange={(event) => setWorkspaceDefaultLocale(event.target.value)}
              className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            >
              {MARKET_LOCALE_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
            <div className="grid gap-3 sm:grid-cols-2">
              <select
                value={workspaceDefaultLanguage}
                onChange={(event) => setWorkspaceDefaultLanguage(event.target.value)}
                className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              >
                {MARKET_LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>{option.label}</option>
                ))}
              </select>
              <select
                value={workspaceDefaultTimezone}
                onChange={(event) => setWorkspaceDefaultTimezone(event.target.value)}
                className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              >
                {MARKET_TIMEZONE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>{option.label}</option>
                ))}
              </select>
            </div>
            {createMessage ? (
              <p className={`text-sm font-medium ${createMessage === "Workspace created." ? "text-emerald-700" : "text-red-500"}`}>
                {createMessage}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={isCreating}
              className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isCreating ? "Creating workspace..." : "Create workspace"}
            </button>
          </div> : null}
        </form>

        <form onSubmit={handleCompanySave} className="settings-card admin-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[var(--foreground)]">Company settings</p>
              <p className="mt-1 text-sm text-[var(--muted)]">Update company name across all linked workspaces.</p>
            </div>
            <button type="button" onClick={() => setIsCompanySettingsCardOpen((open) => !open)} className="admin-disclosure-hint" aria-expanded={isCompanySettingsCardOpen}>
              {isCompanySettingsCardOpen ? "Hide" : "Open"}
            </button>
          </div>
          {!isCompanySettingsCardOpen ? <p className="mt-3 text-sm text-[var(--muted)]">This section is collapsed.</p> : null}
          {isCompanySettingsCardOpen ? <div className="mt-4 space-y-3">
            <input
              type="text"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder="Company name"
              className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            />
            {companyMessage ? (
              <p className={`text-sm font-medium ${companyMessage === "Company settings saved." ? "text-emerald-700" : "text-red-500"}`}>
                {companyMessage}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={isSavingCompany}
              className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSavingCompany ? "Saving..." : "Save company"}
            </button>
          </div> : null}
        </form>
      </div>
      </div>

      <div className="admin-section space-y-4">
        <div className="admin-section-header">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Team and access</p>
          <p className="mt-1 text-sm text-[var(--muted)]">Manage where coworkers belong inside your company scope.</p>
        </div>

        <form onSubmit={handleMoveMember} className="settings-card admin-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[var(--foreground)]">Move coworkers</p>
              <p className="mt-1 text-sm text-[var(--muted)]">Reassign a coworker from one workspace to another inside your admin scope.</p>
            </div>
            <button type="button" onClick={() => setIsMoveCoworkersCardOpen((open) => !open)} className="admin-disclosure-hint" aria-expanded={isMoveCoworkersCardOpen}>
              {isMoveCoworkersCardOpen ? "Hide" : "Open"}
            </button>
          </div>
          {!isMoveCoworkersCardOpen ? <p className="mt-3 text-sm text-[var(--muted)]">This section is collapsed.</p> : null}

          {isMoveCoworkersCardOpen ? (
            <>

              {isMembersLoading ? <p className="mt-4 text-sm text-[var(--muted)]">Loading coworkers...</p> : null}
              {membersError ? <p className="mt-4 text-sm font-medium text-red-500">{membersError}</p> : null}

              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <select
                  value={selectedMemberId}
                  onChange={(event) => setSelectedMemberId(event.target.value)}
                  disabled={isMembersLoading || adminMembers.length === 0 || movingMemberId !== null}
                  className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {adminMembers.length === 0 ? <option value="">No coworkers available</option> : null}
                  {adminMembers.map((member) => (
                    <option key={member.profile_id} value={member.profile_id}>
                      {`${formatAdminMemberName(member.first_name, member.last_name)}${member.email ? ` (${member.email})` : ""} | ${formatRoleLabel(member.role)} | ${member.workspace_name}`}
                    </option>
                  ))}
                </select>

                <select
                  value={targetWorkspaceId}
                  onChange={(event) => setTargetWorkspaceId(event.target.value)}
                  disabled={!selectedMemberId || movingMemberId !== null}
                  className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {(() => {
                    const selectedMember = adminMembers.find((member) => member.profile_id === selectedMemberId);
                    const availableTargets = adminWorkspaces.filter((workspace) => workspace.workspace_id !== selectedMember?.workspace_id);

                    if (availableTargets.length === 0) {
                      return <option value="">No destination workspaces available</option>;
                    }

                    return availableTargets.map((workspace) => (
                      <option key={workspace.workspace_id} value={workspace.workspace_id}>
                        {workspace.workspace_name}
                      </option>
                    ));
                  })()}
                </select>
              </div>

              {selectedMemberId ? (
                <p className="mt-3 text-xs text-[var(--muted)]">
                  Current workspace: {adminMembers.find((member) => member.profile_id === selectedMemberId)?.workspace_name || "Unknown"}
                </p>
              ) : null}

              {moveMessage ? (
                <p className={`mt-4 text-sm font-medium ${moveMessage === "Coworker moved." ? "text-emerald-700" : "text-red-500"}`}>
                  {moveMessage}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={!selectedMemberId || !targetWorkspaceId || movingMemberId !== null}
                className="mt-4 rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {movingMemberId ? "Moving coworker..." : "Move coworker"}
              </button>
            </>
          ) : null}
        </form>
      </div>

      <div className="admin-section space-y-3">
        <div className="admin-section-header">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Advanced actions</p>
          <p className="mt-1 text-sm text-[var(--muted)]">Less frequent actions are collapsed by default to reduce noise.</p>
        </div>

        <div className="admin-disclosure">
          <button
            type="button"
            onClick={() => setIsLifecycleSectionOpen((open) => !open)}
            className="admin-disclosure-toggle"
            aria-expanded={isLifecycleSectionOpen}
          >
            <span>Workspace lifecycle and deletion</span>
            <span className="admin-disclosure-hint">{isLifecycleSectionOpen ? "Hide" : "Open"}</span>
          </button>
          {isLifecycleSectionOpen ? (
            <div className="settings-card admin-card mt-3 rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
            <p className="text-sm font-semibold text-[var(--foreground)]">All workspaces</p>
            <p className="mt-1 text-sm text-[var(--muted)]">Delete only empty workspaces (no assigned members).</p>

            {isLoading ? <p className="mt-4 text-sm text-[var(--muted)]">Loading workspaces...</p> : null}
            {error ? <p className="mt-4 text-sm font-medium text-red-500">{error}</p> : null}

            <div className="mt-4 space-y-3">
              {adminWorkspaces.map((item) => (
                <div key={item.workspace_id} className="rounded-2xl border border-[var(--border)] bg-white/80 px-4 py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-[var(--foreground)]">
                        {item.workspace_name}
                        {item.is_current ? " (Current)" : ""}
                      </p>
                      <p className="text-xs text-[var(--muted)]">
                        Company: {item.company_name || "No company"} | Currency: {item.currency} | Metric: {item.metric_system} | Members: {item.members_count}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => beginDeleteWorkspace(item.workspace_id, item.workspace_name)}
                      disabled={item.is_current || item.members_count > 0 || deletingWorkspaceId === item.workspace_id}
                      className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {deletingWorkspaceId === item.workspace_id ? "Deleting..." : "Delete workspace"}
                    </button>
                  </div>
                  {pendingDeleteWorkspaceId === item.workspace_id ? (
                    <div className="mt-3 rounded-xl border border-red-200 bg-red-50/70 p-3">
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-red-700">Confirm archive</p>
                      <p className="mt-2 text-sm text-red-700">
                        Type <span className="font-semibold">{pendingDeleteWorkspaceName}</span> to archive this workspace.
                      </p>
                      <input
                        type="text"
                        value={deleteConfirmationName}
                        onChange={(event) => setDeleteConfirmationName(event.target.value)}
                        placeholder="Workspace name"
                        className="settings-field mt-3 w-full rounded-2xl border border-red-200 bg-white px-4 py-3 text-sm outline-none focus:border-red-400"
                      />
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleDeleteWorkspace(item.workspace_id, item.workspace_name)}
                          disabled={deletingWorkspaceId === item.workspace_id}
                          className="rounded-xl border border-red-200 bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {deletingWorkspaceId === item.workspace_id ? "Deleting..." : "Confirm delete"}
                        </button>
                        <button
                          type="button"
                          onClick={cancelDeleteWorkspace}
                          disabled={deletingWorkspaceId === item.workspace_id}
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm font-medium text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {item.members_count > 0 ? (
                    <p className="mt-2 text-xs text-amber-700">Cannot delete: this workspace still has assigned members.</p>
                  ) : null}
                </div>
              ))}
            </div>

            {deleteMessage ? (
              <p className={`mt-4 text-sm font-medium ${deleteMessage === "Workspace archived." ? "text-emerald-700" : "text-red-500"}`}>
                {deleteMessage}
              </p>
            ) : null}
            </div>
          ) : null}
        </div>

        <div className="admin-disclosure">
          <button
            type="button"
            onClick={() => setIsTraceabilitySectionOpen((open) => !open)}
            className="admin-disclosure-toggle"
            aria-expanded={isTraceabilitySectionOpen}
          >
            <span>Audit logs and traceability</span>
            <span className="admin-disclosure-hint">{isTraceabilitySectionOpen ? "Hide" : "Open"}</span>
          </button>
          {isTraceabilitySectionOpen ? (
            <div className="settings-card admin-card mt-3 rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">Audit logs</p>
                <p className="mt-1 text-sm text-[var(--muted)]">Recent sensitive admin actions for support and compliance.</p>
                <p className="mt-1 text-xs text-[var(--muted)]">Visibility: owners see only logs inside their current company scope.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsAuditOpen((open) => !open)}
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                >
                  {isAuditOpen ? "Hide logs" : "Open logs"}
                </button>
                <button
                  type="button"
                  onClick={() => void refreshAuditLogs()}
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm font-medium text-[var(--muted)] transition hover:bg-slate-50"
                >
                  Refresh
                </button>
              </div>
            </div>

            {isAuditLoading ? <p className="mt-4 text-sm text-[var(--muted)]">Loading audit logs...</p> : null}
            {auditError ? <p className="mt-4 text-sm font-medium text-red-500">{auditError}</p> : null}

            {!isAuditOpen && !isAuditLoading && !auditError ? (
              <p className="mt-4 text-sm text-[var(--muted)]">
                Logs are hidden to keep this page compact. Open logs to view recent activity.
              </p>
            ) : null}

            {isAuditOpen ? (
              <div className="mt-4 max-h-[30rem] space-y-2 overflow-y-auto pr-1">
                {auditLogs.map((log) => (
                  <div key={log.id} className="rounded-xl border border-[var(--border)] bg-white/80 px-3 py-2">
                    <p className="text-sm font-semibold text-[var(--foreground)]">
                      {log.action.replace(/_/g, " ")} - {new Date(log.created_at).toLocaleString()}
                    </p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      Actor: {log.actor_email_snapshot || "unknown"} ({log.actor_role_snapshot || "unknown"}) | Source: {log.source || "n/a"}
                    </p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      Target: {log.target_type || "n/a"} / {log.target_id || "n/a"}
                    </p>
                  </div>
                ))}
                {!isAuditLoading && auditLogs.length === 0 ? <p className="text-sm text-[var(--muted)]">No audit entries yet.</p> : null}
              </div>
            ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
