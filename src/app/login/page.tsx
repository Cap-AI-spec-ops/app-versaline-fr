"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Provider } from "@supabase/supabase-js";
import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { resolveAppearancePreferences, resolveSafeNextPath } from "@/lib/preferences/appearance";

function getSafeNextPath(nextPath: string | null) {
  if (!nextPath) {
    return null;
  }

  return resolveSafeNextPath(nextPath);
}

async function getPostLoginPath(
  supabase: NonNullable<ReturnType<typeof getSupabaseBrowserClient>>,
  requestedPath: string | null
) {
  if (requestedPath) {
    return requestedPath;
  }

  const { data: profileData } = await supabase.rpc("get_current_profile");
  const profile = profileData as { workspace_id?: string | null } | null;

  if (!profile?.workspace_id) {
    return "/onboarding";
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return resolveAppearancePreferences((user?.user_metadata as Record<string, unknown> | undefined) ?? undefined)
    .defaultLandingPage;
}

export default function LoginPage() {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [nextPath, setNextPath] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [canProceedToOnboarding, setCanProceedToOnboarding] = useState(false);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    setNextPath(getSafeNextPath(search.get("next")));

    const suggestedEmail = search.get("email");

    if (suggestedEmail) {
      setEmail(suggestedEmail);
    }

    if (search.get("verify") === "1") {
      setInfoMessage("Check your inbox and confirm your email, then sign in to continue onboarding.");
    }
  }, []);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    const checkSession = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        return;
      }

      const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      const destination = await getPostLoginPath(supabase, nextPath);

      if (destination === "/onboarding" && !nextPath) {
        setCanProceedToOnboarding(true);
        setInfoMessage("Continue to onboarding, or sign in with another account.");
        return;
      }

      if (aalData?.currentLevel === "aal2" || aalData?.nextLevel !== "aal2") {
        router.replace(destination);
        return;
      }

      router.replace(`/mfa/verify?next=${encodeURIComponent(destination)}`);
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
    setIsLoading(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setIsLoading(false);

    if (signInError) {
      setError(withSessionReloadFallback(signInError.message, "Could not sign in. Please try again."));
      return;
    }

    setCanProceedToOnboarding(false);

    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    const destination = await getPostLoginPath(supabase, nextPath);

    if (aalData?.currentLevel !== "aal2" && aalData?.nextLevel === "aal2") {
      router.replace(`/mfa/verify?next=${encodeURIComponent(destination)}`);
      router.refresh();
      return;
    }

    router.replace(destination);
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
    setInfoMessage(null);

    const nextParam = nextPath ? `?next=${encodeURIComponent(nextPath)}` : "";
    const redirectTo = `${window.location.origin}/login${nextParam}`;

    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
      },
    });

    if (oauthError) {
      setError(withSessionReloadFallback(oauthError.message, "Could not sign in with OAuth. Please try again."));
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-10 sm:px-6">
      <section className="grid w-full max-w-5xl gap-6 rounded-[32px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl shadow-[rgba(15,23,42,0.1)] md:grid-cols-[1.2fr_1fr] md:p-10">
        <div className="rounded-[24px] bg-[linear-gradient(165deg,rgba(59,130,246,0.16)_0%,rgba(99,102,241,0.14)_100%)] p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
            Welcome back
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--foreground)]">
            Sign in to Versaline
          </h1>
          <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
            Access your workspace with your email and password.
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
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              placeholder="Your password"
            />
          </div>

          {error ? (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          {infoMessage ? (
            <p className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-700">
              {infoMessage}
            </p>
          ) : null}

          {canProceedToOnboarding ? (
            <button
              type="button"
              onClick={() => {
                router.replace("/onboarding");
                router.refresh();
              }}
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
            >
              Proceed to onboarding
            </button>
          ) : null}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {isLoading ? "Signing in..." : "Sign in"}
          </button>

          <p className="text-sm text-[var(--muted)]">
            No account yet?{" "}
            <Link href={nextPath ? `/signup?next=${encodeURIComponent(nextPath)}` : "/signup"} className="font-semibold text-[var(--accent)] hover:underline">
              Create one
            </Link>
          </p>
        </form>
      </section>
    </main>
  );
}