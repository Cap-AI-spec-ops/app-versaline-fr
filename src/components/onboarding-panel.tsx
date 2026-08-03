"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  MARKET_LANGUAGE_OPTIONS,
  MARKET_LOCALE_OPTIONS,
  MARKET_PRESETS,
  MARKET_TIMEZONE_OPTIONS,
  getMarketPresetByCountry,
} from "@/lib/market/market-presets";

type OnboardingMode = "create" | "join";
type CreditAllocationMode = "workspace_shared" | "per_person";
type CreditAllocationControl = "owner_locked" | "team_lead_select";

function extractInviteToken(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const parsed = new URL(trimmed);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const inviteIndex = segments.findIndex((segment) => segment === "invite");

      if (inviteIndex >= 0 && segments[inviteIndex + 1]) {
        return segments[inviteIndex + 1];
      }
    } catch {
      return null;
    }
  }

  if (trimmed.includes("/")) {
    const segments = trimmed.split("/").filter(Boolean);
    return segments[segments.length - 1] || null;
  }

  return trimmed;
}

export default function OnboardingPanel() {
  const router = useRouter();
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);

  const [mode, setMode] = useState<OnboardingMode>("create");
  const [isLoading, setIsLoading] = useState(true);

  const [companyName, setCompanyName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [metricSystem, setMetricSystem] = useState("metric");
  const [defaultCountryCode, setDefaultCountryCode] = useState("FR");
  const [defaultLocale, setDefaultLocale] = useState("fr-FR");
  const [defaultLanguage, setDefaultLanguage] = useState("fr");
  const [defaultTimezone, setDefaultTimezone] = useState("Europe/Paris");
  const [creditAllocationMode, setCreditAllocationMode] = useState<CreditAllocationMode>("workspace_shared");
  const [creditAllocationControl, setCreditAllocationControl] = useState<CreditAllocationControl>("owner_locked");
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [inviteInput, setInviteInput] = useState("");
  const [joinMessage, setJoinMessage] = useState<string | null>(null);

  useEffect(() => {
    const checkProfile = async () => {
      if (!supabase) {
        setIsLoading(false);
        return;
      }

      const { data: profileData } = await supabase.rpc("get_current_profile");
      const profile = profileData as { workspace_id?: string | null } | null;

      if (profile?.workspace_id) {
        router.replace("/dashboard");
        return;
      }

      setIsLoading(false);
    };

    void checkProfile();
  }, [router, supabase]);

  const handleCreateCompany = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setCreateMessage("Supabase is not configured.");
      return;
    }

    const trimmedCompany = companyName.trim();
    const trimmedWorkspace = workspaceName.trim();

    if (!trimmedCompany || !trimmedWorkspace) {
      setCreateMessage("Company and workspace names are required.");
      return;
    }

    setIsCreating(true);
    setCreateMessage(null);

    const { error } = await supabase.rpc("bootstrap_company_workspace", {
      p_company_name: trimmedCompany,
      p_workspace_name: trimmedWorkspace,
      p_currency: currency,
      p_metric_system: metricSystem,
      p_default_country_code: defaultCountryCode,
      p_default_locale: defaultLocale,
      p_default_language: defaultLanguage,
      p_default_timezone: defaultTimezone,
      p_credit_allocation_mode: creditAllocationMode,
      p_credit_allocation_control: creditAllocationControl,
      p_idempotency_key: crypto.randomUUID(),
      p_source: "onboarding_page",
    });

    setIsCreating(false);

    if (error) {
      setCreateMessage(error.message);
      return;
    }

    setCreateMessage("Company and workspace created. Redirecting...");
    router.replace("/dashboard");
    router.refresh();
  };

  const handleJoinWorkspace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const token = extractInviteToken(inviteInput);

    if (!token) {
      setJoinMessage("Please paste a valid invite link or token.");
      return;
    }

    setJoinMessage(null);
    router.push(`/invite/${token}`);
  };

  if (isLoading) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-10 sm:px-6">
        <section className="w-full max-w-2xl rounded-[32px] border border-[var(--border)] bg-[var(--surface)] p-8 shadow-xl">
          <p className="text-sm text-[var(--muted)]">Loading onboarding...</p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-4 py-10 sm:px-6">
      <section className="w-full max-w-3xl rounded-[32px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-xl shadow-[rgba(15,23,42,0.1)] sm:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Onboarding</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-[var(--foreground)]">Set up your access</h1>
        <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
          Create your company and first workspace, or join an existing workspace with an invite.
        </p>

        <div className="mt-6 flex rounded-2xl border border-[var(--border)] bg-white p-1">
          <button
            type="button"
            onClick={() => setMode("create")}
            className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium transition ${
              mode === "create"
                ? "bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] text-white"
                : "text-[var(--muted)] hover:bg-slate-50"
            }`}
          >
            Create company
          </button>
          <button
            type="button"
            onClick={() => setMode("join")}
            className={`flex-1 rounded-xl px-3 py-2 text-sm font-medium transition ${
              mode === "join"
                ? "bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] text-white"
                : "text-[var(--muted)] hover:bg-slate-50"
            }`}
          >
            Join with invite
          </button>
        </div>

        {mode === "create" ? (
          <form onSubmit={handleCreateCompany} className="mt-6 space-y-4">
            <input
              type="text"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder="Company name"
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              required
            />
            <input
              type="text"
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="First workspace name"
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              required
            />
            <select
              value={currency}
              onChange={(event) => setCurrency(event.target.value)}
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
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
              value={metricSystem}
              onChange={(event) => setMetricSystem(event.target.value)}
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
            >
              <option value="metric">Metric (m², m, kg)</option>
              <option value="imperial">Imperial (ft², ft, lbs)</option>
            </select>
            <select
              value={defaultCountryCode}
              onChange={(event) => {
                const preset = getMarketPresetByCountry(event.target.value);
                setDefaultCountryCode(preset.countryCode);
                setDefaultLocale(preset.defaultLocale);
                setDefaultLanguage(preset.defaultLanguage);
                setDefaultTimezone(preset.defaultTimezone);
              }}
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
            >
              {MARKET_PRESETS.map((preset) => (
                <option key={preset.countryCode} value={preset.countryCode}>{`${preset.countryCode} - ${preset.countryName}`}</option>
              ))}
            </select>
            <select
              value={defaultLocale}
              onChange={(event) => setDefaultLocale(event.target.value)}
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
            >
              {MARKET_LOCALE_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
            <div className="grid gap-3 sm:grid-cols-2">
              <select
                value={defaultLanguage}
                onChange={(event) => setDefaultLanguage(event.target.value)}
                className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              >
                {MARKET_LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>{option.label}</option>
                ))}
              </select>
              <select
                value={defaultTimezone}
                onChange={(event) => setDefaultTimezone(event.target.value)}
                className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              >
                {MARKET_TIMEZONE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>{option.label}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--muted)]">
                <span>Credits mode</span>
                <span className="group relative inline-flex">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-white text-[11px] font-semibold text-[var(--muted)]">i</span>
                  <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-72 -translate-x-1/2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-normal leading-5 text-[var(--foreground)] opacity-0 shadow-lg transition group-hover:opacity-100">
                    Shared across workspace means everyone uses one common credit pool inside the workspace. Per person means each member spends only from their own credit balance.
                  </span>
                </span>
              </div>
              <select
                value={creditAllocationMode}
                onChange={(event) => setCreditAllocationMode(event.target.value as CreditAllocationMode)}
                className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              >
                <option value="workspace_shared">Credits mode: Shared across workspace</option>
                <option value="per_person">Credits mode: Per person</option>
              </select>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--muted)]">
                <span>Mode control</span>
                <span className="group relative inline-flex">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-white text-[11px] font-semibold text-[var(--muted)]">i</span>
                  <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-72 -translate-x-1/2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-normal leading-5 text-[var(--foreground)] opacity-0 shadow-lg transition group-hover:opacity-100">
                    Owner locked keeps the chosen credits mode fixed by the owner. Team lead can choose lets a team lead switch this workspace between shared and per-person later.
                  </span>
                </span>
              </div>
              <select
                value={creditAllocationControl}
                onChange={(event) => setCreditAllocationControl(event.target.value as CreditAllocationControl)}
                className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              >
                <option value="owner_locked">Mode control: Owner locked</option>
                <option value="team_lead_select">Mode control: Team lead can choose per workspace</option>
              </select>
            </div>

            {createMessage ? (
              <p className={`text-sm font-medium ${createMessage.includes("created") ? "text-emerald-700" : "text-red-600"}`}>
                {createMessage}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={isCreating}
              className="w-full rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isCreating ? "Creating..." : "Create company and workspace"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleJoinWorkspace} className="mt-6 space-y-4">
            <input
              type="text"
              value={inviteInput}
              onChange={(event) => setInviteInput(event.target.value)}
              placeholder="Paste invite link or token"
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
              required
            />
            <p className="text-sm text-[var(--muted)]">
              Ask your admin to send you an invite link by email, then paste that link (or just its token) here.
            </p>

            {joinMessage ? <p className="text-sm font-medium text-red-600">{joinMessage}</p> : null}

            <button
              type="submit"
              className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
            >
              Continue with invite
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
