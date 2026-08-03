"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import WorkspaceBrandingCard from "@/components/workspace-branding-card";
import WorkspaceSummaryCard from "@/components/workspace-summary-card";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

type VerifiedFactor = {
  id: string;
  friendly_name?: string;
  factor_type: string;
  status: string;
};

export default function MfaSettingsPanel() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { workspace } = useCurrentWorkspace();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [verifiedFactors, setVerifiedFactors] = useState<VerifiedFactor[]>([]);
  const [qrCodeSvg, setQrCodeSvg] = useState<string | null>(null);
  const [pendingFactorId, setPendingFactorId] = useState<string | null>(null);
  const [enrollmentCode, setEnrollmentCode] = useState("");

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [securityMessage, setSecurityMessage] = useState<string | null>(null);
  const [mfaMessage, setMfaMessage] = useState<string | null>(null);
  const [currentRole, setCurrentRole] = useState<"agent" | "team_lead" | "owner" | "super_admin">("agent");
  const [isEmailAutomationEnabled, setIsEmailAutomationEnabled] = useState(false);
  const [isEmailPolicyLoading, setIsEmailPolicyLoading] = useState(true);

  useEffect(() => {
    async function loadEmailPolicy(companyId: string) {
      if (!supabase) {
        setIsEmailAutomationEnabled(false);
        setIsEmailPolicyLoading(false);
        return;
      }

      setIsEmailPolicyLoading(true);

      const { data, error: policyError } = await supabase
        .from("email_ingestion_policies")
        .select("feature_enabled")
        .eq("company_id", companyId)
        .maybeSingle();

      if (policyError) {
        setIsEmailAutomationEnabled(false);
        setIsEmailPolicyLoading(false);
        return;
      }

      setIsEmailAutomationEnabled(Boolean((data as { feature_enabled?: boolean } | null)?.feature_enabled));
      setIsEmailPolicyLoading(false);
    }

    const companyId = workspace?.company_id ?? null;

    if (!companyId) {
      setIsEmailAutomationEnabled(false);
      setIsEmailPolicyLoading(false);
      return;
    }

    void loadEmailPolicy(companyId);
  }, [supabase, workspace?.company_id]);

  const loadSettings = async () => {
    if (!supabase) {
      setError("Supabase is not configured.");
      setIsLoading(false);
      return;
    }

    setError(null);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError) {
      setError(withSessionReloadFallback(userError.message, "Could not load user session."));
      setIsLoading(false);
      return;
    }

    if (user) {
      const metadata = user.user_metadata ?? {};
      setPhone(metadata.phone ?? "");

      const { data: profileData, error: profileError } = await supabase.rpc("get_current_profile");

      if (!profileError && profileData) {
        const profile = profileData as { role?: string; workspace_id?: string; first_name?: string | null; last_name?: string | null };
        const nextRole = profile.role as "agent" | "team_lead" | "owner" | "super_admin" | undefined;

        setFirstName(profile.first_name ?? "");
        setLastName(profile.last_name ?? "");

        if (nextRole) {
          setCurrentRole(nextRole);
        }
      } else {
        setFirstName(metadata.first_name ?? "");
        setLastName(metadata.last_name ?? "");
      }
    }

    const { data, error: listError } = await supabase.auth.mfa.listFactors();

    if (listError) {
      setError(withSessionReloadFallback(listError.message, "Could not load MFA factors."));
      setIsLoading(false);
      return;
    }

    setVerifiedFactors(data.totp.filter((factor) => factor.status === "verified"));
    setIsLoading(false);
  };

  useEffect(() => {
    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const refreshFromProfile = () => {
      void loadSettings();
    };

    window.addEventListener("focus", refreshFromProfile);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        refreshFromProfile();
      }
    });

    return () => {
      window.removeEventListener("focus", refreshFromProfile);
      document.removeEventListener("visibilitychange", refreshFromProfile);
    };
  }, [supabase]);

  const handleProfileSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setProfileMessage("Supabase is not configured.");
      return;
    }

    setIsSaving(true);
    setProfileMessage(null);

    const { error: profileUpdateError } = await supabase.rpc("update_current_profile_identity", {
      p_first_name: firstName.trim(),
      p_last_name: lastName.trim(),
    });

    if (profileUpdateError) {
      setIsSaving(false);
      setProfileMessage(withSessionReloadFallback(profileUpdateError.message, "Could not update profile."));
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({
      data: {
        phone: phone.trim(),
      },
    });

    setIsSaving(false);

    if (updateError) {
      setProfileMessage(withSessionReloadFallback(updateError.message, "Could not update profile."));
      return;
    }

    setProfileMessage("Profile updated.");
  };

  const handlePasswordChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setSecurityMessage("Supabase is not configured.");
      return;
    }

    if (newPassword.length < 8) {
      setSecurityMessage("New password must be at least 8 characters.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setSecurityMessage("New password and confirmation do not match.");
      return;
    }

    setIsSaving(true);
    setSecurityMessage(null);

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user?.email) {
      setIsSaving(false);
      setSecurityMessage(withSessionReloadFallback(userError?.message, "Unable to verify your current session."));
      return;
    }

    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });

    if (reauthError) {
      setIsSaving(false);
      setSecurityMessage("Current password is incorrect.");
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    setIsSaving(false);

    if (updateError) {
      setSecurityMessage(withSessionReloadFallback(updateError.message, "Could not update password."));
      return;
    }

    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setSecurityMessage("Password updated.");
  };

  const handleStartEnrollment = async () => {
    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setError(null);
    setMfaMessage(null);
    setIsSaving(true);

    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "Authenticator app",
    });

    setIsSaving(false);

    if (enrollError) {
      setError(withSessionReloadFallback(enrollError.message, "Could not start MFA enrollment."));
      return;
    }

    setPendingFactorId(data.id);
    setQrCodeSvg(data.totp.qr_code);
  };

  const handleVerifyEnrollment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase || !pendingFactorId) {
      setError("No pending enrollment challenge.");
      return;
    }

    setError(null);
    setMfaMessage(null);
    setIsSaving(true);

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: pendingFactorId,
    });

    if (challengeError) {
      setIsSaving(false);
      setError(withSessionReloadFallback(challengeError.message, "Could not start MFA verification challenge."));
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: pendingFactorId,
      challengeId: challengeData.id,
      code: enrollmentCode,
    });

    setIsSaving(false);

    if (verifyError) {
      setError(withSessionReloadFallback(verifyError.message, "Could not verify MFA enrollment."));
      return;
    }

    setMfaMessage("Two-factor authentication is enabled.");
    setEnrollmentCode("");
    setPendingFactorId(null);
    setQrCodeSvg(null);
    await loadSettings();
  };

  const handleDisableFactor = async (factorId: string) => {
    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setError(null);
    setMfaMessage(null);
    setIsSaving(true);

    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId });

    setIsSaving(false);

    if (unenrollError) {
      setError(withSessionReloadFallback(unenrollError.message, "Could not disable MFA factor."));
      return;
    }

    setMfaMessage("Two-factor authentication has been disabled for this factor.");
    await loadSettings();
  };

  return (
    <section className="settings-surface mx-auto w-full max-w-5xl space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Settings</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">Account and workspace</h1>
        <p className="mt-4 text-base leading-7 text-[var(--muted)]">
          Manage your profile, security, workspace defaults, and interface preferences.
        </p>
        <p className="mt-3 inline-flex rounded-full border border-[var(--border)] bg-white/70 px-3 py-1 text-sm font-medium text-[var(--foreground)]">
          Current role: <span className="ml-2 capitalize text-[var(--accent)]">{currentRole.replace("_", " ")}</span>
          {workspace?.name ? (
            <span className="ml-3 border-l border-[var(--border)] pl-3 text-[var(--muted)]">
              Workspace: <span className="text-[var(--foreground)]">{workspace.name}</span>
            </span>
          ) : null}
        </p>
      </div>

      <div className="space-y-4">
        {isEmailPolicyLoading ? null : isEmailAutomationEnabled ? (
          <div className="settings-card settings-email-automation-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
            <p className="text-sm font-semibold text-[var(--foreground)]">Email automation</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Configure mailbox connections and company-approved AI triage controls.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Link
                href="/settings/mailbox"
                className="settings-email-automation-link rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
              >
                Open mailbox settings
              </Link>
              <Link
                href="/settings/daily-briefing"
                className="settings-email-automation-link rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
              >
                Open daily briefing settings
              </Link>
              {currentRole === "super_admin" || currentRole === "owner" ? (
                <Link
                  href="/admin"
                  className="settings-email-automation-link rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                >
                  Manage company policy in Admin
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}

        <form onSubmit={handleProfileSave} className="settings-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-4 py-4 shadow-sm md:px-5 md:py-5">
          <p className="text-sm font-semibold text-[var(--foreground)]">Profile</p>
          <p className="mt-1 text-sm text-[var(--muted)]">Update identity details used across the workspace.</p>
          <div className="mt-3 grid gap-2.5 md:grid-cols-2">
            <input type="text" value={firstName} onChange={(event) => setFirstName(event.target.value)} required placeholder="First name" className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-2.5 text-sm outline-none focus:border-[var(--accent)]" />
            <input type="text" value={lastName} onChange={(event) => setLastName(event.target.value)} required placeholder="Last name" className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-2.5 text-sm outline-none focus:border-[var(--accent)]" />
            <input type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="Phone" className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-2.5 text-sm outline-none focus:border-[var(--accent)] md:col-span-2" />
            {profileMessage ? <p className="text-sm font-medium text-red-500">{profileMessage}</p> : null}
            <button type="submit" disabled={isSaving} className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70 md:justify-self-start">Save profile</button>
          </div>
        </form>

        <WorkspaceBrandingCard />

        {currentRole === "team_lead" || currentRole === "agent" ? <WorkspaceSummaryCard /> : null}

        <div className="settings-card settings-security-card rounded-[24px] border border-red-200 bg-[linear-gradient(160deg,rgba(255,246,246,0.92)_0%,rgba(255,255,255,0.98)_45%,rgba(255,244,245,0.9)_100%)] px-5 py-5 shadow-sm dark:border-red-800/50 dark:bg-[linear-gradient(155deg,rgba(30,20,24,0.92)_0%,rgba(20,16,22,0.95)_48%,rgba(28,18,22,0.93)_100%)]">
          <p className="text-sm font-semibold text-[var(--foreground)]">Security</p>
          <p className="mt-1 text-sm text-[var(--muted)]">Manage password reset and two-factor authentication in one security box.</p>

          <form onSubmit={handlePasswordChange} className="mt-4 space-y-3">
            <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required placeholder="Current password" className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100 dark:focus:border-red-500 dark:focus:ring-red-900/40" />
            <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={8} placeholder="New password" className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100 dark:focus:border-red-500 dark:focus:ring-red-900/40" />
            <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={8} placeholder="Confirm new password" className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100 dark:focus:border-red-500 dark:focus:ring-red-900/40" />
            {securityMessage ? <p className="text-sm font-medium text-red-500">{securityMessage}</p> : null}
            <button type="submit" disabled={isSaving} className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-70 dark:border-red-700/70 dark:bg-red-900/28 dark:text-red-100 dark:hover:bg-red-900/40">Update password</button>
          </form>

          <div className="mt-6 border-t border-red-200 pt-5 dark:border-red-800/55">
            <p className="text-sm font-semibold text-[var(--foreground)]">Two-factor authentication</p>
            <p className="mt-2 text-sm text-[var(--muted)]">{isLoading ? "Checking factors..." : verifiedFactors.length > 0 ? "2FA is enabled." : "2FA is not enabled yet."}</p>

            <div className="mt-4">
              {verifiedFactors.length > 0 ? (
                <div className="space-y-3">
                  {verifiedFactors.map((factor) => (
                    <div key={factor.id} className="flex flex-col gap-3 rounded-2xl border border-red-200 bg-white/80 p-4 sm:flex-row sm:items-center sm:justify-between dark:border-red-800/55 dark:bg-slate-900/45">
                      <div>
                        <p className="text-sm font-semibold text-[var(--foreground)]">{factor.friendly_name || "Authenticator app"}</p>
                        <p className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">{factor.factor_type} - {factor.status}</p>
                      </div>
                      <button type="button" onClick={() => void handleDisableFactor(factor.id)} disabled={isSaving} className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-70 dark:border-red-700/70 dark:bg-red-900/28 dark:text-red-100 dark:hover:bg-red-900/40">Disable</button>
                    </div>
                  ))}
                </div>
              ) : (
                <button type="button" onClick={() => void handleStartEnrollment()} disabled={isSaving} className="rounded-2xl bg-[linear-gradient(135deg,#ef4444_0%,#dc2626_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(220,38,38,0.26)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70 dark:bg-[linear-gradient(135deg,#ef4444_0%,#b91c1c_100%)] dark:shadow-[0_10px_20px_rgba(185,28,28,0.3)]">{isSaving ? "Starting..." : "Enable 2FA"}</button>
              )}

              {qrCodeSvg ? (
                <div className="mt-6 rounded-2xl border border-red-200 bg-white p-4 dark:border-red-800/55 dark:bg-slate-900/45">
                  <p className="text-sm font-medium text-[var(--foreground)]">1. Scan this QR code in your authenticator app.</p>
                  <div className="mt-4 flex justify-center rounded-xl border border-red-200 bg-slate-50 p-4 dark:border-red-800/55 dark:bg-slate-900/55" dangerouslySetInnerHTML={{ __html: qrCodeSvg }} />
                  <form onSubmit={handleVerifyEnrollment} className="mt-4 space-y-3">
                    <label htmlFor="enrollment-code" className="text-sm font-medium text-[var(--foreground)]">2. Enter the 6-digit code from the app.</label>
                    <input id="enrollment-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={enrollmentCode} onChange={(event) => setEnrollmentCode(event.target.value.replace(/\D/g, "").slice(0, 6))} required className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm tracking-[0.3em] outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100 dark:focus:border-red-500 dark:focus:ring-red-900/40" placeholder="123456" />
                    <button type="submit" disabled={isSaving} className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-70">{isSaving ? "Verifying..." : "Verify and activate"}</button>
                  </form>
                </div>
              ) : null}

              {error ? <p className="mt-4 text-sm font-medium text-red-500">{error}</p> : null}
              {mfaMessage ? <p className="mt-4 text-sm font-medium text-red-500">{mfaMessage}</p> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
