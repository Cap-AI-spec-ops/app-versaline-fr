import "server-only";

import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  createWhatsAppSender,
  fetchWhatsAppSender,
  isWhatsAppSenderOnline,
  verifyWhatsAppSender,
  type WhatsAppSenderRecord,
  type WhatsAppVerificationMethod,
} from "@/lib/twilio/whatsapp";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type WorkspaceRole = "agent" | "team_lead" | "owner" | "super_admin";

const bodySchema = z.object({
  workspaceId: z.string().uuid(),
  action: z.enum(["create", "refresh", "verify"]),
  verificationMethod: z.enum(["sms", "voice"]).optional(),
  verificationCode: z.string().trim().min(3).max(12).optional(),
});

type CurrentProfile = {
  workspace_id?: string | null;
  role?: WorkspaceRole | null;
};

type WorkspaceRow = {
  id: string;
  company_id: string | null;
};

type CompanyPolicyRow = {
  twilio_control: "owner_locked" | "team_lead_select" | null;
};

type AccountRow = {
  id: string;
  subaccount_sid: string;
};

type NumberRow = {
  id: string;
  phone_number: string;
};

type SenderRow = {
  id: string;
  sender_sid: string;
  sender_id: string;
  status: string;
  verification_method: WhatsAppVerificationMethod | null;
};

