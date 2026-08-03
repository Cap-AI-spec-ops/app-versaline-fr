import crypto from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type OAuthProvider = "google" | "azure";

type GoogleMailboxState = {
  workspaceId: string;
  profileId: string;
  nonce: string;
};

function parseProvider(value: string | null): OAuthProvider | null {
  if (value === "google" || value === "azure") {
    return value;
  }

  return null;
}

export async function GET(request: NextRequest) {
  const callbackMode = request.nextUrl.searchParams.get("callback");

  if (callbackMode === "google") {
    return handleGoogleCallback(request);
  }

  const provider = parseProvider(request.nextUrl.searchParams.get("provider"));
  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim();

  if (!provider) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=invalid_provider", request.url));
  }

  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=supabase_unavailable", request.url));
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL("/login?next=/settings/mailbox", request.url));
  }

  if (provider === "google") {
    const googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
    const stateSecret = process.env.MAILBOX_OAUTH_STATE_SECRET?.trim() || process.env.CRON_SECRET?.trim();

    if (!googleClientId || !stateSecret) {
      return NextResponse.redirect(new URL("/settings/mailbox?error=google_oauth_not_configured", request.url));
    }

    const callbackBaseUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.nextUrl.origin;
    const redirectUri = `${callbackBaseUrl.replace(/\/$/, "")}/api/mailbox/connect?callback=google`;

    const statePayload: GoogleMailboxState = {
      workspaceId: workspaceId ?? "",
      profileId: user.id,
      nonce: crypto.randomUUID(),
    };

    const stateToken = signState(statePayload, stateSecret);
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", googleClientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set(
      "scope",
      "openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events",
    );
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("state", stateToken);

    return NextResponse.redirect(authUrl);
  }

  const callbackBaseUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.nextUrl.origin;
  const redirectTo = `${callbackBaseUrl.replace(/\/$/, "")}/settings/mailbox${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo,
      scopes: "openid email profile offline_access Mail.Read Calendars.ReadWrite",
    },
  });

  if (error || !data?.url) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=oauth_init_failed", request.url));
  }

  return NextResponse.redirect(data.url);
}

async function handleGoogleCallback(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim();
  const stateToken = request.nextUrl.searchParams.get("state")?.trim();
  const error = request.nextUrl.searchParams.get("error")?.trim();

  if (error) {
    return NextResponse.redirect(new URL(`/settings/mailbox?error=${encodeURIComponent(error)}`, request.url));
  }

  if (!code || !stateToken) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=oauth_callback_invalid", request.url));
  }

  const stateSecret = process.env.MAILBOX_OAUTH_STATE_SECRET?.trim() || process.env.CRON_SECRET?.trim();

  if (!stateSecret) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=oauth_state_secret_missing", request.url));
  }

  const state = verifyState(stateToken, stateSecret);

  if (!state || !state.workspaceId || !state.profileId) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=oauth_state_invalid", request.url));
  }

  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=supabase_unavailable", request.url));
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.id !== state.profileId) {
    return NextResponse.redirect(new URL("/login?next=/settings/mailbox", request.url));
  }

  const googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const googleClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();

  if (!googleClientId || !googleClientSecret) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=google_oauth_not_configured", request.url));
  }

  const callbackBaseUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.nextUrl.origin;
  const redirectUri = `${callbackBaseUrl.replace(/\/$/, "")}/api/mailbox/connect?callback=google`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=google_token_exchange_failed", request.url));
  }

  const tokenPayload = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
  };

  const accessToken = tokenPayload.access_token?.trim() || null;
  const refreshToken = tokenPayload.refresh_token?.trim() || null;

  if (!accessToken) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=google_access_token_missing", request.url));
  }

  const adminClient = getSupabaseAdminClient();

  if (!adminClient) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=supabase_admin_unavailable", request.url));
  }

  const { error: updateError } = await adminClient
    .from("mailbox_connections")
    .upsert(
      {
        workspace_id: state.workspaceId,
        profile_id: state.profileId,
        provider: "gmail",
        status: "connected",
        last_error: null,
        oauth_access_token: accessToken,
        oauth_refresh_token: refreshToken,
        oauth_token_updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,profile_id,provider" },
    );

  if (updateError) {
    return NextResponse.redirect(new URL("/settings/mailbox?error=mailbox_token_store_failed", request.url));
  }

  const destinationUrl = new URL("/settings/mailbox", request.url);
  destinationUrl.searchParams.set("workspaceId", state.workspaceId);
  destinationUrl.searchParams.set("connected", "gmail");
  return NextResponse.redirect(destinationUrl);
}

function signState(state: GoogleMailboxState, secret: string) {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyState(token: string, secret: string): GoogleMailboxState | null {
  const [payload, signature] = token.split(".");

  if (!payload || !signature) {
    return null;
  }

  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  if (!timingSafeEqual(expected, signature)) {
    return null;
  }

  try {
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as GoogleMailboxState;

    if (!parsed.workspaceId || !parsed.profileId || !parsed.nonce) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function timingSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
