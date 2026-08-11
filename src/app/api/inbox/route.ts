import { Buffer } from "node:buffer";

import { NextRequest, NextResponse } from "next/server";

import { resolveGmailAccessToken, resolveOutlookAccessToken } from "@/app/api/mailbox/sync/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const INBOX_LOOKBACK_DAYS = 30;
const INBOX_LIST_PAGE_SIZE = 200;
const GMAIL_DETAIL_FETCH_CONCURRENCY = 12;

type MailProvider = "gmail" | "outlook";
type MailboxView = "inbox" | "archive" | "drafts" | "deleted";

type MailboxConnectionRow = {
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
  last_error?: string | null;
};

type ConnectionDiagnostic = {
  provider: MailProvider;
  status: MailboxConnectionRow["status"];
  lastSyncedAt: string | null;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  lastError: string | null;
  accountEmail: string | null;
  fetchedCount: number;
  fetchError: string | null;
};

type InboxAssignmentRow = {
  provider: string;
  message_id: string;
  assigned_to_profile_id: string | null;
};

type WorkspaceMemberRow = {
  profile_id: string;
  first_name: string | null;
  last_name: string | null;
  role: "agent" | "team_lead" | "owner" | "super_admin";
};

type InboxMessage = {
  key: string;
  provider: MailProvider;
  messageId: string;
  threadId: string | null;
  subject: string;
  from: string;
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  isArchived: boolean;
  assignedToProfileId: string | null;
};

type InboxThreadMessage = {
  provider: MailProvider;
  messageId: string;
  threadId: string | null;
  subject: string;
  from: string;
  to: string;
  cc: string;
  body: string;
  bodyHtml: string | null;
  receivedAt: string;
  isUnread: boolean;
};

type InboxContextSuccess = {
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>;
  user: { id: string };
  workspaceId: string;
  profileId: string;
  connections: MailboxConnectionRow[];
  connectionDiagnostics: ConnectionDiagnostic[];
};

type InboxContextError = {
  error: string;
  status: number;
};

type InboxActionRequest =
  | {
      action: "mark_read" | "mark_unread" | "archive";
      provider: MailProvider;
      messageId: string;
    }
  | {
      action: "assign";
      provider: MailProvider;
      messageId: string;
      threadId?: string | null;
      assignedToProfileId?: string | null;
    }
  | {
      action: "reply";
      provider: MailProvider;
      messageId: string;
      body: string;
      bodyHtml?: string;
    }
  | {
      action: "reply_all";
      provider: MailProvider;
      messageId: string;
      body: string;
      bodyHtml?: string;
    }
  | {
      action: "send_new";
      provider: MailProvider;
      to: string;
      cc?: string;
      subject: string;
      body: string;
      bodyHtml?: string;
    };

export async function GET(request: NextRequest) {
  const view = request.nextUrl.searchParams.get("view")?.trim() ?? "list";
  const mailbox = request.nextUrl.searchParams.get("mailbox")?.trim() ?? "inbox";

  if (view === "thread") {
    return getThreadView(request);
  }

  if (mailbox !== "inbox" && mailbox !== "archive" && mailbox !== "drafts" && mailbox !== "deleted") {
    return NextResponse.json({ error: "Invalid mailbox view" }, { status: 400 });
  }

  return getListView(mailbox as MailboxView);
}