export const runtime = "nodejs";

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
  const profile = (profileData as CurrentProfile | null) ?? null;

  if (!profile?.workspace_id || profile.workspace_id !== body.workspaceId) {
    return NextResponse.json({ error: "Workspace mismatch" }, { status: 403 });
  }

  const { data: effectiveEnabled } = await supabase.rpc("get_effective_workspace_twilio_enabled", {
    p_workspace_id: body.workspaceId,
  });

  if (!effectiveEnabled) {
    return NextResponse.json({ error: "Twilio is disabled by company policy for this workspace" }, { status: 403 });
  }

  const adminClient = getSupabaseAdminClient();

  if (!adminClient) {
    return NextResponse.json({ error: "Service client unavailable" }, { status: 500 });
  }

  const { data: workspace } = await adminClient
    .from("workspaces")
    .select("id, company_id")
    .eq("id", body.workspaceId)
    .maybeSingle<WorkspaceRow>();

  if (!workspace?.company_id) {
    return NextResponse.json({ error: "Workspace company scope not found" }, { status: 422 });
  }

  const { data: policyRow } = await adminClient
    .from("email_ingestion_policies")
    .select("twilio_control")
    .eq("company_id", workspace.company_id)
    .maybeSingle<CompanyPolicyRow>();

  const isOwner = profile.role === "owner";
  const isDelegatedTeamLead = profile.role === "team_lead" && policyRow?.twilio_control === "team_lead_select";

  if (!isOwner && !isDelegatedTeamLead) {
    return NextResponse.json(
      {
        error: "Only owners can manage WhatsApp setup. Team leads need owner delegation in policy.",
      },
      { status: 403 },
    );
  }

  const { data: accountRow } = await adminClient
    .from("workspace_twilio_accounts")
    .select("id, subaccount_sid")
    .eq("workspace_id", body.workspaceId)
    .maybeSingle<AccountRow>();

  const { data: numberRow } = await adminClient
    .from("workspace_twilio_numbers")
    .select("id, phone_number")
    .eq("workspace_id", body.workspaceId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<NumberRow>();

  if (!accountRow?.subaccount_sid || !numberRow?.id) {
    return NextResponse.json(
      { error: "Provision an active SMS/calls number before starting WhatsApp activation." },
      { status: 422 },
    );
  }

  const { data: senderRow } = await adminClient
    .from("workspace_twilio_whatsapp_senders")
    .select("id, sender_sid, sender_id, status, verification_method")
    .eq("workspace_id", body.workspaceId)
    .eq("twilio_number_id", numberRow.id)
    .maybeSingle<SenderRow>();

  try {
    let sender: WhatsAppSenderRecord;

    if (body.action === "create") {
      if (senderRow?.sender_sid) {
        sender = await fetchWhatsAppSender({
          subaccountSid: accountRow.subaccount_sid,
          senderSid: senderRow.sender_sid,
        });
      } else {
        sender = await createWhatsAppSender({
          subaccountSid: accountRow.subaccount_sid,
          phoneNumber: numberRow.phone_number,
          verificationMethod: body.verificationMethod ?? "sms",
        });
      }
    } else if (body.action === "verify") {
      if (!senderRow?.sender_sid) {
        return NextResponse.json({ error: "Start WhatsApp activation first." }, { status: 422 });
      }

      if (!body.verificationCode) {
        return NextResponse.json({ error: "Verification code is required." }, { status: 400 });
      }

      sender = await verifyWhatsAppSender({
        subaccountSid: accountRow.subaccount_sid,
        senderSid: senderRow.sender_sid,
        verificationCode: body.verificationCode,
        verificationMethod: senderRow.verification_method ?? body.verificationMethod,
      });
    } else {
      if (!senderRow?.sender_sid) {
        return NextResponse.json({ error: "No WhatsApp sender exists for this number yet." }, { status: 404 });
      }

      sender = await fetchWhatsAppSender({
        subaccountSid: accountRow.subaccount_sid,
        senderSid: senderRow.sender_sid,
      });
    }

    await syncWhatsAppSenderState({
      adminClient,
      workspaceId: body.workspaceId,
      twilioAccountId: accountRow.id,
      twilioNumberId: numberRow.id,
      createdBy: user.id,
      sender,
      verificationMethod: sender.configuration?.verification_method ?? senderRow?.verification_method ?? body.verificationMethod ?? null,
    });

    return NextResponse.json({
      ok: true,
      sender: {
        sid: sender.sid,
        senderId: sender.sender_id,
        status: sender.status,
        verificationMethod: sender.configuration?.verification_method ?? senderRow?.verification_method ?? body.verificationMethod ?? null,
        isOnline: isWhatsAppSenderOnline(sender.status),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "WhatsApp sender setup failed";

    if (senderRow?.id) {
      await adminClient
        .from("workspace_twilio_whatsapp_senders")
        .update({
          error_message: message,
          last_synced_at: new Date().toISOString(),
        })
        .eq("id", senderRow.id);
    }

    return NextResponse.json({ error: message }, { status: 502 });
  }
}

async function syncWhatsAppSenderState(options: {
  adminClient: NonNullable<ReturnType<typeof getSupabaseAdminClient>>;
  workspaceId: string;
  twilioAccountId: string;
  twilioNumberId: string;
  createdBy: string;
  sender: WhatsAppSenderRecord;
  verificationMethod: WhatsAppVerificationMethod | null;
}) {
  const isOnline = isWhatsAppSenderOnline(options.sender.status);
  const now = new Date().toISOString();

  const { error: upsertSenderError } = await options.adminClient
    .from("workspace_twilio_whatsapp_senders")
    .upsert(
      {
        workspace_id: options.workspaceId,
        twilio_account_id: options.twilioAccountId,
        twilio_number_id: options.twilioNumberId,
        sender_sid: options.sender.sid,
        sender_id: options.sender.sender_id,
        status: options.sender.status,
        verification_method: options.verificationMethod,
        error_code: null,
        error_message: null,
        last_synced_at: now,
        metadata: {
          offline_reasons: options.sender.offline_reasons ?? null,
          properties: options.sender.properties ?? null,
          webhook: options.sender.webhook ?? null,
          profile: options.sender.profile ?? null,
          resource_url: options.sender.url ?? null,
        },
        created_by: options.createdBy,
      },
      { onConflict: "twilio_number_id" },
    );

  if (upsertSenderError) {
    throw new Error(upsertSenderError.message);
  }

  const { error: updateNumberError } = await options.adminClient
    .from("workspace_twilio_numbers")
    .update({
      capabilities_whatsapp: isOnline,
      updated_at: now,
    })
    .eq("id", options.twilioNumberId)
    .eq("workspace_id", options.workspaceId);

  if (updateNumberError) {
    throw new Error(updateNumberError.message);
  }
}

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}