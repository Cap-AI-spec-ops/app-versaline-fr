import crypto from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateObject } from "ai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

type JsonRecord = Record<string, unknown>;

type AiProvider = "anthropic" | "gemini" | "mistral" | "xai";

type InboundErrorCode =
  | "audit_lookup_failed"
  | "audit_insert_failed"
  | "contact_lookup_failed"
  | "context_lookup_failed"
  | "mailbox_connection_lookup_failed"
  | "policy_lookup_failed"
  | "feature_disabled_by_company_policy"
  | "config_missing_model_setting"
  | "config_missing_model_name"
  | "config_missing_api_key"
  | "config_provider_unavailable"
  | "credit_deduction_failed"
  | "ai_generate_failed"
  | "summary_insert_failed";

type AuditContext = {
  workspaceId: string;
  mailboxConnectionId: string;
  provider: string;
  messageIdHash: string;
  threadIdHash: string | null;
  occurredAt: string;
  senderEmail: string;
  senderEmailHash: string;
};

type ModelSettingRow = {
  action_type: string;
  provider: string | null;
  model: string | null;
  text_provider: string | null;
  text_model: string | null;
};

type SummaryContextRow = {
  summary_text: string;
  received_at: string;
};

const TRIAGE_CREDIT_COST = 0.1;
const SUMMARY_CREDIT_COST = 0.1;
const INCLUDE_SENT_SUMMARY_SURCHARGE = 0.1;

const inboundEmailSchema = z.object({
  workspaceId: z.string().uuid(),
  mailboxConnectionId: z.string().uuid(),
  billedUserId: z.string().uuid(),
  provider: z.string().trim().min(1),
  messageIdHash: z.string().trim().min(16),
  threadIdHash: z.string().trim().min(16).optional(),
  senderEmail: z.string().email(),
  subject: z.string().trim().max(500).optional(),
  body: z.string().min(1),
  receivedAt: z.string().datetime().optional(),
});

