"use client";

import Link from "next/link";

type PropertyToolId = "listing-description" | "valuation" | "inventory";

const PROPERTY_TOOLS: Array<{ id: PropertyToolId; title: string; description: string; badge: string }> = [
  {
    id: "listing-description",
    title: "Listing description",
    description: "Generate a market-aware description from photos and a few property facts.",
    badge: "Ready",
  },
  {
    id: "valuation",
    title: "Valuation helper",
    description: "Compare pricing signals and prepare a draft range for the listing.",
    badge: "Coming soon",
  },
  {
    id: "inventory",
    title: "Property inventory",
    description: "Track rooms, photo sets, and listing assets in one place.",
    badge: "Coming soon",
  },
];

export default function PropertiesHub() {
  return (
    <section className="flex min-h-full flex-col gap-8">
      <div className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Properties</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">Property tools</h1>
        <p className="mt-4 text-base leading-7 text-[var(--muted)]">
          Use the buttons below to open property features. The listing description tool opens on its own properties page.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {PROPERTY_TOOLS.map((tool) => {
          const isReady = tool.id === "listing-description";

          return (
            <article
              key={tool.id}
              className="rounded-[24px] border border-[var(--border)] bg-[var(--surface)] px-5 py-5 text-left shadow-sm"
            >
              <div className="flex items-start gap-4">
                <div>
                  <p className="text-sm font-semibold text-[var(--foreground)]">{tool.title}</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{tool.description}</p>
                </div>
              </div>
              <div className="mt-4">
                {tool.id === "listing-description" ? (
                  <Link
                    href="/properties/listing-description"
                    className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105"
                  >
                    Open tool
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--muted)]"
                  >
                    Coming soon
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
