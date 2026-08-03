"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

function getSafeNextPath(nextPath: string | null) {
  if (!nextPath) {
    return "/dashboard";
  }

  return nextPath.startsWith("/") ? nextPath : "/dashboard";
}

export default function MfaVerifyPage() {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);

  const [code, setCode] = useState("");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [nextPath, setNextPath] = useState("/dashboard");
  const [isPreparing, setIsPreparing] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const setupChallenge = async () => {
      const search = new URLSearchParams(window.location.search);
      const routeNextPath = getSafeNextPath(search.get("next"));
      setNextPath(routeNextPath);

      if (!supabase) {
        setError("Supabase is not configured.");
        setIsPreparing(false);
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        router.replace(`/login?next=${encodeURIComponent(routeNextPath)}`);
        return;
      }

      const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

      if (aalData?.currentLevel === "aal2" || aalData?.nextLevel !== "aal2") {
        router.replace(routeNextPath);
        return;
      }

      const { data: factorsData, error: listError } = await supabase.auth.mfa.listFactors();

      if (listError) {
        setError(withSessionReloadFallback(listError.message, "Could not load MFA factors."));
        setIsPreparing(false);
        return;
      }

      const verifiedTotpFactor = factorsData.totp.find((factor) => factor.status === "verified");

      if (!verifiedTotpFactor) {
        setError("No verified authenticator app found. Set up 2FA from Settings first.");
        setIsPreparing(false);
        return;
      }

      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: verifiedTotpFactor.id,
      });

      if (challengeError) {
        setError(withSessionReloadFallback(challengeError.message, "Could not start MFA challenge."));
        setIsPreparing(false);
        return;
      }

      setFactorId(verifiedTotpFactor.id);
      setChallengeId(challengeData.id);
      setIsPreparing(false);
    };

    void setupChallenge();
  }, [router, supabase]);

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase || !factorId || !challengeId) {
      setError("2FA challenge is not ready yet.");
      return;
    }

    setError(null);
    setIsSubmitting(true);

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId,
      code,
    });

    setIsSubmitting(false);

    if (verifyError) {
      setError(withSessionReloadFallback(verifyError.message, "Could not verify MFA code."));
      return;
    }

    router.replace(nextPath);
    router.refresh();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-10 sm:px-6">
      <section className="w-full max-w-xl rounded-[32px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl shadow-[rgba(15,23,42,0.1)] md:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Security check</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--foreground)]">
          Enter your 2FA code
        </h1>
        <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
          Open your authenticator app and enter the 6-digit code to continue.
        </p>

        <form onSubmit={handleVerify} className="mt-6 space-y-4">
          <div className="space-y-2">
            <label htmlFor="otp" className="text-sm font-medium text-[var(--foreground)]">
              One-time code
            </label>
            <input
              id="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              required
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm tracking-[0.3em] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              placeholder="123456"
              disabled={isPreparing || isSubmitting}
            />
          </div>

          {error ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={isPreparing || isSubmitting}
            className="w-full rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isPreparing ? "Preparing challenge..." : isSubmitting ? "Verifying..." : "Verify code"}
          </button>

          <p className="text-sm text-[var(--muted)]">
            No access to your app? Go to{" "}
            <Link href="/settings" className="font-semibold text-[var(--accent)] hover:underline">
              Settings
            </Link>
            {" "}after login recovery.
          </p>
        </form>
      </section>
    </main>
  );
}