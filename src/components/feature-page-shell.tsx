import Link from "next/link";

type FeaturePageShellProps = {
  backHref: string;
  backLabel: string;
  children: React.ReactNode;
};

export default function FeaturePageShell({
  backHref,
  backLabel,
  children,
}: FeaturePageShellProps) {
  return (
    <div className="flex min-h-full flex-col gap-4">
      <div>
        <Link
          href={backHref}
          className="inline-flex items-center rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
        >
          {`< ${backLabel}`}
        </Link>
      </div>
      {children}
    </div>
  );
}
