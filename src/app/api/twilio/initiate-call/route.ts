import "server-only";

import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getMasterCredentials, hashPhoneNumber, normalizePhoneNumber, twilioApiRequest } from "@/lib/twilio/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const bodySchema = z.object({
  workspaceId: z.string().uuid(),
  contactId: z.string().uuid(),
  to: z.string().min(1),
});

type WorkspaceNumberRow = {
  id: string;
  phone_number: string;
  twilio_account_id: string;
  capabilities_voice: boolean;
};

type TwilioAccountRow = {
  subaccount_sid: string;
};

type PolicyRow = {
  twilio_enabled: boolean | null;
};

export async function POST(request: NextRequest) {
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

  let body: z.infer<typeof bodySchema>;

  try {
    body = bodySchema.parse((await request.json()) as unknown);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { data: profileData } = await supabase.rpc("get_current_profile");
  const profile = profileData as { workspace_id?: string | null } | null;

  if (!profile?.workspace_id || profile.workspace_id !== body.workspaceId) {
    return NextResponse.json({ error: "Workspace mismatch" }, { status: 403 });
  }

  const adminClient = getSupabaseAdminClient();

  if (!adminClient) {
    return NextResponse.json({ error: "Service client unavailable" }, { status: 500 });
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentCount } = await adminClient
    .from("twilio_audit_logs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", body.workspaceId)
    .eq("direction", "outbound")
    .eq("channel", "voice")
    .gte("occurred_at", oneHourAgo);

  if ((recentCount ?? 0) >= 20) {
    return NextResponse.json({ error: "Outbound call limit reached. Try again later." }, { status: 429 });
  }

  if (!adminClient) {
    return NextResponse.json({ error: "Service client unavailable" }, { status: 500 });
  }

  const { data: workspace } = await adminClient
    .from("workspaces")
    .select("company_id")
    .eq("id", body.workspaceId)
    .maybeSingle<{ company_id: string | null }>();

  if (workspace?.company_id) {
    const { data: policy } = await adminClient
      .from("email_ingestion_policies")
      .select("twilio_enabled")
      .eq("company_id", workspace.company_id)
      .maybeSingle<PolicyRow>();

    if (!policy?.twilio_enabled) {
      return NextResponse.json({ error: "Twilio is not enabled for this workspace" }, { status: 403 });
    }
  }

  const { data: numberRow } = await adminClient
    .from("workspace_twilio_numbers")
    .select("id, phone_number, twilio_account_id, capabilities_voice")
    .eq("workspace_id", body.workspaceId)
    .eq("status", "active")
    .eq("capabilities_voice", true)
    .limit(1)
    .maybeSingle<WorkspaceNumberRow>();

  if (!numberRow) {
    return NextResponse.json(
      { error: "No active Twilio number with voice capability found for this workspace" },
      { status: 422 },
    );
  }

  const { data: accountRow } = await adminClient
    .from("workspace_twilio_accounts")
    .select("subaccount_sid")
    .eq("id", numberRow.twilio_account_id)
    .maybeSingle<TwilioAccountRow>();

  if (!accountRow?.subaccount_sid) {
    return NextResponse.json({ error: "Twilio subaccount not found" }, { status: 422 });
  }

  const master = getMasterCredentials();

  if (!master) {
    return NextResponse.json({ error: "Twilio credentials are not configured" }, { status: 503 });
  }

  const toNormalized = normalizePhoneNumber(body.to);
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  const twimlUrl = `${siteUrl}/api/twilio/twiml/outbound-call`;
  const statusCallbackUrl = `${siteUrl}/api/twilio/voice-status`;

  const callResponse = await twilioApiRequest({
    accountSid: accountRow.subaccount_sid,
    authToken: master.authToken,
    path: "Calls.json",
    method: "POST",
    body: {
      From: numberRow.phone_number,
      To: toNormalized,
      Url: twimlUrl,
      StatusCallback: statusCallbackUrl,
      StatusCallbackMethod: "POST",
    },
  });

  if (!callResponse.ok) {
    const payload = await callResponse.text();
    return NextResponse.json({ error: `Twilio call failed: ${payload}` }, { status: 502 });
  }

  const callPayload = (await callResponse.json()) as { sid?: string; status?: string };

  if (!callPayload.sid) {
    return NextResponse.json({ error: "Twilio did not return a call SID" }, { status: 502 });
  }

  await adminClient.from("twilio_audit_logs").insert({
    workspace_id: body.workspaceId,
    contact_id: body.contactId,
    twilio_number_id: numberRow.id,
    channel: "voice",
    direction: "outbound",
    twilio_sid: callPayload.sid,
    from_number_hash: hashPhoneNumber(numberRow.phone_number),
    to_number_hash: hashPhoneNumber(toNormalized),
    processing_status: "processed",
    triage_label: "needs_review",
    triage_reason_code: "outbound_call_initiated",
    occurred_at: new Date().toISOString(),
    metadata: {
      initiated_by: user.id,
      status: callPayload.status ?? "unknown",
      source: "crm_outbound_call",
    },
  });

  return NextResponse.json({ ok: true, sid: callPayload.sid });
}

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
