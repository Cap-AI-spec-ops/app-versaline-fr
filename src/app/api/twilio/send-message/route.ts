import "server-only";

import crypto from "node:crypto";

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
  message: z.string().min(1).max(1600),
  channel: z.enum(["sms", "whatsapp"]),
});

type WorkspaceNumberRow = {
  id: string;
  phone_number: string;
  twilio_account_id: string;
  capabilities_sms: boolean;
  capabilities_whatsapp: boolean;
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
    .in("channel", ["sms", "whatsapp"])
    .gte("occurred_at", oneHourAgo);

  if ((recentCount ?? 0) >= 100) {
    return NextResponse.json({ error: "Outbound message limit reached. Try again later." }, { status: 429 });
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

  const capabilityField = body.channel === "whatsapp" ? "capabilities_whatsapp" : "capabilities_sms";

  const { data: numberRow } = await adminClient
    .from("workspace_twilio_numbers")
    .select("id, phone_number, twilio_account_id, capabilities_sms, capabilities_whatsapp")
    .eq("workspace_id", body.workspaceId)
    .eq("status", "active")
    .eq(capabilityField, true)
    .limit(1)
    .maybeSingle<WorkspaceNumberRow>();

  if (!numberRow) {
    return NextResponse.json(
      { error: `No active Twilio number with ${body.channel} capability found for this workspace` },
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
  const fromNumber = numberRow.phone_number;
  const from = body.channel === "whatsapp" ? `whatsapp:${fromNumber}` : fromNumber;
  const to = body.channel === "whatsapp" ? `whatsapp:${toNormalized}` : toNormalized;

  const sendResponse = await twilioApiRequest({
    accountSid: accountRow.subaccount_sid,
    authToken: master.authToken,
    path: "Messages.json",
    method: "POST",
    body: { From: from, To: to, Body: body.message },
  });

  if (!sendResponse.ok) {
    const payload = await sendResponse.text();
    return NextResponse.json({ error: `Twilio send failed: ${payload}` }, { status: 502 });
  }

  const sendPayload = (await sendResponse.json()) as { sid?: string; status?: string };

  if (!sendPayload.sid) {
    return NextResponse.json({ error: "Twilio did not return a message SID" }, { status: 502 });
  }

  await adminClient.from("twilio_audit_logs").insert({
    workspace_id: body.workspaceId,
    contact_id: body.contactId,
    twilio_number_id: numberRow.id,
    channel: body.channel,
    direction: "outbound",
    twilio_sid: sendPayload.sid,
    from_number_hash: hashPhoneNumber(fromNumber),
    to_number_hash: hashPhoneNumber(toNormalized),
    processing_status: "processed",
    triage_label: "save_summary",
    triage_reason_code: "outbound_message",
    occurred_at: new Date().toISOString(),
    metadata: {
      sent_by: user.id,
      status: sendPayload.status ?? "unknown",
      source: "crm_outbound_message",
    },
  });

  return NextResponse.json({ ok: true, sid: sendPayload.sid });
}

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
