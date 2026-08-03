import { NextRequest, NextResponse } from "next/server";

import { buildRoleAwareApiError } from "@/lib/auth/api-error-visibility";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  buildWorkspaceInviteEmail,
  sendTransactionalEmailWithSmtp,
} from "@/lib/email/brevo";

type SendInvitationBody = {
  email?: string;
  role?: "agent" | "team_lead" | "owner" | "super_admin";
  inviteToken?: string;
  workspaceName?: string;
  inviterName?: string;
};

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

  const { data: profileData, error: profileError } = await supabase.rpc("get_current_profile");

  if (profileError || !profileData) {
    return NextResponse.json({ error: "Could not load current profile" }, { status: 403 });
  }

  const profile = profileData as { role?: string | null };

  if (profile.role !== "super_admin" && profile.role !== "owner" && profile.role !== "team_lead") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as SendInvitationBody;
  const recipientEmail = body.email?.trim().toLowerCase();
  const inviteToken = body.inviteToken?.trim();
  const workspaceName = body.workspaceName?.trim() || "your workspace";
  const inviterName = body.inviterName?.trim() || "A teammate";

  if (!recipientEmail || !inviteToken) {
    return NextResponse.json({ error: "Missing email or inviteToken" }, { status: 400 });
  }

  const inviteLink = buildInviteLink(request, inviteToken);
  const roleLabel = formatRoleLabel(body.role ?? "agent");

  try {
    const payload = buildWorkspaceInviteEmail({
      recipientEmail,
      inviteLink,
      workspaceName,
      roleLabel,
      inviterName,
    });

    const result = await sendTransactionalEmailWithSmtp(payload);

    return NextResponse.json({ ok: true, messageId: result.messageId });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown email send error";
    const safeMessage = buildRoleAwareApiError({
      role: (profile.role as "agent" | "team_lead" | "owner" | "super_admin" | null) ?? null,
      technicalMessage: errorMessage,
      fallbackMessage: "Could not send invitation right now.",
    });

    return NextResponse.json({ error: safeMessage }, { status: 500 });
  }
}

function formatRoleLabel(role: "agent" | "team_lead" | "owner" | "super_admin") {
  return role.replaceAll("_", " ");
}

function buildInviteLink(request: NextRequest, inviteToken: string) {
  const configuredBaseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    request.headers.get("origin") ||
    request.nextUrl.origin;

  return `${configuredBaseUrl.replace(/\/$/, "")}/invite/${inviteToken}`;
}
