import Link from "next/link";
import { requireUser } from "@/lib/auth/require-user";

const DOCUMENT_OPTIONS = [
  {
    href: "/document-generator/mandat-vente",
    title: "Mandat de vente",
    detail: "Create and export a sale mandate with Versaline PDF or agency DOCX templates.",
    status: "Live",
  },
  {
    href: "/document-generator",
    title: "Mandat de recherche",
    detail: "Buyer representation flow planned next.",
    status: "Soon",
  },
  {
    href: "/document-generator",
    title: "Bail de location",
    detail: "ALUR-ready rental drafting flow planned next.",
    status: "Soon",
  },
  {
    href: "/document-generator",
    title: "Avenant au mandat",
    detail: "Mandate amendment drafting flow planned next.",
    status: "Soon",
  },
] as const;

export default async function DocumentGeneratorPage() {
  await requireUser("/document-generator");

  return (
    <section className="flex min-h-full flex-col gap-6">
      <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
          Document families
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">
          Document generator
        </h1>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--muted)]">
          Choose which legal document you want to create. Each document family gets its own drafting
          flow and compliance logic.
        </p>
      </article>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {DOCUMENT_OPTIONS.map((document) => {
          const isLive = document.status === "Live";

          return (
            <article
              key={document.title}
              className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-[var(--foreground)]">{document.title}</h2>
                <span
                  className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${
                    isLive ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {document.status}
                </span>
              </div>
              <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{document.detail}</p>

              {isLive ? (
                <Link
                  href={document.href}
                  className="mt-5 inline-flex items-center rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-700"
                >
                  Open draft flow
                </Link>
              ) : (
                <div className="mt-5 inline-flex items-center rounded-xl border border-[var(--border)] bg-white/70 px-4 py-2 text-sm font-semibold text-[var(--muted)]">
                  Coming next
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}