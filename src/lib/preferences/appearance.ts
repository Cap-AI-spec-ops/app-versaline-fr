export const ALLOWED_LANDING_PATHS = [
  "/dashboard",
  "/properties",
  "/contacts",
  "/document-generator",
  "/settings",
] as const;

export type LandingPath = (typeof ALLOWED_LANDING_PATHS)[number];

type AppearancePreferences = {
  theme?: "system" | "light" | "dark";
  default_landing_page?: string;
};

export function resolveLandingPath(path: string | undefined): LandingPath {
  if (path && ALLOWED_LANDING_PATHS.includes(path as LandingPath)) {
    return path as LandingPath;
  }

  return "/dashboard";
}

export function resolveSafeNextPath(path: string | undefined): string {
  if (!path || !path.startsWith("/")) {
    return "/dashboard";
  }

  if (path.startsWith("//")) {
    return "/dashboard";
  }

  if (ALLOWED_LANDING_PATHS.includes(path as LandingPath)) {
    return path;
  }

  if (path.startsWith("/settings/") || path.startsWith("/admin/")) {
    return path;
  }

  if (path === "/onboarding" || path === "/admin") {
    return path;
  }

  if (path.startsWith("/invite/")) {
    return path;
  }

  return "/dashboard";
}

export function resolveAppearancePreferences(metadata: Record<string, unknown> | undefined) {
  const appearance = (metadata?.appearance_preferences ?? {}) as AppearancePreferences;

  const theme =
    appearance.theme === "light" || appearance.theme === "dark" || appearance.theme === "system"
      ? appearance.theme
      : "system";

  const defaultLandingPage = resolveLandingPath(appearance.default_landing_page);

  return {
    theme,
    defaultLandingPage,
  };
}
