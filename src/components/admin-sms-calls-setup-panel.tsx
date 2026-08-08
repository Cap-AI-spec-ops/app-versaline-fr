"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

type WorkspaceRole = "agent" | "team_lead" | "owner" | "super_admin";

type CompanyPolicyRow = {
  twilio_control: "owner_locked" | "team_lead_select" | null;
};

type TwilioAccountRow = {
  id: string;
  friendly_name: string | null;
  subaccount_sid: string;
  forwarding_number: string | null;
  status: string;
};

type TwilioNumberRow = {
  id: string;
  phone_number: string;
  phone_number_sid: string;
  friendly_name: string | null;
  capabilities_sms: boolean;
  capabilities_mms: boolean;
  capabilities_voice: boolean;
  capabilities_whatsapp: boolean;
  status: string;
};

type TwilioWhatsAppSenderRow = {
  id: string;
  twilio_number_id: string;
  sender_sid: string;
  sender_id: string;
  status: string;
  verification_method: "sms" | "voice" | null;
  last_synced_at: string | null;
  error_message: string | null;
};

export default function AdminSmsCallsSetupPanel() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { workspace, currentRole } = useCurrentWorkspace();

  const [account, setAccount] = useState<TwilioAccountRow | null>(null);
  const [numbers, setNumbers] = useState<TwilioNumberRow[]>([]);
  const [whatsAppSender, setWhatsAppSender] = useState<TwilioWhatsAppSenderRow | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isWhatsAppSaving, setIsWhatsAppSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [twilioControlMode, setTwilioControlMode] = useState<"owner_locked" | "team_lead_select">("owner_locked");

  const [countryCode, setCountryCode] = useState("FR");
  const [preferredType, setPreferredType] = useState<"local" | "mobile" | "tollfree">("local");
  const [requireSms, setRequireSms] = useState(true);
  const [requireVoice, setRequireVoice] = useState(true);
  const [includeWhatsApp, setIncludeWhatsApp] = useState(true);
  const [forwardingNumber, setForwardingNumber] = useState("");
  const [verificationMethod, setVerificationMethod] = useState<"sms" | "voice">("sms");
  const [verificationCode, setVerificationCode] = useState("");

  const role = (currentRole ?? "agent") as WorkspaceRole;
  const canManage = role === "owner" || (role === "team_lead" && twilioControlMode === "team_lead_select");

  useEffect(() => {
    if (!supabase || !workspace?.id || !workspace.company_id) {
      setIsLoading(false);
      return;
    }

    void loadSetup(workspace.id, workspace.company_id);
  }, [supabase, workspace?.id, workspace?.company_id]);

  async function loadSetup(workspaceId: string, companyId: string) {
    if (!supabase) {
      return;
    }

    setIsLoading(true);

    const [accountResult, numbersResult, senderResult, policyResult] = await Promise.all([
      supabase
        .from("workspace_twilio_accounts")
        .select("id, friendly_name, subaccount_sid, forwarding_number, status")
        .eq("workspace_id", workspaceId)
        .maybeSingle<TwilioAccountRow>(),
      supabase
        .from("workspace_twilio_numbers")
        .select("id, phone_number, phone_number_sid, friendly_name, capabilities_sms, capabilities_mms, capabilities_voice, capabilities_whatsapp, status")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: true }),
      supabase
        .from("workspace_twilio_whatsapp_senders")
        .select("id, twilio_number_id, sender_sid, sender_id, status, verification_method, last_synced_at, error_message")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<TwilioWhatsAppSenderRow>(),
      supabase
        .from("email_ingestion_policies")
        .select("twilio_control")
        .eq("company_id", companyId)
        .maybeSingle<CompanyPolicyRow>(),
    ]);

    setTwilioControlMode(policyResult.data?.twilio_control === "team_lead_select" ? "team_lead_select" : "owner_locked");

    if (accountResult.data) {
      setAccount(accountResult.data);
      setForwardingNumber(accountResult.data.forwarding_number ?? "");
    } else {
      setAccount(null);
      setForwardingNumber("");
    }

    setNumbers((numbersResult.data ?? []) as TwilioNumberRow[]);
    setWhatsAppSender(senderResult.data ?? null);

    if (senderResult.data?.verification_method) {
      setVerificationMethod(senderResult.data.verification_method);
    }

    setIsLoading(false);
  }

  const activeNumbers = numbers.filter((num) => num.status === "active");
  const activeNumber = activeNumbers[0] ?? null;
  const needsVerificationCode = whatsAppSender?.status === "PENDING_VERIFICATION" || whatsAppSender?.status === "VERIFYING";

  async function handleManagedProvision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!workspace?.id || !workspace.company_id) {
      setError("Workspace not found.");
      return;
    }

    if (!requireSms && !requireVoice) {
      setError("Enable at least one channel: SMS or voice.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/twilio/managed-setup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        countryCode: countryCode.trim().toUpperCase(),
        preferredType,
        requireSms,
        requireVoice,
        forwardingNumber: forwardingNumber.trim() || null,
      }),
    });

    const payload = (await response.json()) as { error?: string; mode?: string; number?: { phoneNumber?: string } };

    setIsSaving(false);

    if (!response.ok) {
      setError(withSessionReloadFallback(payload.error ?? "Managed setup failed.", "Could not configure SMS and calls."));
      return;
    }

    if (includeWhatsApp) {
      setIsWhatsAppSaving(true);

      const whatsAppResponse = await fetch("/api/twilio/whatsapp-sender", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspaceId: workspace.id,
          action: "create",
          verificationMethod,
        }),
      });

      const whatsAppPayload = (await whatsAppResponse.json()) as {
        error?: string;
        sender?: { status?: string; isOnline?: boolean };
      };

      setIsWhatsAppSaving(false);

      if (!whatsAppResponse.ok) {
        setMessage(
          `SMS and voice setup completed for ${payload.number?.phoneNumber ?? "the workspace number"}, but WhatsApp activation could not start.`,
        );
        setError(withSessionReloadFallback(whatsAppPayload.error ?? "WhatsApp setup failed.", "Could not start WhatsApp activation."));
        void loadSetup(workspace.id, workspace.company_id);
        return;
      }

      if (whatsAppPayload.sender?.isOnline) {
        setMessage(`Setup completed. ${payload.number?.phoneNumber ?? "The workspace number"} is active for SMS, voice, and WhatsApp.`);
      } else {
        setMessage(
          `Setup completed. ${payload.number?.phoneNumber ?? "The workspace number"} is active for SMS and voice, and WhatsApp activation has started (${whatsAppPayload.sender?.status ?? "unknown"}).`,
        );
      }

      void loadSetup(workspace.id, workspace.company_id);
      return;
    }

    setMessage(
      payload.mode === "already_configured"
        ? "Setup verified. Existing number is active and webhooks are synced."
        : `Setup completed. Workspace number ${payload.number?.phoneNumber ?? ""} is now active.`,
    );
    void loadSetup(workspace.id, workspace.company_id);
  }

  async function handleDeactivateNumber(numberId: string) {
    if (!supabase || !workspace?.id || !workspace.company_id || !account) {
      return;
    }

    if (!window.confirm("Deactivate this number for the workspace?")) {
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const { error: updateError } = await supabase
      .from("workspace_twilio_numbers")
      .update({ status: "inactive" })
      .eq("id", numberId)
      .eq("workspace_id", workspace.id);

    setIsSaving(false);

    if (updateError) {
      setError(withSessionReloadFallback(updateError.message, "Could not deactivate number."));
      return;
    }

    setMessage("Number deactivated. You can run managed setup again to provision a new number.");
    void loadSetup(workspace.id, workspace.company_id);
  }

  async function handleWhatsAppAction(action: "create" | "refresh" | "verify") {
    if (!workspace?.id || !workspace.company_id) {
      setError("Workspace not found.");
      return;
    }

    if (action === "verify" && verificationCode.trim().length < 3) {
      setError("Enter the verification code sent by WhatsApp before submitting.");
      return;
    }

    setIsWhatsAppSaving(true);
    setError(null);
    setMessage(null);

    const response = await fetch("/api/twilio/whatsapp-sender", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: workspace.id,
        action,
        verificationMethod,
        verificationCode: action === "verify" ? verificationCode.trim() : undefined,
      }),
    });

    const payload = (await response.json()) as {
      error?: string;
      sender?: { status?: string; isOnline?: boolean };
    };

    setIsWhatsAppSaving(false);

    if (!response.ok) {
      setError(withSessionReloadFallback(payload.error ?? "WhatsApp setup failed.", "Could not update WhatsApp activation."));
      return;
    }

    setVerificationCode("");

    if (payload.sender?.isOnline) {
      setMessage("WhatsApp is now online for this workspace number.");
    } else if (action === "create") {
      setMessage(`WhatsApp activation started. Sender status: ${payload.sender?.status ?? "unknown"}.`);
    } else if (action === "verify") {
      setMessage(`Verification submitted. Sender status: ${payload.sender?.status ?? "unknown"}.`);
    } else {
      setMessage(`WhatsApp sender refreshed. Status: ${payload.sender?.status ?? "unknown"}.`);
    }

    void loadSetup(workspace.id, workspace.company_id);
  }

  if (!canManage) {
    return (
      <div className="settings-card admin-card rounded-[24px] border border-amber-300/60 bg-amber-100/30 px-5 py-5 shadow-sm">
        <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Provisioning access restricted</p>
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-200">
          Only workspace owners can create SMS and call numbers by default. Team leads can do it only when the owner sets Twilio control to delegated mode.
        </p>
      </div>
    );
  }

  return (
    <div className="settings-card admin-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[var(--foreground)]">SMS &amp; calls managed setup</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            One-click number provisioning for SMS and voice, with optional WhatsApp activation started in the same flow.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsPanelOpen((open) => !open)}
          className="admin-disclosure-hint"
          aria-expanded={isPanelOpen}
        >
          {isPanelOpen ? "Hide" : "Open"}
        </button>
      </div>

      {!isPanelOpen ? <p className="mt-3 text-sm text-[var(--muted)]">This section is collapsed.</p> : null}

      {isPanelOpen && !isLoading ? (
        <div className="mt-4 space-y-6">
          {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
          {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}

          <form onSubmit={(event) => void handleManagedProvision(event)} className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Provisioning inputs</p>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
                <span className="text-xs uppercase tracking-[0.1em] text-[var(--muted)]">Country code</span>
                <input
                  value={countryCode}
                  onChange={(event) => setCountryCode(event.target.value.toUpperCase())}
                  maxLength={2}
                  placeholder="FR"
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-sm uppercase outline-none focus:border-[var(--accent)]"
                />
              </label>

              <label className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
                <span className="text-xs uppercase tracking-[0.1em] text-[var(--muted)]">Number preference</span>
                <select
                  value={preferredType}
                  onChange={(event) => setPreferredType(event.target.value as "local" | "mobile" | "tollfree")}
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                >
                  <option value="local">Local</option>
                  <option value="mobile">Mobile</option>
                  <option value="tollfree">Toll free</option>
                </select>
              </label>

              <label className="sm:col-span-2 flex flex-col gap-1 text-sm text-[var(--foreground)]">
                <span className="text-xs uppercase tracking-[0.1em] text-[var(--muted)]">Call forwarding number (optional)</span>
                <input
                  value={forwardingNumber}
                  onChange={(event) => setForwardingNumber(event.target.value)}
                  placeholder="+33600000000"
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                />
                <span className="text-xs text-[var(--muted)]">If set, inbound calls can be forwarded to this number after consent prompt.</span>
              </label>
            </div>

            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 text-xs text-[var(--foreground)]">
                <input type="checkbox" checked={requireSms} onChange={(event) => setRequireSms(event.target.checked)} className="h-3.5 w-3.5" />
                SMS
              </label>
              <label className="flex items-center gap-1.5 text-xs text-[var(--foreground)]">
                <input type="checkbox" checked={requireVoice} onChange={(event) => setRequireVoice(event.target.checked)} className="h-3.5 w-3.5" />
                Voice
              </label>
              <label className="flex items-center gap-1.5 text-xs text-[var(--foreground)]">
                <input type="checkbox" checked={includeWhatsApp} onChange={(event) => setIncludeWhatsApp(event.target.checked)} className="h-3.5 w-3.5" />
                Start WhatsApp activation
              </label>
            </div>

            {includeWhatsApp ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
                  <span className="text-xs uppercase tracking-[0.1em] text-[var(--muted)]">WhatsApp verification</span>
                  <select
                    value={verificationMethod}
                    onChange={(event) => setVerificationMethod(event.target.value as "sms" | "voice")}
                    className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  >
                    <option value="sms">SMS OTP</option>
                    <option value="voice">Voice OTP</option>
                  </select>
                </label>
                <div className="flex flex-col justify-end">
                  <p className="text-xs text-[var(--muted)]">
                    After number setup, the panel will automatically create the WhatsApp sender and then wait for verification if Twilio requires it.
                  </p>
                </div>
              </div>
            ) : null}

            <button
              type="submit"
              disabled={isSaving || isWhatsAppSaving}
              className="rounded-xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[rgba(59,130,246,0.2)] disabled:opacity-70"
            >
              {isSaving || isWhatsAppSaving ? "Provisioning..." : activeNumber ? "Re-run automated setup" : includeWhatsApp ? "Auto-configure SMS, calls, and WhatsApp" : "Auto-configure SMS and calls"}
            </button>
          </form>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Workspace status</p>

            {account ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <p className="text-sm font-semibold text-[var(--foreground)]">Account status: {account.status}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Twilio account is managed by backend automation. Technical IDs remain hidden from workspace users.
                </p>
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">No managed account yet.</p>
            )}

            {activeNumber ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">{activeNumber.phone_number}</p>
                  {activeNumber.friendly_name ? <p className="text-xs text-[var(--muted)]">{activeNumber.friendly_name}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {activeNumber.capabilities_sms ? <span className="rounded-full border border-emerald-200/70 bg-emerald-100/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-700 dark:text-emerald-300">SMS</span> : null}
                    {activeNumber.capabilities_voice ? <span className="rounded-full border border-sky-200/70 bg-sky-100/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-sky-700 dark:text-sky-300">Voice</span> : null}
                    {activeNumber.capabilities_whatsapp ? <span className="rounded-full border border-teal-200/70 bg-teal-100/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-teal-700 dark:text-teal-300">WhatsApp</span> : null}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={isSaving || isWhatsAppSaving}
                  onClick={() => void handleDeactivateNumber(activeNumber.id)}
                  className="rounded-lg border border-rose-300/60 bg-rose-100/30 px-2.5 py-1.5 text-xs font-semibold text-rose-700 dark:text-rose-300 transition hover:bg-rose-100/40 disabled:opacity-60"
                >
                  Deactivate number
                </button>
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">No active number yet. Run automated setup to provision one.</p>
            )}
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">WhatsApp activation</p>

            {!activeNumber ? (
              <p className="text-sm text-[var(--muted)]">Provision an active workspace number above before starting WhatsApp activation.</p>
            ) : (
              <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)]">Activate WhatsApp on {activeNumber.phone_number}</p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      This creates and tracks a Twilio WhatsApp sender for the existing workspace number. Messaging stays disabled until the sender is online.
                    </p>
                  </div>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${activeNumber.capabilities_whatsapp ? "border-teal-300/70 bg-teal-100/20 text-teal-700 dark:text-teal-300" : "border-slate-300/70 bg-slate-100/40 text-slate-700 dark:text-slate-300"}`}>
                    {whatsAppSender?.status ?? (activeNumber.capabilities_whatsapp ? "ONLINE" : "NOT_STARTED")}
                  </span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
                    <span className="text-xs uppercase tracking-[0.1em] text-[var(--muted)]">Verification method</span>
                    <select
                      value={verificationMethod}
                      onChange={(event) => setVerificationMethod(event.target.value as "sms" | "voice")}
                      disabled={Boolean(whatsAppSender)}
                      className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)] disabled:opacity-60"
                    >
                      <option value="sms">SMS OTP</option>
                      <option value="voice">Voice OTP</option>
                    </select>
                  </label>

                  <div className="flex flex-col gap-1 text-sm text-[var(--foreground)]">
                    <span className="text-xs uppercase tracking-[0.1em] text-[var(--muted)]">Current status</span>
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--foreground)]">
                      {whatsAppSender?.status ?? "Not started"}
                    </div>
                  </div>

                  {needsVerificationCode ? (
                    <label className="sm:col-span-2 flex flex-col gap-1 text-sm text-[var(--foreground)]">
                      <span className="text-xs uppercase tracking-[0.1em] text-[var(--muted)]">Verification code</span>
                      <input
                        value={verificationCode}
                        onChange={(event) => setVerificationCode(event.target.value)}
                        placeholder="Enter the WhatsApp verification code"
                        className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      />
                      <span className="text-xs text-[var(--muted)]">
                        Submit the code after WhatsApp sends it to the selected verification channel.
                      </span>
                    </label>
                  ) : null}
                </div>

                {whatsAppSender?.last_synced_at ? (
                  <p className="text-xs text-[var(--muted)]">Last synced: {new Date(whatsAppSender.last_synced_at).toLocaleString()}</p>
                ) : null}

                {whatsAppSender?.error_message ? (
                  <p className="text-xs font-medium text-red-600">Last Twilio error: {whatsAppSender.error_message}</p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {!whatsAppSender ? (
                    <button
                      type="button"
                      disabled={isWhatsAppSaving || isSaving}
                      onClick={() => void handleWhatsAppAction("create")}
                      className="rounded-xl bg-[linear-gradient(135deg,#0f766e_0%,#0d9488_100%)] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[rgba(13,148,136,0.2)] disabled:opacity-70"
                    >
                      {isWhatsAppSaving ? "Starting..." : "Start WhatsApp activation"}
                    </button>
                  ) : null}

                  {needsVerificationCode ? (
                    <button
                      type="button"
                      disabled={isWhatsAppSaving || isSaving}
                      onClick={() => void handleWhatsAppAction("verify")}
                      className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--surface)] disabled:opacity-70"
                    >
                      {isWhatsAppSaving ? "Submitting..." : "Submit verification code"}
                    </button>
                  ) : null}

                  {whatsAppSender ? (
                    <button
                      type="button"
                      disabled={isWhatsAppSaving || isSaving}
                      onClick={() => void handleWhatsAppAction("refresh")}
                      className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--surface)] disabled:opacity-70"
                    >
                      {isWhatsAppSaving ? "Refreshing..." : "Refresh sender status"}
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