const triageOutputSchema = z.object({
  action: z.enum(["save_summary", "discard", "needs_review"]),
  confidence: z.number().min(0).max(100),
  summary: z.string().max(1200),
  reason: z.string().min(1).max(500),
});

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.INBOUND_EMAIL_WEBHOOK_SECRET?.trim();

  if (!webhookSecret) {
    return NextResponse.json({ error: "Inbound webhook secret is not configured" }, { status: 503 });
  }

  const providedSecret = request.headers.get("x-inbound-email-secret")?.trim();

  if (!providedSecret || providedSecret !== webhookSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: z.infer<typeof inboundEmailSchema>;

  try {
    const raw = (await request.json()) as unknown;
    payload = inboundEmailSchema.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();

  if (!supabase) {
    return NextResponse.json({ error: "Supabase service role client unavailable" }, { status: 500 });
  }

  const workspaceId = payload.workspaceId;
  const mailboxConnectionId = payload.mailboxConnectionId;
  const billedUserId = payload.billedUserId;
  const provider = payload.provider.trim().toLowerCase();
  const messageIdHash = payload.messageIdHash.trim();
  const threadIdHash = payload.threadIdHash?.trim() ?? null;
  const senderEmail = payload.senderEmail.trim().toLowerCase();
  const senderEmailHash = sha256(senderEmail);
  const receivedAt = payload.receivedAt ?? new Date().toISOString();
  const subjectHint = (payload.subject ?? "").trim() || null;
  const auditContext: AuditContext = {
    workspaceId,
    mailboxConnectionId,
    provider,
    messageIdHash,
    threadIdHash,
    occurredAt: receivedAt,
    senderEmail,
    senderEmailHash,
  };

  // Fast idempotency check before any AI cost.
  const existingAudit = await supabase
    .from("email_audit_logs")
    .select("id")
    .eq("provider", provider)
    .eq("mailbox_connection_id", mailboxConnectionId)
    .eq("message_id_hash", messageIdHash)
    .limit(1)
    .maybeSingle();

  if (!existingAudit.error && existingAudit.data?.id) {
    return NextResponse.json({ ok: true, deduplicated: true }, { status: 200 });
  }

  if (existingAudit.error) {
    await writeAuditFailure({
      supabase,
      context: auditContext,
      code: "audit_lookup_failed",
      metadata: {
        source: "inbound_email_webhook",
      },
    });

    return NextResponse.json({ error: "Inbound processing failed", code: "audit_lookup_failed" }, { status: 500 });
  }

  const mailboxConnectionResult = await supabase
    .from("mailbox_connections")
    .select("profile_id, include_sent_mail")
    .eq("id", mailboxConnectionId)
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();

  if (mailboxConnectionResult.error || !mailboxConnectionResult.data?.profile_id) {
    await writeAuditFailure({
      supabase,
      context: auditContext,
      code: "mailbox_connection_lookup_failed",
      metadata: {
        source: "inbound_email_webhook",
        fallback_used: true,
      },
    });
  }

  const mailboxOwnerProfileId = billedUserId;
  const includeSentMailForSummaries = Boolean(
    (mailboxConnectionResult.data as { include_sent_mail?: boolean | null } | null)?.include_sent_mail,
  );

  const policyState = await resolveCompanyPolicyState(supabase, workspaceId);

  if (policyState.errorCode) {
    await writeAuditFailure({
      supabase,
      context: auditContext,
      code: policyState.errorCode,
      metadata: {
        source: "inbound_email_webhook",
      },
    });

    return NextResponse.json({ error: "Inbound processing failed", code: policyState.errorCode }, { status: 500 });
  }

  if (policyState.featureEnabled === false) {
    await writeAuditFailure({
      supabase,
      context: auditContext,
      code: "feature_disabled_by_company_policy",
      metadata: {
        source: "inbound_email_webhook",
      },
    });

    return NextResponse.json(
      { ok: true, action: "discard", code: "feature_disabled_by_company_policy" },
      { status: 200 },
    );
  }

  const shouldDiscardByPrefilter = ["no-reply", "newsletter", "marketing"].some((needle) =>
    senderEmail.includes(needle),
  );

  if (shouldDiscardByPrefilter) {
    try {
      const discardInsert = await supabase.from("email_audit_logs").insert({
        workspace_id: workspaceId,
        mailbox_connection_id: mailboxConnectionId,
        provider,
        message_id_hash: messageIdHash,
        thread_id_hash: threadIdHash,
        processing_status: "discarded",
        triage_label: "discard",
        triage_reason_code: "deterministic_sender_prefilter",
        triage_confidence: 1,
        occurred_at: receivedAt,
        metadata: {
          sender_email_hash: senderEmailHash,
          subject_hint_hash: subjectHint ? sha256(subjectHint) : null,
          prefilter_terms: ["no-reply", "newsletter", "marketing"],
        } satisfies JsonRecord,
      });

      if (discardInsert.error && !isUniqueViolation(discardInsert.error)) {
        return NextResponse.json({ error: "Inbound processing failed", code: "audit_insert_failed" }, { status: 500 });
      }

      return NextResponse.json({ ok: true, action: "discard" }, { status: 200 });
    } catch {
      return NextResponse.json({ ok: true, action: "discard" }, { status: 200 });
    }
  }

  const { data: contactRows, error: contactError } = await supabase.rpc("find_contact_by_email", {
    p_workspace_id: workspaceId,
    p_email: senderEmail,
  });

  if (contactError) {
    await writeAuditFailure({
      supabase,
      context: auditContext,
      code: "contact_lookup_failed",
      metadata: {
        source: "inbound_email_webhook",
      },
    });

    return NextResponse.json({ error: "Inbound processing failed", code: "contact_lookup_failed" }, { status: 500 });
  }

  const contactIds = ((contactRows ?? []) as Array<{ id: string }>).map((row) => row.id);
  const primaryContactId = contactIds[0] ?? null;

  let contextRows: SummaryContextRow[] = [];

  if (contactIds.length > 0) {
    const contextQuery = await supabase
      .from("email_summaries")
      .select("summary_text, received_at")
      .eq("workspace_id", workspaceId)
      .in("contact_id", contactIds)
      .order("received_at", { ascending: false })
      .limit(3);

    if (contextQuery.error) {
      await writeAuditFailure({
        supabase,
        context: auditContext,
        contactId: primaryContactId,
        code: "context_lookup_failed",
        metadata: {
          source: "inbound_email_webhook",
          match_mode: "contact",
        },
      });

      return NextResponse.json({ error: "Inbound processing failed", code: "context_lookup_failed" }, { status: 500 });
    }

    contextRows = (contextQuery.data ?? []) as SummaryContextRow[];
  } else {
    const contextQuery = await supabase
      .from("email_summaries")
      .select("summary_text, received_at")
      .eq("workspace_id", workspaceId)
      .contains("metadata", { sender_email_hash: senderEmailHash })
      .order("received_at", { ascending: false })
      .limit(3);

    if (contextQuery.error) {
      await writeAuditFailure({
        supabase,
        context: auditContext,
        code: "context_lookup_failed",
        metadata: {
          source: "inbound_email_webhook",
          match_mode: "sender_hash",
        },
      });

      return NextResponse.json({ error: "Inbound processing failed", code: "context_lookup_failed" }, { status: 500 });
    }

    contextRows = (contextQuery.data ?? []) as SummaryContextRow[];
  }

  const modelSelection = await resolveInboundModelSettings(supabase, workspaceId);

  if (!modelSelection) {
    await writeAuditFailure({
      supabase,
      context: auditContext,
      contactId: primaryContactId,
      code: "config_missing_model_setting",
      metadata: {
        source: "inbound_email_webhook",
      },
    });

    return NextResponse.json(
      { error: "Configuration error: no active model setting found", code: "config_missing_model_setting" },
      { status: 503 },
    );
  }

  const modelValidation = validateModelConfiguration(modelSelection.provider, modelSelection.model);

  if (!modelValidation.ok) {
    await writeAuditFailure({
      supabase,
      context: auditContext,
      contactId: primaryContactId,
      code: modelValidation.code,
      metadata: {
        source: "inbound_email_webhook",
        model_provider: modelSelection.provider,
        model_name: modelSelection.model,
      },
    });

    return NextResponse.json({ error: modelValidation.message, code: modelValidation.code }, { status: 503 });
  }

  const contextBlock = contextRows
    .map((row, index) => `${index + 1}. [${new Date(row.received_at).toISOString()}] ${row.summary_text}`)
    .join("\n");

  const prompt = [
    "You are a CRM email triage assistant for a real-estate agency workspace.",
    "",
    "Return only structured output that follows the schema.",
    "Rules:",
    "- action=save_summary when the email contains business-relevant intent, updates, scheduling, negotiation, offers, or actionable client requests.",
    "- action=discard for low-value or non-actionable operational noise.",
    "- action=needs_review if confidence is low or intent is ambiguous.",
    "- confidence must be an integer between 0 and 100.",
    "- summary must be at most 3 sentences and concise.",
    "- reason should briefly justify the decision.",
    "",
    `Context summaries (latest first):\n${contextBlock || "No prior summaries."}`,
    "",
    `Current email sender: ${senderEmail}`,
    `Current email subject hint: ${subjectHint ?? "No subject provided"}`,
    "Current email body:",
    payload.body,
  ].join("\n");

  let triage: z.infer<typeof triageOutputSchema>;
  let newBalance: number | null = null;

  try {
    if (modelSelection.provider === "gemini") {
      triage = await generateGeminiTriageObject({
        model: modelSelection.model,
        prompt,
      });
    } else {
      const model = await resolveLanguageModel(modelSelection.provider, modelSelection.model);

      if (!model) {
        await writeAuditFailure({
          supabase,
          context: auditContext,
          contactId: primaryContactId,
          code: "config_provider_unavailable",
          metadata: {
            source: "inbound_email_webhook",
            model_provider: modelSelection.provider,
            model_name: modelSelection.model,
          },
        });

        return NextResponse.json(
          { error: "Configuration error: configured provider is unavailable", code: "config_provider_unavailable" },
          { status: 503 },
        );
      }

      const aiResult = await generateObject({
        model,
        schema: triageOutputSchema,
        prompt,
      });

      triage = aiResult.object;
    }
  } catch {
    await writeAuditFailure({
      supabase,
      context: auditContext,
      contactId: primaryContactId,
      code: "ai_generate_failed",
      metadata: {
        source: "inbound_email_webhook",
        model_provider: modelSelection.provider,
        model_name: modelSelection.model,
      },
    });

    return NextResponse.json({ error: "Inbound processing failed", code: "ai_generate_failed" }, { status: 502 });
  }

  const confidenceRatio = clamp01(triage.confidence / 100);
  const summaryText = normalizeSummaryToThreeSentences(triage.summary);

  const creditCheck = await supabase.rpc("get_workspace_credit_balance", {
    p_workspace_id: workspaceId,
  });

  if (!creditCheck.error) {
    const creditBalance = (creditCheck.data as { credit_balance?: number | null } | null)?.credit_balance ?? null;

    if (typeof creditBalance === "number" && creditBalance < TRIAGE_CREDIT_COST) {
      const billingError = `Insufficient credits: balance is ${creditBalance}, requires ${TRIAGE_CREDIT_COST}`;

      await writeAuditFailure({
        supabase,
        context: auditContext,
        contactId: primaryContactId,
        code: "credit_deduction_failed",
        metadata: {
          source: "inbound_email_webhook",
          billing_error: billingError,
        },
      });

      return NextResponse.json(
        { error: "Inbound processing failed", code: "credit_deduction_failed", billing_error: billingError },
        { status: 402 },
      );
    }
  }

  try {
    const triageCharge = await chargeWorkspaceCredit({
      supabase,
      workspaceId,
      billedUserId: mailboxOwnerProfileId,
      amount: TRIAGE_CREDIT_COST,
      action: "email_triage",
      idempotencyKey: `${messageIdHash}:triage`,
      metadata: {
        source: "inbound_email_webhook",
        sender_email: senderEmail,
        sender_email_hash: senderEmailHash,
        model_provider: modelSelection.provider,
        model_name: modelSelection.model,
      },
    });

    newBalance = typeof triageCharge.balance === "number" ? triageCharge.balance : null;
  } catch (error) {
    const billingError = error instanceof Error ? error.message : "Unknown billing error";

    await writeAuditFailure({
      supabase,
      context: auditContext,
      contactId: primaryContactId,
      code: "credit_deduction_failed",
      metadata: {
        source: "inbound_email_webhook",
        billing_error: billingError,
      },
    });

    return NextResponse.json(
      { error: "Inbound processing failed", code: "credit_deduction_failed", billing_error: billingError },
      { status: 402 },
    );
  }

  if (triage.action === "save_summary") {
    let summaryChargeBalance: number | null = null;
    const summaryChargeAmount =
      SUMMARY_CREDIT_COST + (includeSentMailForSummaries ? INCLUDE_SENT_SUMMARY_SURCHARGE : 0);

    try {
      const summaryCharge = await chargeWorkspaceCredit({
        supabase,
        workspaceId,
        billedUserId: mailboxOwnerProfileId,
        amount: summaryChargeAmount,
        action: "email_summary",
        idempotencyKey: `${messageIdHash}:summary`,
        metadata: {
          source: "inbound_email_webhook",
          sender_email: senderEmail,
          sender_email_hash: senderEmailHash,
          model_provider: modelSelection.provider,
          model_name: modelSelection.model,
          include_sent_mail_for_summaries: includeSentMailForSummaries,
          summary_charge_amount: summaryChargeAmount,
        },
      });

      summaryChargeBalance = typeof summaryCharge.balance === "number" ? summaryCharge.balance : null;
    } catch (error) {
      const billingError = error instanceof Error ? error.message : "Unknown billing error";

      await writeAuditFailure({
        supabase,
        context: auditContext,
        contactId: primaryContactId,
        code: "credit_deduction_failed",
        metadata: {
          source: "inbound_email_webhook",
          billing_error: billingError,
          triage_action: triage.action,
        },
      });

      return NextResponse.json(
        { error: "Inbound processing failed", code: "credit_deduction_failed", billing_error: billingError },
        { status: 402 },
      );
    }

    const summaryInsert = await supabase.from("email_summaries").insert({
      workspace_id: workspaceId,
      contact_id: primaryContactId,
      mailbox_connection_id: mailboxConnectionId,
      provider,
      message_id_hash: messageIdHash,
      thread_id_hash: threadIdHash,
      direction: "incoming",
      subject_hint: subjectHint,
      summary_text: summaryText,
      summary_language: "en",
      model_provider: modelSelection.provider,
      model_name: modelSelection.model,
      triage_reason_code: triage.reason,
      triage_confidence: confidenceRatio,
      received_at: receivedAt,
      metadata: {
        sender_email: senderEmail,
        sender_email_hash: senderEmailHash,
        source: "inbound_email_webhook",
        context_summary_count: contextRows.length,
      } satisfies JsonRecord,
    });

    if (summaryInsert.error && !isUniqueViolation(summaryInsert.error)) {
      await supabase.rpc("refund_workspace_credit", {
        p_workspace_id: workspaceId,
        p_amount: summaryChargeAmount,
        p_action: "email_summary_refund",
        p_idempotency_key: `${messageIdHash}:summary`,
        p_metadata: {
          source: "inbound_email_webhook",
          sender_email: senderEmail,
          sender_email_hash: senderEmailHash,
          model_provider: modelSelection.provider,
          model_name: modelSelection.model,
          include_sent_mail_for_summaries: includeSentMailForSummaries,
          summary_charge_amount: summaryChargeAmount,
          reason: "summary_insert_failed",
        },
      });

      await writeAuditFailure({
        supabase,
        context: auditContext,
        contactId: primaryContactId,
        code: "summary_insert_failed",
        metadata: {
          source: "inbound_email_webhook",
          model_provider: modelSelection.provider,
          model_name: modelSelection.model,
          triage_action: triage.action,
        },
      });

      return NextResponse.json({ error: "Inbound processing failed", code: "summary_insert_failed" }, { status: 500 });
    }

    if (typeof summaryChargeBalance === "number") {
      newBalance = summaryChargeBalance;
    }
  }

  const statusByAction: Record<z.infer<typeof triageOutputSchema>["action"], string> = {
    save_summary: "processed",
    discard: "discarded",
    needs_review: "processed",
  };

  try {
    const auditInsert = await supabase.from("email_audit_logs").insert({
      workspace_id: workspaceId,
      contact_id: primaryContactId,
      mailbox_connection_id: mailboxConnectionId,
      provider,
      message_id_hash: messageIdHash,
      thread_id_hash: threadIdHash,
      processing_status: statusByAction[triage.action],
      triage_label: triage.action,
      triage_reason_code: triage.reason,
      triage_confidence: confidenceRatio,
      occurred_at: receivedAt,
      metadata: {
        sender_email: senderEmail,
        sender_email_hash: senderEmailHash,
        model_provider: modelSelection.provider,
        model_name: modelSelection.model,
        matched_contact_count: contactIds.length,
      } satisfies JsonRecord,
    });

    if (auditInsert.error && !isUniqueViolation(auditInsert.error)) {
      return NextResponse.json({ error: "Inbound processing failed", code: "audit_insert_failed" }, { status: 500 });
    }
  } catch {
    // Intentionally swallow duplicate/idempotent webhook collisions.
  }

  return NextResponse.json(
    {
      ok: true,
      action: triage.action,
      confidence: triage.confidence,
      newBalance,
    },
    { status: 200 },
  );
}

function validateModelConfiguration(provider: AiProvider, model: string) {
  if (!model || model.trim().length === 0) {
    return {
      ok: false as const,
      code: "config_missing_model_name" as const,
      message: "Configuration error: model name is missing",
    };
  }

  const requiredKeyByProvider: Record<AiProvider, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    gemini: "GEMINI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    xai: "XAI_API_KEY",
  };

  const requiredEnvName = requiredKeyByProvider[provider];
  const apiKey = process.env[requiredEnvName]?.trim();

  if (!apiKey) {
    return {
      ok: false as const,
      code: "config_missing_api_key" as const,
      message: `Configuration error: missing ${requiredEnvName}`,
    };
  }

  return {
    ok: true as const,
  };
}

