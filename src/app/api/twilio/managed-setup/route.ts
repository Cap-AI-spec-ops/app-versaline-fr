import "server-only";

import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  configureWorkspaceNumberWebhooks,
  createManagedSubaccount,
  findAvailableNumber,
  purchaseWorkspaceNumber,
} from "@/lib/twilio/provisioning";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type WorkspaceRole = "agent" | "team_lead" | "owner" | "super_admin";

const bodySchema = z.object({
  workspaceId: z.string().uuid(),
  countryCode: z.string().trim().length(2).default("FR"),
  forwardingNumber: z.string().trim().optional(),
  preferredType: z.enum(["local", "mobile", "tollfree"]).default("local"),
  requireSms: z.boolean().default(true),
  requireVoice: z.boolean().default(true),
});

type CurrentProfile = {
  workspace_id?: string | null;
  role?: WorkspaceRole | null;
};

type WorkspaceRow = {
  id: string;
  name: string | null;
  company_id: string | null;
};

type CompanyPolicyRow = {
  twilio_control: "owner_locked" | "team_lead_select" | null;
};

type AccountRow = {
  id: string;
  subaccount_sid: string;
  forwarding_number: string | null;
  status: string;
};

type NumberRow = {
  id: string;
  phone_number: string;
  phone_number_sid: string;
  friendly_name: string | null;
  capabilities_sms: boolean;
  capabilities_mms: boolean;
  capabilities_voice: boolean;
  capabilities_whatsapp: boolean;
  status: string;
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
    return NextResponse.json({
      error: "Twilio is disabled by company policy for this workspace",
    }, { status: 403 });
  }

  const adminClient = getSupabaseAdminClient();

  if (!adminClient) {
    return NextResponse.json({ error: "Service client unavailable" }, { status: 500 });
  }

  const { data: workspace } = await adminClient
    .from("workspaces")
    .select("id, name, company_id")
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
        error: "Only owners can configure SMS and calls. Team leads need owner delegation in policy.",
      },
      { status: 403 },
    );
  }

  try {
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";

    if (!siteUrl) {
      return NextResponse.json({ error: "NEXT_PUBLIC_SITE_URL is not configured" }, { status: 503 });
    }

    const smsUrl = `${siteUrl}/api/twilio/inbound-message`;
    const voiceUrl = `${siteUrl}/api/twilio/voice`;
    const statusCallbackUrl = `${siteUrl}/api/twilio/voice-status`;

    const { data: accountRow } = await adminClient
      .from("workspace_twilio_accounts")
      .select("id, subaccount_sid, forwarding_number, status")
      .eq("workspace_id", body.workspaceId)
      .maybeSingle<AccountRow>();

    let accountId = accountRow?.id ?? null;
    let subaccountSid = accountRow?.subaccount_sid ?? "";

    if (!subaccountSid) {
      const created = await createManagedSubaccount({
        workspaceName: workspace.name ?? "Workspace",
        workspaceId: workspace.id,
      });

      subaccountSid = created.sid;

      const { data: upsertedAccount, error: upsertAccountError } = await adminClient
        .from("workspace_twilio_accounts")
        .upsert(
          {
            workspace_id: workspace.id,
            company_id: workspace.company_id,
            subaccount_sid: subaccountSid,
            forwarding_number: normalizeOptionalPhone(body.forwardingNumber),
            friendly_name: created.friendlyName,
            status: "active",
            created_by: user.id,
          },
          { onConflict: "workspace_id" },
        )
        .select("id")
        .maybeSingle<{ id: string }>();

      if (upsertAccountError || !upsertedAccount?.id) {
        return NextResponse.json({ error: upsertAccountError?.message || "Failed to persist Twilio account" }, { status: 500 });
      }

      accountId = upsertedAccount.id;
    } else {
      const { error: updateAccountError } = await adminClient
        .from("workspace_twilio_accounts")
        .update({
          forwarding_number: normalizeOptionalPhone(body.forwardingNumber),
          status: "active",
        })
        .eq("workspace_id", body.workspaceId);

      if (updateAccountError) {
        return NextResponse.json({ error: updateAccountError.message }, { status: 500 });
      }
    }

    const { data: existingNumber } = await adminClient
      .from("workspace_twilio_numbers")
      .select("id, phone_number, phone_number_sid, friendly_name, capabilities_sms, capabilities_mms, capabilities_voice, capabilities_whatsapp, status")
      .eq("workspace_id", body.workspaceId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle<NumberRow>();

    if (existingNumber && subaccountSid) {
      await configureWorkspaceNumberWebhooks({
        subaccountSid,
        phoneNumberSid: existingNumber.phone_number_sid,
        smsUrl,
        voiceUrl,
        statusCallbackUrl,
      });

      return NextResponse.json({
        ok: true,
        mode: "already_configured",
        account: {
          id: accountId,
          status: "active",
        },
        number: {
          phoneNumber: existingNumber.phone_number,
          capabilities: {
            sms: existingNumber.capabilities_sms,
            mms: existingNumber.capabilities_mms,
            voice: existingNumber.capabilities_voice,
            whatsapp: existingNumber.capabilities_whatsapp,
          },
        },
      });
    }

    if (!accountId || !subaccountSid) {
      return NextResponse.json({ error: "Twilio account is not ready" }, { status: 500 });
    }

    const availability = await findAvailableNumber({
      countryCode: body.countryCode,
      requireSms: body.requireSms,
      requireVoice: body.requireVoice,
      preferredType: body.preferredType,
    });

    if (!availability.candidate) {
      const details = availability.diagnostics.slice(0, 3).join(" | ");
      const capabilityHint = body.requireSms && body.requireVoice
        ? "Try enabling only SMS or only voice, or choose another country."
        : "Try another country or number type.";

      return NextResponse.json(
        {
          error: `No phone number is currently available for this configuration. ${capabilityHint}${details ? ` Details: ${details}` : ""}`,
        },
        { status: 422 },
      );
    }

    const candidate = availability.candidate;

    const purchased = await purchaseWorkspaceNumber({
      subaccountSid,
      phoneNumber: candidate.phone_number,
      friendlyName: candidate.friendly_name,
      smsUrl,
      voiceUrl,
      statusCallbackUrl,
    });

    const { error: upsertNumberError } = await adminClient
      .from("workspace_twilio_numbers")
      .upsert(
        {
          workspace_id: body.workspaceId,
          twilio_account_id: accountId,
          phone_number: purchased.phoneNumber,
          phone_number_sid: purchased.sid,
          friendly_name: purchased.friendlyName,
          capabilities_sms: purchased.capabilities.sms,
          capabilities_mms: purchased.capabilities.mms,
          capabilities_voice: purchased.capabilities.voice,
          capabilities_whatsapp: purchased.capabilities.whatsapp,
          status: "active",
        },
        { onConflict: "phone_number_sid" },
      );

    if (upsertNumberError) {
      return NextResponse.json({ error: upsertNumberError.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      mode: "provisioned",
      account: {
        id: accountId,
        status: "active",
      },
      number: {
        phoneNumber: purchased.phoneNumber,
        capabilities: purchased.capabilities,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Managed setup failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

function normalizeOptionalPhone(raw?: string) {
  const value = raw?.trim();
  return value && value.length > 0 ? value : null;
}

function getSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
