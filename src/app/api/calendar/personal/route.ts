import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type CalendarProvider = "gmail" | "outlook";

type MailboxConnectionRow = {
  id: string;
  workspace_id: string;
  profile_id: string;
  provider: CalendarProvider;
  status: "connected" | "disconnected" | "pending" | "error";
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
};

type PersonalCalendarEvent = {
  id: string;
  provider: CalendarProvider;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  location: string | null;
};

type CreatePersonalEventPayload = {
  provider: CalendarProvider;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  location: string | null;
};

type DeletePersonalEventPayload = {
  provider: CalendarProvider;
  eventId: string;
};

type CalendarRequestContext = {
  userId: string;
  workspaceId: string;
  connections: MailboxConnectionRow[];
};

type ProviderErrorCode = "reconnect_required" | "temporary_failure";

class ProviderCalendarError extends Error {
  code: ProviderErrorCode;
  reason: string | null;

  constructor(message: string, code: ProviderErrorCode, reason?: string | null) {
    super(message);
    this.code = code;
    this.reason = reason ?? null;
  }
}

export async function GET(request: NextRequest) {
  const context = await loadCalendarRequestContext();

  if ("errorResponse" in context) {
    return context.errorResponse;
  }

  if (!context.workspaceId) {
    return NextResponse.json({ events: [], providers: [], range: null });
  }

  const from = parseDateOrFallback(request.nextUrl.searchParams.get("from"), startOfMonth(new Date()));
  const to = parseDateOrFallback(request.nextUrl.searchParams.get("to"), endOfMonth(new Date()));

  if (from.getTime() > to.getTime()) {
    return NextResponse.json({ error: "Invalid date range." }, { status: 400 });
  }

  const rows = context.connections;

  const providerStates: Array<{ provider: CalendarProvider; connected: boolean; status: string; reason?: string }> = [];
  const events: PersonalCalendarEvent[] = [];

  for (const provider of ["gmail", "outlook"] as const) {
    const row = rows.find((candidate) => candidate.provider === provider) ?? null;

    if (!row) {
      providerStates.push({
        provider,
        connected: false,
        status: "not_connected",
        reason: "Provider not connected.",
      });
      continue;
    }

    try {
      const providerEvents =
        provider === "gmail"
          ? await fetchGoogleCalendarEvents(row, from, to)
          : await fetchOutlookCalendarEvents(row, from, to);

      events.push(...providerEvents);
      providerStates.push({
        provider,
        connected: true,
        status: "connected",
      });
    } catch (error) {
      const reconnectRequired = isReconnectRequiredError(error);
      const reason = getProviderErrorReason(error, reconnectRequired);

      providerStates.push({
        provider,
        connected: !reconnectRequired,
        status: reconnectRequired ? "reconnect_required" : "connected_unavailable",
        reason,
      });
    }
  }

  events.sort((left, right) => new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime());

  return NextResponse.json({
    events,
    providers: providerStates,
    range: {
      from: toIsoDate(from),
      to: toIsoDate(to),
    },
  });
}

