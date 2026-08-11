import crypto from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type MailProvider = "gmail" | "outlook";

export type MailboxConnectionRow = {
  id: string;
  workspace_id: string;
  profile_id: string;
  provider: MailProvider;
  status: "connected" | "disconnected" | "pending" | "error";
  include_sent_mail: boolean;
  last_synced_at: string | null;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_token_updated_at: string | null;
};

type SyncRequestBody = {
  workspaceId?: string;
  provider?: MailProvider;
  providerToken?: string;
  providerRefreshToken?: string;
};

type GmailMessageListResponse = {
  messages?: Array<{ id: string; threadId?: string }>;
};

type GmailMessageResponse = {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: {
    mimeType?: string;
    body?: { data?: string; size?: number };
    headers?: Array<{ name?: string; value?: string }>;
    parts?: GmailMessageResponse["payload"][];
  };
};

type OutlookMessageListResponse = {
  value?: OutlookMessageResponse[];
};

type OutlookMessageResponse = {
  id?: string;
  conversationId?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  subject?: string;
  bodyPreview?: string;
  body?: {
    contentType?: string;
    content?: string;
  };
  from?: {
    emailAddress?: {
      address?: string;
    };
  };
};

type OutlookMailboxProfileResponse = {
  mail?: string;
  userPrincipalName?: string;
};

const MAX_MESSAGES_PER_SYNC = 25;
const MAILBOX_RECONNECT_INTERVAL_DAYS = 90;

export async function GET(request: NextRequest) {
  return syncMailbox(request, "GET");
}

export async function POST(request: NextRequest) {
  return syncMailbox(request, "POST");
}

type SessionOAuthTokens = {
  providerToken: string | null;
  providerRefreshToken: string | null;
};