export async function POST(request: NextRequest) {
  let payload: InboxActionRequest;

  try {
    payload = (await request.json()) as InboxActionRequest;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const context = await resolveInboxContext();

  if ("error" in context) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }

  const connection = context.connections.find((candidate) => candidate.provider === payload.provider);

  if (!connection) {
    return NextResponse.json({ error: `No connected ${payload.provider} mailbox found.` }, { status: 422 });
  }

  const accessToken = await resolveConnectionAccessToken(connection);

  if (!accessToken) {
    return NextResponse.json(
      { error: `${payload.provider} mailbox token unavailable. Reconnect mailbox from settings.` },
      { status: 422 },
    );
  }

  if (payload.action === "mark_read") {
    return runMessageStateAction(payload.provider, payload.messageId, accessToken, true);
  }

  if (payload.action === "mark_unread") {
    return runMessageStateAction(payload.provider, payload.messageId, accessToken, false);
  }

  if (payload.action === "archive") {
    return runArchiveAction(payload.provider, payload.messageId, accessToken);
  }

  if (payload.action === "assign") {
    const assignedToProfileId = payload.assignedToProfileId?.trim() || null;

    const upsertPayload = {
      workspace_id: context.workspaceId,
      mailbox_owner_profile_id: context.profileId,
      provider: payload.provider,
      message_id: payload.messageId,
      thread_id: payload.threadId ?? null,
      assigned_to_profile_id: assignedToProfileId,
      assigned_by_profile_id: context.profileId,
    };

    if (!assignedToProfileId) {
      const deleteResult = await context.supabase
        .from("inbox_message_assignments")
        .delete()
        .eq("workspace_id", context.workspaceId)
        .eq("mailbox_owner_profile_id", context.profileId)
        .eq("provider", payload.provider)
        .eq("message_id", payload.messageId);

      if (deleteResult.error && !isMissingRelationError(deleteResult.error.message, "inbox_message_assignments")) {
        return NextResponse.json({ error: deleteResult.error.message }, { status: 500 });
      }

      return NextResponse.json({ ok: true, assignedToProfileId: null });
    }

    const membersResult = await context.supabase.rpc("get_workspace_members");

    if (membersResult.error) {
      return NextResponse.json({ error: membersResult.error.message }, { status: 500 });
    }

    const members = (membersResult.data ?? []) as WorkspaceMemberRow[];
    const isMember = members.some((member) => member.profile_id === assignedToProfileId);

    if (!isMember) {
      return NextResponse.json({ error: "Assigned user is not a member of this workspace." }, { status: 422 });
    }

    const upsertResult = await context.supabase
      .from("inbox_message_assignments")
      .upsert(upsertPayload, { onConflict: "workspace_id,mailbox_owner_profile_id,provider,message_id" });

    if (upsertResult.error) {
      if (isMissingRelationError(upsertResult.error.message, "inbox_message_assignments")) {
        return NextResponse.json({ error: "Inbox assignment table is missing. Apply latest migrations." }, { status: 503 });
      }

      return NextResponse.json({ error: upsertResult.error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, assignedToProfileId });
  }

  if (payload.action === "reply" || payload.action === "reply_all") {
    const trimmedBody = payload.body.trim();
    const trimmedBodyHtml = typeof payload.bodyHtml === "string" && payload.bodyHtml.trim() ? payload.bodyHtml.trim() : null;

    if (trimmedBody.length < 2) {
      return NextResponse.json({ error: "Reply message must contain at least 2 characters." }, { status: 422 });
    }

    return runReplyAction(
      payload.provider,
      payload.messageId,
      trimmedBody,
      trimmedBodyHtml,
      accessToken,
      payload.action === "reply_all",
    );
  }

  if (payload.action === "send_new") {
    const toRecipients = extractEmailAddresses(payload.to);
    const ccRecipients = extractEmailAddresses(payload.cc ?? "");
    const subject = payload.subject.trim();
    const body = payload.body.trim();
    const bodyHtml = typeof payload.bodyHtml === "string" && payload.bodyHtml.trim() ? payload.bodyHtml.trim() : null;

    if (toRecipients.length === 0) {
      return NextResponse.json({ error: "At least one To recipient is required." }, { status: 422 });
    }

    if (subject.length < 1) {
      return NextResponse.json({ error: "Subject is required." }, { status: 422 });
    }

    if (body.length < 2) {
      return NextResponse.json({ error: "Message body must contain at least 2 characters." }, { status: 422 });
    }

    return runComposeAction(payload.provider, toRecipients, ccRecipients, subject, body, bodyHtml, accessToken);
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}

async function getListView(mailbox: MailboxView) {
  try {
    const context = await resolveInboxContext();

    if ("error" in context) {
      return NextResponse.json({ error: context.error }, { status: context.status });
    }

    const messagesByKey = new Map<string, InboxMessage>();
    const warnings: string[] = [];

    if (context.connections.length === 0) {
      warnings.push(
        "No connected mailbox found for this signed-in account in the current workspace. Open Settings > Mailbox and reconnect Outlook from this same account.",
      );
    }

    const providerResults = await Promise.all(
      context.connections.map(async (connection) => {
        try {
          const accessToken = await resolveConnectionAccessToken(connection);

          if (!accessToken) {
            return {
              provider: connection.provider,
              messages: [] as InboxMessage[],
              warning: `${connection.provider} mailbox token unavailable. Reconnect mailbox in settings.`,
            };
          }

          const providerMessages =
            connection.provider === "gmail"
              ? await listGmailMessages(accessToken, mailbox)
              : await listOutlookMessages(accessToken, mailbox);

          return {
            provider: connection.provider,
            messages: providerMessages,
            warning: null,
          };
        } catch (providerError) {
          return {
            provider: connection.provider,
            messages: [] as InboxMessage[],
            warning:
              providerError instanceof Error
                ? providerError.message
                : `Could not load ${connection.provider} messages.`,
          };
        }
      }),
    );

    for (const result of providerResults) {
      const diagnostic = context.connectionDiagnostics.find((entry) => entry.provider === result.provider);

      if (diagnostic) {
        diagnostic.fetchedCount = result.messages.length;
        diagnostic.fetchError = result.warning;
      }

      if (result.warning) {
        warnings.push(result.warning);
      }

      for (const message of result.messages) {
        messagesByKey.set(`${message.provider}:${message.messageId}`, message);
      }
    }

    const messages = Array.from(messagesByKey.values());

    messages.sort((left, right) => new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime());

    let assignments = new Map<string, string | null>();

    try {
      assignments = await loadAssignments(context, messages);
    } catch (assignmentError) {
      warnings.push(
        assignmentError instanceof Error
          ? `Inbox assignment lookup failed: ${assignmentError.message}`
          : "Inbox assignment lookup failed.",
      );
    }

    const members = await loadWorkspaceMembers(context.supabase);

    for (const message of messages) {
      message.assignedToProfileId = assignments.get(`${message.provider}:${message.messageId}`) ?? null;
    }

    return NextResponse.json({
      ok: true,
      messages,
      members,
      warnings,
      diagnostics: {
        workspaceId: context.workspaceId,
        profileId: context.profileId,
        authUserId: context.user.id,
        connectionDiagnostics: context.connectionDiagnostics,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Could not load inbox.";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

async function getThreadView(request: NextRequest) {
  const provider = request.nextUrl.searchParams.get("provider")?.trim();
  const messageId = request.nextUrl.searchParams.get("messageId")?.trim();
  const threadId = request.nextUrl.searchParams.get("threadId")?.trim() || null;

  if ((provider !== "gmail" && provider !== "outlook") || !messageId) {
    return NextResponse.json({ error: "Invalid thread query" }, { status: 400 });
  }

  const context = await resolveInboxContext();

  if ("error" in context) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }

  const connection = context.connections.find((candidate) => candidate.provider === provider);

  if (!connection) {
    return NextResponse.json({ error: `No connected ${provider} mailbox found.` }, { status: 422 });
  }

  const accessToken = await resolveConnectionAccessToken(connection);

  if (!accessToken) {
    return NextResponse.json(
      { error: `${provider} mailbox token unavailable. Reconnect mailbox from settings.` },
      { status: 422 },
    );
  }

  try {
    const threadMessages =
      provider === "gmail"
        ? await getGmailThread(accessToken, messageId, threadId)
        : await getOutlookThread(accessToken, messageId, threadId);

    threadMessages.sort((left, right) => new Date(left.receivedAt).getTime() - new Date(right.receivedAt).getTime());

    return NextResponse.json({ ok: true, thread: threadMessages });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Could not load thread.";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

async function resolveInboxContext(): Promise<InboxContextSuccess | InboxContextError> {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return { error: "Supabase is unavailable", status: 500 };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "Unauthorized", status: 401 };
  }

  const profileResult = await supabase.rpc("get_current_profile");

  if (profileResult.error) {
    return { error: profileResult.error.message, status: 500 };
  }

  const profile = profileResult.data as { id?: string | null; workspace_id?: string | null } | null;
  const workspaceId = profile?.workspace_id?.trim() || null;
  const profileId = profile?.id?.trim() || user.id;

  if (!workspaceId) {
    return { error: "No active workspace found.", status: 422 };
  }

  const connectionsResult = await supabase
    .from("mailbox_connections")
    .select(
      "id, workspace_id, profile_id, provider, status, include_sent_mail, last_synced_at, oauth_access_token, oauth_refresh_token, oauth_token_updated_at, last_error",
    )
    .eq("workspace_id", workspaceId)
    .eq("profile_id", profileId)
    .in("provider", ["gmail", "outlook"]);

  if (connectionsResult.error) {
    return { error: connectionsResult.error.message, status: 500 };
  }

  const allConnections = (connectionsResult.data ?? []) as MailboxConnectionRow[];
  const connectedConnections = allConnections
    .filter((connection) => connection.status === "connected")
    .sort((left, right) => {
      const leftTs = Date.parse(left.last_synced_at ?? left.oauth_token_updated_at ?? "");
      const rightTs = Date.parse(right.last_synced_at ?? right.oauth_token_updated_at ?? "");
      const safeLeft = Number.isNaN(leftTs) ? 0 : leftTs;
      const safeRight = Number.isNaN(rightTs) ? 0 : rightTs;
      return safeRight - safeLeft;
    });
  // Single-provider mode: each user mailbox is either Gmail or Outlook.
  const connections = connectedConnections.length > 0 ? [connectedConnections[0]] : [];
  const connectionDiagnostics: ConnectionDiagnostic[] = allConnections.map((connection) => ({
    provider: connection.provider,
    status: connection.status,
    lastSyncedAt: connection.last_synced_at,
    hasAccessToken: Boolean(connection.oauth_access_token),
    hasRefreshToken: Boolean(connection.oauth_refresh_token),
    lastError: connection.last_error ?? null,
    accountEmail: null,
    fetchedCount: 0,
    fetchError: null,
  }));

  for (const diagnostic of connectionDiagnostics) {
    if (diagnostic.status !== "connected") {
      continue;
    }

    const connection = connections.find((candidate) => candidate.provider === diagnostic.provider);

    if (!connection) {
      continue;
    }

    const accessToken = await resolveConnectionAccessToken(connection);

    if (!accessToken) {
      continue;
    }

    diagnostic.accountEmail = await resolveMailboxAccountEmail(diagnostic.provider, accessToken);
  }

  return {
    supabase,
    user: { id: user.id },
    workspaceId,
    profileId,
    connections,
    connectionDiagnostics,
  };
}

async function resolveConnectionAccessToken(connection: MailboxConnectionRow) {
  if (connection.provider === "gmail") {
    return (await resolveGmailAccessToken(connection)) || connection.oauth_access_token || null;
  }

  return (await resolveOutlookAccessToken(connection)) || connection.oauth_access_token || null;
}

async function listGmailMessages(accessToken: string, mailbox: MailboxView): Promise<InboxMessage[]> {
  if (mailbox === "drafts") {
    return listGmailDraftMessages(accessToken);
  }

  const rawItems: Array<{ messageId: string; threadId: string | null }> = [];
  let pageToken: string | undefined;

  while (true) {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(INBOX_LIST_PAGE_SIZE));
    listUrl.searchParams.set("q", buildGmailMailboxQuery(mailbox));

    if (pageToken) {
      listUrl.searchParams.set("pageToken", pageToken);
    }

    const listResponse = await fetch(listUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    });

    if (!listResponse.ok) {
      throw new Error(await parseProviderError("gmail", listResponse));
    }

    const listPayload = (await listResponse.json()) as {
      messages?: Array<{ id?: string; threadId?: string }>;
      nextPageToken?: string;
    };

    const pageItems = (listPayload.messages ?? []).map((item) => ({
      messageId: item.id?.trim() ?? "",
      threadId: item.threadId?.trim() || null,
    }));

    rawItems.push(...pageItems);

    if (!listPayload.nextPageToken || pageItems.length === 0) {
      break;
    }

    pageToken = listPayload.nextPageToken;
  }

  const hydrated = await mapWithConcurrency(rawItems, GMAIL_DETAIL_FETCH_CONCURRENCY, async (item) => {
    if (!item.messageId) {
      return null;
    }

    const messageUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.messageId)}`);
    messageUrl.searchParams.set("format", "metadata");
    messageUrl.searchParams.append("metadataHeaders", "From");
    messageUrl.searchParams.append("metadataHeaders", "Subject");
    messageUrl.searchParams.append("metadataHeaders", "Date");

    const messageResponse = await fetch(messageUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    });

    if (!messageResponse.ok) {
      return null;
    }

    const payload = (await messageResponse.json()) as {
      id?: string;
      threadId?: string;
      snippet?: string;
      labelIds?: string[];
      internalDate?: string;
      payload?: {
        headers?: Array<{ name?: string; value?: string }>;
      };
    };

    const headers = payload.payload?.headers ?? [];
    const from = findHeader(headers, "from") || "Unknown sender";
    const subject = findHeader(headers, "subject") || "(No subject)";
    const dateHeader = findHeader(headers, "date");
    const parsedDate = dateHeader ? new Date(dateHeader) : null;
    const timestamp =
      parsedDate && !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toISOString()
        : payload.internalDate && !Number.isNaN(Number(payload.internalDate))
          ? new Date(Number(payload.internalDate)).toISOString()
          : new Date().toISOString();
    const labelSet = new Set(payload.labelIds ?? []);

    const message: InboxMessage = {
      key: `gmail:${payload.id ?? item.messageId}`,
      provider: "gmail",
      messageId: payload.id ?? item.messageId,
      threadId: payload.threadId ?? item.threadId ?? null,
      subject,
      from,
      snippet: (payload.snippet ?? "").trim(),
      receivedAt: timestamp,
      isUnread: labelSet.has("UNREAD"),
      isArchived: !labelSet.has("INBOX"),
      assignedToProfileId: null,
    };

    return message;
  });

  return hydrated.filter(isNonNull);
}

async function listOutlookMessages(accessToken: string, mailbox: MailboxView): Promise<InboxMessage[]> {
  const cutoffTime = Date.now() - INBOX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const selectFields = "id,conversationId,subject,from,bodyPreview,receivedDateTime,isRead";
  const pageSize = Math.min(200, INBOX_LIST_PAGE_SIZE);
  const messages: InboxMessage[] = [];

  async function collectFromUrl(initialUrl: string, enforceLookback = true) {
    let nextUrl: string | null = initialUrl;

    while (nextUrl) {
      const response = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: `outlook.body-content-type="text", odata.maxpagesize=${pageSize}`,
        },
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(await parseProviderError("outlook", response));
      }

      const payload = (await response.json()) as {
        value?: Array<{
          id?: string;
          conversationId?: string;
          subject?: string;
          bodyPreview?: string;
          receivedDateTime?: string;
          isRead?: boolean;
          parentFolderId?: string;
          from?: {
            emailAddress?: {
              address?: string;
              name?: string;
            };
          };
        }>;
        "@odata.nextLink"?: string;
      };

      let reachedCutoff = false;

      for (const message of payload.value ?? []) {
        const id = message.id?.trim();

        if (!id) {
          continue;
        }

        const receivedAt = message.receivedDateTime?.trim() || new Date().toISOString();
        const receivedAtMs = Date.parse(receivedAt);

        if (enforceLookback && !Number.isNaN(receivedAtMs) && receivedAtMs < cutoffTime) {
          reachedCutoff = true;
          break;
        }

        messages.push({
          key: `outlook:${id}`,
          provider: "outlook",
          messageId: id,
          threadId: message.conversationId?.trim() || null,
          subject: message.subject?.trim() || "(No subject)",
          from:
            message.from?.emailAddress?.name?.trim() ||
            message.from?.emailAddress?.address?.trim() ||
            "Unknown sender",
          snippet: message.bodyPreview?.trim() || "",
          receivedAt,
          isUnread: !Boolean(message.isRead),
          isArchived: false,
          assignedToProfileId: null,
        });
      }

      if (reachedCutoff) {
        break;
      }

      nextUrl = payload["@odata.nextLink"] ?? null;
    }
  }

  const listUrl = new URL(`https://graph.microsoft.com/v1.0/me/mailFolders/${getOutlookFolderName(mailbox)}/messages`);
  listUrl.searchParams.set("$top", String(pageSize));
  listUrl.searchParams.set("$orderby", "receivedDateTime desc");
  listUrl.searchParams.set("$select", selectFields);

  await collectFromUrl(listUrl.toString(), true);

  if (mailbox === "inbox" && messages.length === 0) {
    const fallbackUrl = new URL("https://graph.microsoft.com/v1.0/me/messages");
    fallbackUrl.searchParams.set("$top", String(pageSize));
    fallbackUrl.searchParams.set("$orderby", "receivedDateTime desc");
    fallbackUrl.searchParams.set("$select", selectFields);
    // If the mailbox has no recent items, still surface latest messages for visibility.
    await collectFromUrl(fallbackUrl.toString(), false);
  }

  return messages;
}

async function listGmailDraftMessages(accessToken: string): Promise<InboxMessage[]> {
  const draftIds: string[] = [];
  let pageToken: string | undefined;

  while (true) {
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    listUrl.searchParams.set("maxResults", String(INBOX_LIST_PAGE_SIZE));

    if (pageToken) {
      listUrl.searchParams.set("pageToken", pageToken);
    }

    const listResponse = await fetch(listUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    });

    if (!listResponse.ok) {
      throw new Error(await parseProviderError("gmail", listResponse));
    }

    const listPayload = (await listResponse.json()) as {
      drafts?: Array<{ id?: string; message?: { id?: string; threadId?: string } }>;
      nextPageToken?: string;
    };

    const pageIds = (listPayload.drafts ?? []).map((item) => item.id?.trim() ?? "");
    draftIds.push(...pageIds);

    if (!listPayload.nextPageToken || pageIds.length === 0) {
      break;
    }

    pageToken = listPayload.nextPageToken;
  }

  const hydrated = await mapWithConcurrency(draftIds, GMAIL_DETAIL_FETCH_CONCURRENCY, async (draftId) => {
    if (!draftId) {
      return null;
    }

    const draftUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`);
    draftUrl.searchParams.set("format", "full");

    const draftResponse = await fetch(draftUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    });

    if (!draftResponse.ok) {
      return null;
    }

    const payload = (await draftResponse.json()) as {
      id?: string;
      message?: {
        id?: string;
        threadId?: string;
        snippet?: string;
        internalDate?: string;
        payload?: {
          headers?: Array<{ name?: string; value?: string }>;
        };
      };
    };

    const draftMessage = payload.message;
    const messageId = draftMessage?.id?.trim();

    if (!draftMessage || !messageId) {
      return null;
    }

    const headers = draftMessage.payload?.headers ?? [];
    const from = findHeader(headers, "from") || "Draft";
    const subject = findHeader(headers, "subject") || "(No subject)";
    const dateHeader = findHeader(headers, "date");
    const parsedDate = dateHeader ? new Date(dateHeader) : null;
    const timestamp =
      parsedDate && !Number.isNaN(parsedDate.getTime())
        ? parsedDate.toISOString()
        : draftMessage.internalDate && !Number.isNaN(Number(draftMessage.internalDate))
          ? new Date(Number(draftMessage.internalDate)).toISOString()
          : new Date().toISOString();

    return {
      key: `gmail:${messageId}`,
      provider: "gmail" as const,
      messageId,
      threadId: draftMessage.threadId?.trim() || null,
      subject,
      from,
      snippet: (draftMessage.snippet ?? "").trim(),
      receivedAt: timestamp,
      isUnread: false,
      isArchived: false,
      assignedToProfileId: null,
    };
  });

  return hydrated.filter(isNonNull);
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function buildGmailMailboxQuery(mailbox: MailboxView) {
  if (mailbox === "archive") {
    return `-in:inbox -in:trash -in:spam newer_than:${INBOX_LOOKBACK_DAYS}d`;
  }

  if (mailbox === "deleted") {
    return `in:trash newer_than:${INBOX_LOOKBACK_DAYS}d`;
  }

  return `in:inbox newer_than:${INBOX_LOOKBACK_DAYS}d`;
}

function getOutlookFolderName(mailbox: MailboxView) {
  if (mailbox === "archive") {
    return "archive";
  }

  if (mailbox === "drafts") {
    return "drafts";
  }

  if (mailbox === "deleted") {
    return "deleteditems";
  }

  return "inbox";
}

async function mapWithConcurrency<TInput, TOutput>(
  values: TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
) {
  const results: TOutput[] = new Array(values.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= values.length) {
        return;
      }

      results[index] = await mapper(values[index], index);
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, values.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function loadAssignments(
  context: InboxContextSuccess,
  messages: InboxMessage[],
) {
  const assignmentMap = new Map<string, string | null>();

  if (messages.length === 0) {
    return assignmentMap;
  }

  const messageIds = messages.map((message) => message.messageId);
  const result = await context.supabase
    .from("inbox_message_assignments")
    .select("provider, message_id, assigned_to_profile_id")
    .eq("workspace_id", context.workspaceId)
    .eq("mailbox_owner_profile_id", context.profileId)
    .in("message_id", messageIds);

  if (result.error) {
    if (isMissingRelationError(result.error.message, "inbox_message_assignments")) {
      return assignmentMap;
    }

    if (isPermissionDeniedError(result.error.message, "inbox_message_assignments")) {
      return assignmentMap;
    }

    throw new Error(result.error.message);
  }

  for (const row of (result.data ?? []) as InboxAssignmentRow[]) {
    assignmentMap.set(`${row.provider}:${row.message_id}`, row.assigned_to_profile_id ?? null);
  }

  return assignmentMap;
}

async function loadWorkspaceMembers(supabase: InboxContextSuccess["supabase"]) {
  const result = await supabase.rpc("get_workspace_members");

  if (result.error) {
    return [];
  }

  return ((result.data ?? []) as WorkspaceMemberRow[]).map((member) => ({
    profileId: member.profile_id,
    fullName: [member.first_name ?? "", member.last_name ?? ""].join(" ").trim() || "Unnamed member",
    role: member.role,
  }));
}

async function getGmailThread(accessToken: string, messageId: string, threadId: string | null): Promise<InboxThreadMessage[]> {
  if (!threadId) {
    const message = await fetchGmailMessage(accessToken, messageId);
    return [parseGmailThreadMessage(message)];
  }

  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await parseProviderError("gmail", response));
  }

  const payload = (await response.json()) as {
    messages?: Array<GmailFullMessage>;
  };

  return (payload.messages ?? []).map(parseGmailThreadMessage);
}

async function getOutlookThread(accessToken: string, messageId: string, threadId: string | null): Promise<InboxThreadMessage[]> {
  if (!threadId) {
    const response = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=id,conversationId,subject,body,from,toRecipients,ccRecipients,receivedDateTime,isRead`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'outlook.body-content-type="html"',
        },
        cache: "no-store",
      },
    );

    if (!response.ok) {
      throw new Error(await parseProviderError("outlook", response));
    }

    const message = (await response.json()) as OutlookFullMessage;
    return [parseOutlookThreadMessage(message)];
  }

  // $orderby cannot be combined with $filter for conversationId — causes InefficientFilter (400). Sort client-side.
  const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
  url.searchParams.set("$top", "50");
  url.searchParams.set("$filter", `conversationId eq '${threadId.replace(/'/g, "''")}'`);
  url.searchParams.set(
    "$select",
    "id,conversationId,subject,body,from,toRecipients,ccRecipients,receivedDateTime,isRead",
  );

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="html"',
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await parseProviderError("outlook", response));
  }

  const payload = (await response.json()) as {
    value?: OutlookFullMessage[];
  };

  return (payload.value ?? []).map(parseOutlookThreadMessage);
}

