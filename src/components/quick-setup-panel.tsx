"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type SetupStep = {
  id: string;
  label: string;
  description: string;
  href: string;
  cta: string;
};

const SETUP_STEPS: SetupStep[] = [
  {
    id: "workspace",
    label: "Configure your workspace",
    description: "Set your timezone, locale, currency, and workspace display name.",
    href: "/settings",
    cta: "Open settings",
  },
  {
    id: "property",
    label: "Add your first property",
    description: "Create a listing with details, valuation, and inventory.",
    href: "/properties",
    cta: "Go to Properties",
  },
  {
    id: "contact",
    label: "Add a contact",
    description: "Build your CRM with owners, tenants, leads, and partners.",
    href: "/contacts",
    cta: "Go to CRM",
  },
  {
    id: "inbox",
    label: "Connect your inbox",
    description: "Link a mailbox so Versaline can summarise your emails automatically.",
    href: "/settings/mailbox",
    cta: "Connect mailbox",
  },
  {
    id: "document",
    label: "Generate a document",
    description: "Use the AI document generator to draft contracts or letters.",
    href: "/document-generator",
    cta: "Open generator",
  },
];

type FeatureCard = {
  label: string;
  description: string;
  href: string;
  icon: React.ReactNode;
};

const FEATURE_CARDS: FeatureCard[] = [
  {
    label: "Dashboard",
    description: "Your workspace snapshot — CRM pipeline, recent activity, and your AI daily briefing all in one place.",
    href: "/dashboard",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="2" y="2" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.8"/>
        <rect x="11" y="2" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.5"/>
        <rect x="2" y="11" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.5"/>
        <rect x="11" y="11" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.8"/>
      </svg>
    ),
  },
  {
    label: "Properties",
    description: "Manage every listing in one place — details, valuations, inventory, and AI-generated descriptions.",
    href: "/properties",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M10 2L2 8.5V18h5.5v-5h5v5H18V8.5L10 2Z" fill="currentColor" opacity="0.8"/>
      </svg>
    ),
  },
  {
    label: "CRM",
    description: "Track owners, tenants, leads, and partners through a visual pipeline with follow-up reminders.",
    href: "/contacts",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <circle cx="8" cy="7" r="3.5" fill="currentColor" opacity="0.8"/>
        <path d="M2 17c0-3.314 2.686-5 6-5s6 1.686 6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.8"/>
        <circle cx="15" cy="6" r="2.5" fill="currentColor" opacity="0.4"/>
        <path d="M17 16c0-2.209-1.343-3.5-3-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.4"/>
      </svg>
    ),
  },
  {
    label: "Inbox",
    description: "All your workspace emails in one threaded view, with AI summaries and contact attribution.",
    href: "/inbox",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="2" y="4" width="16" height="12" rx="2" fill="currentColor" opacity="0.15"/>
        <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" opacity="0.8"/>
        <path d="M2 7l8 5 8-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.8"/>
      </svg>
    ),
  },
  {
    label: "Calendar",
    description: "Plan site visits, personal events, and team absences on a shared workspace timeline.",
    href: "/calendar",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="2" y="4" width="16" height="14" rx="2" fill="currentColor" opacity="0.15"/>
        <rect x="2" y="4" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" opacity="0.8"/>
        <path d="M2 9h16" stroke="currentColor" strokeWidth="1.6" opacity="0.5"/>
        <path d="M6 2v4M14 2v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.8"/>
        <circle cx="7" cy="13" r="1.2" fill="currentColor" opacity="0.8"/>
        <circle cx="10" cy="13" r="1.2" fill="currentColor" opacity="0.8"/>
        <circle cx="13" cy="13" r="1.2" fill="currentColor" opacity="0.8"/>
      </svg>
    ),
  },
  {
    label: "Document generator",
    description: "Draft contracts, mandates, and letters using AI — pre-filled with your property and contact data.",
    href: "/document-generator",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M5 2h7l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" fill="currentColor" opacity="0.15"/>
        <path d="M5 2h7l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.6" opacity="0.8"/>
        <path d="M12 2v4h4" stroke="currentColor" strokeWidth="1.4" opacity="0.5"/>
        <path d="M7 10h6M7 13h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.8"/>
      </svg>
    ),
  },
];

