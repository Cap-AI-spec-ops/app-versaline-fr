import "server-only";

import crypto from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { generateStructuredJson } from "@/lib/ai/structured-json-provider";
import {
  detectChannel,
  getMasterCredentials,
  hashPhoneNumber,
  normalizePhoneNumber,
  stripWhatsAppPrefix,
  validateTwilioSignature,
} from "@/lib/twilio/client";

export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;
type AiProvider = "anthropic" | "gemini" | "mistral" | "xai";

const TRIAGE_CREDIT_COST = 0.1;
const SUMMARY_CREDIT_COST = 0.1;

type WorkspaceNumberRow = {
  id: string;
  workspace_id: string;
};

type CompanyPolicyRow = {
  twilio_enabled: boolean | null;
  twilio_confidence_threshold: number | null;
};

type ModelSettingRow = {
  text_provider: string | null;
  text_model: string | null;
  provider: string | null;
  model: string | null;
};

type AuditContext = {
  workspaceId: string;
  twilioNumberId: string | null;
  channel: string;
  twilioSid: string;
  fromHash: string;
  toHash: string;
  occurredAt: string;
};

const triageSchema = z.object({
  action: z.enum(["save_summary", "discard", "needs_review"]),
  confidence: z.number().min(0).max(100),
  summary: z.string().max(1200),
  reason: z.string().min(1).max(500),
});

const TWIML_OK = new NextResponse("<Response/>", {
  status: 200,
  headers: { "Content-Type": "text/xml" },
});

export async function POST(request: NextRequest) {
  const master = getMasterCredentials();

  if (!master) {
    return new NextResponse("<Response/>", { status: 503, headers: { "Content-Type": "text/xml" } });
  }

  const formData = await request.formData();
  const params = Object.fromEntries(formData.entries()) as Record<string, string>;

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  const webhookUrl = `${siteUrl}/api/twilio/inbound-message`;
  const twilioSignature = request.headers.get("X-Twilio-Signature") ?? "";

  if (!validateTwilioSignature({ authToken: master.authToken, twilioSignature, url: webhookUrl, params })) {
    return new NextResponse("<Response/>", { status: 403, headers: { "Content-Type": "text/xml" } });
  }

  const messageSid = (params.MessageSid ?? params.SmsSid ?? "").trim();
  const rawFrom = (params.From ?? "").trim();
  const rawTo = (params.To ?? "").trim();
  const body = (params.Body ?? "").trim();
  const occurredAt = new Date().toISOString();

  if (!messageSid || !rawFrom || !rawTo) {
    return TWIML_OK;
  }

  const channel = detectChannel(rawTo, rawFrom);
  const fromNormalized = normalizePhoneNumber(stripWhatsAppPrefix(rawFrom));
  const toNormalized = normalizePhoneNumber(stripWhatsAppPrefix(rawTo));
  const fromHash = hashPhoneNumber(fromNormalized);
  const toHash = hashPhoneNumber(toNormalized);

  const supabase = getSupabaseAdminClient();

  if (!supabase) {
    return new NextResponse("<Response/>", { status: 503, headers: { "Content-Type": "text/xml" } });
  }

  const { data: numberRow } = await supabase
    .from("workspace_twilio_numbers")
    .select("id, workspace_id")
    .eq("phone_number", toNormalized)
    .eq("status", "active")
    .maybeSingle<WorkspaceNumberRow>();

  if (!numberRow) {
    return TWIML_OK;
  }

  const { workspace_id: workspaceId, id: twilioNumberId } = numberRow;

  const auditCtx: AuditContext = {
    workspaceId,
    twilioNumberId,
    channel,
    twilioSid: messageSid,
    fromHash,
    toHash,
    occurredAt,
  };

  const { data: existingAudit } = await supabase
    .from("twilio_audit_logs")
    .select("id")
    .eq("twilio_sid", messageSid)
    .maybeSingle();

  if (existingAudit?.id) {
    return TWIML_OK;
  }

  const policy = await resolveTwilioPolicy(supabase, workspaceId);

  if (!policy.twilio_enabled) {
    await writeAudit(supabase, auditCtx, "discarded", "discard", "feature_disabled_by_policy");
    return TWIML_OK;
  }

  // Deterministic discard for trivial messages before spending any credits.
  if (!body || body.length < 3) {
    await writeAudit(supabase, auditCtx, "discarded", "discard", "message_too_short");
    return TWIML_OK;
  }

  const { data: contactRows } = await supabase.rpc("find_contact_by_phone", {
    p_workspace_id: workspaceId,
    p_phone: fromNormalized,
  });

  const contactIds = ((contactRows ?? []) as Array<{ id: string }>).map((r) => r.id);
  const primaryContactId = contactIds[0] ?? null;

  if (!primaryContactId) {
    // Unknown number: audit-only, no timeline write per V1 policy.
    await writeAudit(supabase, auditCtx, "discarded", "discard", "no_contact_match");
    return TWIML_OK;
  }

  const modelSelection = await resolveTwilioModelSettings(supabase, workspaceId, "twilio_message_triage");

  if (!modelSelection) {
    await writeAudit(supabase, auditCtx, "failed", "needs_review", "config_missing_model", primaryContactId);
    return TWIML_OK;
  }

  const { data: contextRows } = await supabase
    .from("twilio_summaries")
    .select("summary_text, occurred_at")
    .eq("workspace_id", workspaceId)
    .in("contact_id", contactIds)
    .order("occurred_at", { ascending: false })
    .limit(3);

  const contextBlock = ((contextRows ?? []) as Array<{ summary_text: string; occurred_at: string }>)
    .map((r, i) => `${i + 1}. [${new Date(r.occurred_at).toISOString()}] ${r.summary_text}`)
    .join("\n");

  const channelLabel = channel === "whatsapp" ? "WhatsApp" : "SMS";
  const prompt = [
    `You are a CRM ${channelLabel} triage assistant for a real-estate agency workspace.`,
    "",
    "Return only structured output that follows the schema.",
    "Rules:",
    "- action=save_summary when the message contains business-relevant intent, scheduling, property interest, offers, visit requests, or actionable client requests.",
    "- action=discard for greetings only, automated notifications, delivery receipts, trivial acknowledgements (ok/merci/👍), or non-actionable content.",
    "- action=needs_review if confidence is low or intent is ambiguous.",
    "- confidence must be an integer between 0 and 100.",
    "- summary must be at most 3 sentences and concise.",
    "- reason should briefly justify the decision.",
    "",
    `Context summaries (latest first):\n${contextBlock || "No prior summaries."}`,
    "",
    `Sender: ${fromNormalized}`,
    `Message:`,
    body,
  ].join("\n");

  let triage: z.infer<typeof triageSchema>;

  try {
    triage = await runProviderTriage({
      provider: modelSelection.provider,
      model: modelSelection.model,
      prompt,
    });
  } catch {
    await writeAudit(supabase, auditCtx, "failed", "needs_review", "ai_generate_failed", primaryContactId);
    return TWIML_OK;
  }

  const confidenceRatio = clamp01(triage.confidence / 100);
  const confidenceThreshold = (policy.twilio_confidence_threshold ?? 70) / 100;

  try {
    await chargeCredit(supabase, workspaceId, TRIAGE_CREDIT_COST, "twilio_message_triage", `${messageSid}:triage`);
  } catch {
    await writeAudit(supabase, auditCtx, "failed", "needs_review", "credit_deduction_failed", primaryContactId);
    return TWIML_OK;
  }

  const effectiveAction = confidenceRatio < confidenceThreshold ? "needs_review" : triage.action;

  if (effectiveAction === "save_summary") {
    try {
      await chargeCredit(supabase, workspaceId, SUMMARY_CREDIT_COST, "twilio_message_summary", `${messageSid}:summary`);

      await supabase.from("twilio_summaries").insert({
        workspace_id: workspaceId,
        contact_id: primaryContactId,
        twilio_number_id: twilioNumberId,
        twilio_sid: messageSid,
        channel,
        direction: "inbound",
        summary_text: triage.summary.trim(),
        summary_language: "fr",
        model_provider: modelSelection.provider,
        model_name: modelSelection.model,
        triage_reason_code: triage.reason,
        triage_confidence: confidenceRatio,
        occurred_at: occurredAt,
        metadata: {
          from_number_hash: fromHash,
          to_number_hash: toHash,
          source: "twilio_inbound_message",
          context_summary_count: contextRows?.length ?? 0,
        } satisfies JsonRecord,
      });
    } catch {
      // Audit still written below even if summary fails.
    }
  }

  const processingStatus =
    effectiveAction === "save_summary" ? "processed"
    : effectiveAction === "discard" ? "discarded"
    : "processed";

  await writeAudit(supabase, auditCtx, processingStatus, effectiveAction, triage.reason, primaryContactId, {
    model_provider: modelSelection.provider,
    model_name: modelSelection.model,
    matched_contact_count: contactIds.length,
  });

  return TWIML_OK;
}

