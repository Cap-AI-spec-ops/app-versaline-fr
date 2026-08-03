import { getMarketPresetByCountry } from "@/lib/market/market-presets";

export type WorkspaceMarketDefaults = {
  default_country_code?: string | null;
  default_locale?: string | null;
  default_language?: string | null;
  default_timezone?: string | null;
};

export type MarketContext = {
  countryCode: string;
  locale: string;
  language: string;
  timezone: string;
};

export function resolveMarketContext(options: {
  workspaceDefaults?: WorkspaceMarketDefaults | null;
  overrides?: Partial<MarketContext> | null;
}): MarketContext {
  const workspaceCountry = options.workspaceDefaults?.default_country_code?.trim().toUpperCase() ?? null;
  const countryOverride = options.overrides?.countryCode?.trim().toUpperCase() ?? null;
  const resolvedCountry = countryOverride || workspaceCountry || "FR";

  const preset = getMarketPresetByCountry(resolvedCountry);

  const locale =
    options.overrides?.locale?.trim() ||
    options.workspaceDefaults?.default_locale?.trim() ||
    preset.defaultLocale;

  const language =
    options.overrides?.language?.trim() ||
    options.workspaceDefaults?.default_language?.trim() ||
    preset.defaultLanguage;

  const timezone =
    options.overrides?.timezone?.trim() ||
    options.workspaceDefaults?.default_timezone?.trim() ||
    preset.defaultTimezone;

  return {
    countryCode: preset.countryCode,
    locale,
    language,
    timezone,
  };
}