async function runMessageStateAction(provider: MailProvider, messageId: string, accessToken: string, read: boolean) {
  if (provider === "gmail") {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(
          read
            ? {
                removeLabelIds: ["UNREAD"],
              }
            : {
                addLabelIds: ["UNREAD"],
              },
        ),
      },
    );

    if (!response.ok) {
      return NextResponse.json({ error: await parseProviderError("gmail", response) }, { status: response.status });
    }

    return NextResponse.json({ ok: true });
  }

  const response = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      isRead: read,
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: await parseProviderError("outlook", response) }, { status: response.status });
  }

  return NextResponse.json({ ok: true });
}

async function runArchiveAction(provider: MailProvider, messageId: string, accessToken: string) {
  if (provider === "gmail") {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          removeLabelIds: ["INBOX"],
        }),
      },
    );

    if (!response.ok) {
      return NextResponse.json({ error: await parseProviderError("gmail", response) }, { status: response.status });
    }

    return NextResponse.json({ ok: true });
  }

  const archiveFolderResponse = await fetch("https://graph.microsoft.com/v1.0/me/mailFolders/archive?$select=id", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!archiveFolderResponse.ok) {
    return NextResponse.json(
      { error: await parseProviderError("outlook", archiveFolderResponse) },
      { status: archiveFolderResponse.status },
    );
  }

  const folderPayload = (await archiveFolderResponse.json()) as { id?: string };
  const archiveFolderId = folderPayload.id?.trim();

  if (!archiveFolderId) {
    return NextResponse.json({ error: "Outlook archive folder not found." }, { status: 422 });
  }

  const response = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/move`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      destinationId: archiveFolderId,
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: await parseProviderError("outlook", response) }, { status: response.status });
  }

  return NextResponse.json({ ok: true });
}

async function runReplyAction(
  provider: MailProvider,
  messageId: string,
  body: string,
  bodyHtml: string | null,
  accessToken: string,
  replyAll: boolean,
) {
  if (provider === "outlook") {
    const outlookAction = replyAll ? "replyAll" : "reply";
    const response = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/${outlookAction}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        comment: body,
      }),
    });

    if (!response.ok) {
      return NextResponse.json({ error: await parseProviderError("outlook", response) }, { status: response.status });
    }

    return NextResponse.json({ ok: true });
  }

  const originalMessage = await fetchGmailMessage(accessToken, messageId);
  const headers = originalMessage.payload?.headers ?? [];
  const subject = findHeader(headers, "subject") || "(No subject)";
  const from = findHeader(headers, "from") || "";
  const replyTo = findHeader(headers, "reply-to") || "";
  const toHeader = findHeader(headers, "to") || "";
  const ccHeader = findHeader(headers, "cc") || "";
  const messageHeaderId = findHeader(headers, "message-id") || "";
  const primaryReplyTarget = extractEmailAddress(replyTo || from);

  if (!primaryReplyTarget) {
    return NextResponse.json({ error: "Could not resolve recipient for Gmail reply." }, { status: 422 });
  }

  let toRecipients = [primaryReplyTarget];
  let ccRecipients: string[] = [];

  if (replyAll) {
    const mailboxAccount = (await resolveMailboxAccountEmail("gmail", accessToken))?.toLowerCase() ?? null;
    const allRecipients = dedupeEmailList([
      ...extractEmailAddresses(replyTo || from),
      ...extractEmailAddresses(toHeader),
      ...extractEmailAddresses(ccHeader),
    ]).filter((address) => address.toLowerCase() !== mailboxAccount);

    if (allRecipients.length === 0) {
      allRecipients.push(primaryReplyTarget);
    }

    toRecipients = [allRecipients[0]];
    ccRecipients = allRecipients.slice(1);
  }

  const normalizedSubject = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`;
  const rawMessage = [
    `To: ${toRecipients.join(", ")}`,
    ...(ccRecipients.length > 0 ? [`Cc: ${ccRecipients.join(", ")}`] : []),
    `Subject: ${normalizedSubject}`,
    "MIME-Version: 1.0",
    bodyHtml
      ? 'Content-Type: text/html; charset="UTF-8"'
      : 'Content-Type: text/plain; charset="UTF-8"',
    ...(messageHeaderId ? [`In-Reply-To: ${messageHeaderId}`, `References: ${messageHeaderId}`] : []),
    "",
    bodyHtml ?? body,
  ].join("\r\n");

  const encodedRaw = Buffer.from(rawMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const sendResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      raw: encodedRaw,
      threadId: originalMessage.threadId,
    }),
  });

  if (!sendResponse.ok) {
    return NextResponse.json({ error: await parseProviderError("gmail", sendResponse) }, { status: sendResponse.status });
  }

  return NextResponse.json({ ok: true });
}