export async function POST(request: NextRequest) {
  const context = await loadCalendarRequestContext();

  if ("errorResponse" in context) {
    return context.errorResponse;
  }

  const payloadResult = await parseCreatePayload(request);

  if ("errorResponse" in payloadResult) {
    return payloadResult.errorResponse;
  }

  const payload = payloadResult.payload;
  const connection = context.connections.find((candidate) => candidate.provider === payload.provider) ?? null;

  if (!connection) {
    return NextResponse.json({ error: "Selected calendar provider is not connected." }, { status: 400 });
  }

  try {
    if (payload.provider === "gmail") {
      await createGoogleCalendarEvent(connection, payload);
    } else {
      await createOutlookCalendarEvent(connection, payload);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const reconnectRequired = isReconnectRequiredError(error);
    const reason = getProviderErrorReason(error, reconnectRequired);

    return NextResponse.json(
      {
        error: reconnectRequired
          ? `Reconnect ${payload.provider} calendar to add events. ${reason}`
          : `Could not create event in ${payload.provider} calendar. ${reason}`,
      },
      { status: reconnectRequired ? 400 : 502 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const context = await loadCalendarRequestContext();

  if ("errorResponse" in context) {
    return context.errorResponse;
  }

  const payloadResult = await parseDeletePayload(request);

  if ("errorResponse" in payloadResult) {
    return payloadResult.errorResponse;
  }

  const payload = payloadResult.payload;
  const connection = context.connections.find((candidate) => candidate.provider === payload.provider) ?? null;

  if (!connection) {
    return NextResponse.json({ error: "Selected calendar provider is not connected." }, { status: 400 });
  }

  try {
    if (payload.provider === "gmail") {
      await deleteGoogleCalendarEvent(connection, payload.eventId);
    } else {
      await deleteOutlookCalendarEvent(connection, payload.eventId);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const reconnectRequired = isReconnectRequiredError(error);
    const reason = getProviderErrorReason(error, reconnectRequired);

    return NextResponse.json(
      {
        error: reconnectRequired
          ? `Reconnect ${payload.provider} calendar to delete events. ${reason}`
          : `Could not delete event from ${payload.provider} calendar. ${reason}`,
      },
      { status: reconnectRequired ? 400 : 502 },
    );
  }
}

async function loadCalendarRequestContext(): Promise<CalendarRequestContext | { errorResponse: NextResponse }> {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return { errorResponse: NextResponse.json({ error: "Supabase is not configured." }, { status: 500 }) };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const { data: profileData } = await supabase.rpc("get_current_profile");
  const profile = profileData as { workspace_id?: string | null } | null;
  const workspaceId = profile?.workspace_id?.trim() || "";

  if (!workspaceId) {
    return { userId: user.id, workspaceId: "", connections: [] };
  }

  const supabaseAdmin = getSupabaseAdminClient();

  if (!supabaseAdmin) {
    return { errorResponse: NextResponse.json({ error: "Supabase service role client unavailable." }, { status: 500 }) };
  }

  const { data: connections, error: connectionsError } = await supabaseAdmin
    .from("mailbox_connections")
    .select("id, workspace_id, profile_id, provider, status, oauth_access_token, oauth_refresh_token")
    .eq("workspace_id", workspaceId)
    .eq("profile_id", user.id)
    .eq("status", "connected")
    .in("provider", ["gmail", "outlook"]);

  if (connectionsError) {
    return { errorResponse: NextResponse.json({ error: "Could not load calendar providers." }, { status: 500 }) };
  }

  return {
    userId: user.id,
    workspaceId,
    connections: (connections ?? []) as MailboxConnectionRow[],
  };
}

async function parseCreatePayload(request: NextRequest): Promise<{ payload: CreatePersonalEventPayload } | { errorResponse: NextResponse }> {
  let body: unknown;

  try {
    body = (await request.json()) as unknown;
  } catch {
    return { errorResponse: NextResponse.json({ error: "Invalid request body." }, { status: 400 }) };
  }

  if (!body || typeof body !== "object") {
    return { errorResponse: NextResponse.json({ error: "Invalid request body." }, { status: 400 }) };
  }

  const payload = body as Record<string, unknown>;
  const provider = parseProvider(payload.provider);
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const startsAt = typeof payload.startsAt === "string" ? payload.startsAt.trim() : "";
  const endsAt = typeof payload.endsAt === "string" ? payload.endsAt.trim() : "";
  const isAllDay = Boolean(payload.isAllDay);
  const location = typeof payload.location === "string" ? payload.location.trim() : "";

  if (!provider || !title || !startsAt || !endsAt) {
    return { errorResponse: NextResponse.json({ error: "Missing required event fields." }, { status: 400 }) };
  }

  const startsDate = new Date(startsAt);
  const endsDate = new Date(endsAt);

  if (Number.isNaN(startsDate.getTime()) || Number.isNaN(endsDate.getTime()) || startsDate.getTime() > endsDate.getTime()) {
    return { errorResponse: NextResponse.json({ error: "Invalid event start/end values." }, { status: 400 }) };
  }

  return {
    payload: {
      provider,
      title,
      startsAt: startsDate.toISOString(),
      endsAt: endsDate.toISOString(),
      isAllDay,
      location: location || null,
    },
  };
}

async function parseDeletePayload(request: NextRequest): Promise<{ payload: DeletePersonalEventPayload } | { errorResponse: NextResponse }> {
  let body: unknown;

  try {
    body = (await request.json()) as unknown;
  } catch {
    return { errorResponse: NextResponse.json({ error: "Invalid request body." }, { status: 400 }) };
  }

  if (!body || typeof body !== "object") {
    return { errorResponse: NextResponse.json({ error: "Invalid request body." }, { status: 400 }) };
  }

  const payload = body as Record<string, unknown>;
  const provider = parseProvider(payload.provider);
  const eventId = typeof payload.eventId === "string" ? payload.eventId.trim() : "";

  if (!provider || !eventId) {
    return { errorResponse: NextResponse.json({ error: "Missing provider or event id." }, { status: 400 }) };
  }

  return { payload: { provider, eventId } };
}

function parseProvider(value: unknown): CalendarProvider | null {
  if (value === "gmail" || value === "outlook") {
    return value;
  }

  return null;
}

async function fetchGoogleCalendarEvents(
  connection: MailboxConnectionRow,
  from: Date,
  to: Date,
): Promise<PersonalCalendarEvent[]> {
  const accessToken = await resolveGoogleAccessToken(connection);

  if (!accessToken) {
    throw new ProviderCalendarError("No Google access token available.", "reconnect_required");
  }

  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", from.toISOString());
  url.searchParams.set("timeMax", to.toISOString());
  url.searchParams.set("maxResults", "250");

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const details = await safeReadJson(response);
    const code = classifyProviderResponseFailure(response.status, details);
    throw new ProviderCalendarError("Google calendar query failed.", code, buildProviderFailureReason(response.status, details));
  }

  const payload = (await response.json()) as {
    items?: Array<{
      id?: string;
      summary?: string;
      location?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }>;
  };

  const items = payload.items ?? [];
  const events: PersonalCalendarEvent[] = [];

  for (const item of items) {
    const startDateTime = item.start?.dateTime?.trim() || "";
    const endDateTime = item.end?.dateTime?.trim() || "";
    const allDayStart = item.start?.date?.trim() || "";
    const allDayEnd = item.end?.date?.trim() || "";
    const isAllDay = Boolean(allDayStart && allDayEnd);

    const startsAt = isAllDay ? `${allDayStart}T00:00:00.000Z` : startDateTime;
    const endsAt = isAllDay ? `${allDayEnd}T00:00:00.000Z` : endDateTime;

    if (!startsAt || !endsAt) {
      continue;
    }

    events.push({
      id: item.id?.trim() || `${startsAt}-google`,
      provider: "gmail",
      title: item.summary?.trim() || "Untitled event",
      startsAt,
      endsAt,
      isAllDay,
      location: item.location?.trim() || null,
    });
  }

  return events;
}

async function fetchOutlookCalendarEvents(
  connection: MailboxConnectionRow,
  from: Date,
  to: Date,
): Promise<PersonalCalendarEvent[]> {
  const accessToken = await resolveOutlookAccessToken(connection);

  if (!accessToken) {
    throw new ProviderCalendarError("No Outlook access token available.", "reconnect_required");
  }

  const url = new URL("https://graph.microsoft.com/v1.0/me/calendarView");
  url.searchParams.set("startDateTime", from.toISOString());
  url.searchParams.set("endDateTime", to.toISOString());
  url.searchParams.set("$top", "250");
  url.searchParams.set("$orderby", "start/dateTime");

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.timezone="UTC"',
    },
  });

  if (!response.ok) {
    const details = await safeReadJson(response);
    const code = classifyProviderResponseFailure(response.status, details);
    throw new ProviderCalendarError("Outlook calendar query failed.", code, buildProviderFailureReason(response.status, details));
  }

  const payload = (await response.json()) as {
    value?: Array<{
      id?: string;
      subject?: string;
      isAllDay?: boolean;
      location?: { displayName?: string };
      start?: { dateTime?: string; timeZone?: string };
      end?: { dateTime?: string; timeZone?: string };
    }>;
  };

  const items = payload.value ?? [];
  const events: PersonalCalendarEvent[] = [];

  for (const item of items) {
    const startsAt = normalizeOutlookDateTime(item.start?.dateTime, item.start?.timeZone);
    const endsAt = normalizeOutlookDateTime(item.end?.dateTime, item.end?.timeZone);

    if (!startsAt || !endsAt) {
      continue;
    }

    events.push({
      id: item.id?.trim() || `${startsAt}-outlook`,
      provider: "outlook",
      title: item.subject?.trim() || "Untitled event",
      startsAt,
      endsAt,
      isAllDay: Boolean(item.isAllDay),
      location: item.location?.displayName?.trim() || null,
    });
  }

  return events;
}

async function createGoogleCalendarEvent(connection: MailboxConnectionRow, payload: CreatePersonalEventPayload) {
  const accessToken = await resolveGoogleAccessToken(connection);

  if (!accessToken) {
    throw new ProviderCalendarError("No Google access token available.", "reconnect_required");
  }

  const body = payload.isAllDay
    ? {
        summary: payload.title,
        location: payload.location ?? undefined,
        start: { date: toIsoDate(new Date(payload.startsAt)) },
        end: { date: toIsoDate(addDaysUtc(new Date(payload.endsAt), 1)) },
      }
    : {
        summary: payload.title,
        location: payload.location ?? undefined,
        start: { dateTime: payload.startsAt },
        end: { dateTime: payload.endsAt },
      };

  const response = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const details = await safeReadJson(response);
    const code = classifyProviderResponseFailure(response.status, details);
    throw new ProviderCalendarError("Google calendar create failed.", code, buildProviderFailureReason(response.status, details));
  }
}

