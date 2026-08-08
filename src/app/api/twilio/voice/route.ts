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
  twilio_account_id: string;
};

type TwilioAccountRow = {
  forwarding_number: string | null;
};

type CompanyPolicyRow = {
  twilio_enabled: boolean | null;
  twilio_recording_consent_required: boolean | null;
};

function twiml(xml: string) {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function POST(request: NextRequest) {
  const master = getMasterCredentials();

  if (!master) {
    return twiml("<Hangup/>");
  }

  const formData = await request.formData();
  const params = Object.fromEntries(formData.entries()) as Record<string, string>;

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
  const webhookUrl = `${siteUrl}/api/twilio/voice`;
  const twilioSignature = request.headers.get("X-Twilio-Signature") ?? "";

  if (!validateTwilioSignature({ authToken: master.authToken, twilioSignature, url: webhookUrl, params })) {
    return twiml("<Hangup/>");
  }

  const callSid = (params.CallSid ?? "").trim();
  const rawTo = (params.To ?? "").trim();
  const rawFrom = (params.From ?? "").trim();

  if (!callSid || !rawTo || !rawFrom) {
    return twiml("<Hangup/>");
  }

  const toNormalized = normalizePhoneNumber(rawTo);

  const supabase = getSupabaseAdminClient();

  if (!supabase) {
    return twiml("<Hangup/>");
  }

  const { data: numberRow } = await supabase
    .from("workspace_twilio_numbers")
    .select("id, workspace_id, twilio_account_id")
    .eq("phone_number", toNormalized)
    .eq("status", "active")
    .maybeSingle<WorkspaceNumberRow>();

  if (!numberRow) {
    return twiml("<Hangup/>");
  }

  const { workspace_id: workspaceId, id: twilioNumberId, twilio_account_id: twilioAccountId } = numberRow;

  const { data: accountRow } = await supabase
    .from("workspace_twilio_accounts")
    .select("forwarding_number")
    .eq("id", twilioAccountId)
    .maybeSingle<TwilioAccountRow>();

  const forwardingNumber = accountRow?.forwarding_number?.trim() || null;

  const policy = await resolveTwilioCallPolicy(supabase, workspaceId);

  if (!policy.twilio_enabled) {
    return twiml("<Hangup/>");
  }

  const consentActionBase = `${siteUrl}/api/twilio/voice-consent`;
  const consentUrl = forwardingNumber
    ? `${consentActionBase}?fwd=${encodeURIComponent(forwardingNumber)}`
    : consentActionBase;
  const statusCallbackUrl = `${siteUrl}/api/twilio/voice-status`;

  if (policy.twilio_recording_consent_required) {
    // French legal requirement: explicit consent before recording.
    return twiml(
      `<Gather numDigits="1" action="${consentUrl}" method="POST" timeout="10">` +
        `<Say language="fr-FR">Bonjour. Cet appel pourrait être enregistré à des fins professionnelles. ` +
        `Appuyez sur 1 pour accepter l'enregistrement, ou sur 2 pour continuer sans enregistrement.</Say>` +
      `</Gather>` +
      `<Say language="fr-FR">Nous n'avons pas reçu votre réponse. Au revoir.</Say>` +
      `<Hangup/>`,
    );
  }

  // Consent not required: go straight to recording with status callback.
  return twiml(
    `<Say language="fr-FR">Veuillez laisser votre message après le bip. Appuyez sur dièse lorsque vous avez terminé.</Say>` +
    `<Record playBeep="true" timeout="30" maxLength="300" transcribe="true" transcribeCallback="${siteUrl}/api/twilio/voice-transcript" action="${statusCallbackUrl}" finishOnKey="#"/>` +
    `<Say language="fr-FR">Merci. Au revoir.</Say>` +
    `<Hangup/>`,
  );
}

async function resolveTwilioCallPolicy(supabase: ReturnType<typeof createClient>, workspaceId: string) {
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("company_id")
    .eq("id", workspaceId)
    .maybeSingle<{ company_id: string | null }>();

  if (!workspace?.company_id) {
    return { twilio_enabled: false, twilio_recording_consent_required: true };
  }

  const { data: policy } = await supabase
    .from("email_ingestion_policies")
    .select("twilio_enabled, twilio_recording_consent_required")
    .eq("company_id", workspace.company_id)
    .maybeSingle<CompanyPolicyRow>();

  return {
    twilio_enabled: policy?.twilio_enabled ?? false,
    twilio_recording_consent_required: policy?.twilio_recording_consent_required ?? true,
  };
}

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
