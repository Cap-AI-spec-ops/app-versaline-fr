import { NextRequest, NextResponse } from "next/server";

import {
  getSupabaseAdminClient,
  isMailboxReconnectRequired,
  resolveGmailAccessToken,
  syncOneGmailMailbox,
  type MailboxConnectionRow,
} from "../route";

export const runtime = "nodejs";

const CLAIM_BATCH_SIZE = 10;

type MailboxSyncJobRow = {
  id: string;
  workspace_id: string;
  mailbox_connection_id: string;
  provider: string;
  requested_by_profile_id: string | null;
  trigger_source: string;
  status: string;
  attempts: number;
  processed_messages: number;
  saved_summaries: number;
  new_balance: number | null;
  error_message: string | null;
  payload: Record<string, unknown> | null;
  locked_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function GET(request: NextRequest) {
  return processMailboxSyncQueue(request);
}

export async function POST(request: NextRequest) {
  return processMailboxSyncQueue(request);
}

async function processMailboxSyncQueue(request: NextRequest) {
  const isCronAuthorized = isCronAuthorizedRequest(request);
  const isSyncSecretAuthorized = request.headers.get("x-mailbox-sync-secret")?.trim() === process.env.MAILBOX_SYNC_SECRET?.trim();

  if (!isCronAuthorized && !isSyncSecretAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabaseAdmin = getSupabaseAdminClient();

  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Supabase service role client unavailable" }, { status: 500 });
  }

  const inboundSecret = process.env.INBOUND_EMAIL_WEBHOOK_SECRET?.trim();

  if (!inboundSecret) {
    return NextResponse.json({ error: "Inbound webhook secret is not configured" }, { status: 503 });
  }

  const resetResult = await supabaseAdmin.rpc("reset_stale_mailbox_sync_jobs", {
    p_lease_minutes: 30,
  });

  if (resetResult.error) {
    return NextResponse.json({ error: resetResult.error.message }, { status: 500 });
  }

  const claimedJobsResult = await supabaseAdmin.rpc("claim_mailbox_sync_jobs", {
    p_limit: CLAIM_BATCH_SIZE,
  });

  if (claimedJobsResult.error) {
    return NextResponse.json({ error: claimedJobsResult.error.message }, { status: 500 });
  }

  const claimedJobs = (claimedJobsResult.data ?? []) as MailboxSyncJobRow[];
  const failedJobs: Array<{ jobId: string; reason: string }> = [];
  let processedJobs = 0;
  let processedMessages = 0;
  let savedSummaries = 0;

  for (const job of claimedJobs) {
    const result = await processOneMailboxSyncJob({
      requestUrl: request.url,
      supabaseAdmin,
      job,
      inboundSecret,
    });

    if (result.ok) {
      processedJobs += 1;
      processedMessages += result.processedMessages;
      savedSummaries += result.savedSummaries;
    } else {
      failedJobs.push({
        jobId: job.id,
        reason: result.reason,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    claimedJobs: claimedJobs.length,
    processedJobs,
    processedMessages,
    savedSummaries,
    failedJobs,
  });
}

async function processOneMailboxSyncJob(params: {
  requestUrl: string;
  supabaseAdmin: NonNullable<ReturnType<typeof getSupabaseAdminClient>>;
  job: MailboxSyncJobRow;
  inboundSecret: string;
}): Promise<{ ok: true; processedMessages: number; savedSummaries: number } | { ok: false; reason: string }> {
  const { data: connectionData, error: connectionError } = await params.supabaseAdmin
    .from("mailbox_connections")
    .select(
      "id, workspace_id, profile_id, provider, status, include_sent_mail, last_synced_at, oauth_access_token, oauth_refresh_token, oauth_token_updated_at",
    )
    .eq("id", params.job.mailbox_connection_id)
    .maybeSingle<MailboxConnectionRow>();

  if (connectionError || !connectionData) {
    const reason = connectionError?.message || "Mailbox connection not found";
    await finalizeMailboxSyncJob(params.supabaseAdmin, params.job.id, "failed", 0, 0, null, reason);
    return { ok: false, reason };
  }

  if (connectionData.provider !== "gmail") {
    const reason = "Unsupported mailbox provider";
    await finalizeMailboxSyncJob(params.supabaseAdmin, params.job.id, "failed", 0, 0, null, reason);
    return { ok: false, reason };
  }

  if (isMailboxReconnectRequired(connectionData.oauth_token_updated_at)) {
    const reason = "Mailbox reconnection required every 90 days. Reconnect mailbox before running the worker again.";
    await finalizeMailboxSyncJob(params.supabaseAdmin, params.job.id, "failed", 0, 0, null, reason);
    return { ok: false, reason };
  }

  try {
    const accessToken = await resolveGmailAccessToken(connectionData);
    const resolvedAccessToken = accessToken || connectionData.oauth_access_token || null;

    if (!resolvedAccessToken) {
      throw new Error(
        "No Gmail access token available. Reconnect mailbox before running the worker again.",
      );
    }

    const syncResult = await syncOneGmailMailbox({
      requestUrl: params.requestUrl,
      supabaseAdmin: params.supabaseAdmin,
      connection: connectionData,
      accessToken: resolvedAccessToken,
      inboundSecret: params.inboundSecret,
    });

    await params.supabaseAdmin
      .from("mailbox_connections")
      .update({
        last_synced_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", connectionData.id);

    await finalizeMailboxSyncJob(
      params.supabaseAdmin,
      params.job.id,
      "succeeded",
      syncResult.processedMessages,
      syncResult.savedSummaries,
      syncResult.newBalance ?? null,
      null,
    );

    return {
      ok: true,
      processedMessages: syncResult.processedMessages,
      savedSummaries: syncResult.savedSummaries,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown sync error";

    await params.supabaseAdmin
      .from("mailbox_connections")
      .update({
        last_error: reason.slice(0, 500),
      })
      .eq("id", connectionData.id);

    await finalizeMailboxSyncJob(params.supabaseAdmin, params.job.id, "failed", 0, 0, null, reason);

    return { ok: false, reason };
  }
}

async function finalizeMailboxSyncJob(
  supabaseAdmin: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  jobId: string,
  status: "succeeded" | "failed",
  processedMessages: number,
  savedSummaries: number,
  newBalance: number | null,
  errorMessage: string | null,
) {
  await supabaseAdmin.rpc("complete_mailbox_sync_job", {
    p_job_id: jobId,
    p_status: status,
    p_processed_messages: processedMessages,
    p_saved_summaries: savedSummaries,
    p_new_balance: newBalance,
    p_error_message: errorMessage,
  });
}

function isCronAuthorizedRequest(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const authorization = request.headers.get("authorization")?.trim();

  if (authorization && cronSecret && authorization === `Bearer ${cronSecret}`) {
    return true;
  }

  return Boolean(request.headers.get("x-vercel-cron"));
}
