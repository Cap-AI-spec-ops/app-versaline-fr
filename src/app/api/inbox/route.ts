import { Buffer } from "node:buffer";

import { NextRequest, NextResponse } from "next/server";

import { resolveGmailAccessToken, resolveOutlookAccessToken } from "@/app/api/mailbox/sync/route";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type MailProvider = "gmail" | "outlook";

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
  body: string;
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
    };

export async function GET(request: NextRequest) {
  const view = request.nextUrl.searchParams.get("view")?.trim() ?? "list";

  if (view === "thread") {
    return getThreadView(request);
  }

  return getListView();
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

  if (payload.action === "reply") {
    const trimmedBody = payload.body.trim();

    if (trimmedBody.length < 2) {
      return NextResponse.json({ error: "Reply message must contain at least 2 characters." }, { status: 422 });
    }

    return runReplyAction(payload.provider, payload.messageId, trimmedBody, accessToken);
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}

async function getListView() {
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

    for (const connection of context.connections) {
      try {
        const accessToken = await resolveConnectionAccessToken(connection);

        if (!accessToken) {
          warnings.push(`${connection.provider} mailbox token unavailable. Reconnect mailbox in settings.`);
          continue;
        }

        if (connection.provider === "gmail") {
          const gmailMessages = await listGmailMessages(accessToken);
          const diagnostic = context.connectionDiagnostics.find((entry) => entry.provider === "gmail");

          if (diagnostic) {
            diagnostic.fetchedCount = gmailMessages.length;
          }

          for (const message of gmailMessages) {
            messagesByKey.set(`${message.provider}:${message.messageId}`, message);
          }

          continue;
        }

        const outlookMessages = await listOutlookMessages(accessToken);
        const diagnostic = context.connectionDiagnostics.find((entry) => entry.provider === "outlook");

        if (diagnostic) {
          diagnostic.fetchedCount = outlookMessages.length;
        }

        for (const message of outlookMessages) {
          messagesByKey.set(`${message.provider}:${message.messageId}`, message);
        }
      } catch (providerError) {
        warnings.push(
          providerError instanceof Error
            ? providerError.message
            : `Could not load ${connection.provider} messages.`,
        );
      }
    }

    const messages = Array.from(messagesByKey.values());

    messages.sort((left, right) => {
      if (left.isUnread !== right.isUnread) {
        return left.isUnread ? -1 : 1;
      }

      return new Date(right.receivedAt).getTime() - new Date(left.receivedAt).getTime();
    });

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
  const connections = allConnections.filter((connection) => connection.status === "connected");
  const connectionDiagnostics: ConnectionDiagnostic[] = allConnections.map((connection) => ({
    provider: connection.provider,
    status: connection.status,
    lastSyncedAt: connection.last_synced_at,
    hasAccessToken: Boolean(connection.oauth_access_token),
    hasRefreshToken: Boolean(connection.oauth_refresh_token),
    lastError: connection.last_error ?? null,
    accountEmail: null,
    fetchedCount: 0,
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

async function listGmailMessages(accessToken: string): Promise<InboxMessage[]> {
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("maxResults", "30");
  listUrl.searchParams.set("q", "newer_than:180d");

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
  };

  const messages: InboxMessage[] = [];

  for (const item of listPayload.messages ?? []) {
    const messageId = item.id?.trim();

    if (!messageId) {
      continue;
    }

    const messageUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`);
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
      continue;
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

    messages.push({
      key: `gmail:${payload.id ?? messageId}`,
      provider: "gmail",
      messageId: payload.id ?? messageId,
      threadId: payload.threadId ?? item.threadId ?? null,
      subject,
      from,
      snippet: (payload.snippet ?? "").trim(),
      receivedAt: timestamp,
      isUnread: labelSet.has("UNREAD"),
      isArchived: !labelSet.has("INBOX"),
      assignedToProfileId: null,
    });
  }

  return messages;
}

async function listOutlookMessages(accessToken: string): Promise<InboxMessage[]> {
  const listUrl = new URL("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages");
  listUrl.searchParams.set("$top", "30");
  listUrl.searchParams.set("$orderby", "receivedDateTime desc");
  listUrl.searchParams.set(
    "$select",
    "id,conversationId,subject,from,bodyPreview,receivedDateTime,isRead,parentFolderId",
  );

  const response = await fetch(listUrl.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="text"',
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(await parseProviderError("outlook", response));
  }

  let payload = (await response.json()) as {
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
  };

  if (!Array.isArray(payload.value) || payload.value.length === 0) {
    const fallbackUrl = new URL("https://graph.microsoft.com/v1.0/me/messages");
    fallbackUrl.searchParams.set("$top", "30");
    fallbackUrl.searchParams.set("$orderby", "receivedDateTime desc");
    fallbackUrl.searchParams.set(
      "$select",
      "id,conversationId,subject,from,bodyPreview,receivedDateTime,isRead,parentFolderId",
    );

    const fallbackResponse = await fetch(fallbackUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="text"',
      },
      cache: "no-store",
    });

    if (fallbackResponse.ok) {
      payload = (await fallbackResponse.json()) as {
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
      };
    }
  }

  const messages: InboxMessage[] = [];

  for (const message of payload.value ?? []) {
    const id = message.id?.trim();

    if (!id) {
      continue;
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
      receivedAt: message.receivedDateTime?.trim() || new Date().toISOString(),
      isUnread: !Boolean(message.isRead),
      isArchived: false,
      assignedToProfileId: null,
    });
  }

  return messages;
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
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=id,conversationId,subject,body,from,toRecipients,receivedDateTime,isRead`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'outlook.body-content-type="text"',
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

  const url = new URL("https://graph.microsoft.com/v1.0/me/messages");
  url.searchParams.set("$top", "50");
  url.searchParams.set("$orderby", "receivedDateTime asc");
  url.searchParams.set("$filter", `conversationId eq '${threadId.replace(/'/g, "''")}'`);
  url.searchParams.set(
    "$select",
    "id,conversationId,subject,body,from,toRecipients,receivedDateTime,isRead",
  );

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Prefer: 'outlook.body-content-type="text"',
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

async function runReplyAction(provider: MailProvider, messageId: string, body: string, accessToken: string) {
  if (provider === "outlook") {
    const response = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`, {
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
  const messageHeaderId = findHeader(headers, "message-id") || "";
  const recipient = extractEmailAddress(from);

  if (!recipient) {
    return NextResponse.json({ error: "Could not resolve recipient for Gmail reply." }, { status: 422 });
  }

  const normalizedSubject = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`;
  const rawMessage = [
    `To: ${recipient}`,
    `Subject: ${normalizedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    ...(messageHeaderId ? [`In-Reply-To: ${messageHeaderId}`, `References: ${messageHeaderId}`] : []),
    "",
    body,
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
  receivedDateTime?: string;
  isRead?: boolean;
};

function parseGmailThreadMessage(message: GmailFullMessage): InboxThreadMessage {
  const headers = message.payload?.headers ?? [];
  const body = extractGmailBodyText(message.payload) || message.snippet || "";
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
    body,
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
  const toLine = (message.toRecipients ?? [])
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
    body: (message.body?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
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
        .replace(/<!--([\s\S]*?)-->/g, " ")
        .replace(/<[^>]+>/g, " ")
    : raw;

  const withoutNoise = source
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@font-face\{[\s\S]*?\}/gi, " ")
    .replace(/[A-Za-z0-9_-]+\{[^{}]{20,}\}/g, " ");

  return withoutNoise
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEmailAddress(value: string) {
  const angleMatch = value.match(/<([^>]+)>/);
  const candidate = (angleMatch?.[1] ?? value).trim();

  if (!candidate.includes("@")) {
    return "";
  }

  return candidate;
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