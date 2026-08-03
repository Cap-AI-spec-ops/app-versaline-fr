"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
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