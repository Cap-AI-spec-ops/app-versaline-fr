"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Provider } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { resolveSafeNextPath } from "@/lib/preferences/appearance";

export default function SignupPage() {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nextPath, setNextPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const requestedNext = search.get("next");

    if (requestedNext) {
      setNextPath(resolveSafeNextPath(requestedNext));
    }
  }, []);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    const checkSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session) {
        const { data: profileData } = await supabase.rpc("get_current_profile");
        const profile = profileData as { workspace_id?: string | null } | null;
        const destination = nextPath ?? (profile?.workspace_id ? "/dashboard" : "/onboarding");
        router.replace(destination);
      }
    };

    void checkSession();
  }, [nextPath, router, supabase]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setError(
        "Supabase is not configured yet. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local."
      );
      return;
    }

    setError(null);
    setSuccessMessage(null);
    setIsLoading(true);

    const normalizedEmail = email.trim().toLowerCase();

    const { data: emailTakenData, error: emailTakenError } = await supabase.rpc(
      "is_registration_email_taken",
      {
        p_email: normalizedEmail,
      }
    );

    if (!emailTakenError && emailTakenData === true) {
      setIsLoading(false);
      setError("An account with this email already exists. Please sign in.");
      return;
    }

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        emailRedirectTo:
          typeof window !== "undefined"
            ? `${window.location.origin}/login${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`
            : undefined,
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          full_name: `${firstName.trim()} ${lastName.trim()}`,
        },
      },
    });

    setIsLoading(false);

    if (signUpError) {
      const duplicateEmailError = /already|registered|exists/i.test(signUpError.message);
      setError(
        duplicateEmailError
          ? "An account with this email already exists. Please sign in."
          : signUpError.message
      );
      return;
    }

    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      setError("An account with this email already exists. Please sign in.");
      return;
    }

    if (data.session) {
      const { data: profileData } = await supabase.rpc("get_current_profile");
      const profile = profileData as { workspace_id?: string | null } | null;
      const destination = nextPath ?? (profile?.workspace_id ? "/dashboard" : "/onboarding");
      router.replace(destination);
      router.refresh();
      return;
    }

    const postVerifyNext = nextPath ?? "/onboarding";
    const verifyLoginPath = `/login?verify=1&email=${encodeURIComponent(normalizedEmail)}&next=${encodeURIComponent(postVerifyNext)}`;
    router.replace(verifyLoginPath);
    router.refresh();
  };

  const handleOAuthSignIn = async (provider: Provider) => {
    if (!supabase) {
      setError(
        "Supabase is not configured yet. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local."
      );
      return;
    }

    setError(null);
    setSuccessMessage(null);

    const nextParam = nextPath ? `?next=${encodeURIComponent(nextPath)}` : "";
    const redirectTo = `${window.location.origin}/login${nextParam}`;

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
      },
    });

    if (oauthError) {
      setError(oauthError.message || "Could not continue with OAuth. Please try again.");
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-10 sm:px-6">
      <section className="grid w-full max-w-5xl gap-6 rounded-[32px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl shadow-[rgba(15,23,42,0.1)] md:grid-cols-[1.2fr_1fr] md:p-10">
        <div className="rounded-[24px] bg-[linear-gradient(165deg,rgba(16,185,129,0.14)_0%,rgba(59,130,246,0.14)_100%)] p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
            Create account
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--foreground)]">
            Join Versaline
          </h1>
          <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
            Register with your email and password. You will choose create or join in the next step.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => void handleOAuthSignIn("google")}
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 flex items-center justify-center gap-2.5"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
                <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </button>
            <button
              type="button"
              onClick={() => void handleOAuthSignIn("azure")}
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 flex items-center justify-center gap-2.5"
            >
              <svg width="18" height="18" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <rect x="0" y="11" width="26" height="26" rx="2" fill="#0078D4"/>
                <ellipse cx="13" cy="24" rx="5" ry="5.5" fill="none" stroke="#fff" strokeWidth="2.5"/>
                <path d="M24 11h20a2 2 0 0 1 2 2v22a2 2 0 0 1-2 2H24V11Z" fill="#28A8E0"/>
                <path d="M24 11h20l-10 9.5L24 11Z" fill="#50D9FF"/>
                <path d="M24 37h20L34 27.5 24 37Z" fill="#0078D4"/>
                <path d="M44 11v26L34 27.5l10-16.5Z" fill="#0364B8"/>
                <path d="M24 11v26l10-9.5L24 11Z" fill="#0078D4"/>
              </svg>
              Continue with Outlook
            </button>
            <p className="text-center text-xs uppercase tracking-[0.22em] text-[var(--muted)]">or</p>
          </div>

          <div className="space-y-2">
            <label htmlFor="first-name" className="text-sm font-medium text-[var(--foreground)]">
              First name
            </label>
            <input
              id="first-name"
              type="text"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              required
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              placeholder="John"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="last-name" className="text-sm font-medium text-[var(--foreground)]">
              Last name
            </label>
            <input
              id="last-name"
              type="text"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              required
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              placeholder="Doe"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-medium text-[var(--foreground)]">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              placeholder="you@example.com"
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium text-[var(--foreground)]">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={6}
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              placeholder="At least 6 characters"
            />
          </div>

          {error ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          {successMessage ? (
            <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {successMessage}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-2xl bg-[linear-gradient(135deg,#10b981_0%,#3b82f6_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.2)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isLoading ? "Creating account..." : "Create account"}
          </button>

          <p className="text-sm text-[var(--muted)]">
            Already have an account?{" "}
            <Link href={nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : "/login"} className="font-semibold text-[var(--accent)] hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </section>
    </main>
  );
}