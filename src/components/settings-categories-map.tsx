"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type SettingsAction = {
  label: string;
  href: string;
};

type SettingsCategory = {
  id: string;
  title: string;
  description: string;
  actions: SettingsAction[];
  keywords: string[];
  className?: string;
};

const SETTINGS_CATEGORIES: SettingsCategory[] = [
  {
    id: "profile-account",
    title: "Profile & account",
    description: "Update your identity, contact details, and account profile info.",
    actions: [{ label: "Edit profile details", href: "#profile-account-settings" }],
    keywords: ["profile", "account", "name", "phone", "identity"],
  },
  {
    id: "workspace",
    title: "Workspace",
    description: "Manage workspace branding and shared workspace information.",
    actions: [{ label: "Manage workspace details", href: "#workspace-settings" }],
    keywords: ["workspace", "branding", "team", "company"],
  },
  {
    id: "communication",
    title: "Email & communication",
    description: "Control inbox connections, briefings, and phone channels.",
    actions: [
      { label: "Connect email inbox", href: "#mailbox-settings-inline" },
      { label: "Set briefing schedule", href: "#daily-briefing-settings-inline" },
    ],
    keywords: ["mailbox", "email", "briefing", "sms", "calls", "whatsapp", "inbox"],
  },
  {
    id: "security",
    title: "Security",
    description: "Protect your account with password and two-factor authentication.",
    actions: [{ label: "Protect account", href: "#security-settings-inline" }],
    keywords: ["security", "password", "2fa", "mfa", "authenticator"],
  },
  {
    id: "preferences",
    title: "Preferences",
    description: "Tune daily automation behavior, language, and delivery preferences.",
    actions: [
      { label: "Set briefing schedule", href: "#daily-briefing-settings-inline" },
      { label: "Email summary preferences", href: "#mailbox-settings-inline" },
    ],
    keywords: ["preferences", "automation", "language", "timezone", "delivery"],
    className: "sm:col-span-2 lg:col-span-2",
  },
];

export default function SettingsCategoriesMap() {
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();

  const filteredCategories = useMemo(() => {
    if (!normalizedQuery) {
      return SETTINGS_CATEGORIES;
    }

    return SETTINGS_CATEGORIES.filter((category) => {
      const haystack = [
        category.title,
        category.description,
        ...category.keywords,
        ...category.actions.map((action) => action.label),
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery]);

  const hasNoResults = normalizedQuery.length > 0 && filteredCategories.length === 0;

  return (
    <section className="settings-surface mx-auto w-full max-w-5xl space-y-4">
      <div className="settings-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">Settings map</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Find what you need fast</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
          Start with a category, then open the detailed form below.
        </p>

        <label className="mt-4 block">
          <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Find a setting</span>
          <div className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-white px-3 py-2.5">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 text-[var(--muted)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search: mailbox, password, workspace, briefing..."
              className="w-full bg-transparent text-sm text-[var(--foreground)] outline-none"
              aria-label="Search settings"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--muted)] transition hover:bg-slate-50"
              >
                Clear
              </button>
            ) : null}
          </div>
        </label>

        {hasNoResults ? (
          <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            No settings matched that search. Try terms like "email", "security", or "workspace".
          </p>
        ) : null}

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredCategories.map((category) => (
            <article key={category.id} className={`rounded-2xl border border-[var(--border)] bg-white px-4 py-4 ${category.className ?? ""}`}>
              <p className="text-sm font-semibold text-[var(--foreground)]">{category.title}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">{category.description}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {category.actions.map((action) => (
                  <Link
                    key={action.href + action.label}
                    href={action.href}
                    className="rounded-xl border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                  >
                    {action.label}
                  </Link>
                ))}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