async function createOutlookCalendarEvent(connection: MailboxConnectionRow, payload: CreatePersonalEventPayload) {
  const accessToken = await resolveOutlookAccessToken(connection);

  if (!accessToken) {
    throw new ProviderCalendarError("No Outlook access token available.", "reconnect_required");
  }

  const startsAt = new Date(payload.startsAt);
  const endsAt = new Date(payload.endsAt);

  const body = payload.isAllDay
    ? {
        subject: payload.title,
        isAllDay: true,
        location: payload.location ? { displayName: payload.location } : undefined,
        start: {
          dateTime: `${toIsoDate(startsAt)}T00:00:00`,
          timeZone: "UTC",
        },
        end: {
          dateTime: `${toIsoDate(addDaysUtc(endsAt, 1))}T00:00:00`,
          timeZone: "UTC",
        },
      }
    : {
        subject: payload.title,
        isAllDay: false,
        location: payload.location ? { displayName: payload.location } : undefined,
        start: {
          dateTime: toOutlookDateTime(startsAt),
          timeZone: "UTC",
        },
        end: {
          dateTime: toOutlookDateTime(endsAt),
          timeZone: "UTC",
        },
      };

  const response = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const details = await safeReadJson(response);
    const code = classifyProviderResponseFailure(response.status, details);
    throw new ProviderCalendarError("Outlook calendar create failed.", code, buildProviderFailureReason(response.status, details));
  }
}

