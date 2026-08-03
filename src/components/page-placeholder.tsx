type PagePlaceholderProps = {
  title: string;
  description: string;
};

export default function PagePlaceholder({
  title,
  description,
}: PagePlaceholderProps) {
  return (
    <section className="flex min-h-full flex-col gap-8">
      <div className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
          Blank page
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">
          {title}
        </h1>
        <p className="mt-4 text-base leading-7 text-[var(--muted)]">{description}</p>
      </div>
    </section>
  );
}