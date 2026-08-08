import "server-only";

import { getMasterCredentials, getSubaccountContext } from "@/lib/twilio/client";

export type WhatsAppVerificationMethod = "sms" | "voice";

export type WhatsAppSenderStatus =
  | "CREATING"
  | "ONLINE"
  | "OFFLINE"
  | "PENDING_VERIFICATION"
  | "VERIFYING"
  | "ONLINE:UPDATING"
  | "TWILIO_REVIEW"
  | "DRAFT"
  | "STUBBED";

export type WhatsAppSenderRecord = {
  sid: string;
  status: WhatsAppSenderStatus;
  sender_id: string;
  configuration?: {
    verification_method?: WhatsAppVerificationMethod | null;
    verification_code?: string | null;
    waba_id?: string | null;
    account_type?: "ISV" | "ISVSubAccount" | null;
  } | null;
  offline_reasons?: unknown;
  properties?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
  webhook?: Record<string, unknown> | null;
  url?: string;
};

function buildMessagingApiUrl(path: string) {
  return `https://messaging.twilio.com/v2/${path.replace(/^\//, "")}`;
}

async function twilioMessagingApiRequest(options: {
  subaccountSid: string;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  body?: Record<string, unknown>;
}) {
  const context = getSubaccountContext(options.subaccountSid);
  const master = getMasterCredentials();

  if (!context || !master) {
    throw new Error("Twilio credentials are not configured");
  }

  const credentials = Buffer.from(`${context.accountSid}:${context.authToken}`).toString("base64");
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
    },
  };

  if (options.method === "POST") {
    init.headers = {
      ...init.headers,
      "Content-Type": "application/json",
    };
    init.body = JSON.stringify(options.body ?? {});
  }

  return fetch(buildMessagingApiUrl(options.path), init);
}

async function parseTwilioSenderResponse(response: Response): Promise<WhatsAppSenderRecord> {
  const payload = (await response.json()) as Partial<WhatsAppSenderRecord> & {
    message?: string;
    code?: number | string;
    details?: string;
  };

  if (!response.ok || !payload.sid || !payload.status || !payload.sender_id) {
    const detail = payload.message || payload.details || `Twilio WhatsApp request failed (${response.status})`;
    throw new Error(detail);
  }

  return {
    sid: payload.sid,
    status: payload.status,
    sender_id: payload.sender_id,
    configuration: payload.configuration ?? null,
    offline_reasons: payload.offline_reasons,
    properties: payload.properties ?? null,
    profile: payload.profile ?? null,
    webhook: payload.webhook ?? null,
    url: payload.url,
  };
}

export function isWhatsAppSenderOnline(status: string | null | undefined) {
  return status === "ONLINE" || status === "ONLINE:UPDATING";
}

export async function createWhatsAppSender(options: {
  subaccountSid: string;
  phoneNumber: string;
  verificationMethod: WhatsAppVerificationMethod;
}) {
  const response = await twilioMessagingApiRequest({
    subaccountSid: options.subaccountSid,
    path: "Channels/Senders",
    method: "POST",
    body: {
      sender_id: `whatsapp:${options.phoneNumber}`,
      configuration: {
        verification_method: options.verificationMethod,
        account_type: "ISVSubAccount",
      },
    },
  });

  return parseTwilioSenderResponse(response);
}

export async function fetchWhatsAppSender(options: {
  subaccountSid: string;
  senderSid: string;
}) {
  const response = await twilioMessagingApiRequest({
    subaccountSid: options.subaccountSid,
    path: `Channels/Senders/${encodeURIComponent(options.senderSid)}`,
    method: "GET",
  });

  return parseTwilioSenderResponse(response);
}

export async function verifyWhatsAppSender(options: {
  subaccountSid: string;
  senderSid: string;
  verificationCode: string;
  verificationMethod?: WhatsAppVerificationMethod | null;
}) {
  const response = await twilioMessagingApiRequest({
    subaccountSid: options.subaccountSid,
    path: `Channels/Senders/${encodeURIComponent(options.senderSid)}`,
    method: "POST",
    body: {
      configuration: {
        verification_method: options.verificationMethod ?? "sms",
        verification_code: options.verificationCode.trim(),
        account_type: "ISVSubAccount",
      },
    },
  });

  return parseTwilioSenderResponse(response);
}