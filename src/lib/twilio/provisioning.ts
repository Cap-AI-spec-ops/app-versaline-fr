import "server-only";

import { getMasterCredentials, twilioApiRequest } from "@/lib/twilio/client";

type NumberType = "local" | "mobile" | "tollfree";

type TwilioNumberCapabilities = {
  sms: boolean;
  mms: boolean;
  voice: boolean;
};

type AvailableNumber = {
  phone_number: string;
  friendly_name: string | null;
  capabilities: TwilioNumberCapabilities | null;
};

type TwilioAvailablePhoneNumber = {
  phone_number?: string;
  friendly_name?: string;
  capabilities?: { sms?: boolean; mms?: boolean; voice?: boolean };
};

export type AvailableNumberSearchResult = {
  candidate: AvailableNumber | null;
  diagnostics: string[];
  attemptedTypes: NumberType[];
};

export async function createManagedSubaccount(options: {
  workspaceName: string;
  workspaceId: string;
}): Promise<{ sid: string; friendlyName: string }> {
  const master = getMasterCredentials();

  if (!master) {
    throw new Error("Twilio credentials are not configured");
  }

  const friendlyName = `Versaline ${sanitizeLabel(options.workspaceName)} ${options.workspaceId.slice(0, 8)}`;

  const response = await twilioApiRequest({
    accountSid: master.accountSid,
    authToken: master.authToken,
    path: "Accounts.json",
    accountScoped: false,
    method: "POST",
    body: {
      FriendlyName: friendlyName,
      Status: "active",
    },
  });

  const payload = (await response.json()) as { sid?: string; message?: string };

  if (!response.ok || !payload.sid) {
    throw new Error(payload.message || `Twilio subaccount creation failed (${response.status})`);
  }

  return {
    sid: payload.sid,
    friendlyName,
  };
}

export async function findAvailableNumber(options: {
  countryCode: string;
  requireSms: boolean;
  requireVoice: boolean;
  preferredType: NumberType;
}): Promise<AvailableNumberSearchResult> {
  const master = getMasterCredentials();

  if (!master) {
    throw new Error("Twilio credentials are not configured");
  }

  const countryCode = options.countryCode.trim().toUpperCase();
  const order = buildNumberTypeOrder(options.preferredType);
  const diagnostics: string[] = [];
  const attemptedTypes: NumberType[] = [];

  for (const numberType of order) {
    attemptedTypes.push(numberType);
    const endpointType = numberTypeToEndpointSegment(numberType);
    const query = new URLSearchParams({
      SmsEnabled: String(options.requireSms),
      VoiceEnabled: String(options.requireVoice),
      ExcludeAllAddressRequired: "true",
      Limit: "20",
    });

    const response = await twilioApiRequest({
      accountSid: master.accountSid,
      authToken: master.authToken,
      path: `AvailablePhoneNumbers/${countryCode}/${endpointType}.json?${query.toString()}`,
      method: "GET",
    });

    if (!response.ok) {
      const payloadText = await response.text();
      const parsedError = parseTwilioError(payloadText);

      if (response.status === 404 && parsedError.code === "20404") {
        diagnostics.push(`${numberType}: unsupported in ${countryCode}`);
      } else {
        const detail = formatTwilioError(parsedError, payloadText);
        diagnostics.push(`${numberType}: ${response.status}${detail ? ` (${detail})` : ""}`);
      }
      continue;
    }

    const payload = (await response.json()) as { available_phone_numbers?: TwilioAvailablePhoneNumber[] };
    const candidate = pickCandidate(payload.available_phone_numbers ?? [], options.requireSms, options.requireVoice);

    if (candidate?.phone_number) {
      return {
        candidate: {
          phone_number: candidate.phone_number,
          friendly_name: candidate.friendly_name ?? null,
          capabilities: candidate.capabilities
            ? {
                sms: Boolean(candidate.capabilities.sms),
                mms: Boolean(candidate.capabilities.mms),
                voice: Boolean(candidate.capabilities.voice),
              }
            : null,
        },
        diagnostics,
        attemptedTypes,
      };
    }

    diagnostics.push(`${numberType}: no matching numbers found`);
  }

  const addressRequiredCandidate = await findAddressRequiredCandidate({
    accountSid: master.accountSid,
    authToken: master.authToken,
    countryCode,
    order,
    requireSms: options.requireSms,
    requireVoice: options.requireVoice,
  });

  if (addressRequiredCandidate) {
    diagnostics.push("matching numbers exist but require regulatory address/bundle in Twilio for this country");
  }

  return {
    candidate: null,
    diagnostics,
    attemptedTypes,
  };
}

