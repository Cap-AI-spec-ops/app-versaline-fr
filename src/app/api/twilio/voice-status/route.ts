import "server-only";

import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import {
  getMasterCredentials,
  hashPhoneNumber,
  normalizePhoneNumber,
  validateTwilioSignature,
} from "@/lib/twilio/client";

export const runtime = "nodejs";

type WorkspaceNumberRow = {
  id: string;
  workspace_id: string;
};

type JsonRecord = Record<string, unknown>;

export async function POST(request: NextRequest) {
  const master = getMasterCredentials();

  if (!master) {
    return new NextResponse(null, { status: 204 });
  }

  const formData = await request.formData();
  const params = Object.fromEntries(formData.entries()) as Record<string, string>;

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  const webhookUrl = `${siteUrl}/api/twilio/voice-status`;
  const twilioSignature = request.headers.get("X-Twilio-Signature") ?? "";

  if (!validateTwilioSignature({ authToken: master.authToken, twilioSignature, url: webhookUrl, params })) {
    return new NextResponse(null, { status: 403 });
  }

  const callSid = (params.CallSid ?? "").trim();
  const rawTo = (params.To ?? "").trim();
  const rawFrom = (params.From ?? "").trim();
  const callStatus = (params.CallStatus ?? "").trim();
  const durationStr = (params.CallDuration ?? params.RecordingDuration ?? "").trim();
  const duration = durationStr ? Number.parseInt(durationStr, 10) : null;
  const occurredAt = new Date().toISOString();

  if (!callSid || !rawTo || !rawFrom) {
    return new NextResponse(null, { status: 400 });
  }

  const toNormalized = normalizePhoneNumber(rawTo);
  const fromNormalized = normalizePhoneNumber(rawFrom);
  const fromHash = hashPhoneNumber(fromNormalized);
  const toHash = hashPhoneNumber(toNormalized);

  const supabase = getSupabaseAdminClient();

  if (!supabase) {
    return new NextResponse(null, { status: 503 });
  }

  const { data: numberRow } = await supabase
    .from("workspace_twilio_numbers")
    .select("id, workspace_id")
    .eq("phone_number", toNormalized)
    .eq("status", "active")
    .maybeSingle<WorkspaceNumberRow>();

  if (!numberRow) {
    return new NextResponse(null, { status: 200 });
  }

  const { workspace_id: workspaceId, id: twilioNumberId } = numberRow;

  // Idempotency: only write the final completed record.
  if (callStatus !== "completed") {
    return new NextResponse(null, { status: 200 });
  }

  const { data: existingAudit } = await supabase
    .from("twilio_audit_logs")
    .select("id")
    .eq("twilio_sid", callSid)
    .maybeSingle();

  if (existingAudit?.id) {
    return new NextResponse(null, { status: 200 });
  }

  // consent_obtained is determined by whether a recording was initiated.
  // RecordingUrl presence indicates consent was given and recording succeeded.
  const recordingUrl = (params.RecordingUrl ?? "").trim();
  const recordingEnabled = Boolean(recordingUrl);
  const consentObtained = recordingEnabled;

  await supabase.from("twilio_audit_logs").insert({
    workspace_id: workspaceId,
    twilio_number_id: twilioNumberId,
    channel: "voice",
    direction: "inbound",
    twilio_sid: callSid,
    from_number_hash: fromHash,
    to_number_hash: toHash,
    processing_status: "processed",
    triage_label: "needs_review",
    triage_reason_code: "awaiting_transcript",
    occurred_at: occurredAt,
    duration_seconds: Number.isFinite(duration) ? duration : null,
    recording_enabled: recordingEnabled,
    consent_obtained: consentObtained,
    metadata: {
      call_status: callStatus,
      source: "twilio_voice_status_callback",
    } satisfies JsonRecord,
  });

  return new NextResponse(null, { status: 200 });
}

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
