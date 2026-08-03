import { NextRequest, NextResponse } from "next/server";

import { buildListingDescriptionDraftEmailPayload, sendTransactionalEmailWithSmtp } from "@/lib/email/brevo";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type ListingDraftPayload = {
  title?: string;
  description?: string;
  bulletPoints?: string[];
  secondaryTitle?: string;
  secondaryDescription?: string;
  secondaryBulletPoints?: string[];
  metadata?: {
    language?: string;
    countryCode?: string;
    locale?: string;
    timezone?: string;
  };
};

type SendListingDraftBody = {
  workspaceId?: string;
  workspaceName?: string;
  recipientEmail?: string;
  draft?: ListingDraftPayload;
};

const MAX_EMAIL_ATTACHMENTS = 10;

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

  const profile = profileData as {
    workspace_id?: string | null;
    role?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  };

  const contentType = request.headers.get("content-type") ?? "";
  let body: SendListingDraftBody = {};
  let imageFiles: File[] = [];

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const draftRaw = readOptionalFormValue(formData, "draft");

    body = {
      workspaceId: readOptionalFormValue(formData, "workspaceId") ?? undefined,
      workspaceName: readOptionalFormValue(formData, "workspaceName") ?? undefined,
      recipientEmail: readOptionalFormValue(formData, "recipientEmail") ?? undefined,
      draft: parseDraftPayload(draftRaw),
    };

    imageFiles = formData
      .getAll("images")
      .filter((entry): entry is File => entry instanceof File && entry.size > 0 && entry.type.startsWith("image/"))
      .slice(0, MAX_EMAIL_ATTACHMENTS);
  } else {
    body = (await request.json()) as SendListingDraftBody;
  }

  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId || !profile.workspace_id || workspaceId !== profile.workspace_id) {
    return NextResponse.json({ error: "Workspace mismatch" }, { status: 403 });
  }

  const draft = body.draft;
  const title = draft?.title?.trim() ?? "";
  const description = draft?.description?.trim() ?? "";
  const bulletPoints = (draft?.bulletPoints ?? []).filter((point): point is string => typeof point === "string" && point.trim().length > 0);
  const secondaryTitle = draft?.secondaryTitle?.trim() ?? "";
  const secondaryDescription = draft?.secondaryDescription?.trim() ?? "";
  const secondaryBulletPoints = (draft?.secondaryBulletPoints ?? []).filter(
    (point): point is string => typeof point === "string" && point.trim().length > 0,
  );

  if (!title || !description) {
    return NextResponse.json({ error: "Draft content is incomplete" }, { status: 400 });
  }

  const recipientEmail = body.recipientEmail?.trim().toLowerCase() || user.email?.trim().toLowerCase();

  if (!recipientEmail) {
    return NextResponse.json({ error: "Recipient email is required" }, { status: 400 });
  }

  const metadata = draft?.metadata;
  const marketSummary = [metadata?.countryCode, metadata?.locale, metadata?.language, metadata?.timezone]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" • ");

  try {
    const recipientName = [profile.first_name ?? "", profile.last_name ?? ""].join(" ").trim() || undefined;

    const payload = buildListingDescriptionDraftEmailPayload({
      recipientEmail,
      recipientName,
      title,
      description,
      bulletPoints,
      secondaryTitle: secondaryTitle || undefined,
      secondaryDescription: secondaryDescription || undefined,
      secondaryBulletPoints,
      marketSummary: marketSummary || "Default workspace market",
      workspaceName: body.workspaceName,
    });

    const attachments = await Promise.all(
      imageFiles.map(async (file) => ({
        filename: file.name || "photo.jpg",
        content: Buffer.from(await file.arrayBuffer()),
        contentType: file.type || "image/jpeg",
      })),
    );

    const result = await sendTransactionalEmailWithSmtp({
      ...payload,
      attachments,
    });

    return NextResponse.json({ ok: true, messageId: result.messageId });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown email send error";
    const safeMessage =
      profile.role === "super_admin"
        ? errorMessage
        : "Could not send draft email right now. Please try again.";
    return NextResponse.json({ error: safeMessage }, { status: 500 });
  }
}

function readOptionalFormValue(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDraftPayload(raw: string | null): ListingDraftPayload | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as ListingDraftPayload;
  } catch {
    return undefined;
  }
}