async function syncMailbox(request: NextRequest, method: "GET" | "POST") {
  const supabaseAdmin = getSupabaseAdminClient();

  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase service role client unavailable" }, { status: 500 });
  }

  const inboundSecret = process.env.INBOUND_EMAIL_WEBHOOK_SECRET?.trim();

  if (!inboundSecret) {
    return NextResponse.json({ error: "Inbound webhook secret is not configured" }, { status: 503 });
  }

  const authorization = request.headers.get("authorization")?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();
  const syncSecret = process.env.MAILBOX_SYNC_SECRET?.trim();
  const isCronAuthorized =
    Boolean(cronSecret) && Boolean(authorization) && authorization === `Bearer ${cronSecret}`;
  const isSyncSecretAuthorized =
    Boolean(syncSecret) && request.headers.get("x-mailbox-sync-secret")?.trim() === syncSecret;

  let requestedWorkspaceId: string | null = null;
  let requestedProvider: MailProvider | null = null;
  let sessionOAuthTokens: SessionOAuthTokens = {
    providerToken: null,
    providerRefreshToken: null,
  };

  if (method === "POST") {
    let body: SyncRequestBody | null = null;

    try {
      body = (await request.json()) as SyncRequestBody;
    } catch {
      body = null;
    }

    requestedWorkspaceId = body?.workspaceId?.trim() || null;
    requestedProvider = normalizeProvider(body?.provider);

    if (typeof body?.providerToken === "string" && body.providerToken.trim()) {
      sessionOAuthTokens.providerToken = body.providerToken.trim();
    }

    if (typeof body?.providerRefreshToken === "string" && body.providerRefreshToken.trim()) {
      sessionOAuthTokens.providerRefreshToken = body.providerRefreshToken.trim();
    }
  } else {
    requestedWorkspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim() || null;
    requestedProvider = normalizeProvider(request.nextUrl.searchParams.get("provider"));
  }

  let profileIdScope: string | null = null;

  if (!isCronAuthorized && !isSyncSecretAuthorized) {
    const supabase = await getSupabaseServerClient();

    if (!supabase) {
      return NextResponse.json({ error: "Supabase client unavailable" }, { status: 500 });
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    profileIdScope = user.id;

    const { data: sessionData } = await supabase.auth.getSession();
    sessionOAuthTokens = {
      providerToken: sessionOAuthTokens.providerToken ?? sessionData.session?.provider_token ?? null,
      providerRefreshToken: sessionOAuthTokens.providerRefreshToken ?? sessionData.session?.provider_refresh_token ?? null,
    };
  }

  const connections = await getConnectionsToSync({
    supabaseAdmin,
    profileIdScope,
    workspaceId: requestedWorkspaceId,
    provider: requestedProvider,
  });

  if (connections.error) {
    return NextResponse.json({ error: connections.error }, { status: 500 });
  }

  const rows = connections.rows;

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, processedMessages: 0, savedSummaries: 0, failedConnections: [] });
  }

  if (isCronAuthorized || isSyncSecretAuthorized) {
    await supabaseAdmin.rpc("reset_stale_mailbox_sync_jobs", {
      p_lease_minutes: 30,
    });

    const failedConnections: Array<{ connectionId: string; reason: string }> = [];
    let queuedJobs = 0;

    for (const row of rows) {
      try {
        const { error: enqueueError } = await supabaseAdmin.rpc("enqueue_mailbox_sync_job", {
          p_workspace_id: row.workspace_id,
          p_mailbox_connection_id: row.id,
          p_provider: row.provider,
          p_requested_by_profile_id: row.profile_id,
          p_trigger_source: "cron",
          p_payload: {
            source: "cron",
            profile_id_scope: profileIdScope,
            workspace_id: requestedWorkspaceId,
            provider: requestedProvider,
          },
        });

        if (enqueueError) {
          throw new Error(enqueueError.message);
        }

        queuedJobs += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown sync error";

        failedConnections.push({
          connectionId: row.id,
          reason,
        });

        await supabaseAdmin
          .from("mailbox_connections")
          .update({
            last_error: reason.slice(0, 500),
          })
          .eq("id", row.id);
      }
    }

    return NextResponse.json(
      {
        ok: true,
        queuedConnections: queuedJobs,
        queuedJobs,
        failedConnections,
      },
      { status: 202 },
    );
  }

  let processedMessages = 0;
  let savedSummaries = 0;
  let newBalance: number | null = null;
  const failedConnections: Array<{ connectionId: string; reason: string }> = [];

  for (const row of rows) {
    try {
      if (isMailboxReconnectRequired(row.oauth_token_updated_at)) {
        throw new Error(
          `Mailbox reconnection required every ${MAILBOX_RECONNECT_INTERVAL_DAYS} days. Please reconnect ${row.provider} mailbox and try again.`,
        );
      }

      if (
        profileIdScope &&
        row.profile_id === profileIdScope &&
        (!row.oauth_refresh_token || !row.oauth_access_token) &&
        (sessionOAuthTokens.providerToken || sessionOAuthTokens.providerRefreshToken)
      ) {
        await supabaseAdmin
          .from("mailbox_connections")
          .update({
            oauth_access_token: sessionOAuthTokens.providerToken,
            oauth_refresh_token: sessionOAuthTokens.providerRefreshToken,
            oauth_token_updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);

        row.oauth_access_token = row.oauth_access_token ?? sessionOAuthTokens.providerToken;
        row.oauth_refresh_token = row.oauth_refresh_token ?? sessionOAuthTokens.providerRefreshToken;
      }

      const accessToken =
        row.provider === "outlook" ? await resolveOutlookAccessToken(row) : await resolveGmailAccessToken(row);
      const resolvedAccessToken = accessToken || row.oauth_access_token || sessionOAuthTokens.providerToken || null;

      if (!resolvedAccessToken) {
        throw new Error(
          `No ${row.provider === "outlook" ? "Outlook" : "Gmail"} access token available. Reconnect mailbox, then click Sync now immediately from the same signed-in session.`,
        );
      }

      const syncResult =
        row.provider === "outlook"
          ? await syncOneOutlookMailbox({
              requestUrl: request.url,
              supabaseAdmin,
              connection: row,
              accessToken: resolvedAccessToken,
              inboundSecret,
            })
          : await syncOneGmailMailbox({
              requestUrl: request.url,
              supabaseAdmin,
              connection: row,
              accessToken: resolvedAccessToken,
              inboundSecret,
            });

      processedMessages += syncResult.processedMessages;
      savedSummaries += syncResult.savedSummaries;
      if (typeof syncResult.newBalance === "number") {
        newBalance = syncResult.newBalance;
      }

      await supabaseAdmin
        .from("mailbox_connections")
        .update({
          last_synced_at: new Date().toISOString(),
          last_error: null,
        })
        .eq("id", row.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown sync error";

      failedConnections.push({
        connectionId: row.id,
        reason,
      });

      await supabaseAdmin
        .from("mailbox_connections")
        .update({
          last_error: reason.slice(0, 500),
        })
        .eq("id", row.id);
    }
  }

  return NextResponse.json({
    ok: true,
    processedMessages,
    savedSummaries,
    newBalance,
    failedConnections,
  });
}

export async function syncOneGmailMailbox(params: {
  requestUrl: string;
  supabaseAdmin: SupabaseClient;
  connection: MailboxConnectionRow;
  accessToken: string;
  inboundSecret: string;
}) {
  const afterUnixSeconds = resolveAfterUnixSeconds(params.connection.last_synced_at);
  const listQuery = params.connection.include_sent_mail
    ? `after:${afterUnixSeconds}`
    : `in:inbox after:${afterUnixSeconds}`;

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("maxResults", String(MAX_MESSAGES_PER_SYNC));
  listUrl.searchParams.set("q", listQuery);

  const listResponse = await fetch(listUrl.toString(), {
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
    },
  });

  if (!listResponse.ok) {
    const details = await safeReadJson(listResponse);
    throw new Error(`Gmail list failed (${listResponse.status}): ${JSON.stringify(details)}`);
  }

  const listPayload = (await listResponse.json()) as GmailMessageListResponse;
  const messages = listPayload.messages ?? [];

  let processedMessages = 0;
  let savedSummaries = 0;
  let newBalance: number | null = null;

  for (const entry of messages) {
    if (!entry.id) {
      continue;
    }

    const message = await fetchGmailMessage(params.accessToken, entry.id);
    const senderEmail = normalizeSenderEmail(message.payload?.headers ?? []);

    if (!senderEmail) {
      continue;
    }

    const body = extractMessageBody(message);

    if (!body) {
      continue;
    }

    const subject = getHeaderValue(message.payload?.headers ?? [], "subject") || null;
    const occurredAt = resolveOccurredAt(message);

    const payload = {
      workspaceId: params.connection.workspace_id,
      mailboxConnectionId: params.connection.id,
      billedUserId: params.connection.profile_id,
      provider: "gmail",
      messageIdHash: sha256(entry.id),
      threadIdHash: entry.threadId ? sha256(entry.threadId) : undefined,
      senderEmail,
      subject: subject ?? undefined,
      body,
      receivedAt: occurredAt,
    };

    const inboundUrl = new URL("/api/inbound-email", params.requestUrl).toString();
    const inboundResponse = await fetch(inboundUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inbound-email-secret": params.inboundSecret,
      },
      body: JSON.stringify(payload),
    });

    const inboundJson = await safeReadJson(inboundResponse);

    if (!inboundResponse.ok) {
      throw new Error(`Inbound triage failed (${inboundResponse.status}): ${JSON.stringify(inboundJson)}`);
    }

    processedMessages += 1;

    if (typeof inboundJson === "object" && inboundJson && "action" in inboundJson) {
      const payload = inboundJson as Record<string, unknown>;
      const action = String(payload.action);
      if (action === "save_summary") {
        savedSummaries += 1;
      }

      if (typeof payload.newBalance === "number") {
        newBalance = payload.newBalance;
      }
    }
  }

  return {
    processedMessages,
    savedSummaries,
    newBalance,
  };
}

