import Link from "next/link";
import { Suspense } from "react";

import DashboardBriefingCard from "@/components/dashboard-briefing-card";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type CurrentProfileRow = {
  id?: string | null;
  workspace_id?: string | null;
  role?: string | null;
};

type WorkspaceRow = {
  name: string;
  currency: string | null;
};

type CrmContactRow = {
  id: string;
  stage: string;
  priority: string;
  next_follow_up_at: string | null;
  updated_at: string;
};

type CrmEventRow = {
  id: string;
  contact_id: string;
  event_type: string;
  title: string;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
};

type DashboardEmailSummaryRow = {
  id: string;
  contact_id: string | null;
  message_id_hash: string | null;
  summary_text: string | null;
  received_at: string | null;
  created_at: string | null;
};

type DashboardActivityRow = {
  id: string;
  contact_id: string | null;
  event_type: string;
  title: string;
  occurred_at: string;
  metadata: Record<string, unknown> | null;
  source: "crm_contact_events" | "email_summaries";
  description: string;
};

type ContactNameRow = {
  id: string;
  first_name: string;
  last_name: string;
};

const STAGE_ORDER = ["new_lead", "qualified", "viewing", "negotiating", "closed_won"] as const;

const STAGE_LABELS: Record<(typeof STAGE_ORDER)[number], string> = {
  new_lead: "New leads",
  qualified: "Qualified",
  viewing: "Visits",
  negotiating: "Negotiating",
  closed_won: "Active",
};

