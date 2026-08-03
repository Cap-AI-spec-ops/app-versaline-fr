export type MarketPreset = {
  countryCode: string;
  countryName: string;
  defaultLocale: string;
  defaultLanguage: string;
  defaultTimezone: string;
};

export type MarketOption = {
  code: string;
  label: string;
};

export const MARKET_PRESETS: readonly MarketPreset[] = [
  {
    countryCode: "FR",
    countryName: "France",
    defaultLocale: "fr-FR",
    defaultLanguage: "fr",
    defaultTimezone: "Europe/Paris",
  },
  {
    countryCode: "SE",
    countryName: "Sweden",
    defaultLocale: "sv-SE",
    defaultLanguage: "sv",
    defaultTimezone: "Europe/Stockholm",
  },
  {
    countryCode: "DE",
    countryName: "Germany",
    defaultLocale: "de-DE",
    defaultLanguage: "de",
    defaultTimezone: "Europe/Berlin",
  },
  {
    countryCode: "ES",
    countryName: "Spain",
    defaultLocale: "es-ES",
    defaultLanguage: "es",
    defaultTimezone: "Europe/Madrid",
  },
  {
    countryCode: "IT",
    countryName: "Italy",
    defaultLocale: "it-IT",
    defaultLanguage: "it",
    defaultTimezone: "Europe/Rome",
  },
  {
    countryCode: "NL",
    countryName: "Netherlands",
    defaultLocale: "nl-NL",
    defaultLanguage: "nl",
    defaultTimezone: "Europe/Amsterdam",
  },
  {
    countryCode: "BE",
    countryName: "Belgium",
    defaultLocale: "fr-BE",
    defaultLanguage: "fr",
    defaultTimezone: "Europe/Brussels",
  },
  {
    countryCode: "PT",
    countryName: "Portugal",
    defaultLocale: "pt-PT",
    defaultLanguage: "pt",
    defaultTimezone: "Europe/Lisbon",
  },
  {
    countryCode: "CH",
    countryName: "Switzerland",
    defaultLocale: "fr-CH",
    defaultLanguage: "fr",
    defaultTimezone: "Europe/Zurich",
  },
  {
    countryCode: "AT",
    countryName: "Austria",
    defaultLocale: "de-AT",
    defaultLanguage: "de",
    defaultTimezone: "Europe/Vienna",
  },
  {
    countryCode: "IE",
    countryName: "Ireland",
    defaultLocale: "en-IE",
    defaultLanguage: "en",
    defaultTimezone: "Europe/Dublin",
  },
  {
    countryCode: "DK",
    countryName: "Denmark",
    defaultLocale: "da-DK",
    defaultLanguage: "da",
    defaultTimezone: "Europe/Copenhagen",
  },
  {
    countryCode: "NO",
    countryName: "Norway",
    defaultLocale: "nb-NO",
    defaultLanguage: "nb",
    defaultTimezone: "Europe/Oslo",
  },
  {
    countryCode: "FI",
    countryName: "Finland",
    defaultLocale: "fi-FI",
    defaultLanguage: "fi",
    defaultTimezone: "Europe/Helsinki",
  },
  {
    countryCode: "PL",
    countryName: "Poland",
    defaultLocale: "pl-PL",
    defaultLanguage: "pl",
    defaultTimezone: "Europe/Warsaw",
  },
] as const;

const LANGUAGE_LABELS: Record<string, string> = {
  fr: "French",
  sv: "Swedish",
  de: "German",
  es: "Spanish",
  it: "Italian",
  nl: "Dutch",
  pt: "Portuguese",
  en: "English",
  da: "Danish",
  nb: "Norwegian Bokmal",
  fi: "Finnish",
  pl: "Polish",
};

function buildUniqueLocaleOptions() {
  const uniqueLocales = Array.from(new Set(MARKET_PRESETS.map((preset) => preset.defaultLocale))).sort();

  return uniqueLocales.map((locale) => ({
    code: locale,
    label: locale,
  }));
}

function buildUniqueLanguageOptions() {
  const uniqueLanguages = Array.from(new Set(MARKET_PRESETS.map((preset) => preset.defaultLanguage))).sort();

  return uniqueLanguages.map((language) => ({
    code: language,
    label: `${language} - ${LANGUAGE_LABELS[language] ?? "Language"}`,
  }));
}

function buildUniqueTimezoneOptions() {
  const uniqueTimezones = Array.from(new Set(MARKET_PRESETS.map((preset) => preset.defaultTimezone))).sort();

  return uniqueTimezones.map((timezone) => ({
    code: timezone,
    label: timezone,
  }));
}

export const MARKET_LOCALE_OPTIONS: readonly MarketOption[] = buildUniqueLocaleOptions();
export const MARKET_LANGUAGE_OPTIONS: readonly MarketOption[] = buildUniqueLanguageOptions();
export const MARKET_TIMEZONE_OPTIONS: readonly MarketOption[] = buildUniqueTimezoneOptions();

const FALLBACK_MARKET_PRESET = MARKET_PRESETS[0];

export function getMarketPresetByCountry(countryCode: string | null | undefined): MarketPreset {
  if (!countryCode) {
    return FALLBACK_MARKET_PRESET;
  }

  const normalizedCountryCode = countryCode.trim().toUpperCase();
  const resolved = MARKET_PRESETS.find((preset) => preset.countryCode === normalizedCountryCode);

  return resolved ?? FALLBACK_MARKET_PRESET;
}