async function runComposeAction(
  provider: MailProvider,
  toRecipients: string[],
  ccRecipients: string[],
  subject: string,
  body: string,
  bodyHtml: string | null,
  accessToken: string,
) {
  if (provider === "outlook") {
    const response = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject,
          body: {
            contentType: bodyHtml ? "HTML" : "Text",
            content: bodyHtml ?? body,
          },
          toRecipients: toRecipients.map((address) => ({
            emailAddress: {
              address,
            },
          })),
          ccRecipients: ccRecipients.map((address) => ({
            emailAddress: {
              address,
            },
          })),
        },
      }),
    });

    if (!response.ok) {
      return NextResponse.json({ error: await parseProviderError("outlook", response) }, { status: response.status });
    }

    return NextResponse.json({ ok: true });
  }

  const rawMessage = [
    `To: ${toRecipients.join(", ")}`,
    ...(ccRecipients.length > 0 ? [`Cc: ${ccRecipients.join(", ")}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    bodyHtml
      ? 'Content-Type: text/html; charset="UTF-8"'
      : 'Content-Type: text/plain; charset="UTF-8"',
    "",
    bodyHtml ?? body,
  ].join("\r\n");

  const encodedRaw = Buffer.from(rawMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      raw: encodedRaw,
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: await parseProviderError("gmail", response) }, { status: response.status });
  }

  return NextResponse.json({ ok: true });
}

type GmailHeader = { name?: string; value?: string };

type GmailPayloadPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
};

type GmailFullMessage = {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: {
    headers?: GmailHeader[];
    body?: { data?: string };
    parts?: GmailPayloadPart[];
  };
};

type OutlookFullMessage = {
  id?: string;
  conversationId?: string;
  subject?: string;
  body?: { content?: string };
  from?: {
    emailAddress?: {
      name?: string;
      address?: string;
    };
  };
  toRecipients?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
  }>;
  ccRecipients?: Array<{
    emailAddress?: {
      name?: string;
      address?: string;
    };
  }>;
  receivedDateTime?: string;
  isRead?: boolean;
};

function parseGmailThreadMessage(message: GmailFullMessage): InboxThreadMessage {
  const headers = message.payload?.headers ?? [];
  const extractedBody = extractGmailBodyText(message.payload);
  const htmlBody = extractGmailHtmlBody(message.payload);
  const body = selectReadableBody(extractedBody, message.snippet || "");
  const dateHeader = findHeader(headers, "date");
  const dateValue = dateHeader ? new Date(dateHeader) : null;
  const labelSet = new Set(message.labelIds ?? []);

  return {
    provider: "gmail",
    messageId: message.id,
    threadId: message.threadId ?? null,
    subject: findHeader(headers, "subject") || "(No subject)",
    from: findHeader(headers, "from") || "Unknown sender",
    to: findHeader(headers, "to") || "",
    cc: findHeader(headers, "cc") || "",
    body,
    bodyHtml: htmlBody || null,
    receivedAt:
      dateValue && !Number.isNaN(dateValue.getTime())
        ? dateValue.toISOString()
        : message.internalDate && !Number.isNaN(Number(message.internalDate))
          ? new Date(Number(message.internalDate)).toISOString()
          : new Date().toISOString(),
    isUnread: labelSet.has("UNREAD"),
  };
}

function parseOutlookThreadMessage(message: OutlookFullMessage): InboxThreadMessage {
  const htmlBody = message.body?.content?.trim() || "";
  const toLine = (message.toRecipients ?? [])
    .map((recipient) => recipient.emailAddress?.name?.trim() || recipient.emailAddress?.address?.trim() || "")
    .filter(Boolean)
    .join(", ");
  const ccLine = (message.ccRecipients ?? [])
    .map((recipient) => recipient.emailAddress?.name?.trim() || recipient.emailAddress?.address?.trim() || "")
    .filter(Boolean)
    .join(", ");

  return {
    provider: "outlook",
    messageId: message.id?.trim() || "",
    threadId: message.conversationId?.trim() || null,
    subject: message.subject?.trim() || "(No subject)",
    from:
      message.from?.emailAddress?.name?.trim() || message.from?.emailAddress?.address?.trim() || "Unknown sender",
    to: toLine,
    cc: ccLine,
    body: htmlToPlainText(htmlBody),
    bodyHtml: htmlBody || null,
    receivedAt: message.receivedDateTime?.trim() || new Date().toISOString(),
    isUnread: !Boolean(message.isRead),
  };
}

async function fetchGmailMessage(accessToken: string, messageId: string): Promise<GmailFullMessage> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(await parseProviderError("gmail", response));
  }

  return (await response.json()) as GmailFullMessage;
}

function findHeader(headers: GmailHeader[], name: string) {
  const normalized = name.toLowerCase();

  for (const header of headers) {
    if (header.name?.trim().toLowerCase() === normalized) {
      return decodeMimeHeader(header.value?.trim() || "");
    }
  }

  return "";
}

function extractGmailBodyText(payload: GmailFullMessage["payload"] | undefined): string {
  if (!payload) {
    return "";
  }

  const plainBody = findPreferredGmailBody(payload, "text/plain");

  if (plainBody) {
    return normalizeEmailBody(plainBody, false);
  }

  const htmlBody = findPreferredGmailBody(payload, "text/html");

  if (htmlBody) {
    return normalizeEmailBody(htmlBody, true);
  }

  const partBody = readBodyFromPart(payload);

  if (partBody) {
    return partBody;
  }

  for (const part of payload.parts ?? []) {
    const value = readBodyFromPart(part);
    if (value) {
      return value;
    }

    const nested = extractNestedBody(part);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function extractGmailHtmlBody(payload: GmailFullMessage["payload"] | undefined): string {
  if (!payload) {
    return "";
  }

  const htmlBody = findPreferredGmailBody(payload, "text/html");

  if (htmlBody) {
    return htmlBody;
  }

  for (const part of payload.parts ?? []) {
    const value = extractNestedHtmlBody(part);
    if (value) {
      return value;
    }
  }

  return "";
}

function findPreferredGmailBody(part: GmailPayloadPart, mimeType: "text/plain" | "text/html"): string {
  const normalizedMime = part.mimeType?.toLowerCase() ?? "";

  if (normalizedMime === mimeType) {
    return decodeGmailData(part.body?.data);
  }

  for (const child of part.parts ?? []) {
    const result = findPreferredGmailBody(child, mimeType);

    if (result) {
      return result;
    }
  }

  return "";
}

function extractNestedBody(part: GmailPayloadPart): string {
  for (const child of part.parts ?? []) {
    const value = readBodyFromPart(child);
    if (value) {
      return value;
    }

    const nested = extractNestedBody(child);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function extractNestedHtmlBody(part: GmailPayloadPart): string {
  for (const child of part.parts ?? []) {
    if (child.mimeType?.toLowerCase() === "text/html") {
      const value = decodeGmailData(child.body?.data);
      if (value) {
        return value;
      }
    }

    const nested = extractNestedHtmlBody(child);
    if (nested) {
      return nested;
    }
  }

  return "";
}

function readBodyFromPart(part: { mimeType?: string; body?: { data?: string } }) {
  const raw = decodeGmailData(part.body?.data);

  if (!raw) {
    return "";
  }

  if (part.mimeType?.toLowerCase() === "text/html") {
    return normalizeEmailBody(raw, true);
  }

  return normalizeEmailBody(raw, false);
}

function decodeGmailData(data: string | undefined) {
  if (!data) {
    return "";
  }

  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;

  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function decodeMimeHeader(value: string) {
  const encodedWordPattern = /=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g;

  return value.replace(encodedWordPattern, (_match, _charset, encoding, payload) => {
    try {
      if (String(encoding).toUpperCase() === "B") {
        return Buffer.from(String(payload), "base64").toString("utf8");
      }

      return String(payload)
        .replace(/_/g, " ")
        .replace(/=([0-9A-Fa-f]{2})/g, (_hex, code) => String.fromCharCode(Number.parseInt(code, 16)));
    } catch {
      return value;
    }
  });
}

function normalizeEmailBody(raw: string, isHtml: boolean) {
  const source = isHtml
    ? raw
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<head[\s\S]*?<\/head>/gi, " ")
        .replace(/<!\[if[\s\S]*?<!\[endif\]>/gi, " ")
        .replace(/<!--([\s\S]*?)-->/g, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|table|section|article|h[1-6])>/gi, "\n")
        .replace(/<li[^>]*>/gi, "\n- ")
        .replace(/<\/(li|td)>/gi, " ")
        .replace(/<(td|th)[^>]*>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    : raw;

  const withoutNoise = source
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@font-face\{[\s\S]*?\}/gi, " ")
    .replace(/@media[\s\S]*?\{[\s\S]*?\}/gi, "\n")
    .replace(/[A-Za-z0-9_-]+\{[^{}]{20,}\}/g, " ");

  const decodedEntities = decodeHtmlEntities(withoutNoise);

  const normalized = decodedEntities
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .trim();

  if (!isHtml) {
    return normalized.replace(/\s+/g, " ").trim();
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isNoiseLine(line));

  const compactedLines = lines.filter((line, index) => {
    if (index === 0) {
      return true;
    }

    return line !== lines[index - 1];
  });

  const trimmedLines = trimFooterLines(compactedLines);
  return trimmedLines.join("\n\n").trim();
}

function htmlToPlainText(value: string) {
  if (!value) {
    return "";
  }

  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function isNoiseLine(line: string) {
  const normalized = line.toLowerCase();

  return (
    normalized.includes("not(#outlook)") ||
    normalized.includes("@media") ||
    normalized.includes("font-face") ||
    normalized.includes("!important") ||
    normalized.includes("table{zoom") ||
    normalized.includes("converted-body") ||
    normalized.includes("mso-hide")
  );
}

function trimFooterLines(lines: string[]) {
  if (lines.length < 6) {
    return lines;
  }

  const footerMarkers = [
    "unsubscribe",
    "se desinscrire",
    "se désinscrire",
    "manage preferences",
    "instagram",
    "youtube",
    "linkedin",
    "tiktok",
    "reddit",
    "support",
  ];

  for (let index = Math.floor(lines.length * 0.5); index < lines.length; index += 1) {
    const line = lines[index]?.toLowerCase() ?? "";

    if (footerMarkers.some((marker) => line.includes(marker))) {
      return lines.slice(0, index);
    }
  }

  return lines;
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    eacute: "e",
    egrave: "e",
    ecirc: "e",
    agrave: "a",
    ugrave: "u",
    ccedil: "c",
  };

  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCharCode(Number.parseInt(decimal, 10)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => namedEntities[name.toLowerCase()] ?? match);
}

function looksLikeCssNoise(value: string) {
  const normalized = value.toLowerCase();
  const cssHints = ["@media", "font-face", "!important", "table{", "not(#outlook)"];
  const hintCount = cssHints.filter((hint) => normalized.includes(hint)).length;

  if (hintCount >= 2) {
    return true;
  }

  const punctuationCount = (value.match(/[{};<>]/g) ?? []).length;
  return punctuationCount > value.length * 0.08;
}

function selectReadableBody(body: string, snippet: string) {
  const normalizedBody = body.trim();
  const normalizedSnippet = normalizeEmailBody(snippet, false);

  if (!normalizedBody) {
    return formatReadablePlainText(normalizedSnippet);
  }

  if (looksLikeCssNoise(normalizedBody) && normalizedSnippet.length > 0) {
    return formatReadablePlainText(normalizedSnippet);
  }

  return formatReadablePlainText(normalizedBody);
}

function formatReadablePlainText(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  const withBullets = trimmed
    .replace(/\s-\s(?=[A-Z0-9])/g, "\n- ")
    .replace(/\s•\s/g, "\n- ");

  const withSectionBreaks = withBullets
    .replace(/:\s(?=[A-Z])/g, ":\n")
    .replace(/\?\s(?=[A-Z])/g, "?\n")
    .replace(/\!\s(?=[A-Z])/g, "!\n");

  // If provider body comes as one very long line, break after sentence boundaries.
  const forceSentenceBreaks =
    withSectionBreaks.includes("\n")
      ? withSectionBreaks
      : withSectionBreaks.replace(/\.\s(?=[A-Z])/g, ".\n");

  return forceSentenceBreaks
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

function extractEmailAddress(value: string) {
  const angleMatch = value.match(/<([^>]+)>/);
  const candidate = (angleMatch?.[1] ?? value).trim();

  if (!candidate.includes("@")) {
    return "";
  }

  return candidate;
}

function extractEmailAddresses(value: string) {
  if (!value.trim()) {
    return [];
  }

  const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return dedupeEmailList(matches);
}

function dedupeEmailList(values: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const email = value.trim();

    if (!email) {
      continue;
    }

    const key = email.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(email);
  }

  return deduped;
}

async function resolveMailboxAccountEmail(provider: MailProvider, accessToken: string) {
  if (provider === "gmail") {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as { emailAddress?: string };
    return payload.emailAddress?.trim() || null;
  }

  const response = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as { mail?: string; userPrincipalName?: string };
  const value = payload.mail?.trim() || payload.userPrincipalName?.trim() || "";
  return value || null;
}

async function parseProviderError(provider: MailProvider, response: Response) {
  let details: unknown;

  try {
    details = (await response.json()) as unknown;
  } catch {
    details = await response.text();
  }

  const detailsText = typeof details === "string" ? details : JSON.stringify(details);
  const normalized = detailsText.toLowerCase();

  if (
    response.status === 401 ||
    response.status === 403 ||
    normalized.includes("insufficient") ||
    normalized.includes("permission") ||
    normalized.includes("scope")
  ) {
    return `${provider} mailbox permissions are insufficient for this action. Reconnect ${provider} in mailbox settings to grant latest scopes.`;
  }

  return `${provider} request failed (${response.status}): ${detailsText}`;
}

function isMissingRelationError(message: string, relation: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("does not exist") && normalized.includes(relation.toLowerCase());
}

function isPermissionDeniedError(message: string, relation: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("permission denied") && normalized.includes(relation.toLowerCase());
}