function formatPersonName(firstName: string | null | undefined, lastName: string | null | undefined) {
  const fullName = `${firstName ?? ""} ${lastName ?? ""}`.trim();
  return fullName || "Unnamed contact";
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "Not set";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDateOnly(value: string | null, emptyLabel = "Not set") {
  if (!value) {
    return emptyLabel;
  }

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${day}/${month}/${year}`;
  }

  const displayMatch = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

  if (displayMatch) {
    return value;
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function getTimelineEventDueDate(event: { metadata: Record<string, unknown> | null }) {
  const metadata = event.metadata;

  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const dueDate = "due_date" in metadata ? metadata.due_date : null;

  if (typeof dueDate !== "string" || !dueDate.trim()) {
    return null;
  }

  return dueDate;
}

function formatEventType(value: string) {
  return value.replace(/_/g, " ");
}

function isWithinFollowUpWindow(value: string | null | undefined, windowEnd: Date) {
  if (!value) {
    return false;
  }

  const dueDate = new Date(value);

  if (Number.isNaN(dueDate.getTime())) {
    return false;
  }

  return dueDate.getTime() <= windowEnd.getTime();
}

export default async function DashboardOverview() {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return (
      <section className="flex min-h-full flex-col gap-8">
        <div className="max-w-4xl">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Dashboard</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">Workspace snapshot</h1>
          <p className="mt-4 text-base leading-7 text-[var(--muted)]">
            Supabase is not configured, so the dashboard CRM overview cannot load yet.
          </p>
        </div>
      </section>
    );
  }

  const { data: profileData } = await supabase.rpc("get_current_profile");
  const profile = profileData as CurrentProfileRow | null;

  if (!profile?.workspace_id) {
    return (
      <section className="flex min-h-full flex-col gap-8">
        <div className="max-w-4xl">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Dashboard</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">Workspace snapshot</h1>
          <p className="mt-4 text-base leading-7 text-[var(--muted)]">
            There is no workspace linked to this account yet. Finish onboarding to see CRM activity here.
          </p>
          <div className="mt-6">
            <Link
              href="/onboarding"
              className="inline-flex items-center rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105"
            >
              Go to onboarding
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const workspaceId = profile.workspace_id;
  const profileId = profile.id ?? null;
  const sevenDaysFromNow = new Date();
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

  const [workspaceResult, contactResult, eventResult, summaryResult] = await Promise.all([
    supabase.from("workspaces").select("name, currency").eq("id", workspaceId).maybeSingle<WorkspaceRow>(),
    supabase
      .from("crm_contacts")
      .select("id, stage, priority, next_follow_up_at, updated_at")
      .eq("workspace_id", workspaceId)
      .neq("stage", "archived")
      .neq("stage", "closed_lost")
      .order("updated_at", { ascending: false }),
    supabase
      .from("crm_contact_events")
      .select("id, contact_id, event_type, title, metadata, occurred_at")
      .eq("workspace_id", workspaceId)
      .order("occurred_at", { ascending: false })
      .limit(10),
    supabase
      .from("email_summaries")
      .select("id, contact_id, message_id_hash, summary_text, received_at, created_at")
      .eq("workspace_id", workspaceId)
      .order("received_at", { ascending: false })
      .limit(10),
  ]);

  const workspace = workspaceResult.data ?? null;
  const contacts = (contactResult.data ?? []) as CrmContactRow[];
  const events = (eventResult.data ?? []) as CrmEventRow[];
  const emailSummaries = (summaryResult.data ?? []) as DashboardEmailSummaryRow[];
  const dedupedSummaries = emailSummaries.reduce<DashboardEmailSummaryRow[]>((accumulator, summary) => {
    const summaryText = (summary.summary_text ?? "Email received").trim().toLowerCase().replace(/\s+/g, " ");
    const summaryTime = summary.received_at ?? summary.created_at ?? new Date().toISOString();
    const summaryTimeBucket = Math.floor(new Date(summaryTime).getTime() / (30 * 60 * 1000));
    const summaryKey = summary.message_id_hash?.trim() || `${summary.contact_id ?? "no-contact"}|${summaryText}|${summaryTimeBucket}`;

    const existingIndex = accumulator.findIndex((candidate) => {
      const candidateText = (candidate.summary_text ?? "Email received").trim().toLowerCase().replace(/\s+/g, " ");
      const candidateTime = candidate.received_at ?? candidate.created_at ?? new Date().toISOString();
      const candidateTimeBucket = Math.floor(new Date(candidateTime).getTime() / (30 * 60 * 1000));
      const candidateKey = candidate.message_id_hash?.trim() || `${candidate.contact_id ?? "no-contact"}|${candidateText}|${candidateTimeBucket}`;

      return candidateKey === summaryKey;
    });

    if (existingIndex === -1) {
      accumulator.push(summary);
      return accumulator;
    }

    const existing = accumulator[existingIndex];
    const existingHasContact = Boolean(existing.contact_id);
    const nextHasContact = Boolean(summary.contact_id);

    if (!existingHasContact && nextHasContact) {
      accumulator[existingIndex] = summary;
    }

    return accumulator;
  }, []);

  const normalizedSummaries = dedupedSummaries.map((summary) => {
    const occurredAt = summary.received_at ?? summary.created_at ?? new Date().toISOString();
    return {
      contactId: summary.contact_id,
      text: (summary.summary_text ?? "Email received").trim().toLowerCase().replace(/\s+/g, " "),
      occurredAt,
    };
  });

  const mergedActivity = [
    ...dedupedSummaries.map((summary) => ({
      id: `email-summary-${summary.id}`,
      contact_id: summary.contact_id,
      event_type: "email_summary",
      title: "Email summary",
      occurred_at: summary.received_at ?? summary.created_at ?? new Date().toISOString(),
      metadata: null,
      source: "email_summaries" as const,
      description: summary.summary_text ?? "Email received",
    })),
    ...events
      .filter((event) => {
        const normalizedEventText = event.title.trim().toLowerCase().replace(/\s+/g, " ");
        const eventTime = new Date(event.occurred_at).getTime();

        return !normalizedSummaries.some((summary) => {
          const sameContact = summary.contactId ? summary.contactId === event.contact_id : true;
          const sameText = summary.text === normalizedEventText;
          const summaryTime = new Date(summary.occurredAt).getTime();
          const closeInTime = Math.abs(summaryTime - eventTime) <= 30 * 60 * 1000;

          return sameText && sameContact && closeInTime;
        });
      })
      .map((event) => ({
        id: `crm-event-${event.id}`,
        contact_id: event.contact_id,
        event_type: event.event_type,
        title: event.title,
        occurred_at: event.occurred_at,
        metadata: event.metadata,
        source: "crm_contact_events" as const,
        description: event.title,
      })),
  ] as Array<DashboardActivityRow & { source: "crm_contact_events" | "email_summaries"; description: string }>;

  const recentActivity = mergedActivity
    .sort((left, right) => new Date(right.occurred_at).getTime() - new Date(left.occurred_at).getTime())
    .slice(0, 5);
  const contactNames = new Map<string, string>();

  if (recentActivity.length > 0) {
    const contactIds = Array.from(new Set(recentActivity.map((event) => event.contact_id).filter((contactId): contactId is string => Boolean(contactId))));
    const { data: contactNameRows } = await supabase
      .from("crm_contacts")
      .select("id, first_name, last_name")
      .in("id", contactIds);

    for (const row of (contactNameRows ?? []) as ContactNameRow[]) {
      contactNames.set(row.id, formatPersonName(row.first_name, row.last_name));
    }
  }

  const activeContactsCount = contacts.length;
  const highPriorityCount = contacts.filter((contact) => contact.priority === "high").length;
  const followUpCount = contacts.filter((contact) => isWithinFollowUpWindow(contact.next_follow_up_at, sevenDaysFromNow)).length;
  const latestActivityLabel = recentActivity[0] ? formatDateTime(recentActivity[0].occurred_at) : "No CRM activity yet";
  const stageCounts = STAGE_ORDER.map((stage) => ({
    key: stage,
    label: STAGE_LABELS[stage],
    count: contacts.filter((contact) => contact.stage === stage).length,
  }));

  return (
    <section className="flex min-h-full flex-col gap-8 pb-6">
      <div className="relative overflow-hidden rounded-[32px] border border-[var(--border)] bg-[linear-gradient(135deg,#0f172a_0%,#1d4ed8_55%,#0f172a_100%)] px-6 py-6 text-white shadow-[0_24px_60px_rgba(15,23,42,0.18)] sm:px-8">
        <div className="absolute inset-0 opacity-25 [background-image:radial-gradient(circle_at_top_right,rgba(255,255,255,0.4),transparent_34%),radial-gradient(circle_at_bottom_left,rgba(96,165,250,0.5),transparent_28%)]" />
        <div className="relative max-w-4xl">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-blue-100">Dashboard</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight">{workspace?.name ?? "Workspace snapshot"}</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-blue-100/90">
            A compact view of your CRM pulse, recent updates, and the next actions worth attention.
          </p>

        </div>
      </div>

      <Suspense fallback={<DashboardBriefingSkeleton />}>
        {profileId ? <DashboardBriefingCard workspaceId={workspaceId} profileId={profileId} /> : null}
      </Suspense>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)]">
        <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">CRM snapshot</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Pipeline mix</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--muted)]">A quick read on where the active CRM workload is concentrated.</p>
            </div>
            <Link
              href="/contacts"
              className="rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
            >
              Open CRM
            </Link>
          </div>

          <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {stageCounts.map((stage) => (
              <div key={stage.key} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">{stage.label}</p>
                <p className="mt-3 text-2xl font-semibold text-[var(--foreground)]">{stage.count}</p>
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-white/70 p-4">
            <p className="text-sm font-semibold text-[var(--foreground)]">Quick actions</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                href="/contacts"
                className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105"
              >
                Review contacts
              </Link>
              <Link
                href="/contacts/archive"
                className="rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
              >
                View archive
              </Link>
              <Link
                href="/properties"
                className="rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
              >
                Open properties
              </Link>
            </div>
          </div>
        </article>

        <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">Recent CRM activity</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Latest updates</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">The last interactions across this workspace’s CRM.</p>
          </div>

          <div className="mt-5 space-y-3">
            {recentActivity.length > 0 ? (
              recentActivity.map((event) => (
                <div key={event.id} className="rounded-2xl border border-[var(--border)] bg-white/80 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[var(--foreground)]">
                        {event.contact_id ? contactNames.get(event.contact_id) ?? "CRM contact" : "CRM activity"}
                      </p>
                      <p className="mt-1 text-sm text-[var(--muted)]">{event.description}</p>
                    </div>
                    <span className="rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-600">
                      {formatEventType(event.event_type)}
                    </span>
                  </div>
                  {event.source === "crm_contact_events" && getTimelineEventDueDate(event) ? (
                    <p className="mt-2 text-xs font-medium text-[var(--foreground)]">
                      Due: {formatDateOnly(getTimelineEventDueDate(event))}
                    </p>
                  ) : null}
                  <p className="mt-3 text-xs text-[var(--muted)]">{formatDateTime(event.occurred_at)}</p>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-[var(--border)] bg-white/70 px-4 py-6 text-sm text-[var(--muted)]">
                No CRM activity yet. Create your first contact in the CRM to populate this feed.
              </div>
            )}
          </div>
        </article>
      </div>

      <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">Workspace shortcuts</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Other places to work</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">A compact set of entry points outside the CRM so the dashboard stays a true home screen.</p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Link href="/calendar" className="rounded-2xl border border-[var(--border)] bg-white/75 px-4 py-4 transition hover:bg-slate-50">
            <p className="text-sm font-semibold text-[var(--foreground)]">Calendar</p>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">Track personal events and coworker absences in one view.</p>
          </Link>
          <Link href="/properties" className="rounded-2xl border border-[var(--border)] bg-white/75 px-4 py-4 transition hover:bg-slate-50">
            <p className="text-sm font-semibold text-[var(--foreground)]">Properties</p>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">Manage listings, market context, and property workflows.</p>
          </Link>
          <Link href="/document-generator" className="rounded-2xl border border-[var(--border)] bg-white/75 px-4 py-4 transition hover:bg-slate-50">
            <p className="text-sm font-semibold text-[var(--foreground)]">Document generator</p>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">Draft documents, letters, and supporting material.</p>
          </Link>
          <Link href="/settings" className="rounded-2xl border border-[var(--border)] bg-white/75 px-4 py-4 transition hover:bg-slate-50">
            <p className="text-sm font-semibold text-[var(--foreground)]">Settings</p>
            <p className="mt-2 text-sm leading-6 text-[var(--muted)]">Update workspace preferences and account options.</p>
          </Link>
        </div>
      </article>
    </section>
  );
}

function DashboardBriefingSkeleton() {
  return (
    <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
      <div className="h-3 w-32 rounded-full bg-white/20" />
      <div className="mt-4 h-8 w-56 rounded-full bg-white/15" />
      <div className="mt-4 h-4 w-full rounded-full bg-white/10" />
      <div className="mt-2 h-4 w-5/6 rounded-full bg-white/10" />
    </article>
  );
}
