import { NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

type CurrentProfile = {
  role?: "agent" | "team_lead" | "owner" | "super_admin" | null;
};

const CHAT_ASSISTANT_ACTION = "chat_assistant";
const DEFAULT_PROVIDER = "gemini" as const;
const DEFAULT_MODEL = "gemini-2.5-flash-lite";

export async function POST() {
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

  const profile = profileData as CurrentProfile;

  if (profile.role !== "super_admin") {
    return NextResponse.json({ error: "Only super admins can bootstrap model settings" }, { status: 403 });
  }

  const { data: rows, error: readError } = await supabase
    .from("ai_model_settings")
    .select("id, provider, model, text_provider, text_model, updated_at")
    .eq("action_type", CHAT_ASSISTANT_ACTION)
    .is("workspace_id", null)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false });

  if (readError) {
    return NextResponse.json({ error: `Could not read ai_model_settings: ${readError.message}` }, { status: 500 });
  }

  const currentRows = (rows ?? []) as Array<{
    id: number;
    provider: string | null;
    model: string | null;
    text_provider: string | null;
    text_model: string | null;
    updated_at: string;
  }>;

  const keepRow = currentRows[0] ?? null;
  const resolvedProvider =
    keepRow?.text_provider?.trim() || keepRow?.provider?.trim() || DEFAULT_PROVIDER;
  const resolvedModel =
    keepRow?.text_model?.trim() || keepRow?.model?.trim() || DEFAULT_MODEL;

  if (keepRow) {
    const { error: updateError } = await supabase
      .from("ai_model_settings")
      .update({
        provider: resolvedProvider,
        model: resolvedModel,
        text_provider: resolvedProvider,
        text_model: resolvedModel,
        vision_provider: resolvedProvider,
        vision_model: resolvedModel,
        is_active: true,
      })
      .eq("id", keepRow.id);

    if (updateError) {
      return NextResponse.json({ error: `Could not update ai_model_settings: ${updateError.message}` }, { status: 500 });
    }

    if (currentRows.length > 1) {
      const idsToDelete = currentRows.slice(1).map((row) => row.id);
      const { error: deleteError } = await supabase
        .from("ai_model_settings")
        .delete()
        .in("id", idsToDelete);

      if (deleteError) {
        return NextResponse.json({ error: `Could not clean duplicate rows: ${deleteError.message}` }, { status: 500 });
      }
    }

    return NextResponse.json({
      ok: true,
      actionType: CHAT_ASSISTANT_ACTION,
      status: "updated",
      provider: resolvedProvider,
      model: resolvedModel,
      removedDuplicates: Math.max(0, currentRows.length - 1),
    });
  }

  const { error: insertError } = await supabase.from("ai_model_settings").insert({
    action_type: CHAT_ASSISTANT_ACTION,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    text_provider: DEFAULT_PROVIDER,
    text_model: DEFAULT_MODEL,
    vision_provider: DEFAULT_PROVIDER,
    vision_model: DEFAULT_MODEL,
    workspace_id: null,
    is_active: true,
  });

  if (insertError) {
    return NextResponse.json({ error: `Could not insert ai_model_settings: ${insertError.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    actionType: CHAT_ASSISTANT_ACTION,
    status: "inserted",
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    removedDuplicates: 0,
  });
}
