import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import { generateWithCredits, InsufficientCreditsError } from "@/lib/ai/generate-with-credits";
import { composeDailyBriefing } from "@/lib/briefing/compose-daily-briefing";
import { buildDailyBriefingEmailPayload, sendTransactionalEmailWithSmtp } from "@/lib/email/brevo";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const requestSchema = z.object({
  mode: z.enum(["preview", "test-send"]).default("preview"),
  workspaceId: z.string().uuid().optional(),
});

type CurrentProfileRow = {
  workspace_id?: string | null;
  role?: string | null;
  first_name?: string | null;
  last_name?: string | null;
};

type BriefingPreferenceRow = {
  timezone: string | null;
  language: string | null;
  locale: string | null;
};

type WorkspacePolicyScopeRow = {
  company_id: string | null;
  team_lead_daily_briefing_enabled: boolean | null;
};

type CompanyBriefingPolicyRow = {
  daily_briefing_enabled: boolean | null;
  daily_briefing_control: "owner_locked" | "team_lead_select" | null;
};

type WorkspaceCompanyScopeRow = {
  company_id: string | null;
};

export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServerClient();
  const adminClient = getSupabaseAdminClient();
  const policyReadClient = adminClient ?? supabase;

  if (!supabase) {
    return NextResponse.json({ error: "Supabase client unavailable" }, { status: 500 });
  }

  if (!adminClient) {
    return NextResponse.json(
      {
        error: "Supabase service role client unavailable",
        details: "Daily briefing preview/test requires service-role access to match scheduled automation context.",
      },
      { status: 500 },
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let parsedBody: z.infer<typeof requestSchema>;

  try {
    parsedBody = requestSchema.parse((await request.json()) as unknown);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { data: profileData, error: profileError } = await supabase.rpc("get_current_profile");

  if (profileError || !profileData) {
    return NextResponse.json({ error: "Could not load current profile" }, { status: 403 });
  }

  const profile = profileData as CurrentProfileRow;

  if (!profile.workspace_id) {
    return NextResponse.json({ error: "No workspace on current profile" }, { status: 400 });
  }

  const workspaceId = parsedBody.workspaceId ?? profile.workspace_id;

  if (workspaceId !== profile.workspace_id) {
    return NextResponse.json({ error: "Workspace mismatch" }, { status: 403 });
  }

  const { data: workspacePolicyScope, error: workspacePolicyScopeError } = await policyReadClient
    .from("workspaces")
    .select("company_id, team_lead_daily_briefing_enabled")
    .eq("id", workspaceId)
    .maybeSingle<WorkspacePolicyScopeRow>();

  let resolvedWorkspacePolicyScope = workspacePolicyScope ?? null;

  if (workspacePolicyScopeError) {
    if (!isMissingWorkspaceTeamLeadBriefingColumn(workspacePolicyScopeError)) {
      return NextResponse.json({ error: "Could not load workspace briefing policy scope" }, { status: 500 });
    }

    const { data: workspaceCompanyScope, error: workspaceCompanyScopeError } = await policyReadClient
      .from("workspaces")
      .select("company_id")
      .eq("id", workspaceId)
      .maybeSingle<WorkspaceCompanyScopeRow>();

    if (workspaceCompanyScopeError) {
      resolvedWorkspacePolicyScope = {
        company_id: null,
        team_lead_daily_briefing_enabled: null,
      };
    } else {
      resolvedWorkspacePolicyScope = {
        company_id: workspaceCompanyScope?.company_id ?? null,
        team_lead_daily_briefing_enabled: null,
      };
    }
  }

  let companyPolicy: CompanyBriefingPolicyRow | null = null;

  if (resolvedWorkspacePolicyScope?.company_id) {
    const { data: policyData, error: policyError } = await policyReadClient
      .from("email_ingestion_policies")
      .select("daily_briefing_enabled, daily_briefing_control")
      .eq("company_id", resolvedWorkspacePolicyScope.company_id)
      .maybeSingle<CompanyBriefingPolicyRow>();

    if (!policyError) {
      companyPolicy = policyData;
    }
  }

  const effectiveBriefingEnabled = resolveDailyBriefingPolicy(companyPolicy, resolvedWorkspacePolicyScope);

  if (!effectiveBriefingEnabled) {
    return NextResponse.json(
      { error: "Daily briefing is disabled by company policy for this workspace" },
      { status: 403 },
    );
  }

  const { data: preferenceData, error: preferenceError } = await supabase
    .from("daily_briefing_preferences")
    .select("timezone, language, locale")
    .eq("workspace_id", workspaceId)
    .eq("profile_id", user.id)
    .maybeSingle<BriefingPreferenceRow>();

  if (preferenceError) {
    return NextResponse.json({ error: "Could not load briefing preferences" }, { status: 500 });
  }

  const timezone = preferenceData?.timezone?.trim() || undefined;
  const language = preferenceData?.language?.trim() || undefined;
  const locale = preferenceData?.locale?.trim() || undefined;
  const actionType = "daily_briefing" as const;
  const idempotencyKey =
    request.headers.get("Idempotency-Key") ??
    `daily-briefing-preview:${workspaceId}:${user.id}:${crypto.randomUUID()}`;

  let composition;
  let creditsUsed = 0;
  let newBalance: number | null = null;

  try {
    const billedGeneration = await generateWithCredits({
      workspaceId,
      actionType,
      idempotencyKey,
      generationFn: () =>
        composeDailyBriefing({
          supabase: adminClient,
          workspaceId,
          profileId: user.id,
          timezone,
          language,
          locale,
        }),
    });

    composition = billedGeneration.result;
    creditsUsed = billedGeneration.creditsUsed;
    newBalance = billedGeneration.newBalance;
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      return NextResponse.json(
        {
          error: error.message,
          workspaceId: error.workspaceId,
          actionType: error.actionType,
          requiredCredits: error.requiredCredits,
          currentBalance: error.currentBalance,
        },
        { status: 402 },
      );
    }

    return NextResponse.json(
      {
        error: "Could not compose daily briefing",
        details: error instanceof Error ? error.message : null,
      },
      { status: 500 },
    );
  }

  if (parsedBody.mode === "preview") {
    return NextResponse.json({
      ok: true,
      mode: "preview",
      creditsUsed,
      newBalance,
      localDate: composition.localDate,
      timezone: composition.timezone,
      language: composition.language,
      aiBriefing: composition.aiBriefing,
      sectionCounts: {
        assignedFollowUpsDueToday: composition.sections.assignedFollowUpsDueToday.length,
        assignedHighPriorityContacts: composition.sections.assignedHighPriorityContacts.length,
        todaysTimelineMeetingsAndVisits: composition.sections.todaysTimelineMeetingsAndVisits.length,
        todaysEmailSummaries: composition.sections.todaysEmailSummaries.length,
      },
      sections: composition.sections,
    });
  }

  const recipientEmail = user.email?.trim().toLowerCase();

  if (!recipientEmail) {
    return NextResponse.json({ error: "Authenticated user has no email" }, { status: 400 });
  }

  try {
    const recipientName = [profile.first_name ?? "", profile.last_name ?? ""].join(" ").trim() || undefined;

    const payload = buildDailyBriefingEmailPayload({
      recipientEmail,
      recipientName,
      workspaceName: composition.sections.workspaceSnapshot.workspaceName,
      localDate: composition.localDate,
      timezone: composition.timezone,
      language: composition.language,
      headline: composition.aiBriefing.headline,
      briefing: composition.aiBriefing.briefing,
      workspacePulse: composition.aiBriefing.workspacePulse,
      topActions: composition.aiBriefing.topActions,
    });

    const sendResult = await sendTransactionalEmailWithSmtp(payload);

    return NextResponse.json({
      ok: true,
      mode: "test-send",
      creditsUsed,
      newBalance,
      recipientEmail,
      messageId: sendResult.messageId,
      localDate: composition.localDate,
      timezone: composition.timezone,
      sectionCounts: {
        assignedFollowUpsDueToday: composition.sections.assignedFollowUpsDueToday.length,
        assignedHighPriorityContacts: composition.sections.assignedHighPriorityContacts.length,
        todaysTimelineMeetingsAndVisits: composition.sections.todaysTimelineMeetingsAndVisits.length,
        todaysEmailSummaries: composition.sections.todaysEmailSummaries.length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not send test briefing email",
        details: error instanceof Error ? error.message : null,
      },
      { status: 500 },
    );
  }
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

function resolveDailyBriefingPolicy(
  companyPolicy: CompanyBriefingPolicyRow | null,
  workspaceScope: WorkspacePolicyScopeRow | null,
) {
  const companyEnabled = companyPolicy?.daily_briefing_enabled ?? true;
  const control = companyPolicy?.daily_briefing_control === "team_lead_select" ? "team_lead_select" : "owner_locked";

  if (control !== "team_lead_select") {
    return companyEnabled;
  }

  if (typeof workspaceScope?.team_lead_daily_briefing_enabled === "boolean") {
    return workspaceScope.team_lead_daily_briefing_enabled;
  }

  return companyEnabled;
}

function isMissingWorkspaceTeamLeadBriefingColumn(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message).toLowerCase() : "";

  return code === "42703" || message.includes("team_lead_daily_briefing_enabled") || message.includes("column");
}
