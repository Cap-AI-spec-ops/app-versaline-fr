export default function DashboardLoading() {
  return (
    <section className="flex min-h-full flex-col gap-8 pb-6">
      <div className="relative overflow-hidden rounded-[32px] border border-[var(--border)] bg-[linear-gradient(135deg,#0f172a_0%,#1d4ed8_55%,#0f172a_100%)] px-6 py-6 text-white shadow-[0_24px_60px_rgba(15,23,42,0.18)] sm:px-8">
        <div className="h-3 w-28 rounded-full bg-white/35" />
        <div className="mt-4 h-10 w-72 rounded-full bg-white/25" />
        <div className="mt-5 h-4 w-full max-w-2xl rounded-full bg-white/20" />
      </div>

      <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
        <div className="h-3 w-32 rounded-full bg-white/20" />
        <div className="mt-4 h-8 w-56 rounded-full bg-white/15" />
        <div className="mt-4 h-4 w-full rounded-full bg-white/10" />
      </article>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)]">
        <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
          <div className="h-3 w-32 rounded-full bg-white/20" />
          <div className="mt-4 h-8 w-48 rounded-full bg-white/15" />
          <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
                <div className="h-3 w-20 rounded-full bg-white/15" />
                <div className="mt-3 h-7 w-14 rounded-full bg-white/25" />
              </div>
            ))}
          </div>
        </article>

        <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
          <div className="h-3 w-40 rounded-full bg-white/20" />
          <div className="mt-4 h-8 w-44 rounded-full bg-white/15" />
          <div className="mt-6 space-y-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-[var(--border)] bg-white/80 px-4 py-4">
                <div className="h-4 w-40 rounded-full bg-slate-200" />
                <div className="mt-2 h-3 w-3/4 rounded-full bg-slate-200" />
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}
