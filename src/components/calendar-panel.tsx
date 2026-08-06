"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import DateTimePickerInput from "@/components/ui/date-time-picker-input";
import { useWorkspaceAbsences, type WorkspaceAbsence } from "@/lib/calendar/use-workspace-absences";
import { useWorkspaceMembers } from "@/lib/workspace/use-workspace-members";

type PersonalProviderState = {
  provider: "gmail" | "outlook";
  connected: boolean;
  status: string;
  reason?: string;
};

type PersonalCalendarEvent = {
  id: string;
  provider: "gmail" | "outlook";
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  location: string | null;
};

type PersonalCalendarResponse = {
  events: PersonalCalendarEvent[];
  providers: PersonalProviderState[];
  range: { from: string; to: string } | null;
  error?: string;
};

type CalendarViewMode = "month" | "week" | "day";

type PersonalEventForm = {
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  location: string;
};

type AbsenceStatus = "planned" | "confirmed" | "cancelled";

type AbsenceForm = {
  profileId: string;
  startsOn: string;
  endsOn: string;
  publicNote: string;
};

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS_IN_DAY = 24;
const HOUR_ROW_HEIGHT = 52;

type TimelineEvent = {
  event: PersonalCalendarEvent;
  top: number;
  height: number;
};

async function readJsonResponse<T>(response: Response): Promise<T | null> {
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";

  if (!contentType.includes("application/json")) {
    return null;
  }

  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function getCalendarLoadError(response: Response, payload: PersonalCalendarResponse | null) {
  if (payload?.error) {
    return payload.error;
  }

  if (response.status === 404) {
    return "Personal calendar is temporarily unavailable.";
  }

  if (response.status === 401) {
    return "Your session expired. Reload the page and sign in again.";
  }

  return "Could not load personal calendar.";
}

function getPersonalMutationError(response: Response, payload: { error?: string } | null, fallback: string) {
  if (payload?.error) {
    return payload.error;
  }

  if (response.status === 404) {
    return "Personal calendar is temporarily unavailable.";
  }

  if (response.status === 401) {
    return "Your session expired. Reload the page and sign in again.";
  }

  return fallback;
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function toLocalIsoDateTime(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");

  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function addOneHourToLocalIsoDateTime(value: string) {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  parsed.setHours(parsed.getHours() + 1);
  return toLocalIsoDateTime(parsed);
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function startOfCalendarGrid(date: Date) {
  const monthStart = startOfMonth(date);
  const shift = getMondayBasedDayIndex(monthStart);
  return new Date(monthStart.getFullYear(), monthStart.getMonth(), monthStart.getDate() - shift);
}

function startOfWeek(date: Date) {
  const shift = getMondayBasedDayIndex(date);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - shift);
}

function getMondayBasedDayIndex(date: Date) {
  return (date.getDay() + 6) % 7;
}

function addDays(date: Date, amount: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function parseDayKey(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);

  if (!year || !month || !day) {
    return new Date();
  }

  return new Date(year, month - 1, day);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function formatHourLabel(hour: number) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
  }).format(new Date(2000, 0, 1, hour, 0, 0));
}

function formatTimeRange(start: Date, end: Date) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function formatMemberName(firstName: string | null, lastName: string | null) {
  const fullName = [firstName ?? "", lastName ?? ""].join(" ").trim();
  return fullName || "Unnamed member";
}

function formatStatusLabel(status: AbsenceStatus) {
  if (status === "cancelled") {
    return "Cancelled";
  }

  if (status === "planned") {
    return "Planned";
  }

  return "Confirmed";
}

function formatProviderStatus(status: string) {
  if (status === "connected_unavailable") {
    return "calendar unavailable";
  }

  return status.replace(/_/g, " ");
}

function formatDateRange(startsOn: string, endsOn: string) {
  const start = new Date(`${startsOn}T00:00:00`);
  const end = new Date(`${endsOn}T00:00:00`);

  const startLabel = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
  }).format(start);

  const endLabel = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
  }).format(end);

  return startsOn === endsOn ? startLabel : `${startLabel} - ${endLabel}`;
}

function toDayKey(value: Date | string) {
  if (value instanceof Date) {
    return toIsoDate(new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0)));
  }

  return value.slice(0, 10);
}

function buildAbsenceForm(currentUserId: string | null): AbsenceForm {
  const today = toIsoDate(new Date());

  return {
    profileId: currentUserId ?? "",
    startsOn: today,
    endsOn: today,
    publicNote: "",
  };
}

