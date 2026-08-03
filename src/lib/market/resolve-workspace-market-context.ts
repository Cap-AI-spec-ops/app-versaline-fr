import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { resolveMarketContext, type MarketContext } from "@/lib/market/context";

export async function resolveWorkspaceMarketContext(options: {
  workspaceId: string;
  overrides?: Partial<MarketContext> | null;
}): Promise<MarketContext> {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return resolveMarketContext({
      overrides: options.overrides,
    });
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("default_country_code, default_locale, default_language, default_timezone")
    .eq("id", options.workspaceId)
    .single<{
      default_country_code?: string | null;
      default_locale?: string | null;
      default_language?: string | null;
      default_timezone?: string | null;
    }>();

  return resolveMarketContext({
    workspaceDefaults: workspace,
    overrides: options.overrides,
  });
}