export async function syncOneOutlookMailbox(params: {
  requestUrl: string;
  supabaseAdmin: SupabaseClient;
  connection: MailboxConnectionRow;
  accessToken: string;
  inboundSecret: string;
}) {
  const receivedAfterMs = resolveOutlookReceivedAfterMs(params.connection.last_synced_at);
  const mailboxEmail = params.connection.include_sent_mail ? null : await fetchOutlookMailboxEmail(params.accessToken);
  const listUrl = new URL("https://graph.microsoft.com/v1.0/me/messages");

  listUrl.searchParams.set("$top", String(MAX_MESSAGES_PER_SYNC));
  listUrl.searchParams.set("$orderby", "receivedDateTime desc");
  listUrl.searchParams.set(
    "$select",
    "id,conversationId,receivedDateTime,sentDateTime,subject,bodyPreview,body,from",
  );

  const listResponse = await fetch(listUrl.toString(), {
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      Prefer: 'outlook.body-content-type="text"',
    },
  });

  if (!listResponse.ok) {
    const details = await safeReadJson(listResponse);
    throw new Error(`Outlook list failed (${listResponse.status}): ${JSON.stringify(details)}`);
  }

  const listPayload = (await listResponse.json()) as OutlookMessageListResponse;
  const messages = listPayload.value ?? [];

  let processedMessages = 0;
  let savedSummaries = 0;
  let newBalance: number | null = null;

  for (const message of messages) {
    const messageId = message.id?.trim();

    if (!messageId) {
      continue;
    }

    const occurredAt = resolveOutlookOccurredAt(message);
    const occurredAtMs = new Date(occurredAt).getTime();

    if (!Number.isNaN(occurredAtMs) && occurredAtMs < receivedAfterMs) {
      continue;
    }

    const senderEmail = normalizeOutlookSenderEmail(message);

    if (!senderEmail) {
      continue;
    }

    if (mailboxEmail && senderEmail === mailboxEmail) {
      continue;
    }

    const body = extractOutlookMessageBody(message);

    if (!body) {
      continue;
    }

    const payload = {
      workspaceId: params.connection.workspace_id,
      mailboxConnectionId: params.connection.id,
      billedUserId: params.connection.profile_id,
      provider: "outlook",
      messageIdHash: sha256(messageId),
      threadIdHash: message.conversationId?.trim() ? sha256(message.conversationId.trim()) : undefined,
      senderEmail,
      subject: message.subject?.trim() || undefined,
      body,
      receivedAt: occurredAt,
    };

    const inboundUrl = new URL("/api/inbound-email", params.requestUrl).toString();
    const inboundResponse = await fetch(inboundUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-inbound-email-secret": params.inboundSecret,
      },
      body: JSON.stringify(payload),
    });

    const inboundJson = await safeReadJson(inboundResponse);

    if (!inboundResponse.ok) {
      throw new Error(`Inbound triage failed (${inboundResponse.status}): ${JSON.stringify(inboundJson)}`);
    }

    processedMessages += 1;

    if (typeof inboundJson === "object" && inboundJson && "action" in inboundJson) {
      const resultPayload = inboundJson as Record<string, unknown>;
      const action = String(resultPayload.action);
      if (action === "save_summary") {
        savedSummaries += 1;
      }

      if (typeof resultPayload.newBalance === "number") {
        newBalance = resultPayload.newBalance;
      }
    }
  }

  return {
    processedMessages,
    savedSummaries,
    newBalance,
  };
}