function buildPersonalEventForm(selectedDateKey: string): PersonalEventForm {
  return {
    title: "",
    startsAt: `${selectedDateKey}T09:00`,
    endsAt: `${selectedDateKey}T10:00`,
    isAllDay: false,
    location: "",
  };
}

export default function CalendarPanel() {
  const [activeMonth, setActiveMonth] = useState(() => startOfMonth(new Date()));
  const [viewMode, setViewMode] = useState<CalendarViewMode>("month");
  const [selectedDateKey, setSelectedDateKey] = useState(() => toIsoDate(new Date()));
  const [providers, setProviders] = useState<PersonalProviderState[]>([]);
  const [personalEvents, setPersonalEvents] = useState<PersonalCalendarEvent[]>([]);
  const [isPersonalLoading, setIsPersonalLoading] = useState(false);
  const [personalError, setPersonalError] = useState<string | null>(null);
  const [isPersonalMutating, setIsPersonalMutating] = useState(false);
  const [personalFormError, setPersonalFormError] = useState<string | null>(null);
  const [personalFormMessage, setPersonalFormMessage] = useState<string | null>(null);
  const { members, currentUserId } = useWorkspaceMembers();

  const selectedDate = useMemo(() => parseDayKey(selectedDateKey), [selectedDateKey]);
  const weekStartDate = useMemo(() => startOfWeek(selectedDate), [selectedDate]);

  const rangeStart = useMemo(() => {
    if (viewMode === "week") {
      return weekStartDate;
    }

    if (viewMode === "day") {
      return selectedDate;
    }

    return startOfCalendarGrid(activeMonth);
  }, [activeMonth, selectedDate, viewMode, weekStartDate]);

  const rangeEnd = useMemo(() => {
    if (viewMode === "week") {
      return addDays(weekStartDate, 6);
    }

    if (viewMode === "day") {
      return selectedDate;
    }

    const gridStart = startOfCalendarGrid(activeMonth);
    return addDays(gridStart, 41);
  }, [activeMonth, selectedDate, viewMode, weekStartDate]);

  const {
    absences,
    isLoading: isAbsenceLoading,
    isMutating,
    error: absenceError,
    createAbsence,
    updateAbsence,
    deleteAbsence,
  } = useWorkspaceAbsences(rangeStart, rangeEnd);

  const [form, setForm] = useState<AbsenceForm>(() => buildAbsenceForm(currentUserId));
  const [personalEventForm, setPersonalEventForm] = useState<PersonalEventForm>(() => buildPersonalEventForm(selectedDateKey));
  const [editingAbsenceId, setEditingAbsenceId] = useState<string | null>(null);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isPersonalEventCardOpen, setIsPersonalEventCardOpen] = useState(false);
  const [isAbsenceCardOpen, setIsAbsenceCardOpen] = useState(false);

  useEffect(() => {
    if (!form.profileId && currentUserId) {
      setForm((current) => ({ ...current, profileId: currentUserId }));
    }
  }, [currentUserId, form.profileId]);

  const loadPersonalCalendar = useCallback(
    async (signal?: AbortSignal) => {
      setIsPersonalLoading(true);
      setPersonalError(null);

      try {
        const from = toIsoDate(rangeStart);
        const to = toIsoDate(rangeEnd);
        const response = await fetch(`/api/calendar/personal?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
          method: "GET",
          signal,
          cache: "no-store",
        });

        const payload = await readJsonResponse<PersonalCalendarResponse>(response);

        if (!response.ok) {
          throw new Error(getCalendarLoadError(response, payload));
        }

        setProviders(payload?.providers ?? []);
        setPersonalEvents(payload?.events ?? []);
      } catch (error) {
        if (signal?.aborted) {
          return;
        }

        const message = error instanceof Error ? error.message : "Could not load personal calendar.";
        setPersonalError(message);
        setProviders([]);
        setPersonalEvents([]);
      } finally {
        if (!signal?.aborted) {
          setIsPersonalLoading(false);
        }
      }
    },
    [rangeEnd, rangeStart],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadPersonalCalendar(controller.signal);

    return () => {
      controller.abort();
    };
  }, [loadPersonalCalendar]);

  const monthDays = useMemo(() => {
    const results: Date[] = [];

    for (let index = 0; index < 42; index += 1) {
      results.push(addDays(startOfCalendarGrid(activeMonth), index));
    }

    return results;
  }, [activeMonth]);

  const weekDays = useMemo(() => {
    const results: Date[] = [];

    for (let index = 0; index < 7; index += 1) {
      results.push(addDays(weekStartDate, index));
    }

    return results;
  }, [weekStartDate]);

  const calendarDays = useMemo(() => {
    if (viewMode === "week") {
      return weekDays;
    }

    if (viewMode === "day") {
      return [selectedDate];
    }

    return monthDays;
  }, [monthDays, selectedDate, viewMode, weekDays]);

  const absencesByDay = useMemo(() => {
    const dayMap = new Map<string, WorkspaceAbsence[]>();

    for (const absence of absences) {
      const start = new Date(`${absence.starts_on}T00:00:00`);
      const end = new Date(`${absence.ends_on}T00:00:00`);

      for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
        const key = toDayKey(cursor);
        const bucket = dayMap.get(key) ?? [];
        bucket.push(absence);
        dayMap.set(key, bucket);
      }
    }

    return dayMap;
  }, [absences]);

  const personalEventsByDay = useMemo(() => {
    const dayMap = new Map<string, PersonalCalendarEvent[]>();

    for (const event of personalEvents) {
      const startsAt = new Date(event.startsAt);
      const endsAtRaw = new Date(event.endsAt);

      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAtRaw.getTime())) {
        continue;
      }

      const effectiveEnd = event.isAllDay ? new Date(endsAtRaw.getTime() - 1000) : endsAtRaw;
      const startDay = new Date(startsAt.getFullYear(), startsAt.getMonth(), startsAt.getDate());
      const endDay = new Date(effectiveEnd.getFullYear(), effectiveEnd.getMonth(), effectiveEnd.getDate());

      for (let cursor = new Date(startDay); cursor <= endDay; cursor.setDate(cursor.getDate() + 1)) {
        const key = toDayKey(cursor);
        const bucket = dayMap.get(key) ?? [];
        bucket.push(event);
        dayMap.set(key, bucket);
      }
    }

    return dayMap;
  }, [personalEvents]);

  const selectedDayAbsences = absencesByDay.get(selectedDateKey) ?? [];
  const selectedDayPersonalEvents = personalEventsByDay.get(selectedDateKey) ?? [];
  const connectedProviders = providers.filter((provider) => provider.connected);
  const visibleProviders = connectedProviders.length > 0 ? connectedProviders : providers;
  const timelineDays = viewMode === "week" ? weekDays : [selectedDate];

  const timelineByDay = useMemo(() => {
    const byDay = new Map<string, { timed: TimelineEvent[]; allDay: PersonalCalendarEvent[] }>();

    for (const day of timelineDays) {
      byDay.set(toDayKey(day), { timed: [], allDay: [] });
    }

    for (const event of personalEvents) {
      const startsAt = new Date(event.startsAt);
      const endsAt = new Date(event.endsAt);

      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
        continue;
      }

      for (const day of timelineDays) {
        const dayKey = toDayKey(day);
        const bucket = byDay.get(dayKey);

        if (!bucket) {
          continue;
        }

        const dayStart = startOfDay(day);
        const dayEnd = endOfDay(day);
        const overlapStart = new Date(Math.max(startsAt.getTime(), dayStart.getTime()));
        const overlapEnd = new Date(Math.min(endsAt.getTime(), dayEnd.getTime()));

        if (overlapEnd.getTime() <= overlapStart.getTime()) {
          continue;
        }

        if (event.isAllDay) {
          bucket.allDay.push(event);
          continue;
        }

        const startMinutes = overlapStart.getHours() * 60 + overlapStart.getMinutes();
        const endMinutes = overlapEnd.getHours() * 60 + overlapEnd.getMinutes();
        const durationMinutes = Math.max(15, endMinutes - startMinutes);

        bucket.timed.push({
          event,
          top: (startMinutes / 60) * HOUR_ROW_HEIGHT,
          height: Math.max((durationMinutes / 60) * HOUR_ROW_HEIGHT, 18),
        });
      }
    }

    for (const [, bucket] of byDay) {
      bucket.timed.sort((left, right) => left.top - right.top);
    }

    return byDay;
  }, [personalEvents, timelineDays]);

  const calendarTitle = useMemo(() => {
    if (viewMode === "week") {
      return `Week of ${new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(weekStartDate)}`;
    }

    if (viewMode === "day") {
      return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(selectedDate);
    }

    return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(activeMonth);
  }, [activeMonth, selectedDate, viewMode, weekStartDate]);

  const previousLabel = viewMode === "month" ? "Prev month" : viewMode === "week" ? "Prev week" : "Prev day";
  const currentLabel = viewMode === "month" ? "This month" : viewMode === "week" ? "This week" : "Today";
  const nextLabel = viewMode === "month" ? "Next month" : viewMode === "week" ? "Next week" : "Next day";

  const handleNavigatePrevious = () => {
    if (viewMode === "month") {
      setActiveMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1));
      return;
    }

    const shift = viewMode === "week" ? -7 : -1;
    const nextDate = addDays(selectedDate, shift);
    setSelectedDateKey(toIsoDate(nextDate));
    setActiveMonth(startOfMonth(nextDate));
  };

  const handleNavigateCurrent = () => {
    const today = new Date();
    setSelectedDateKey(toIsoDate(today));
    setActiveMonth(startOfMonth(today));
  };

  const handleNavigateNext = () => {
    if (viewMode === "month") {
      setActiveMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1));
      return;
    }

    const shift = viewMode === "week" ? 7 : 1;
    const nextDate = addDays(selectedDate, shift);
    setSelectedDateKey(toIsoDate(nextDate));
    setActiveMonth(startOfMonth(nextDate));
  };

  useEffect(() => {
    setPersonalEventForm((current) => ({
      ...current,
      startsAt: `${selectedDateKey}T09:00`,
      endsAt: `${selectedDateKey}T10:00`,
    }));
  }, [selectedDateKey]);

  const handleCreatePersonalEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const provider = connectedProviders[0]?.provider;
    const title = personalEventForm.title.trim();

    if (!provider) {
      setPersonalFormError("Connect a calendar provider.");
      return;
    }

    if (!title) {
      setPersonalFormError("Event title is required.");
      return;
    }

    const startsAtDate = personalEventForm.isAllDay
      ? new Date(`${selectedDateKey}T00:00:00`)
      : new Date(personalEventForm.startsAt);
    const endsAtDate = personalEventForm.isAllDay
      ? new Date(`${selectedDateKey}T23:59:00`)
      : new Date(personalEventForm.endsAt);

    if (!personalEventForm.isAllDay) {
      if (Number.isNaN(startsAtDate.getTime()) || Number.isNaN(endsAtDate.getTime())) {
        setPersonalFormError("Start and end values are invalid.");
        return;
      }

      if (startsAtDate.getTime() > endsAtDate.getTime()) {
        setPersonalFormError("End cannot be before start.");
        return;
      }
    }

    setPersonalFormError(null);
    setPersonalFormMessage(null);
    setIsPersonalMutating(true);

    try {
      const response = await fetch("/api/calendar/personal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider,
          title,
          startsAt: startsAtDate.toISOString(),
          endsAt: endsAtDate.toISOString(),
          isAllDay: personalEventForm.isAllDay,
          location: personalEventForm.location.trim() || null,
        }),
      });

      const payload = await readJsonResponse<{ error?: string }>(response);

      if (!response.ok) {
        throw new Error(getPersonalMutationError(response, payload, "Could not create personal event."));
      }

      setPersonalFormMessage("Personal event created.");
      setPersonalEventForm(buildPersonalEventForm(selectedDateKey));
      await loadPersonalCalendar();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create personal event.";
      setPersonalFormError(message);
    } finally {
      setIsPersonalMutating(false);
    }
  };

  const handleDeletePersonalEvent = async (calendarEvent: PersonalCalendarEvent) => {
    const confirmed = window.confirm("Delete this personal event from your linked calendar?");

    if (!confirmed) {
      return;
    }

    setPersonalFormError(null);
    setPersonalFormMessage(null);
    setIsPersonalMutating(true);

    try {
      const response = await fetch("/api/calendar/personal", {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider: calendarEvent.provider,
          eventId: calendarEvent.id,
        }),
      });

      const payload = await readJsonResponse<{ error?: string }>(response);

      if (!response.ok) {
        throw new Error(getPersonalMutationError(response, payload, "Could not delete personal event."));
      }

      setPersonalFormMessage("Personal event deleted.");
      await loadPersonalCalendar();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete personal event.";
      setPersonalFormError(message);
    } finally {
      setIsPersonalMutating(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!form.profileId) {
      setFormError("Select a coworker.");
      return;
    }

    if (form.startsOn > form.endsOn) {
      setFormError("End date cannot be before start date.");
      return;
    }

    setFormMessage(null);
    setFormError(null);

    try {
      if (editingAbsenceId) {
        await updateAbsence({
          absenceId: editingAbsenceId,
          startsOn: form.startsOn,
          endsOn: form.endsOn,
          publicNote: form.publicNote,
        });

        setFormMessage("Absence updated.");
      } else {
        await createAbsence({
          profileId: form.profileId,
          startsOn: form.startsOn,
          endsOn: form.endsOn,
          publicNote: form.publicNote,
        });

        setFormMessage("Absence created.");
      }

      setEditingAbsenceId(null);
      setForm(buildAbsenceForm(currentUserId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save absence.";
      setFormError(message);
    }
  };

  const handleEdit = (absence: WorkspaceAbsence) => {
    setEditingAbsenceId(absence.id);
    setForm({
      profileId: absence.profile_id,
      startsOn: absence.starts_on,
      endsOn: absence.ends_on,
      publicNote: absence.public_note ?? "",
    });
    setFormMessage(null);
    setFormError(null);
  };

  const handleDelete = async (absence: WorkspaceAbsence) => {
    const confirmed = window.confirm("Delete this absence?");

    if (!confirmed) {
      return;
    }

    setFormMessage(null);
    setFormError(null);

    try {
      await deleteAbsence(absence.id);
      setFormMessage("Absence deleted.");

      if (editingAbsenceId === absence.id) {
        setEditingAbsenceId(null);
        setForm(buildAbsenceForm(currentUserId));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete absence.";
      setFormError(message);
    }
  };

  return (
    <section className="flex min-h-full flex-col gap-6 pb-6">
      <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">Unified calendar</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--foreground)]">Personal and workspace timeline</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--muted)]">
              Personal events are read from your linked mailbox calendar providers. Workspace absences are manually managed here so coworkers can rebalance workload when someone is out.
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2 text-xs">
          {visibleProviders.map((provider) => {
            const needsReconnect = !provider.connected;
            const isTemporarilyUnavailable = provider.status === "connected_unavailable";
            const badgeClass = `rounded-full border px-2.5 py-1 font-semibold uppercase tracking-[0.1em] ${
              provider.connected && !isTemporarilyUnavailable
                ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                : "border-amber-300 bg-amber-50 text-amber-700"
            }`;

            if (needsReconnect || isTemporarilyUnavailable) {
              return (
                <Link
                  key={provider.provider}
                  href="/settings/mailbox"
                  className={`${badgeClass} transition hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300`}
                >
                  {provider.provider} {formatProviderStatus(provider.status)} - open email settings
                </Link>
              );
            }

            return (
              <span key={provider.provider} className={badgeClass}>
                {provider.provider} {formatProviderStatus(provider.status)}
              </span>
            );
          })}
          {!providers.length && isPersonalLoading ? (
            <span className="rounded-full border border-[var(--border)] bg-white px-2.5 py-1 font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
              Loading providers
            </span>
          ) : null}
        </div>

        {personalError ? <p className="mt-3 text-sm text-red-500">{personalError}</p> : null}
      </article>

      <div className="grid gap-6 xl:grid-cols-2">
        <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="text-lg font-semibold text-[var(--foreground)]">Add personal event</h3>
            <button
              type="button"
              onClick={() => setIsPersonalEventCardOpen((open) => !open)}
              className="admin-disclosure-hint"
              aria-expanded={isPersonalEventCardOpen}
            >
              {isPersonalEventCardOpen ? "Hide" : "Open"}
            </button>
          </div>

          {isPersonalEventCardOpen ? (
            <form onSubmit={handleCreatePersonalEvent} className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="flex items-end gap-2 pb-2 text-sm text-[var(--muted)]">
                <input
                  type="checkbox"
                  checked={personalEventForm.isAllDay}
                  onChange={(event) => setPersonalEventForm((current) => ({ ...current, isAllDay: event.target.checked }))}
                  className="h-4 w-4 rounded border-[var(--border)]"
                />
                All day
              </label>

              <label className="space-y-1 text-sm text-[var(--muted)] md:col-span-2">
                Title
                <input
                  type="text"
                  value={personalEventForm.title}
                  onChange={(event) => setPersonalEventForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Client call, dentist, focused work..."
                  className="w-full rounded-2xl border border-[var(--border)] bg-white px-3 py-2.5 text-sm text-[var(--foreground)]"
                />
              </label>

              {personalEventForm.isAllDay ? (
                <p className="md:col-span-2 rounded-xl border border-dashed border-[var(--border)] bg-white/70 px-3 py-2 text-sm text-[var(--muted)]">
                  This all-day event will be created on {selectedDateKey}.
                </p>
              ) : (
                <>
                  <label className="space-y-1 text-sm text-[var(--muted)]">
                    Start
                    <DateTimePickerInput
                      mode="datetime"
                      value={personalEventForm.startsAt}
                      onChange={(nextValue) =>
                        setPersonalEventForm((current) => ({
                          ...current,
                          startsAt: nextValue,
                          endsAt: addOneHourToLocalIsoDateTime(nextValue),
                        }))
                      }
                      className="w-full rounded-2xl border border-[var(--border)] bg-white px-3 py-2.5 text-sm text-[var(--foreground)]"
                    />
                  </label>

                  <label className="space-y-1 text-sm text-[var(--muted)]">
                    End
                    <DateTimePickerInput
                      mode="datetime"
                      value={personalEventForm.endsAt}
                      onChange={(nextValue) => setPersonalEventForm((current) => ({ ...current, endsAt: nextValue }))}
                      className="w-full rounded-2xl border border-[var(--border)] bg-white px-3 py-2.5 text-sm text-[var(--foreground)]"
                    />
                  </label>
                </>
              )}

              <label className="space-y-1 text-sm text-[var(--muted)] md:col-span-2">
                Location (optional)
                <input
                  type="text"
                  value={personalEventForm.location}
                  onChange={(event) => setPersonalEventForm((current) => ({ ...current, location: event.target.value }))}
                  placeholder="Address or meeting room"
                  className="w-full rounded-2xl border border-[var(--border)] bg-white px-3 py-2.5 text-sm text-[var(--foreground)]"
                />
              </label>

              {connectedProviders.length === 0 ? (
                <p className="md:col-span-2 text-sm text-amber-700">Connect Google or Outlook in email settings to create personal events.</p>
              ) : null}
              {personalFormError ? <p className="md:col-span-2 text-sm text-red-500">{personalFormError}</p> : null}
              {personalFormMessage ? <p className="md:col-span-2 text-sm text-emerald-600">{personalFormMessage}</p> : null}

              <div className="md:col-span-2 flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={isPersonalMutating || connectedProviders.length === 0}
                  className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isPersonalMutating ? "Saving..." : "Create personal event"}
                </button>
              </div>
            </form>
          ) : null}
        </article>

        <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="text-lg font-semibold text-[var(--foreground)]">Add workspace absence</h3>
            <button
              type="button"
              onClick={() => setIsAbsenceCardOpen((open) => !open)}
              className="admin-disclosure-hint"
              aria-expanded={isAbsenceCardOpen}
            >
              {isAbsenceCardOpen ? "Hide" : "Open"}
            </button>
          </div>

          {isAbsenceCardOpen ? (
            <form onSubmit={handleSubmit} className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="space-y-1 text-sm text-[var(--muted)]">
                Coworker
                <select
                  value={form.profileId}
                  onChange={(event) => setForm((current) => ({ ...current, profileId: event.target.value }))}
                  className="w-full rounded-2xl border border-[var(--border)] bg-white px-3 py-2.5 text-sm text-[var(--foreground)]"
                >
                  <option value="">Select member</option>
                  {members.map((member) => (
                    <option key={member.profile_id} value={member.profile_id}>
                      {formatMemberName(member.first_name, member.last_name)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-1 text-sm text-[var(--muted)]">
                Start date
                <DateTimePickerInput
                  mode="date"
                  value={form.startsOn}
                  onChange={(nextValue) => setForm((current) => ({ ...current, startsOn: nextValue }))}
                  className="w-full rounded-2xl border border-[var(--border)] bg-white px-3 py-2.5 text-sm text-[var(--foreground)]"
                />
              </label>

              <label className="space-y-1 text-sm text-[var(--muted)]">
                End date
                <DateTimePickerInput
                  mode="date"
                  value={form.endsOn}
                  onChange={(nextValue) => setForm((current) => ({ ...current, endsOn: nextValue }))}
                  className="w-full rounded-2xl border border-[var(--border)] bg-white px-3 py-2.5 text-sm text-[var(--foreground)]"
                />
              </label>

              <label className="space-y-1 text-sm text-[var(--muted)] md:col-span-2">
                Public note (optional)
                <input
                  type="text"
                  maxLength={240}
                  value={form.publicNote}
                  onChange={(event) => setForm((current) => ({ ...current, publicNote: event.target.value }))}
                  placeholder="Optional short context visible to workspace members"
                  className="w-full rounded-2xl border border-[var(--border)] bg-white px-3 py-2.5 text-sm text-[var(--foreground)]"
                />
              </label>

              {absenceError ? <p className="md:col-span-2 text-sm text-red-500">{absenceError}</p> : null}
              {formError ? <p className="md:col-span-2 text-sm text-red-500">{formError}</p> : null}
              {formMessage ? <p className="md:col-span-2 text-sm text-emerald-600">{formMessage}</p> : null}

              <div className="md:col-span-2 flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={isMutating}
                  className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {editingAbsenceId ? "Save changes" : "Create absence"}
                </button>

                {editingAbsenceId ? (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingAbsenceId(null);
                      setForm(buildAbsenceForm(currentUserId));
                      setFormMessage(null);
                      setFormError(null);
                    }}
                    className="rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                  >
                    Cancel edit
                  </button>
                ) : null}
              </div>
            </form>
          ) : null}
        </article>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold text-[var(--foreground)]">{calendarTitle}</h3>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleNavigatePrevious}
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                >
                  {previousLabel}
                </button>
                <button
                  type="button"
                  onClick={handleNavigateCurrent}
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                >
                  {currentLabel}
                </button>
                <button
                  type="button"
                  onClick={handleNavigateNext}
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                >
                  {nextLabel}
                </button>
              </div>
            </div>
            {(isAbsenceLoading || isPersonalLoading) ? (
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">Refreshing</span>
            ) : null}
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            {(["month", "week", "day"] as CalendarViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setViewMode(mode);
                  if (mode === "month") {
                    setActiveMonth(startOfMonth(selectedDate));
                  }
                }}
                className={`rounded-xl border px-3 py-1.5 text-sm font-semibold transition ${
                  viewMode === mode
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--foreground)]"
                    : "border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-slate-50"
                }`}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>

          {viewMode === "month" ? (
            <div className="grid grid-cols-7 gap-2">
              {WEEKDAY_LABELS.map((label) => (
                <div key={label} className="px-1 text-center text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
                  {label}
                </div>
              ))}

              {calendarDays.map((day) => {
                const dayKey = toDayKey(day);
                const isCurrentMonth = day.getMonth() === activeMonth.getMonth();
                const isSelected = dayKey === selectedDateKey;
                const dayAbsenceCount = (absencesByDay.get(dayKey) ?? []).length;
                const dayPersonalCount = (personalEventsByDay.get(dayKey) ?? []).length;

                return (
                  <button
                    key={dayKey}
                    type="button"
                    onClick={() => {
                      setSelectedDateKey(dayKey);
                      setActiveMonth(startOfMonth(day));
                    }}
                    className={`min-h-[92px] rounded-2xl border px-2 py-2 text-left transition ${
                      isSelected
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--border)] bg-white/80 hover:bg-slate-50"
                    } ${!isCurrentMonth ? "opacity-50" : "opacity-100"}`}
                  >
                    <p className="text-sm font-semibold text-[var(--foreground)]">{day.getDate()}</p>
                    <div className="mt-2 space-y-1">
                      <p className={`text-[11px] font-medium ${isSelected ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                        Personal events: {dayPersonalCount}
                      </p>
                      <p className={`text-[11px] font-medium ${isSelected ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                        Absences: {dayAbsenceCount}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className={`grid gap-2 ${viewMode === "week" ? "grid-cols-[64px_repeat(7,minmax(140px,1fr))]" : "grid-cols-[64px_minmax(220px,1fr)]"}`}>
                <div />
                {timelineDays.map((day) => {
                  const dayKey = toDayKey(day);
                  const isSelected = dayKey === selectedDateKey;
                  const dayPersonalCount = (personalEventsByDay.get(dayKey) ?? []).length;

                  return (
                    <button
                      key={`timeline-header-${dayKey}`}
                      type="button"
                      onClick={() => setSelectedDateKey(dayKey)}
                      className={`rounded-xl border px-2 py-2 text-left ${isSelected ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)] bg-white"}`}
                    >
                      <p className="text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
                        {new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(day)}
                      </p>
                      <p className="text-sm font-semibold text-[var(--foreground)]">
                        {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(day)}
                      </p>
                      <p className="text-[11px] text-[var(--muted)]">Events: {dayPersonalCount}</p>
                    </button>
                  );
                })}

                <div className="relative" style={{ height: `${HOUR_ROW_HEIGHT * HOURS_IN_DAY}px` }}>
                  {Array.from({ length: HOURS_IN_DAY + 1 }, (_, hour) => (
                    <div key={`hour-${hour}`} className="absolute left-0 right-0" style={{ top: `${hour * HOUR_ROW_HEIGHT}px` }}>
                      {hour < HOURS_IN_DAY ? (
                        <span className="-translate-y-1/2 text-xs text-[var(--muted)]">{formatHourLabel(hour)}</span>
                      ) : null}
                    </div>
                  ))}
                </div>

                {timelineDays.map((day) => {
                  const dayKey = toDayKey(day);
                  const bucket = timelineByDay.get(dayKey) ?? { timed: [], allDay: [] };

                  return (
                    <div key={`timeline-day-${dayKey}`} className="relative rounded-xl border border-[var(--border)] bg-white/90" style={{ height: `${HOUR_ROW_HEIGHT * HOURS_IN_DAY}px` }}>
                      {Array.from({ length: HOURS_IN_DAY + 1 }, (_, hour) => (
                        <div
                          key={`line-${dayKey}-${hour}`}
                          className="absolute left-0 right-0 border-t border-slate-100"
                          style={{ top: `${hour * HOUR_ROW_HEIGHT}px` }}
                        />
                      ))}

                      {bucket.allDay.length ? (
                        <div className="absolute left-1 right-1 top-1 z-20 flex flex-wrap gap-1">
                          {bucket.allDay.map((event) => (
                            <span key={`all-day-${dayKey}-${event.provider}-${event.id}`} className="rounded-md bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800">
                              {event.title}
                            </span>
                          ))}
                        </div>
                      ) : null}

                      {bucket.timed.map((item, index) => (
                        <div
                          key={`timed-${dayKey}-${item.event.provider}-${item.event.id}-${index}`}
                          className="absolute left-1 right-1 z-10 overflow-hidden rounded-lg border border-blue-200 bg-blue-50 px-2 py-1"
                          style={{ top: `${item.top}px`, height: `${item.height}px` }}
                          title={`${item.event.title} (${item.event.provider})`}
                        >
                          <p className="truncate text-[11px] font-semibold text-blue-900">{item.event.title}</p>
                          <p className="truncate text-[10px] text-blue-700">
                            {formatTimeRange(new Date(item.event.startsAt), new Date(item.event.endsAt))}
                          </p>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </article>

        <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <h3 className="text-lg font-semibold text-[var(--foreground)]">{selectedDateKey}</h3>
          <div className="mt-4 space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Personal calendar</p>
              <div className="mt-2 space-y-2">
                {selectedDayPersonalEvents.length ? (
                  selectedDayPersonalEvents.map((event) => (
                    <div key={`${event.provider}:${event.id}`} className="rounded-xl border border-[var(--border)] bg-white px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-[var(--foreground)]">{event.title}</p>
                          <p className="mt-1 text-xs text-[var(--muted)]">
                            {event.isAllDay
                              ? "All day"
                              : `${new Intl.DateTimeFormat("en-GB", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }).format(new Date(event.startsAt))} - ${new Intl.DateTimeFormat("en-GB", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                }).format(new Date(event.endsAt))}`}
                            {" | "}
                            {event.provider}
                          </p>
                          {event.location ? <p className="mt-1 text-xs text-[var(--muted)]">{event.location}</p> : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void handleDeletePersonalEvent(event);
                          }}
                          disabled={isPersonalMutating}
                          className="rounded-lg border border-red-300 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-70"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="rounded-xl border border-dashed border-[var(--border)] bg-white/70 px-3 py-2 text-sm text-[var(--muted)]">
                    No personal events on this day.
                  </p>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Workspace absences</p>
              <div className="mt-2 space-y-2">
                {selectedDayAbsences.length ? (
                  selectedDayAbsences.map((absence) => (
                    <div key={absence.id} className="rounded-xl border border-[var(--border)] bg-white px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-[var(--foreground)]">
                            {formatMemberName(absence.first_name, absence.last_name)}
                          </p>
                          <p className="mt-1 text-xs text-[var(--muted)]">{formatDateRange(absence.starts_on, absence.ends_on)}</p>
                          <p className="mt-1 text-xs text-[var(--muted)]">{formatStatusLabel(absence.status)}</p>
                          {absence.public_note ? <p className="mt-1 text-xs text-[var(--muted)]">{absence.public_note}</p> : null}
                        </div>
                        <div className="flex gap-1">
                          {absence.can_edit ? (
                            <button
                              type="button"
                              onClick={() => handleEdit(absence)}
                              className="rounded-lg border border-[var(--border)] bg-white px-2 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                            >
                              Edit
                            </button>
                          ) : null}
                          {absence.can_delete ? (
                            <button
                              type="button"
                              onClick={() => {
                                void handleDelete(absence);
                              }}
                              className="rounded-lg border border-red-300 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 transition hover:bg-red-100"
                            >
                              Delete
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="rounded-xl border border-dashed border-[var(--border)] bg-white/70 px-3 py-2 text-sm text-[var(--muted)]">
                    No coworker absences on this day.
                  </p>
                )}
              </div>
            </div>
          </div>
        </article>
      </div>

    </section>
  );
}
