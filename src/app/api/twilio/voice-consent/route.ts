import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { getMasterCredentials, validateTwilioSignature } from "@/lib/twilio/client";

export const runtime = "nodejs";

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
  const webhookUrl = `${siteUrl}/api/twilio/voice-consent`;
  const twilioSignature = request.headers.get("X-Twilio-Signature") ?? "";

  if (!validateTwilioSignature({ authToken: master.authToken, twilioSignature, url: webhookUrl, params })) {
    return twiml("<Hangup/>");
  }

  const digits = (params.Digits ?? "").trim();
  const statusCallbackUrl = `${siteUrl}/api/twilio/voice-status`;
  const transcriptCallbackUrl = `${siteUrl}/api/twilio/voice-transcript`;
  // forwarding_number passed as query param from /api/twilio/voice
  const forwardingNumber = new URL(request.url).searchParams.get("fwd")?.trim() || null;

  if (digits === "1") {
    if (forwardingNumber) {
      // Live call: dial through to agent's phone with dual-channel recording.
      return twiml(
        `<Say language="fr-FR">Merci. Connexion en cours.</Say>` +
        `<Dial record="record-from-ringing-dual" recordingStatusCallback="${statusCallbackUrl}" recordingStatusCallbackMethod="POST" action="${statusCallbackUrl}">` +
          `<Number statusCallback="${statusCallbackUrl}" statusCallbackMethod="POST">${forwardingNumber}</Number>` +
        `</Dial>`,
      );
    }

    // No forwarding number: voicemail recording with transcription.
    return twiml(
      `<Say language="fr-FR">Merci. Veuillez laisser votre message après le bip. Appuyez sur dièse lorsque vous avez terminé.</Say>` +
      `<Record playBeep="true" timeout="30" maxLength="300" recordingStatusCallback="${statusCallbackUrl}" transcribe="true" transcribeCallback="${transcriptCallbackUrl}" finishOnKey="#"/>` +
      `<Say language="fr-FR">Message enregistré. Merci. Au revoir.</Say>` +
      `<Hangup/>`,
    );
  }

  // No consent: voicemail without transcription.
  return twiml(
    `<Say language="fr-FR">Enregistrement refusé. Veuillez laisser votre message après le bip. Appuyez sur dièse lorsque vous avez terminé.</Say>` +
    `<Record playBeep="true" timeout="30" maxLength="300" recordingStatusCallback="${statusCallbackUrl}" finishOnKey="#"/>` +
    `<Say language="fr-FR">Message reçu. Merci. Au revoir.</Say>` +
    `<Hangup/>`,
  );
}