export async function purchaseWorkspaceNumber(options: {
  subaccountSid: string;
  phoneNumber: string;
  friendlyName?: string | null;
  smsUrl: string;
  voiceUrl: string;
  statusCallbackUrl: string;
}): Promise<{
  sid: string;
  phoneNumber: string;
  friendlyName: string | null;
  capabilities: { sms: boolean; mms: boolean; voice: boolean; whatsapp: boolean };
}> {
  const master = getMasterCredentials();

  if (!master) {
    throw new Error("Twilio credentials are not configured");
  }

  const response = await twilioApiRequest({
    accountSid: options.subaccountSid,
    authToken: master.authToken,
    path: "IncomingPhoneNumbers.json",
    method: "POST",
    body: {
      PhoneNumber: options.phoneNumber,
      FriendlyName: options.friendlyName?.trim() || "Versaline workspace number",
      SmsUrl: options.smsUrl,
      SmsMethod: "POST",
      VoiceUrl: options.voiceUrl,
      VoiceMethod: "POST",
      StatusCallback: options.statusCallbackUrl,
      StatusCallbackMethod: "POST",
    },
  });

  const payload = (await response.json()) as {
    sid?: string;
    phone_number?: string;
    friendly_name?: string;
    capabilities?: { sms?: boolean; mms?: boolean; voice?: boolean };
    message?: string;
  };

  if (!response.ok || !payload.sid || !payload.phone_number) {
    throw new Error(payload.message || `Twilio number purchase failed (${response.status})`);
  }

  return {
    sid: payload.sid,
    phoneNumber: payload.phone_number,
    friendlyName: payload.friendly_name ?? null,
    capabilities: {
      sms: Boolean(payload.capabilities?.sms),
      mms: Boolean(payload.capabilities?.mms),
      voice: Boolean(payload.capabilities?.voice),
      whatsapp: false,
    },
  };
}

export async function configureWorkspaceNumberWebhooks(options: {
  subaccountSid: string;
  phoneNumberSid: string;
  smsUrl: string;
  voiceUrl: string;
  statusCallbackUrl: string;
}) {
  const master = getMasterCredentials();

  if (!master) {
    throw new Error("Twilio credentials are not configured");
  }

  const response = await twilioApiRequest({
    accountSid: options.subaccountSid,
    authToken: master.authToken,
    path: `IncomingPhoneNumbers/${encodeURIComponent(options.phoneNumberSid)}.json`,
    method: "POST",
    body: {
      SmsUrl: options.smsUrl,
      SmsMethod: "POST",
      VoiceUrl: options.voiceUrl,
      VoiceMethod: "POST",
      StatusCallback: options.statusCallbackUrl,
      StatusCallbackMethod: "POST",
    },
  });

  if (!response.ok) {
    const payload = await response.text();
    throw new Error(`Twilio webhook configuration failed (${response.status}): ${payload}`);
  }
}

function buildNumberTypeOrder(preferred: NumberType): NumberType[] {
  const sequence: NumberType[] = [preferred, "local", "mobile", "tollfree"];
  return Array.from(new Set(sequence));
}

function numberTypeToEndpointSegment(numberType: NumberType) {
  if (numberType === "mobile") return "Mobile";
  if (numberType === "tollfree") return "TollFree";
  return "Local";
}

function sanitizeLabel(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Workspace";
  }

  return trimmed.replace(/\s+/g, " ").slice(0, 48);
}

async function findAddressRequiredCandidate(options: {
  accountSid: string;
  authToken: string;
  countryCode: string;
  order: NumberType[];
  requireSms: boolean;
  requireVoice: boolean;
}): Promise<AvailableNumber | null> {
  for (const numberType of options.order) {
    const endpointType = numberTypeToEndpointSegment(numberType);
    const query = new URLSearchParams({
      SmsEnabled: String(options.requireSms),
      VoiceEnabled: String(options.requireVoice),
      Limit: "20",
    });

    const response = await twilioApiRequest({
      accountSid: options.accountSid,
      authToken: options.authToken,
      path: `AvailablePhoneNumbers/${options.countryCode}/${endpointType}.json?${query.toString()}`,
      method: "GET",
    });

    if (!response.ok) {
      continue;
    }

    const payload = (await response.json()) as { available_phone_numbers?: TwilioAvailablePhoneNumber[] };
    const candidate = pickCandidate(payload.available_phone_numbers ?? [], options.requireSms, options.requireVoice);

    if (candidate) {
      const phoneNumber = candidate.phone_number?.trim();
      if (!phoneNumber) {
        continue;
      }

      return {
        phone_number: phoneNumber,
        friendly_name: candidate.friendly_name ?? null,
        capabilities: candidate.capabilities
          ? {
              sms: Boolean(candidate.capabilities.sms),
              mms: Boolean(candidate.capabilities.mms),
              voice: Boolean(candidate.capabilities.voice),
            }
          : null,
      };
    }
  }

  return null;
}

function pickCandidate(
  numbers: TwilioAvailablePhoneNumber[],
  requireSms: boolean,
  requireVoice: boolean,
): TwilioAvailablePhoneNumber | null {
  return numbers.find((item) => {
    if (!item.phone_number) return false;
    const caps = item.capabilities;
    if (requireSms && !caps?.sms) return false;
    if (requireVoice && !caps?.voice) return false;
    return true;
  }) ?? null;
}

function parseTwilioError(payloadText: string): { code: string | null; message: string | null } {
  if (!payloadText) {
    return { code: null, message: null };
  }

  try {
    const payload = JSON.parse(payloadText) as { message?: unknown; code?: unknown };
    const code = typeof payload.code === "number" || typeof payload.code === "string" ? String(payload.code) : null;
    const message = typeof payload.message === "string" ? payload.message.trim() : null;
    return { code, message };
  } catch {
    return { code: null, message: null };
  }
}

function formatTwilioError(parsed: { code: string | null; message: string | null }, payloadText: string): string {
  if (parsed.code && parsed.message) {
    return `${parsed.code}: ${parsed.message}`;
  }

  if (parsed.message) {
    return parsed.message;
  }

  return payloadText.trim().slice(0, 220);
}
