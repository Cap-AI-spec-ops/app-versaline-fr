import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { generateStructuredJson } from "@/lib/ai/structured-json-provider";
import {
  getMasterCredentials,
  hashPhoneNumber,
  normalizePhoneNumber,
  validateTwilioSignature,
} from "@/lib/twilio/client";

export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;
type AiProvider = "anthropic" | "gemini" | "mistral" | "xai";

const CALL_SUMMARY_CREDIT_COST = 0.2;

type WorkspaceNumberRow = {
  id: string;
  workspace_id: string;
};

type ModelSettingRow = {
  text_provider: string | null;
  text_model: string | null;
  provider: string | null;
  model: string | null;
};

const triageSchema = z.object({
  action: z.enum(["save_summary", "discard", "needs_review"]),
  confidence: z.number().min(0).max(100),
  summary: z.string().max(1200),
  reason: z.string().min(1).max(500),
});

export async function POST(request: NextRequest) {
  const master = getMasterCredentials();

  if (!master) {
    return new NextResponse(null, { status: 204 });
  }

  const formData = await request.formData();
  const params = Object.fromEntries(formData.entries()) as Record<string, string>;

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  const webhookUrl = `${siteUrl}/api/twilio/voice-transcript`;
  const twilioSignature = request.headers.get("X-Twilio-Signature") ?? "";

  if (!validateTwilioSignature({ authToken: master.authToken, twilioSignature, url: webhookUrl, params })) {
    return new NextResponse(null, { status: 403 });
  }

  const callSid = (params.CallSid ?? "").trim();
  const rawTo = (params.To ?? "").trim();
  const rawFrom = (params.From ?? "").trim();
  const transcriptionText = (params.TranscriptionText ?? "").trim();
  const transcriptionStatus = (params.TranscriptionStatus ?? "").trim();
  const occurredAt = new Date().toISOString();

  if (!callSid || !rawTo || !rawFrom) {
    return new NextResponse(null, { status: 400 });
  }

  if (transcriptionStatus !== "completed" || !transcriptionText) {
    return new NextResponse(null, { status: 200 });
  }

  const toNormalized = normalizePhoneNumber(rawTo);
  const fromNormalized = normalizePhoneNumber(rawFrom);
  const fromHash = hashPhoneNumber(fromNormalized);
  const toHash = hashPhoneNumber(toNormalized);

  // Deduplicate by call SID: only one summary per call.
  const summaryTwilioSid = `${callSid}:transcript`;

  const supabase = getSupabaseAdminClient();

  if (!supabase) {
    return new NextResponse(null, { status: 503 });
  }

  const { data: existingSummary } = await supabase
    .from("twilio_summaries")
    .select("id")
    .eq("twilio_sid", summaryTwilioSid)
    .maybeSingle();

  if (existingSummary?.id) {
    return new NextResponse(null, { status: 200 });
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

  const { data: contactRows } = await supabase.rpc("find_contact_by_phone", {
    p_workspace_id: workspaceId,
    p_phone: fromNormalized,
  });

  const contactIds = ((contactRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  const primaryContactId = contactIds[0] ?? null;

  if (!primaryContactId) {
    return new NextResponse(null, { status: 200 });
  }

  const modelSelection = await resolveTwilioModelSettings(supabase, workspaceId, "twilio_call_summary");

  if (!modelSelection) {
    return new NextResponse(null, { status: 200 });
  }

  const { data: contextRows } = await supabase
    .from("twilio_summaries")
    .select("summary_text, occurred_at")
    .eq("workspace_id", workspaceId)
    .in("contact_id", contactIds)
    .eq("channel", "voice")
    .order("occurred_at", { ascending: false })
    .limit(3);

  const contextBlock = ((contextRows ?? []) as Array<{ summary_text: string; occurred_at: string }>)
    .map((r, i) => `${i + 1}. [${new Date(r.occurred_at).toISOString()}] ${r.summary_text}`)
    .join("\n");

  const prompt = [
    "You are a CRM call triage assistant for a real-estate agency workspace.",
    "You receive a voice message transcription. Analyze it and produce structured output.",
    "",
    "Rules:",
    "- action=save_summary when the message contains business-relevant intent: property enquiry, visit request, offer, scheduling, or negotiation.",
    "- action=discard for empty messages, background noise only, trivial acknowledgements, or clearly wrong number.",
    "- action=needs_review if confidence is low or intent is ambiguous.",
    "- confidence must be an integer between 0 and 100.",
    "- summary must be at most 3 sentences and concise.",
    "- reason should briefly justify the decision.",
    "",
    `Context summaries (latest first):\n${contextBlock || "No prior summaries."}`,
    "",
    `Caller: ${fromNormalized}`,
    "Transcription:",
    transcriptionText,
  ].join("\n");

  let triage: z.infer<typeof triageSchema>;

  try {
    triage = await runProviderTriage({
      provider: modelSelection.provider,
      model: modelSelection.model,
      prompt,
    });
  } catch {
    return new NextResponse(null, { status: 200 });
  }

  if (triage.action !== "save_summary") {
    return new NextResponse(null, { status: 200 });
  }

  try {
    await supabase.rpc("deduct_workspace_credit", {
      p_workspace_id: workspaceId,
      p_amount: CALL_SUMMARY_CREDIT_COST,
      p_action: "twilio_call_summary",
      p_idempotency_key: `${callSid}:call_summary`,
      p_metadata: { source: "twilio_voice_transcript" },
    });
  } catch {
    return new NextResponse(null, { status: 200 });
  }

  const confidenceRatio = Math.min(1, Math.max(0, triage.confidence / 100));

  await supabase.from("twilio_summaries").insert({
    workspace_id: workspaceId,
    contact_id: primaryContactId,
    twilio_number_id: twilioNumberId,
    twilio_sid: summaryTwilioSid,
    channel: "voice",
    direction: "inbound",
    summary_text: triage.summary.trim(),
    summary_language: "fr",
    model_provider: modelSelection.provider,
    model_name: modelSelection.model,
    triage_reason_code: triage.reason,
    triage_confidence: confidenceRatio,
    occurred_at: occurredAt,
    metadata: {
      call_sid: callSid,
      from_number_hash: fromHash,
      to_number_hash: toHash,
      source: "twilio_voice_transcript",
    } satisfies JsonRecord,
  });

  // Update the existing audit log to reflect that a transcript was processed.
  await supabase
    .from("twilio_audit_logs")
    .update({
      triage_label: "save_summary",
      triage_reason_code: triage.reason,
      triage_confidence: confidenceRatio,
      processing_status: "processed",
      metadata: {
        source: "twilio_voice_status_callback",
        transcript_processed: true,
        model_provider: modelSelection.provider,
        model_name: modelSelection.model,
      } satisfies JsonRecord,
    })
    .eq("twilio_sid", callSid);

  return new NextResponse(null, { status: 200 });
}

async function resolveTwilioModelSettings(
  supabase: SupabaseClient,
  workspaceId: string,
  actionType: string,
): Promise<{ provider: AiProvider; model: string } | null> {
  for (const scope of [workspaceId, null]) {
    const query = supabase
      .from("ai_model_settings")
      .select("text_provider, text_model, provider, model")
      .eq("action_type", actionType)
      .eq("is_active", true);

    const { data } =
      scope !== null
        ? await query.eq("workspace_id", scope).maybeSingle<ModelSettingRow>()
        : await query.is("workspace_id", null).maybeSingle<ModelSettingRow>();

    if (!data) continue;

    const provider = (data.text_provider ?? data.provider ?? "gemini") as AiProvider;
    const model = (data.text_model ?? data.model ?? "").trim();

    if (model) return { provider, model };
  }

  return null;
}

async function runProviderTriage(options: {
  provider: AiProvider;
  model: string;
  prompt: string;
}): Promise<z.infer<typeof triageSchema>> {
  const payload = await generateStructuredJson({
    provider: options.provider,
    model: options.model,
    prompt: options.prompt,
    temperature: 0.2,
    maxTokens: 700,
  });

  return triageSchema.parse(payload);
}

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