async function resolveTwilioPolicy(supabase: SupabaseClient, workspaceId: string) {
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .maybeSingle<{ company_id: string | null }>();

  if (!workspace?.company_id) {
    return { twilio_enabled: false, twilio_confidence_threshold: 70 };
  }

  const { data: policy } = await supabase
    .from("email_ingestion_policies")
    .select("twilio_enabled, twilio_confidence_threshold")
    .eq("company_id", workspace.company_id)
    .maybeSingle<CompanyPolicyRow>();

  return {
    twilio_enabled: policy?.twilio_enabled ?? false,
    twilio_confidence_threshold: policy?.twilio_confidence_threshold ?? 70,
  };
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

async function chargeCredit(
  supabase: SupabaseClient,
  workspaceId: string,
  amount: number,
  action: string,
  idempotencyKey: string,
) {
  const { error } = await supabase.rpc("deduct_workspace_credit", {
    p_workspace_id: workspaceId,
    p_amount: amount,
    p_action: action,
    p_idempotency_key: idempotencyKey,
    p_metadata: { source: "twilio_inbound_message" },
  });

  if (error) {
    throw new Error(error.message);
  }
}

async function writeAudit(
  supabase: SupabaseClient,
  ctx: AuditContext,
  processingStatus: string,
  triageLabel: string,
  reasonCode: string,
  contactId: string | null = null,
  extra: JsonRecord = {},
) {
  await supabase.from("twilio_audit_logs").insert({
    workspace_id: ctx.workspaceId,
    contact_id: contactId,
    twilio_number_id: ctx.twilioNumberId,
    channel: ctx.channel,
    direction: "inbound",
    twilio_sid: ctx.twilioSid,
    from_number_hash: ctx.fromHash,
    to_number_hash: ctx.toHash,
    processing_status: processingStatus,
    triage_label: triageLabel,
    triage_reason_code: reasonCode,
    occurred_at: ctx.occurredAt,
    metadata: { source: "twilio_inbound_message", ...extra } satisfies JsonRecord,
  });
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
