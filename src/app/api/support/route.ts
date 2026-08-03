import { NextRequest, NextResponse } from "next/server";

import { buildSupportRequestEmailPayload, sendTransactionalEmailWithSmtp } from "@/lib/email/brevo";
import { buildRoleAwareApiError } from "@/lib/auth/api-error-visibility";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type SupportBody = {
  subject?: string;
  message?: string;
  routePath?: string;
  workspaceId?: string;
  workspaceName?: string;
};

const MIN_SUBJECT_LENGTH = 4;
const MAX_SUBJECT_LENGTH = 140;
const MIN_MESSAGE_LENGTH = 10;
const MAX_MESSAGE_LENGTH = 4000;

export async function POST(request: NextRequest) {
  const supportInboxEmail = process.env.SUPPORT_INBOX_EMAIL?.trim().toLowerCase();

  if (!supportInboxEmail) {
    return NextResponse.json({ error: "Support channel is not configured" }, { status: 503 });
  }

  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ error: "Supabase client unavailable" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: SupportBody;

  try {
    body = (await request.json()) as SupportBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const subject = body.subject?.trim() ?? "";
  const message = body.message?.trim() ?? "";

  if (subject.length < MIN_SUBJECT_LENGTH || subject.length > MAX_SUBJECT_LENGTH) {
    return NextResponse.json(
      { error: `Subject must be between ${MIN_SUBJECT_LENGTH} and ${MAX_SUBJECT_LENGTH} characters.` },
      { status: 400 },
    );
  }

  if (message.length < MIN_MESSAGE_LENGTH || message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `Message must be between ${MIN_MESSAGE_LENGTH} and ${MAX_MESSAGE_LENGTH} characters.` },
      { status: 400 },
    );
  }

  const { data: profileData } = await supabase.rpc("get_current_profile");
  const profile = profileData as {
    workspace_id?: string | null;
    role?: "agent" | "team_lead" | "owner" | "super_admin" | null;
    first_name?: string | null;
    last_name?: string | null;
  } | null;

  if (!profile?.workspace_id) {
    return NextResponse.json({ error: "No active workspace" }, { status: 400 });
  }

  const requestWorkspaceId = body.workspaceId?.trim();

  if (!requestWorkspaceId || requestWorkspaceId !== profile.workspace_id) {
    return NextResponse.json({ error: "Workspace mismatch" }, { status: 403 });
  }

  const requesterName = [profile.first_name ?? "", profile.last_name ?? ""].join(" ").trim() || user.email;

  try {
    const payload = buildSupportRequestEmailPayload({
      supportInboxEmail,
      requesterEmail: user.email,
      requesterName,
      subject,
      message,
      workspaceId: profile.workspace_id,
      workspaceName: body.workspaceName,
      role: profile.role ?? undefined,
      routePath: body.routePath,
    });

    const result = await sendTransactionalEmailWithSmtp(payload);

    return NextResponse.json({ ok: true, messageId: result.messageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown support error";
    const safeMessage = buildRoleAwareApiError({
      role: profile.role ?? null,
      technicalMessage: message,
      fallbackMessage: "Could not send support request right now.",
    });
    return NextResponse.json({ error: safeMessage }, { status: 500 });
  }
}
