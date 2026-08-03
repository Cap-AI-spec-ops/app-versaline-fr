"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";
import { useWorkspaceMembers } from "@/lib/workspace/use-workspace-members";

type WorkspaceRole = "agent" | "team_lead" | "owner" | "super_admin";
type CreditAllocationMode = "workspace_shared" | "per_person";

function resolveEffectiveCreditMode(
  ownerMode: CreditAllocationMode | undefined,
  control: "owner_locked" | "team_lead_select" | undefined,
  teamLeadMode: CreditAllocationMode | null | undefined,
): CreditAllocationMode {
  if (control === "team_lead_select" && teamLeadMode) {
    return teamLeadMode;
  }

  return ownerMode ?? "workspace_shared";
}

function formatRoleLabel(role: WorkspaceRole) {
  return role.replace("_", " ");
}

function formatMemberName(firstName: string | null, lastName: string | null) {
  const fullName = [firstName ?? "", lastName ?? ""].join(" ").trim();
  return fullName || "Unnamed member";
}

export default function WorkspaceSummaryCard() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { workspace } = useCurrentWorkspace();
  const { members: workspaceMembers, isLoading: isMembersLoading, error: membersError, currentUserId } = useWorkspaceMembers();

  const [currentRole, setCurrentRole] = useState<WorkspaceRole>("agent");
  const [inviterName, setInviterName] = useState("A teammate");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"agent" | "team_lead">("agent");
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [isInviting, setIsInviting] = useState(false);
  const [creditMode, setCreditMode] = useState<CreditAllocationMode>("workspace_shared");
  const [creditMessage, setCreditMessage] = useState<string | null>(null);
  const [isSavingCreditMode, setIsSavingCreditMode] = useState(false);

  const canTeamLeadChooseCreditMode =
    currentRole === "team_lead" && workspace?.credit_allocation_control === "team_lead_select";

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

      if (profile.role) {
        setCurrentRole(profile.role);
      }
    };

    void loadProfile();
  }, [supabase]);

  useEffect(() => {
    setCreditMode(
      resolveEffectiveCreditMode(
        workspace?.credit_allocation_mode,
        workspace?.credit_allocation_control,
        workspace?.team_lead_credit_allocation_mode,
      ),
    );
  }, [
    workspace?.credit_allocation_mode,
    workspace?.credit_allocation_control,
    workspace?.team_lead_credit_allocation_mode,
  ]);

  const canInviteMembers = currentRole === "team_lead";

  const handleInviteSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setInviteMessage("Supabase is not configured.");
      return;
    }

    if (!canInviteMembers) {
      setInviteMessage("Only team leads can invite teammates from this page.");
      return;
    }

    if (!workspace?.id) {
      setInviteMessage("You need an assigned workspace before you can invite teammates.");
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
      p_workspace_id: workspace.id,
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
    const workspaceName = workspace.name?.trim() || "your workspace";

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

  const handleCreditModeSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setCreditMessage("Supabase is not configured.");
      return;
    }

    if (!workspace?.id) {
      setCreditMessage("Workspace not found.");
      return;
    }

    if (!canTeamLeadChooseCreditMode) {
      setCreditMessage("Your owner has locked credit mode for this workspace.");
      return;
    }

    setIsSavingCreditMode(true);
    setCreditMessage(null);

    const { error } = await supabase.rpc("set_workspace_credit_mode_by_team_lead", {
      p_workspace_id: workspace.id,
      p_credit_allocation_mode: creditMode,
      p_source: "settings_page",
    });

    setIsSavingCreditMode(false);

    if (error) {
      setCreditMessage(error.message);
      return;
    }

    setCreditMessage("Credit mode updated for this workspace.");
  };

  return (
    <div className="settings-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
      <p className="text-sm font-semibold text-[var(--foreground)]">Workspace</p>
      <p className="mt-1 text-sm text-[var(--muted)]">Quick view of your current workspace and team.</p>

      <div className="mt-4 rounded-2xl border border-[var(--border)] bg-white/70 p-4">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--muted)]">Workspace name</p>
        <p className="mt-2 text-base font-semibold text-[var(--foreground)]">{workspace?.name || "No workspace assigned"}</p>
        <p className="mt-2 text-xs uppercase tracking-[0.14em] text-[var(--muted)]">
          Effective credits mode: {resolveEffectiveCreditMode(
            workspace?.credit_allocation_mode,
            workspace?.credit_allocation_control,
            workspace?.team_lead_credit_allocation_mode,
          ).replace("_", " ")}
        </p>
      </div>

      {currentRole === "team_lead" ? (
        <form onSubmit={handleCreditModeSave} className="mt-4 rounded-2xl border border-[var(--border)] bg-white/70 p-4">
          <p className="text-sm font-semibold text-[var(--foreground)]">Credits mode</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {canTeamLeadChooseCreditMode
              ? "Your owner lets team leads choose the mode for this workspace."
              : "Your owner has locked this workspace credit mode."}
          </p>
          <div className="mt-3 space-y-3">
            <select
              value={creditMode}
              onChange={(event) => setCreditMode(event.target.value as CreditAllocationMode)}
              disabled={!canTeamLeadChooseCreditMode || isSavingCreditMode}
              className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="workspace_shared">Shared across workspace</option>
              <option value="per_person">Per person</option>
            </select>
            {creditMessage ? (
              <p className={`text-sm font-medium ${creditMessage === "Credit mode updated for this workspace." ? "text-emerald-700" : "text-red-500"}`}>
                {creditMessage}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={!canTeamLeadChooseCreditMode || isSavingCreditMode}
              className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSavingCreditMode ? "Saving..." : "Save credits mode"}
            </button>
          </div>
        </form>
      ) : null}

      <div className="mt-4 rounded-2xl border border-[var(--border)] bg-white/70 p-4">
        <p className="text-sm font-semibold text-[var(--foreground)]">Team members</p>
        <div className="mt-3 space-y-2">
          {isMembersLoading ? (
            <p className="text-sm text-[var(--muted)]">Loading members...</p>
          ) : workspaceMembers.length > 0 ? (
            workspaceMembers.map((member) => (
              <div key={member.profile_id} className="flex flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="truncate text-sm font-medium text-[var(--foreground)]">
                  {formatMemberName(member.first_name, member.last_name)}
                  {member.profile_id === currentUserId ? " (You)" : ""}
                </p>
                <p className="text-xs capitalize tracking-[0.12em] text-[var(--muted)]">{formatRoleLabel(member.role)}</p>
              </div>
            ))
          ) : (
            <p className="text-sm text-[var(--muted)]">No members found.</p>
          )}
          {membersError ? <p className="text-sm font-medium text-red-500">{membersError}</p> : null}
        </div>
      </div>

      {canInviteMembers ? (
        <div className="mt-6 border-t border-[var(--border)] pt-5">
          <p className="text-sm font-semibold text-[var(--foreground)]">Invite teammates</p>
          <p className="mt-1 text-sm text-[var(--muted)]">Create invite links for agents or other team leads.</p>
          <form onSubmit={handleInviteSubmit} className="mt-4 space-y-3">
            <input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} disabled={isInviting} placeholder="coworker@example.com" className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50" />
            <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "agent" | "team_lead")} disabled={isInviting} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50">
              <option value="agent">Role: Agent</option>
              <option value="team_lead">Role: Team lead</option>
            </select>
            {inviteMessage ? <p className={`text-sm font-medium ${inviteMessage.startsWith("Invitation sent") ? "text-emerald-700" : "text-red-500"}`}>{inviteMessage}</p> : null}
            {inviteLink ? <div className="rounded-2xl border border-[var(--border)] bg-white/80 p-4"><p className="text-sm font-semibold text-[var(--foreground)]">Share this invite link</p><a href={inviteLink} className="mt-2 block break-all text-sm text-[var(--accent)] underline">{inviteLink}</a></div> : null}
            <button type="submit" disabled={isInviting} className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70">{isInviting ? "Sending invite..." : "Send invite"}</button>
          </form>
        </div>
      ) : null}
    </div>
  );
}