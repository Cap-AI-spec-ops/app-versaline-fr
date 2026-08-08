import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { resolveAppearancePreferences, resolveLandingPath, resolveSafeNextPath } from "@/lib/preferences/appearance";

const protectedRoutePrefixes = [
  "/dashboard",
  "/inbox",
  "/calendar",
  "/properties",
  "/contacts",
  "/document-generator",
  "/admin",
  "/settings",
];

const authRoutes = ["/login", "/signup"];
const mfaVerifyRoute = "/mfa/verify";
const onboardingRoute = "/onboarding";

function isProtectedRoute(pathname: string) {
  return protectedRoutePrefixes.some((prefix) => pathname.startsWith(prefix));
}

function isAuthRoute(pathname: string) {
  return authRoutes.includes(pathname);
}

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const defaultLandingPage = resolveAppearancePreferences(
    (user?.user_metadata as Record<string, unknown> | undefined) ?? undefined
  ).defaultLandingPage;

  const pathname = request.nextUrl.pathname;

  if (!user && (isProtectedRoute(pathname) || pathname === mfaVerifyRoute || pathname === onboardingRoute)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (!user) {
    return response;
  }

  const { data: profileData } = await supabase.rpc("get_current_profile");
  const profile = profileData as { workspace_id?: string | null } | null;
  const hasWorkspace = Boolean(profile?.workspace_id);

  if (isAuthRoute(pathname)) {
    if (!hasWorkspace && pathname === "/login") {
      return response;
    }

    const nextParam = request.nextUrl.searchParams.get("next") ?? undefined;
    const destination = resolveSafeNextPath(nextParam) || (hasWorkspace ? defaultLandingPage : onboardingRoute);
    const landingUrl = request.nextUrl.clone();
    landingUrl.pathname = destination;
    landingUrl.search = "";
    return NextResponse.redirect(landingUrl);
  }

  if (!hasWorkspace && pathname !== onboardingRoute && !pathname.startsWith("/invite/")) {
    const onboardingUrl = request.nextUrl.clone();
    onboardingUrl.pathname = onboardingRoute;
    onboardingUrl.search = "";
    return NextResponse.redirect(onboardingUrl);
  }

  if (hasWorkspace && pathname === onboardingRoute) {
    const destinationUrl = request.nextUrl.clone();
    destinationUrl.pathname = defaultLandingPage;
    destinationUrl.search = "";
    return NextResponse.redirect(destinationUrl);
  }

  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const needsAal2 = aalData?.nextLevel === "aal2" && aalData.currentLevel !== "aal2";

  if (needsAal2 && isProtectedRoute(pathname)) {
    const verifyUrl = request.nextUrl.clone();
    verifyUrl.pathname = mfaVerifyRoute;
    verifyUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(verifyUrl);
  }

  if (!needsAal2 && pathname === mfaVerifyRoute) {
    const rawNextParam = request.nextUrl.searchParams.get("next") ?? undefined;
    const nextParam = rawNextParam ? resolveLandingPath(rawNextParam) : defaultLandingPage;
    const destinationUrl = request.nextUrl.clone();
    destinationUrl.pathname = nextParam;
    destinationUrl.search = "";
    return NextResponse.redirect(destinationUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/inbox/:path*",
    "/calendar/:path*",
    "/properties/:path*",
    "/contacts/:path*",
    "/document-generator/:path*",
    "/settings/:path*",
    "/admin/:path*",
    "/onboarding",
    "/mfa/verify",
    "/login",
    "/signup",
  ],
};