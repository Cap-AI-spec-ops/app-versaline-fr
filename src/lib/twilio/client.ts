import "server-only";

import crypto from "node:crypto";

export type TwilioChannel = "sms" | "whatsapp" | "voice";
export type TwilioDirection = "inbound" | "outbound";

export type TwilioSubaccountContext = {
  accountSid: string;
  authToken: string;
};

// Master credentials are platform-wide; subaccount SID comes from the DB per workspace.
export function getMasterCredentials(): { accountSid: string; authToken: string } | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();

  if (!accountSid || !authToken) {
    return null;
  }

  return { accountSid, authToken };
}

// Twilio allows the master account to act on behalf of a subaccount by passing
// the subaccount SID as the account parameter while authenticating with master credentials.
export function getSubaccountContext(subaccountSid: string): TwilioSubaccountContext | null {
  const master = getMasterCredentials();

  if (!master) {
    return null;
  }

  return {
    accountSid: subaccountSid,
    authToken: master.authToken,
  };
}

// Validate that an inbound webhook request genuinely came from Twilio.
// Twilio signs each request using HMAC-SHA1 with the master auth token.
export function validateTwilioSignature(options: {
  authToken: string;
  twilioSignature: string;
  url: string;
  params: Record<string, string>;
}): boolean {
  const sortedKeys = Object.keys(options.params).sort();
  const paramString = sortedKeys.map((key) => `${key}${options.params[key]}`).join("");
  const data = options.url + paramString;
  const expected = crypto.createHmac("sha1", options.authToken).update(data, "utf8").digest("base64");

  return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(options.twilioSignature, "utf8"));
}

// Normalize any phone number to E.164 format for consistent contact matching.
export function normalizePhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");

  if (raw.startsWith("+")) {
    return `+${digits}`;
  }

  // Default to France (+33) if no country code prefix present.
  if (digits.startsWith("0") && digits.length === 10) {
    return `+33${digits.slice(1)}`;
  }

  return `+${digits}`;
}

// Strip WhatsApp URI prefix that Twilio prepends to WhatsApp sender/recipient numbers.
export function stripWhatsAppPrefix(value: string): string {
  return value.startsWith("whatsapp:") ? value.slice("whatsapp:".length) : value;
}

export function hashPhoneNumber(phone: string): string {
  return crypto.createHash("sha256").update(phone.trim().toLowerCase()).digest("hex");
}

// Detect channel from Twilio's `To` or `From` fields.
export function detectChannel(to: string, from: string): TwilioChannel {
  if (to.startsWith("whatsapp:") || from.startsWith("whatsapp:")) {
    return "whatsapp";
  }

  return "sms";
}

// Build the Twilio REST API base URL for a given account SID.
export function buildApiUrl(accountSid: string, path: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/${path.replace(/^\//, "")}`;
}

// Build a Twilio REST API URL that is not scoped under /Accounts/{SID}.
export function buildRootApiUrl(path: string): string {
  return `https://api.twilio.com/2010-04-01/${path.replace(/^\//, "")}`;
}

type TwilioApiRequestOptions = {
  accountSid: string;
  authToken: string;
  path: string;
  accountScoped?: boolean;
  method?: "GET" | "POST";
  body?: Record<string, string>;
};

export async function twilioApiRequest(options: TwilioApiRequestOptions): Promise<Response> {
  const url = options.accountScoped === false
    ? buildRootApiUrl(options.path)
    : buildApiUrl(options.accountSid, options.path);
  const credentials = Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64");

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
  };

  if (options.method === "POST" && options.body) {
    init.body = new URLSearchParams(options.body).toString();
  }

  return fetch(url, init);
}

// Send an SMS using the master account credentials on behalf of a workspace subaccount.
export async function sendSms(options: {
  subaccountSid: string;
  from: string;
  to: string;
  body: string;
}): Promise<{ sid: string; status: string }> {
  const master = getMasterCredentials();

  if (!master) {
    throw new Error("TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not configured");
  }

  const response = await twilioApiRequest({
    accountSid: options.subaccountSid,
    authToken: master.authToken,
    path: "Messages.json",
    method: "POST",
    body: {
      From: options.from,
      To: options.to,
      Body: options.body,
    },
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Twilio SMS send failed (${response.status}): ${payload}`);
  }

  const payload = (await response.json()) as { sid?: string; status?: string };

  if (!payload.sid) {
    throw new Error("Twilio SMS response did not include a SID");
  }

  return { sid: payload.sid, status: payload.status ?? "unknown" };
}

// Initiate an outbound call using the master account credentials.
export async function initiateCall(options: {
  subaccountSid: string;
  from: string;
  to: string;
  twimlUrl: string;
}): Promise<{ sid: string; status: string }> {
  const master = getMasterCredentials();

  if (!master) {
    throw new Error("TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is not configured");
  }

  const response = await twilioApiRequest({
    accountSid: options.subaccountSid,
    authToken: master.authToken,
    path: "Calls.json",
    method: "POST",
    body: {
      From: options.from,
      To: options.to,
      Url: options.twimlUrl,
    },
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Twilio call initiation failed (${response.status}): ${payload}`);
  }

  const payload = (await response.json()) as { sid?: string; status?: string };

  if (!payload.sid) {
    throw new Error("Twilio call response did not include a SID");
  }

  return { sid: payload.sid, status: payload.status ?? "unknown" };
}