export async function resolveGmailAccessToken(connection: MailboxConnectionRow) {
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

export async function resolveOutlookAccessToken(connection: MailboxConnectionRow) {
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
      scope: "offline_access openid profile email User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite",
    }),
  });

  if (!refreshResponse.ok) {
    return connection.oauth_access_token?.trim() || null;
  }

  const payload = (await refreshResponse.json()) as { access_token?: string };
  return payload.access_token?.trim() || connection.oauth_access_token?.trim() || null;
}

async function fetchOutlookMailboxEmail(accessToken: string) {
  const response = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as OutlookMailboxProfileResponse;
  const candidate = payload.mail?.trim().toLowerCase() || payload.userPrincipalName?.trim().toLowerCase() || "";

  return candidate.includes("@") ? candidate : null;
}

async function fetchGmailMessage(accessToken: string, messageId: string) {
  const messageUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`;
  const response = await fetch(messageUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const details = await safeReadJson(response);
    throw new Error(`Gmail message fetch failed (${response.status}): ${JSON.stringify(details)}`);
  }

  return (await response.json()) as GmailMessageResponse;
}

function extractMessageBody(message: GmailMessageResponse) {
  const plainText = extractPlainTextPart(message.payload);

  if (plainText) {
    return plainText;
  }

  const snippet = (message.snippet ?? "").trim();
  if (snippet) {
    return snippet;
  }

  return null;
}

function extractPlainTextPart(part: GmailMessageResponse["payload"] | undefined): string | null {
  if (!part) {
    return null;
  }

  if (part.mimeType?.toLowerCase() === "text/plain") {
    const decoded = decodeGmailBody(part.body?.data);
    if (decoded) {
      return decoded;
    }
  }

  if (part.mimeType?.toLowerCase() === "text/html") {
    const htmlDecoded = decodeGmailBody(part.body?.data);
    if (htmlDecoded) {
      const stripped = htmlDecoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (stripped) {
        return stripped;
      }
    }
  }

  for (const child of part.parts ?? []) {
    const nested = extractPlainTextPart(child);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function decodeGmailBody(data: string | undefined) {
  if (!data) {
    return null;
  }

  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = normalized.length % 4;
  const padded = padLength === 0 ? normalized : `${normalized}${"=".repeat(4 - padLength)}`;

  try {
    return Buffer.from(padded, "base64").toString("utf8").replace(/\s+/g, " ").trim();
  } catch {
    return null;
  }
}

function normalizeSenderEmail(headers: Array<{ name?: string; value?: string }>) {
  const from = getHeaderValue(headers, "from");

  if (!from) {
    return null;
  }

  const angleMatch = from.match(/<([^>]+)>/);
  const candidate = (angleMatch?.[1] ?? from).trim().toLowerCase();

  if (!candidate.includes("@")) {
    return null;
  }

  return candidate;
}

function normalizeOutlookSenderEmail(message: OutlookMessageResponse) {
  const candidate = message.from?.emailAddress?.address?.trim().toLowerCase() || "";

  if (!candidate.includes("@")) {
    return null;
  }

  return candidate;
}

function getHeaderValue(headers: Array<{ name?: string; value?: string }>, name: string) {
  const normalizedName = name.toLowerCase();

  for (const header of headers) {
    if (header.name?.trim().toLowerCase() === normalizedName) {
      return header.value?.trim() || "";
    }
  }

  return "";
}

function resolveOccurredAt(message: GmailMessageResponse) {
  if (message.internalDate) {
    const asNumber = Number(message.internalDate);

    if (!Number.isNaN(asNumber) && asNumber > 0) {
      return new Date(asNumber).toISOString();
    }
  }

  const dateHeader = getHeaderValue(message.payload?.headers ?? [], "date");

  if (dateHeader) {
    const parsed = new Date(dateHeader);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

function extractOutlookMessageBody(message: OutlookMessageResponse) {
  const content = message.body?.content?.trim();

  if (content) {
    return message.body?.contentType?.toLowerCase() === "html"
      ? content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
      : content;
  }

  const preview = message.bodyPreview?.trim();
  return preview || null;
}

function resolveOutlookOccurredAt(message: OutlookMessageResponse) {
  const candidate = message.receivedDateTime?.trim() || message.sentDateTime?.trim() || "";

  if (candidate) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return new Date().toISOString();
}

function resolveAfterUnixSeconds(lastSyncedAt: string | null) {
  if (!lastSyncedAt) {
    // Backfill a short recent window on first sync to avoid long, expensive pulls.
    return Math.floor(Date.now() / 1000) - 60 * 60 * 24;
  }

  const parsed = new Date(lastSyncedAt).getTime();

  if (Number.isNaN(parsed)) {
    return Math.floor(Date.now() / 1000) - 60 * 60 * 24;
  }

  // Rewind 5 minutes to avoid missing messages around clock edges.
  return Math.max(0, Math.floor(parsed / 1000) - 300);
}

function resolveOutlookReceivedAfter(lastSyncedAt: string | null) {
  if (!lastSyncedAt) {
    return new Date(Date.now() - 60 * 60 * 24 * 1000).toISOString();
  }

  const parsed = new Date(lastSyncedAt).getTime();

  if (Number.isNaN(parsed)) {
    return new Date(Date.now() - 60 * 60 * 24 * 1000).toISOString();
  }

  return new Date(Math.max(0, parsed - 300_000)).toISOString();
}

function resolveOutlookReceivedAfterMs(lastSyncedAt: string | null) {
  return new Date(resolveOutlookReceivedAfter(lastSyncedAt)).getTime();
}

export async function getConnectionsToSync(params: {
  supabaseAdmin: SupabaseClient;
  profileIdScope: string | null;
  workspaceId: string | null;
  provider: MailProvider | null;
}): Promise<{ rows: MailboxConnectionRow[]; error: string | null }> {
  let query = params.supabaseAdmin
    .from("mailbox_connections")
    .select(
      "id, workspace_id, profile_id, provider, status, include_sent_mail, last_synced_at, oauth_access_token, oauth_refresh_token, oauth_token_updated_at",
    )
    .eq("status", "connected");

  if (params.profileIdScope) {
    query = query.eq("profile_id", params.profileIdScope);
  }

  if (params.workspaceId) {
    query = query.eq("workspace_id", params.workspaceId);
  }

  if (params.provider) {
    query = query.eq("provider", params.provider);
  }

  const { data, error } = await query;

  if (error) {
    const message = error.message || "Unknown mailbox sync query failure";

    if (message.includes("oauth_access_token") && message.toLowerCase().includes("does not exist")) {
      return {
        rows: [],
        error:
          "Mailbox sync schema is outdated. Apply migration supabase/migrations/20260731_mailbox_sync_tokens.sql, then retry Sync now.",
      };
    }

    return {
      rows: [],
      error: message,
    };
  }

  return {
    rows: (data ?? []) as MailboxConnectionRow[],
    error: null,
  };
}

export function normalizeProvider(value: unknown): MailProvider | null {
  if (value === "gmail" || value === "outlook") {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "gmail" || normalized === "outlook") {
    return normalized;
  }

  return null;
}

export function getSupabaseAdminClient() {
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

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    const text = await response.text();
    return text;
  }
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function isMailboxReconnectRequired(oauthTokenUpdatedAt: string | null | undefined) {
  if (!oauthTokenUpdatedAt) {
    return true;
  }

  const updatedAt = new Date(oauthTokenUpdatedAt).getTime();

  if (Number.isNaN(updatedAt)) {
    return true;
  }

  const ageMs = Date.now() - updatedAt;
  const maxAgeMs = MAILBOX_RECONNECT_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

  return ageMs >= maxAgeMs;
}
