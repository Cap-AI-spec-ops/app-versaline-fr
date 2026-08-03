import { getSupabaseServerClient } from "@/lib/supabase/server";

type DailyBriefingPreferenceRow = {
  is_enabled: boolean | null;
  send_weekdays: number[] | null;
  send_time_local: string | null;
  timezone: string | null;
  language: string | null;
  locale: string | null;
  include_workspace_snapshot: boolean | null;
};

type DailyBriefingRunRow = {
  scheduled_for_local_date: string;
  status: string;
  sent_at: string | null;
  failure_message: string | null;
  payload_metadata: Record<string, unknown> | null;
};

type StoredAIBriefing = {
  headline: string;
  briefing: string;
  topActions: Array<{
    title: string;
    reason: string;
    dueHint: string | null;
  }>;
  workspacePulse: string | null;
  localDate: string | null;
  timezone: string | null;
  language: string | null;
  diagnosticsSource: "ai" | "fallback";
  diagnosticsError: string | null;
  stageCounts: Array<{ key: string; label: string; count: number }>;
};

type DashboardBriefingCardProps = {
  workspaceId: string;
  profileId: string;
};

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "Not set";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default async function DashboardBriefingCard({ workspaceId, profileId }: DashboardBriefingCardProps) {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return null;
  }

  const [{ data: preferenceRow }, { data: effectivePolicyData, error: effectivePolicyError }] = await Promise.all([
    supabase
      .from("daily_briefing_preferences")
      .select("is_enabled, send_weekdays, send_time_local, timezone, language, locale, include_workspace_snapshot")
      .eq("workspace_id", workspaceId)
      .eq("profile_id", profileId)
      .maybeSingle<DailyBriefingPreferenceRow>(),
    supabase.rpc("get_effective_workspace_daily_briefing_enabled", { p_workspace_id: workspaceId }),
  ]);

  const effectiveWorkspaceBriefingEnabled =
    effectivePolicyError ? false : typeof effectivePolicyData === "boolean" ? effectivePolicyData : true;
  const userBriefingEnabled = preferenceRow?.is_enabled ?? false;

  if (!effectiveWorkspaceBriefingEnabled || !userBriefingEnabled) {
    return null;
  }

  const timezone = preferenceRow?.timezone?.trim() || "Europe/Paris";
  const localDate = getLocalDateKey(new Date(), timezone);
  const { data: runRows } = await supabase
    .from("daily_briefing_runs")
    .select("scheduled_for_local_date, status, sent_at, failure_message, payload_metadata")
    .eq("workspace_id", workspaceId)
    .eq("profile_id", profileId)
    .order("run_started_at", { ascending: false })
    .limit(10);

  const runRow = (runRows ?? []).find((row) => row.scheduled_for_local_date === localDate) ?? null;

  const storedBriefingFromToday = extractStoredBriefing(runRow?.payload_metadata);
  const storedBriefingFallback = (runRows ?? [])
    .map((row) => extractStoredBriefing(row.payload_metadata))
    .find((value): value is StoredAIBriefing => !!value) ?? null;

  const storedBriefing = storedBriefingFromToday ?? storedBriefingFallback;

  const fallbackDetails =
    storedBriefing?.diagnosticsSource === "fallback"
      ? storedBriefing.diagnosticsError ?? "Provider returned a fallback brief."
      : null;
  const scheduledTime = normalizeTimeForDisplay(preferenceRow?.send_time_local);
  const topRightScheduleLabel = buildTopRightScheduleLabel({
    runStatus: runRow?.status ?? null,
    sentAt: runRow?.sent_at ?? null,
    timezone,
    scheduledTime,
    sendWeekdays: preferenceRow?.send_weekdays ?? null,
    now: new Date(),
  });

  let statusMessage = "Today's briefing has not run yet.";
  if (runRow?.status === "pending") {
    statusMessage = "Today's briefing is queued and will appear soon.";
  } else if (runRow?.status === "failed") {
    statusMessage = runRow.failure_message?.trim() || "Today's briefing run failed.";
  } else if (runRow?.status === "sent") {
    statusMessage = "Today's briefing content is not available yet for this run.";
  }

  const includeWorkspaceSnapshot = preferenceRow?.include_workspace_snapshot ?? true;

  return (
    <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
      <div>
        <div className="flex items-start justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">Today's briefing</p>
          <span className="rounded-full border border-[var(--border)] bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)] whitespace-nowrap">
            {topRightScheduleLabel}
          </span>
        </div>
        <div className="mt-2">
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
            {storedBriefing?.headline ?? "Daily focus"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            {storedBriefing?.briefing ?? statusMessage}
          </p>
          {!storedBriefing ? <p className="mt-2 text-xs text-[var(--muted)]">Scheduled at {scheduledTime} ({timezone})</p> : null}
          {fallbackDetails ? <p className="mt-2 text-xs text-amber-700">AI fallback reason: {fallbackDetails}</p> : null}
        </div>
      </div>

      {storedBriefing?.topActions.length ? (
        <div className="mt-5 space-y-3">
          {storedBriefing.topActions.map((action, index) => (
            <div key={`${action.title}-${index}`} className="rounded-2xl border border-[var(--border)] bg-white/80 px-4 py-4">
              <p className="text-sm font-semibold text-[var(--foreground)]">
                {index + 1}. {action.title}
              </p>
              <p className="mt-1 text-sm text-[var(--muted)]">{action.reason}</p>
              {action.dueHint ? <p className="mt-2 text-xs text-[var(--muted)]">Due: {formatDateTime(action.dueHint)}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      {includeWorkspaceSnapshot && storedBriefing && storedBriefing.workspacePulse && storedBriefing.stageCounts.length > 0 ? (
        <div className="mt-6 rounded-2xl border border-[var(--border)] bg-white p-4">
          <p className="text-sm font-semibold text-[var(--foreground)]">Compact workspace summary</p>
          <p className="mt-1 text-sm text-[var(--muted)]">{storedBriefing.workspacePulse}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {storedBriefing.stageCounts.map((stage) => (
              <span key={stage.key} className="rounded-full border border-[var(--border)] bg-slate-50 px-2.5 py-1 font-semibold text-[var(--foreground)]">
                {stage.label}: {stage.count}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function getLocalDateKey(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function normalizeTimeForDisplay(value: string | null | undefined) {
  if (!value) {
    return "08:30";
  }

  const match = value.match(/^(\d{2}:\d{2})/);
  return match ? match[1] : "08:30";
}

function formatLocalHourMinute(value: string, timeZone: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function buildTopRightScheduleLabel(input: {
  runStatus: string | null;
  sentAt: string | null;
  timezone: string;
  scheduledTime: string;
  sendWeekdays: number[] | null;
  now: Date;
}) {
  const normalizedWeekdays = normalizeWeekdays(input.sendWeekdays);
  const localNowMinutes = getLocalMinutes(input.now, input.timezone);
  const localTodayWeekday = getLocalWeekday(input.now, input.timezone);
  const scheduledMinutes = parseTimeToMinutes(input.scheduledTime);

  const nextOffset = getNextScheduledOffsetDays({
    todayWeekday: localTodayWeekday,
    nowMinutes: localNowMinutes,
    scheduledMinutes,
    allowedWeekdays: normalizedWeekdays,
    includeToday: input.runStatus !== "sent",
  });

  const nextRunDescriptor = formatNextRunDescriptor(nextOffset, localTodayWeekday);

  if (input.runStatus === "sent") {
    const generatedAt = input.sentAt ? formatLocalHourMinute(input.sentAt, input.timezone) : null;

    if (generatedAt) {
      return `${generatedAt}, next run ${nextRunDescriptor} at ${input.scheduledTime}`;
    }

    return `next run ${nextRunDescriptor} at ${input.scheduledTime}`;
  }

  if (input.runStatus === "pending") {
    return `next run today at ${input.scheduledTime}`;
  }

  if (
    input.runStatus !== "sent"
    && normalizedWeekdays.includes(localTodayWeekday)
    && localNowMinutes >= scheduledMinutes
  ) {
    return `due now, waiting for scheduler`;
  }

  if (nextOffset === 0) {
    return `next run at ${input.scheduledTime}`;
  }

  return `next run ${nextRunDescriptor} at ${input.scheduledTime}`;
}

function parseTimeToMinutes(value: string) {
  const [hoursText, minutesText] = value.split(":");
  const hours = Number.parseInt(hoursText ?? "0", 10);
  const minutes = Number.parseInt(minutesText ?? "0", 10);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return 0;
  }

  return Math.max(0, Math.min(23, hours)) * 60 + Math.max(0, Math.min(59, minutes));
}

function getLocalMinutes(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hourText = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minuteText = parts.find((part) => part.type === "minute")?.value ?? "00";
  const hours = Number.parseInt(hourText, 10);
  const minutes = Number.parseInt(minuteText, 10);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return 0;
  }

  return hours * 60 + minutes;
}

function normalizeWeekdays(value: number[] | null | undefined) {
  if (!Array.isArray(value) || value.length === 0) {
    return [1, 2, 3, 4, 5];
  }

  const uniqueSorted = Array.from(new Set(value.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))).sort(
    (left, right) => left - right,
  );

  return uniqueSorted.length > 0 ? uniqueSorted : [1, 2, 3, 4, 5];
}

function getLocalWeekday(date: Date, timeZone: string) {
  const weekdayShort = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  const mapping: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return mapping[weekdayShort] ?? 0;
}

function getNextScheduledOffsetDays(input: {
  todayWeekday: number;
  nowMinutes: number;
  scheduledMinutes: number;
  allowedWeekdays: number[];
  includeToday: boolean;
}) {
  if (
    input.includeToday
    && input.allowedWeekdays.includes(input.todayWeekday)
    && input.nowMinutes < input.scheduledMinutes
  ) {
    return 0;
  }

  for (let offset = 1; offset <= 7; offset += 1) {
    const weekday = (input.todayWeekday + offset) % 7;
    if (input.allowedWeekdays.includes(weekday)) {
      return offset;
    }
  }

  return 1;
}

function formatNextRunDescriptor(offsetDays: number, todayWeekday: number) {
  if (offsetDays === 0) {
    return "today";
  }

  if (offsetDays === 1) {
    return "tomorrow";
  }

  const weekday = (todayWeekday + offsetDays) % 7;
  const weekdayNames: Record<number, string> = {
    0: "sunday",
    1: "monday",
    2: "tuesday",
    3: "wednesday",
    4: "thursday",
    5: "friday",
    6: "saturday",
  };

  return weekdayNames[weekday] ?? "soon";
}

function extractStoredBriefing(payload: Record<string, unknown> | null | undefined): StoredAIBriefing | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const aiBriefing = payload.ai_briefing;
  if (!aiBriefing || typeof aiBriefing !== "object") {
    return null;
  }

  const source = aiBriefing as Record<string, unknown>;
  const headline = typeof source.headline === "string" ? source.headline.trim() : "";
  const briefing = typeof source.briefing === "string" ? source.briefing.trim() : "";
  const workspacePulse = typeof source.workspace_pulse === "string" ? source.workspace_pulse.trim() : "";

  if (!headline || !briefing) {
    return null;
  }

  const topActions = Array.isArray(source.top_actions)
    ? source.top_actions
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }

          const row = item as Record<string, unknown>;
          const title = typeof row.title === "string" ? row.title.trim() : "";
          const reason = typeof row.reason === "string" ? row.reason.trim() : "";
          const dueHint = typeof row.due_hint === "string" ? row.due_hint.trim() : null;

          if (!title || !reason) {
            return null;
          }

          return {
            title,
            reason,
            dueHint: dueHint || null,
          };
        })
        .filter((item): item is { title: string; reason: string; dueHint: string | null } => !!item)
    : [];

  const stageCounts = Array.isArray(source.stage_counts)
    ? source.stage_counts
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }

          const row = item as Record<string, unknown>;
          const key = typeof row.key === "string" ? row.key : "";
          const label = typeof row.label === "string" ? row.label : "";
          const count = typeof row.count === "number" ? row.count : Number.parseInt(String(row.count ?? "0"), 10);

          if (!key || !label || Number.isNaN(count)) {
            return null;
          }

          return { key, label, count };
        })
        .filter((item): item is { key: string; label: string; count: number } => !!item)
    : [];

  return {
    headline,
    briefing,
    topActions,
    workspacePulse: workspacePulse || null,
    localDate: typeof source.local_date === "string" ? source.local_date : null,
    timezone: typeof source.timezone === "string" ? source.timezone : null,
    language: typeof source.language === "string" ? source.language : null,
    diagnosticsSource: source.diagnostics_source === "fallback" ? "fallback" : "ai",
    diagnosticsError: typeof source.diagnostics_error === "string" ? source.diagnostics_error : null,
    stageCounts,
  };
}