async function deleteGoogleCalendarEvent(connection: MailboxConnectionRow, eventId: string) {
  const accessToken = await resolveGoogleAccessToken(connection);

  if (!accessToken) {
    throw new ProviderCalendarError("No Google access token available.", "reconnect_required");
  }

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const details = await safeReadJson(response);
    const code = classifyProviderResponseFailure(response.status, details);
    throw new ProviderCalendarError("Google calendar delete failed.", code, buildProviderFailureReason(response.status, details));
  }
}

async function deleteOutlookCalendarEvent(connection: MailboxConnectionRow, eventId: string) {
  const accessToken = await resolveOutlookAccessToken(connection);

  if (!accessToken) {
    throw new ProviderCalendarError("No Outlook access token available.", "reconnect_required");
  }

  const response = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const details = await safeReadJson(response);
    const code = classifyProviderResponseFailure(response.status, details);
    throw new ProviderCalendarError("Outlook calendar delete failed.", code, buildProviderFailureReason(response.status, details));
  }
}

function normalizeOutlookDateTime(value: string | undefined, timeZone: string | undefined) {
  if (!value || !value.trim()) {
    return null;
  }

  const asDate = new Date(value);

  if (!Number.isNaN(asDate.getTime())) {
    return asDate.toISOString();
  }

  if (timeZone && timeZone.toUpperCase() !== "UTC") {
    const fallbackDate = new Date(`${value}Z`);
    if (!Number.isNaN(fallbackDate.getTime())) {
      return fallbackDate.toISOString();
    }
  }

  return null;
}

