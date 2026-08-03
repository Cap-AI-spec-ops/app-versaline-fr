import { redirect } from "next/navigation";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/require-user";

export async function requireAdmin(nextPath: string) {
  const user = await requireUser(nextPath);
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    redirect("/dashboard");
  }

  const { data: profileData, error: profileError } = await supabase.rpc("get_current_profile");

  if (profileError || !profileData) {
    redirect("/dashboard");
  }

  const profile = profileData as { role?: string };

  if (profile.role !== "super_admin" && profile.role !== "owner") {
    redirect("/dashboard");
  }

  return { user, role: profile.role };
}