async function writeAuditFailure(options: {
  supabase: SupabaseClient;
  context: AuditContext;
  code: InboundErrorCode;
  contactId?: string | null;
  metadata?: JsonRecord;
}) {
  const insertResult = await options.supabase.from("email_audit_logs").insert({
    workspace_id: options.context.workspaceId,
    contact_id: options.contactId ?? null,
    mailbox_connection_id: options.context.mailboxConnectionId,
    provider: options.context.provider,
    message_id_hash: options.context.messageIdHash,
    thread_id_hash: options.context.threadIdHash,
    processing_status: "failed",
    triage_label: "needs_review",
    triage_reason_code: options.code,
    triage_confidence: null,
    occurred_at: options.context.occurredAt,
    metadata: {
      sender_email: options.context.senderEmail,
      sender_email_hash: options.context.senderEmailHash,
      error_code: options.code,
      ...(options.metadata ?? {}),
    } satisfies JsonRecord,
  });

  if (insertResult.error && !isUniqueViolation(insertResult.error)) {
    return;
  }
}

async function chargeWorkspaceCredit(options: {
  supabase: SupabaseClient;
  workspaceId: string;
  billedUserId: string;
  amount: number;
  action: string;
  idempotencyKey: string;
  metadata?: JsonRecord;
}) {
  const { data, error } = await options.supabase.rpc("deduct_workspace_credit", {
    p_workspace_id: options.workspaceId,
    p_amount: options.amount,
    p_action: options.action,
    p_idempotency_key: options.idempotencyKey,
    p_metadata: {
      ...(options.metadata ?? {}),
      billed_user_id: options.billedUserId,
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  const result = data as { balance?: number | null } | null;

  if (!result || typeof result.balance !== "number") {
    throw new Error("Credit deduction did not return a balance");
  }

  return result;
}

async function resolveLanguageModel(provider: AiProvider, model: string) {
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

    if (!apiKey) {
      return null;
    }

    const module = await safeImport("@ai-sdk/anthropic");

    if (!module || typeof module.createAnthropic !== "function") {
      return null;
    }

    const anthropic = module.createAnthropic({ apiKey });
    return anthropic(model);
  }

  if (provider === "mistral") {
    const apiKey = process.env.MISTRAL_API_KEY?.trim();

    if (!apiKey) {
      return null;
    }

    const module = await safeImport("@ai-sdk/mistral");

    if (!module || typeof module.createMistral !== "function") {
      return null;
    }

    const mistral = module.createMistral({ apiKey });
    return mistral(model);
  }

  if (provider === "xai") {
    const apiKey = process.env.XAI_API_KEY?.trim();

    if (!apiKey) {
      return null;
    }

    const module = await safeImport("@ai-sdk/xai");

    if (!module || typeof module.createXai !== "function") {
      return null;
    }

    const xai = module.createXai({ apiKey });
    return xai(model);
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    return null;
  }

  const module = await safeImport("@ai-sdk/google");

  if (!module || typeof module.createGoogleGenerativeAI !== "function") {
    return null;
  }

  const google = module.createGoogleGenerativeAI({ apiKey });
  return google(model);
}

async function safeImport(moduleId: string) {
  try {
    return await import(moduleId);
  } catch {
    return null;
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}

async function generateGeminiTriageObject(options: { model: string; prompt: string }) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing");
  }

  const apiBaseUrl = (process.env.GEMINI_API_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const endpoint = `${apiBaseUrl}/models/${encodeURIComponent(options.model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: options.prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const details = await safeReadJson(response);
    throw new Error(`Gemini triage request failed (${response.status}): ${JSON.stringify(details)}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const rawText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";

  if (!rawText) {
    throw new Error("Gemini triage returned an empty response");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Gemini triage returned invalid JSON: ${rawText.slice(0, 500)}`);
  }

  return triageOutputSchema.parse(parsed);
}

async function resolveInboundModelSettings(supabase: SupabaseClient, workspaceId: string) {
  const actionTypes = ["email_summary", "email_triage"];

  for (const actionType of actionTypes) {
    const workspaceRow = await getAiModelSettingRow(supabase, actionType, workspaceId);

    if (workspaceRow) {
      const resolved = resolveProviderAndModel(workspaceRow);

      if (resolved) {
        return resolved;
      }
    }

    const globalRow = await getAiModelSettingRow(supabase, actionType, null);

    if (globalRow) {
      const resolved = resolveProviderAndModel(globalRow);

      if (resolved) {
        return resolved;
      }
    }
  }

  const fallbackModel = process.env.INBOUND_EMAIL_MODEL?.trim() || "gemini-2.0-flash";
  const fallbackProvider = normalizeProvider(process.env.INBOUND_EMAIL_PROVIDER);

  return {
    provider: fallbackProvider,
    model: fallbackModel,
  };
}

async function resolveCompanyPolicyState(supabase: SupabaseClient, workspaceId: string): Promise<{
  featureEnabled: boolean | null;
  errorCode: InboundErrorCode | null;
}> {
  const workspaceResult = await supabase
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .maybeSingle();

  if (workspaceResult.error) {
    return {
      featureEnabled: null,
      errorCode: null,
    };
  }

  const companyId = (workspaceResult.data as { company_id?: string | null } | null)?.company_id ?? null;

  if (!companyId) {
    return {
      featureEnabled: null,
      errorCode: null,
    };
  }

  const policyResult = await supabase
    .from("email_ingestion_policies")
    .select("feature_enabled")
    .eq("company_id", companyId)
    .maybeSingle();

  if (policyResult.error) {
    return {
      featureEnabled: null,
      errorCode: null,
    };
  }

  return {
    featureEnabled: (policyResult.data as { feature_enabled?: boolean } | null)?.feature_enabled ?? null,
    errorCode: null,
  };
}

async function getAiModelSettingRow(supabase: SupabaseClient, actionType: string, workspaceId: string | null) {
  let query = supabase
    .from("ai_model_settings")
    .select("action_type, provider, model, text_provider, text_model")
    .eq("is_active", true)
    .eq("action_type", actionType)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);

  query = workspaceId ? query.eq("workspace_id", workspaceId) : query.is("workspace_id", null);

  const { data, error } = await query.maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as ModelSettingRow;
}

function resolveProviderAndModel(row: ModelSettingRow) {
  const provider = normalizeProvider(row.text_provider ?? row.provider ?? undefined);
  const model = firstNonEmpty(row.text_model, row.model);

  if (!model) {
    return null;
  }

  return {
    provider,
    model,
  };
}

function normalizeProvider(value: string | undefined): AiProvider {
  const normalized = value?.trim().toLowerCase();

  if (normalized === "anthropic" || normalized === "gemini" || normalized === "mistral" || normalized === "xai") {
    return normalized;
  }

  return "gemini";
}

function firstNonEmpty(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return null;
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

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";

  return code === "23505" || message.toLowerCase().includes("duplicate key");
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clamp01(value: number) {
  if (Number.isNaN(value)) {
    return 0;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return Number(value.toFixed(4));
}

function normalizeSummaryToThreeSentences(summary: string) {
  const cleaned = summary.replace(/\s+/g, " ").trim();

  if (!cleaned) {
    return "No summary generated.";
  }

  const chunks = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [cleaned];
  const topThree = chunks.slice(0, 3).map((chunk) => chunk.trim());

  return topThree.join(" ");
}