async function resolveGoogleAccessToken(connection: MailboxConnectionRow) {
  const refreshToken = connection.oauth_refresh_token?.trim() || "";

  if (!refreshToken) {
    return connection.oauth_access_token?.trim() || null;
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    return connection.oauth_access_token?.trim() || null;
  }

  const refreshResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!refreshResponse.ok) {
    return connection.oauth_access_token?.trim() || null;
  }

  const payload = (await refreshResponse.json()) as { access_token?: string };
  return payload.access_token?.trim() || connection.oauth_access_token?.trim() || null;
}

async function resolveOutlookAccessToken(connection: MailboxConnectionRow) {
  const refreshToken = connection.oauth_refresh_token?.trim() || "";

  if (!refreshToken) {
    return connection.oauth_access_token?.trim() || null;
  }

  const clientId = process.env.AZURE_CLIENT_ID?.trim() || process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.AZURE_CLIENT_SECRET?.trim() || process.env.MICROSOFT_CLIENT_SECRET?.trim();
  const tenantId = process.env.AZURE_TENANT_ID?.trim() || "common";

  if (!clientId || !clientSecret) {
    return connection.oauth_access_token?.trim() || null;
  }

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const refreshResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: "offline_access openid profile email User.Read Mail.Read Calendars.ReadWrite",
    }),
  });

  if (!refreshResponse.ok) {
    return connection.oauth_access_token?.trim() || null;
  }

  const payload = (await refreshResponse.json()) as { access_token?: string };
  return payload.access_token?.trim() || connection.oauth_access_token?.trim() || null;
}

function parseDateOrFallback(value: string | null, fallback: Date) {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed;
}

function startOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0));
}

function endOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59));
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDaysUtc(date: Date, amount: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + amount, 0, 0, 0));
}

function toOutlookDateTime(date: Date) {
  return date.toISOString().replace("Z", "");
}

function isReconnectRequiredError(error: unknown) {
  return error instanceof ProviderCalendarError && error.code === "reconnect_required";
}

function getProviderErrorReason(error: unknown, reconnectRequired: boolean) {
  if (error instanceof ProviderCalendarError) {
    if (error.reason) {
      return error.reason;
    }

    return reconnectRequired
      ? "Calendar permission is missing or token is invalid."
      : "Calendar provider is temporarily unavailable.";
  }

  return reconnectRequired
    ? "Calendar permission is missing or token is invalid."
    : "Calendar provider is temporarily unavailable.";
}

function buildProviderFailureReason(status: number, details: unknown) {
  const detailsText = extractProviderDetails(details);

  if (status === 401) {
    return detailsText || "Authentication failed (401).";
  }

  if (status === 403) {
    if (detailsText.toLowerCase().includes("insufficient") || detailsText.toLowerCase().includes("scope")) {
      return "Missing calendar permission scope. Reconnect and accept calendar access.";
    }

    return detailsText || "Access forbidden (403).";
  }

  return detailsText || `Provider request failed (${status}).`;
}

function extractProviderDetails(details: unknown) {
  if (!details) {
    return "";
  }

  if (typeof details === "string") {
    return details.slice(0, 240);
  }

  if (typeof details === "object") {
    const asRecord = details as Record<string, unknown>;
    const error = asRecord.error;

    if (typeof error === "string" && error.trim()) {
      return error.trim().slice(0, 240);
    }

    if (error && typeof error === "object") {
      const nested = error as Record<string, unknown>;
      if (typeof nested.message === "string" && nested.message.trim()) {
        return nested.message.trim().slice(0, 240);
      }
    }

    if (typeof asRecord.error_description === "string" && asRecord.error_description.trim()) {
      return asRecord.error_description.trim().slice(0, 240);
    }

    if (typeof asRecord.message === "string" && asRecord.message.trim()) {
      return asRecord.message.trim().slice(0, 240);
    }
  }

  return "";
}

function classifyProviderResponseFailure(status: number, details: unknown): ProviderErrorCode {
  if (status === 401) {
    return "reconnect_required";
  }

  if (status !== 403) {
    return "temporary_failure";
  }

  const text = JSON.stringify(details ?? {}).toLowerCase();

  if (
    text.includes("insufficient") ||
    text.includes("invalid authentication") ||
    text.includes("invalid_grant") ||
    text.includes("token")
  ) {
    return "reconnect_required";
  }

  return "temporary_failure";
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return await response.text();
  }
}

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