const STORAGE_KEY = "versaline_quick_setup_done";

function loadDoneSteps(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return new Set();
    }

    const parsed = JSON.parse(raw) as unknown;

    if (Array.isArray(parsed)) {
      return new Set(parsed as string[]);
    }
  } catch {
    // Ignore parse errors
  }

  return new Set();
}

export default function QuickSetupPanel() {
  const [doneSteps, setDoneSteps] = useState<Set<string>>(new Set());
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setDoneSteps(loadDoneSteps());
    setMounted(true);
  }, []);

  const toggleStep = (id: string) => {
    setDoneSteps((prev) => {
      const next = new Set(prev);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Ignore storage errors
      }

      return next;
    });
  };

  const completedCount = doneSteps.size;
  const totalCount = SETUP_STEPS.length;
  const allDone = completedCount === totalCount;

  return (
    <section className="flex min-h-full flex-col gap-10">
      {/* Header */}
      <div className="max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Quick setup</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">
          Get started with Versaline
        </h1>
        <p className="mt-4 text-base leading-7 text-[var(--muted)]">
          Versaline is a property and document workflow platform. Follow these steps to get your workspace ready, then explore the features below.
        </p>
      </div>

      {/* Checklist */}
      <div className="max-w-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">Setup checklist</h2>
          {mounted ? (
            <span className="text-xs text-[var(--muted)]">
              {completedCount} / {totalCount} done
            </span>
          ) : null}
        </div>

        {/* Progress bar */}
        {mounted ? (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]">
            <div
              className="h-full rounded-full bg-[linear-gradient(90deg,var(--accent),var(--accent-strong))] transition-all duration-500"
              style={{ width: `${(completedCount / totalCount) * 100}%` }}
            />
          </div>
        ) : null}

        <ul className="mt-4 space-y-3">
          {SETUP_STEPS.map((step) => {
            const isDone = mounted && doneSteps.has(step.id);

            return (
              <li
                key={step.id}
                className="flex items-start gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm"
              >
                <button
                  type="button"
                  onClick={() => toggleStep(step.id)}
                  aria-label={isDone ? `Mark "${step.label}" as not done` : `Mark "${step.label}" as done`}
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition ${
                    isDone
                      ? "border-[var(--accent)] bg-[var(--accent)]"
                      : "border-[var(--border)] bg-transparent hover:border-[var(--accent)]"
                  }`}
                >
                  {isDone ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                      <path d="M2 5l2.5 2.5 3.5-4" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  ) : null}
                </button>

                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium transition ${isDone ? "text-[var(--muted)] line-through" : "text-[var(--foreground)]"}`}>
                    {step.label}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-[var(--muted)]">{step.description}</p>
                </div>

                <Link
                  href={step.href}
                  className="shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:bg-[var(--accent)] hover:text-white hover:border-[var(--accent)]"
                >
                  {step.cta}
                </Link>
              </li>
            );
          })}
        </ul>

        {mounted && allDone ? (
          <div className="mt-4 rounded-2xl border border-[var(--accent-soft)] bg-[rgba(59,130,246,0.07)] p-4 text-sm text-[var(--accent-strong)]">
            All setup steps complete — your workspace is ready to use.
          </div>
        ) : null}
      </div>

      {/* Feature overview */}
      <div>
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Features overview</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">Explore what each section of Versaline does.</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURE_CARDS.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="group flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm transition hover:border-[var(--accent)] hover:shadow-md"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-[rgba(59,130,246,0.1)] text-[var(--accent)] transition group-hover:bg-[rgba(59,130,246,0.18)]">
                {card.icon}
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">{card.label}</p>
                <p className="mt-1 text-xs leading-5 text-[var(--muted)]">{card.description}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
