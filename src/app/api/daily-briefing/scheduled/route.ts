import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { getActionConfig } from "@/lib/ai/model-router";
import { composeDailyBriefing } from "@/lib/briefing/compose-daily-briefing";
import { buildDailyBriefingEmailPayload, sendTransactionalEmailWithSmtp } from "@/lib/email/brevo";

export const runtime = "nodejs";

type DailyBriefingPreferenceRow = {
  id: string;
  workspace_id: string;
  profile_id: string;
  send_weekdays: number[] | null;
  send_time_local: string;
  timezone: string | null;
  language: string | null;
  locale: string | null;
  include_workspace_snapshot: boolean;
  include_email_delivery: boolean;
  is_enabled: boolean;
};

type ProfileRow = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

type WorkspacePolicyScopeRow = {
  id: string;
  company_id: string | null;
  team_lead_daily_briefing_enabled: boolean | null;
};

type CompanyBriefingPolicyRow = {
  company_id: string;
  daily_briefing_enabled: boolean | null;
  daily_briefing_control: "owner_locked" | "team_lead_select" | null;
};

type WorkspaceCompanyScopeRow = {
  id: string;
  company_id: string | null;
};

type CreditMutationResult = {
  workspace_id: string;
  transaction_id: string;
  transaction_type: "deduction" | "refund" | "topup";
  amount: number;
  balance: number;
  billing_mode?: "workspace_shared" | "per_person";
  billed_user_id?: string | null;
  idempotent: boolean;
};

type DailyBriefingRunRow = {
  status: string;
  payload_metadata: Record<string, unknown> | null;
};

type WorkspaceAbsenceRow = {
  profile_id: string;
  starts_on: string;
  ends_on: string;
  status: "planned" | "confirmed" | "cancelled";
};

type AbsentProfileSummary = {
  profileId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
};

type TakeoverBriefingSnapshot = {
  absentProfileId: string;
  absentDisplayName: string;
  headline: string;
  briefing: string;
  workspacePulse: string;
  topActions: Array<{
    title: string;
    reason: string;
    dueHint?: string | null;
  }>;
};

type WorkspaceProfileRow = {
  id: string;
  workspace_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

export async function POST(request: NextRequest) {
  const expectedSecret = process.env.DAILY_BRIEFING_CRON_SECRET?.trim() || process.env.CRON_SECRET?.trim();

  if (!expectedSecret) {
    return NextResponse.json({ error: "DAILY_BRIEFING_CRON_SECRET is missing" }, { status: 503 });
  }

  if (!isCronAuthorized(request, expectedSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();

  if (!supabase) {
    return NextResponse.json({ error: "Supabase service role client unavailable" }, { status: 500 });
  }

  const now = new Date();
  const schedulerSource = request.headers.get("x-vercel-cron") ? "vercel-cron" : "manual-or-external";
  const actionType = "daily_briefing" as const;
  const actionConfig = getActionConfig(actionType);

  logSchedulerEvent("run_started", {
    source: schedulerSource,
    ran_at: now.toISOString(),
  });

  const { data: preferenceRows, error: preferenceError } = await supabase
    .from("daily_briefing_preferences")
    .select("id, workspace_id, profile_id, send_weekdays, send_time_local, timezone, language, locale, include_workspace_snapshot, include_email_delivery, is_enabled")
    .eq("is_enabled", true)
    .order("updated_at", { ascending: true })
    .limit(5000);

  if (preferenceError) {
    return NextResponse.json({ error: "Could not load daily briefing preferences", details: preferenceError.message }, { status: 500 });
  }

  const preferences = (preferenceRows ?? []) as DailyBriefingPreferenceRow[];
  const workspaceIds = Array.from(new Set(preferences.map((row) => row.workspace_id)));

  const workspaceScopeById = new Map<string, WorkspacePolicyScopeRow>();
  const companyPolicyByCompanyId = new Map<string, CompanyBriefingPolicyRow>();

  if (workspaceIds.length > 0) {
    const { data: workspaceScopeRows, error: workspaceScopeError } = await supabase
      .from("workspaces")
      .select("id, company_id, team_lead_daily_briefing_enabled")
      .in("id", workspaceIds);

    if (workspaceScopeError) {
      if (!isMissingWorkspaceTeamLeadBriefingColumn(workspaceScopeError)) {
        return NextResponse.json(
          { error: "Could not load workspace briefing policy scope", details: workspaceScopeError.message },
          { status: 500 },
        );
      }

      const { data: workspaceCompanyScopeRows, error: workspaceCompanyScopeError } = await supabase
        .from("workspaces")
        .select("id, company_id")
        .in("id", workspaceIds);

      if (workspaceCompanyScopeError) {
        return NextResponse.json(
          { error: "Could not load workspace briefing policy scope", details: workspaceCompanyScopeError.message },
          { status: 500 },
        );
      }

      for (const row of (workspaceCompanyScopeRows ?? []) as WorkspaceCompanyScopeRow[]) {
        workspaceScopeById.set(row.id, {
          id: row.id,
          company_id: row.company_id,
          team_lead_daily_briefing_enabled: null,
        });
      }

      const companyIds = Array.from(
        new Set(
          (workspaceCompanyScopeRows ?? [])
            .map((row) => (row as WorkspaceCompanyScopeRow).company_id)
            .filter((value): value is string => typeof value === "string"),
        ),
      );

      if (companyIds.length > 0) {
        const { data: companyPolicyRows, error: companyPolicyError } = await supabase
          .from("email_ingestion_policies")
          .select("company_id, daily_briefing_enabled, daily_briefing_control")
          .in("company_id", companyIds);

        if (companyPolicyError) {
          if (!isPermissionDeniedError(companyPolicyError)) {
            return NextResponse.json(
              { error: "Could not load company briefing policy", details: companyPolicyError.message },
              { status: 500 },
            );
          }

          logSchedulerEvent("policy_read_skipped", {
            source: schedulerSource,
            reason: "permission_denied_email_ingestion_policies",
          });
        } else {
          for (const row of (companyPolicyRows ?? []) as CompanyBriefingPolicyRow[]) {
            companyPolicyByCompanyId.set(row.company_id, row);
          }
        }
      }

    } else {
      for (const row of (workspaceScopeRows ?? []) as WorkspacePolicyScopeRow[]) {
        workspaceScopeById.set(row.id, row);
      }

      const companyIds = Array.from(
        new Set(
          (workspaceScopeRows ?? [])
            .map((row) => (row as WorkspacePolicyScopeRow).company_id)
            .filter((value): value is string => typeof value === "string"),
        ),
      );

      if (companyIds.length > 0) {
        const { data: companyPolicyRows, error: companyPolicyError } = await supabase
          .from("email_ingestion_policies")
          .select("company_id, daily_briefing_enabled, daily_briefing_control")
          .in("company_id", companyIds);

        if (companyPolicyError) {
          if (!isPermissionDeniedError(companyPolicyError)) {
            return NextResponse.json(
              { error: "Could not load company briefing policy", details: companyPolicyError.message },
              { status: 500 },
            );
          }

          logSchedulerEvent("policy_read_skipped", {
            source: schedulerSource,
            reason: "permission_denied_email_ingestion_policies",
          });
        } else {
          for (const row of (companyPolicyRows ?? []) as CompanyBriefingPolicyRow[]) {
            companyPolicyByCompanyId.set(row.company_id, row);
          }
        }
      }
    }
  }

  const effectivePreferences = preferences.filter((preference) => {
    const workspaceScope = workspaceScopeById.get(preference.workspace_id) ?? null;
    const companyPolicy = workspaceScope?.company_id
      ? companyPolicyByCompanyId.get(workspaceScope.company_id) ?? null
      : null;

    return resolveDailyBriefingPolicy(companyPolicy, workspaceScope);
  });

  const profileIds = Array.from(new Set(effectivePreferences.map((row) => row.profile_id)));

  const profileById = new Map<string, ProfileRow>();

  if (profileIds.length > 0) {
    const { data: profileRows, error: profileError } = await supabase
      .from("profiles")
      .select("id, email, first_name, last_name")
      .in("id", profileIds);

    if (profileError) {
      return NextResponse.json({ error: "Could not load profile emails", details: profileError.message }, { status: 500 });
    }

    for (const row of (profileRows ?? []) as ProfileRow[]) {
      profileById.set(row.id, row);
    }
  }

  const counters = {
    scanned: preferences.length,
    skippedByPolicy: preferences.length - effectivePreferences.length,
    due: 0,
    inserted: 0,
    sent: 0,
    skippedNotDue: 0,
    skippedAlreadySent: 0,
    skippedNoRecipient: 0,
    skippedInsufficientCredits: 0,
    takeoverForwarded: 0,
    takeoverForwardFailures: 0,
    failed: 0,
  };

  const skippedReasons = {
    disabled_by_company_policy: preferences.length - effectivePreferences.length,
    weekday_not_selected: 0,
    send_time_not_reached: 0,
    already_sent_for_local_day: 0,
    missing_recipient_email: 0,
    insufficient_credits: 0,
  };

  const results: Array<Record<string, unknown>> = [];
  const absenceCache = new Map<string, AbsentProfileSummary[]>();
  const takeoverBriefingCache = new Map<string, TakeoverBriefingSnapshot | null>();

  const workspaceProfileByWorkspaceId = new Map<string, WorkspaceProfileRow[]>();

  if (workspaceIds.length > 0) {
    const { data: workspaceProfileRows, error: workspaceProfileError } = await supabase
      .from("profiles")
      .select("id, workspace_id, email, first_name, last_name")
      .in("workspace_id", workspaceIds);

    if (workspaceProfileError) {
      return NextResponse.json(
        { error: "Could not load workspace profiles for briefing delivery", details: workspaceProfileError.message },
        { status: 500 },
      );
    }

    for (const row of (workspaceProfileRows ?? []) as WorkspaceProfileRow[]) {
      const workspaceId = row.workspace_id;

      if (!workspaceId) {
        continue;
      }

      const bucket = workspaceProfileByWorkspaceId.get(workspaceId) ?? [];
      bucket.push(row);
      workspaceProfileByWorkspaceId.set(workspaceId, bucket);
    }
  }

  for (const preference of effectivePreferences) {
    const timezone = preference.timezone?.trim() || "Europe/Paris";
    const localDate = getLocalDateKey(now, timezone);
    const localWeekday = getLocalWeekday(now, timezone);
    const localMinutes = getLocalMinutes(now, timezone);
    const scheduledMinutes = parseTimeToMinutes(preference.send_time_local);
    const weekdays = Array.isArray(preference.send_weekdays) && preference.send_weekdays.length > 0
      ? preference.send_weekdays
      : [1, 2, 3, 4, 5];

    const isDueToday = weekdays.includes(localWeekday);
    const hasReachedSendTime = localMinutes >= scheduledMinutes;

    if (!isDueToday) {
      counters.skippedNotDue += 1;
      skippedReasons.weekday_not_selected += 1;
      continue;
    }

    if (!hasReachedSendTime) {
      counters.skippedNotDue += 1;
      skippedReasons.send_time_not_reached += 1;
      continue;
    }

    counters.due += 1;

    const dedupeKey = `${preference.workspace_id}:${preference.profile_id}:${localDate}`;
    const creditIdempotencyKey = `daily-briefing:${dedupeKey}`;
    const insertRun = await supabase.from("daily_briefing_runs").insert({
      workspace_id: preference.workspace_id,
      profile_id: preference.profile_id,
      preference_id: preference.id,
      scheduled_for_local_date: localDate,
      scheduled_weekday: localWeekday,
      scheduled_send_time_local: preference.send_time_local,
      scheduled_timezone: timezone,
      status: "pending",
      dedupe_key: dedupeKey,
      run_started_at: now.toISOString(),
      payload_metadata: {
        source: "scheduled_endpoint",
      },
    });

    if (insertRun.error) {
      if (isUniqueViolation(insertRun.error)) {
        counters.skippedAlreadySent += 1;
        skippedReasons.already_sent_for_local_day += 1;

        const { data: existingRun } = await supabase
          .from("daily_briefing_runs")
          .select("status, payload_metadata")
          .eq("workspace_id", preference.workspace_id)
          .eq("profile_id", preference.profile_id)
          .eq("scheduled_for_local_date", localDate)
          .order("run_started_at", { ascending: false })
          .limit(1)
          .maybeSingle<DailyBriefingRunRow>();

        if (existingRun?.status === "sent" && !hasStoredAIBriefing(existingRun.payload_metadata)) {
          try {
            const backfilledBriefing = await composeDailyBriefing({
              supabase,
              workspaceId: preference.workspace_id,
              profileId: preference.profile_id,
              timezone,
              language: preference.language,
              locale: preference.locale,
              now,
            });

            await supabase
              .from("daily_briefing_runs")
              .update({
                payload_metadata: {
                  ...(existingRun.payload_metadata ?? {}),
                  ai_briefing: buildStoredAiBriefingPayload(backfilledBriefing),
                  backfilled_at: new Date().toISOString(),
                },
              })
              .eq("workspace_id", preference.workspace_id)
              .eq("profile_id", preference.profile_id)
              .eq("scheduled_for_local_date", localDate);

            logSchedulerEvent("run_backfilled", {
              workspace_id: preference.workspace_id,
              profile_id: preference.profile_id,
              local_date: localDate,
              reason: "missing_ai_briefing_metadata",
            });
          } catch (backfillError) {
            logSchedulerEvent("run_backfill_failed", {
              workspace_id: preference.workspace_id,
              profile_id: preference.profile_id,
              local_date: localDate,
              reason: "missing_ai_briefing_metadata",
              details: normalizeErrorMessage(backfillError),
            });
          }
        } else if (existingRun?.status === "sent" && shouldRepairStoredFallback(existingRun.payload_metadata)) {
          try {
            const repairedBriefing = await composeDailyBriefing({
              supabase,
              workspaceId: preference.workspace_id,
              profileId: preference.profile_id,
              timezone,
              language: preference.language,
              locale: preference.locale,
              now,
            });

            await supabase
              .from("daily_briefing_runs")
              .update({
                payload_metadata: {
                  ...(existingRun.payload_metadata ?? {}),
                  ai_briefing: buildStoredAiBriefingPayload(repairedBriefing),
                  repaired_at: new Date().toISOString(),
                  repair_reason: "fallback_invalid_json",
                },
              })
              .eq("workspace_id", preference.workspace_id)
              .eq("profile_id", preference.profile_id)
              .eq("scheduled_for_local_date", localDate);

            logSchedulerEvent("run_repaired", {
              workspace_id: preference.workspace_id,
              profile_id: preference.profile_id,
              local_date: localDate,
              reason: "fallback_invalid_json",
              diagnostics_source: repairedBriefing.diagnostics.source,
              diagnostics_error: repairedBriefing.diagnostics.error,
            });
          } catch (repairError) {
            logSchedulerEvent("run_repair_failed", {
              workspace_id: preference.workspace_id,
              profile_id: preference.profile_id,
              local_date: localDate,
              reason: "fallback_invalid_json",
              details: normalizeErrorMessage(repairError),
            });
          }
        }

        logSchedulerEvent("run_skipped", {
          workspace_id: preference.workspace_id,
          profile_id: preference.profile_id,
          local_date: localDate,
          reason: "already_sent_for_local_day",
          timezone,
          scheduled_time_local: preference.send_time_local,
        });
        continue;
      }

      counters.failed += 1;
      logSchedulerEvent("run_failed", {
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        reason: "run_insert_failed",
        details: insertRun.error.message,
      });
      results.push({
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        status: "failed",
        reason: "run_insert_failed",
        details: insertRun.error.message,
      });
      continue;
    }

    counters.inserted += 1;

    const profile = profileById.get(preference.profile_id);
    const recipientEmail = profile?.email?.trim().toLowerCase() ?? "";
    const recipientName = [profile?.first_name ?? "", profile?.last_name ?? ""].join(" ").trim() || undefined;

    const absenceCacheKey = `${preference.workspace_id}:${localDate}`;
    let absentProfilesToday = absenceCache.get(absenceCacheKey);

    if (!absentProfilesToday) {
      absentProfilesToday = await loadAbsentProfilesForDate({
        supabase,
        workspaceId: preference.workspace_id,
        localDate,
        workspaceProfiles: workspaceProfileByWorkspaceId.get(preference.workspace_id) ?? [],
      });
      absenceCache.set(absenceCacheKey, absentProfilesToday);
    }

    const isRecipientAbsentToday = absentProfilesToday.some((entry) => entry.profileId === preference.profile_id);

    const { data: deductionData, error: deductionError } = await supabase.rpc(
      "deduct_workspace_credit",
      {
        p_workspace_id: preference.workspace_id,
        p_amount: actionConfig.creditCost,
        p_action: actionType,
        p_idempotency_key: creditIdempotencyKey,
        p_metadata: {
          actionType,
          source: "daily_briefing_scheduler",
          profile_id: preference.profile_id,
          billed_user_id: preference.profile_id,
          scheduled_for_local_date: localDate,
        },
      },
    );

    if (deductionError || !deductionData) {
      if (isInsufficientCreditsError(deductionError)) {
        counters.skippedInsufficientCredits += 1;
        skippedReasons.insufficient_credits += 1;

        await supabase
          .from("daily_briefing_runs")
          .update({
            status: "skipped",
            failure_code: "insufficient_credits",
            failure_message: normalizeErrorMessage(deductionError),
            payload_metadata: {
              source: "scheduled_endpoint",
              skipped_reason: "insufficient_credits",
              required_credits: actionConfig.creditCost,
            },
          })
          .eq("workspace_id", preference.workspace_id)
          .eq("profile_id", preference.profile_id)
          .eq("scheduled_for_local_date", localDate);

        logSchedulerEvent("run_skipped", {
          workspace_id: preference.workspace_id,
          profile_id: preference.profile_id,
          local_date: localDate,
          reason: "insufficient_credits",
          required_credits: actionConfig.creditCost,
        });

        results.push({
          workspace_id: preference.workspace_id,
          profile_id: preference.profile_id,
          local_date: localDate,
          status: "skipped",
          reason: "insufficient_credits",
          required_credits: actionConfig.creditCost,
        });

        continue;
      }

      counters.failed += 1;

      await supabase
        .from("daily_briefing_runs")
        .update({
          status: "failed",
          failure_code: "credit_deduction_failed",
          failure_message: normalizeErrorMessage(deductionError),
          payload_metadata: {
            source: "scheduled_endpoint",
            failure_scope: "billing",
          },
        })
        .eq("workspace_id", preference.workspace_id)
        .eq("profile_id", preference.profile_id)
        .eq("scheduled_for_local_date", localDate);

      logSchedulerEvent("run_failed", {
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        reason: "credit_deduction_failed",
        details: normalizeErrorMessage(deductionError),
      });

      results.push({
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        status: "failed",
        reason: "credit_deduction_failed",
        details: normalizeErrorMessage(deductionError),
      });

      continue;
    }

    const deduction = deductionData as CreditMutationResult;

    let briefing;

    try {
      briefing = await composeDailyBriefing({
        supabase,
        workspaceId: preference.workspace_id,
        profileId: preference.profile_id,
        timezone,
        language: preference.language,
        locale: preference.locale,
        now,
      });

      const absentCoworkersToday = absentProfilesToday.filter((entry) => entry.profileId !== preference.profile_id);

      briefing.aiBriefing.briefing = appendAbsenceNotification({
        baseBriefing: briefing.aiBriefing.briefing,
        absentProfiles: absentCoworkersToday,
        language: briefing.language,
      });

      const takeoverBriefings = await loadTakeoverBriefingsForRecipient({
        supabase,
        workspaceId: preference.workspace_id,
        localDate,
        timezone,
        language: briefing.language,
        locale: preference.locale,
        absentCoworkers: absentCoworkersToday,
        cache: takeoverBriefingCache,
      });

      briefing.aiBriefing.briefing = appendTakeoverSections({
        baseBriefing: briefing.aiBriefing.briefing,
        takeoverBriefings,
        language: briefing.language,
      });
    } catch (error) {
      counters.failed += 1;

      const { error: refundError } = await supabase.rpc("refund_workspace_credit", {
        p_workspace_id: preference.workspace_id,
        p_amount: actionConfig.creditCost,
        p_action: actionType,
        p_idempotency_key: creditIdempotencyKey,
        p_metadata: {
          actionType,
          source: "daily_briefing_scheduler",
          profile_id: preference.profile_id,
          reason: "compose_failed",
        },
      });

      await supabase
        .from("daily_briefing_runs")
        .update({
          status: "failed",
          failure_code: "compose_failed",
          failure_message: normalizeErrorMessage(error),
          payload_metadata: {
            source: "scheduled_endpoint",
            failure_scope: "compose",
            credits_refunded: !refundError,
            refund_error: refundError ? normalizeErrorMessage(refundError) : null,
          },
        })
        .eq("workspace_id", preference.workspace_id)
        .eq("profile_id", preference.profile_id)
        .eq("scheduled_for_local_date", localDate);

      logSchedulerEvent("run_failed", {
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        reason: "compose_failed",
        details: normalizeErrorMessage(error),
        credits_refunded: !refundError,
      });

      results.push({
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        status: "failed",
        reason: "compose_failed",
        details: normalizeErrorMessage(error),
        creditsRefunded: !refundError,
      });

      continue;
    }

    if (!preference.include_email_delivery) {
      counters.sent += 1;

      await supabase
        .from("daily_briefing_runs")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          payload_metadata: {
            source: "scheduled_endpoint",
            delivery_channels: ["dashboard"],
            ai_briefing: buildStoredAiBriefingPayload(briefing),
            section_counts: {
              assigned_follow_ups_due_today: briefing.sections.assignedFollowUpsDueToday.length,
              assigned_high_priority_contacts: briefing.sections.assignedHighPriorityContacts.length,
              todays_meetings_and_visits: briefing.sections.todaysTimelineMeetingsAndVisits.length,
              todays_email_summaries: briefing.sections.todaysEmailSummaries.length,
            },
            credits_used: actionConfig.creditCost,
            billing_mode: deduction.billing_mode ?? null,
            billed_user_id: deduction.billed_user_id ?? null,
            billing_transaction_id: deduction.transaction_id,
            balance_after_charge: deduction.balance,
            absent_profiles_today: absentProfilesToday.map((entry) => ({
              profile_id: entry.profileId,
              first_name: entry.firstName,
              last_name: entry.lastName,
            })),
          },
        })
        .eq("workspace_id", preference.workspace_id)
        .eq("profile_id", preference.profile_id)
        .eq("scheduled_for_local_date", localDate);

      logSchedulerEvent("run_sent", {
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        timezone: briefing.timezone,
        language: briefing.language,
        delivery_channels: ["dashboard"],
      });

      results.push({
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        status: "sent",
        delivery_channels: ["dashboard"],
        credits_used: actionConfig.creditCost,
        billing_transaction_id: deduction.transaction_id,
      });

      continue;
    }

    if (!recipientEmail) {
      counters.skippedNoRecipient += 1;
      skippedReasons.missing_recipient_email += 1;

      await supabase
        .from("daily_briefing_runs")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          payload_metadata: {
            source: "scheduled_endpoint",
            delivery_channels: ["dashboard"],
            skipped_email_reason: "missing_recipient_email",
            ai_briefing: buildStoredAiBriefingPayload(briefing),
            section_counts: {
              assigned_follow_ups_due_today: briefing.sections.assignedFollowUpsDueToday.length,
              assigned_high_priority_contacts: briefing.sections.assignedHighPriorityContacts.length,
              todays_meetings_and_visits: briefing.sections.todaysTimelineMeetingsAndVisits.length,
              todays_email_summaries: briefing.sections.todaysEmailSummaries.length,
            },
            credits_used: actionConfig.creditCost,
            billing_mode: deduction.billing_mode ?? null,
            billed_user_id: deduction.billed_user_id ?? null,
            billing_transaction_id: deduction.transaction_id,
            balance_after_charge: deduction.balance,
            absent_profiles_today: absentProfilesToday.map((entry) => ({
              profile_id: entry.profileId,
              first_name: entry.firstName,
              last_name: entry.lastName,
            })),
          },
        })
        .eq("workspace_id", preference.workspace_id)
        .eq("profile_id", preference.profile_id)
        .eq("scheduled_for_local_date", localDate);

      logSchedulerEvent("run_sent", {
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        reason: "missing_recipient_email",
        delivery_channels: ["dashboard"],
      });

      results.push({
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        status: "sent",
        reason: "missing_recipient_email",
        delivery_channels: ["dashboard"],
        credits_used: actionConfig.creditCost,
        billing_transaction_id: deduction.transaction_id,
      });

      continue;
    }

    try {
      const payload = buildDailyBriefingEmailPayload({
        recipientEmail,
        recipientName,
        workspaceName: briefing.sections.workspaceSnapshot.workspaceName,
        localDate: briefing.localDate,
        timezone: briefing.timezone,
        language: briefing.language,
        headline: briefing.aiBriefing.headline,
        briefing: briefing.aiBriefing.briefing,
        workspacePulse: briefing.aiBriefing.workspacePulse,
        topActions: briefing.aiBriefing.topActions,
      });

      const sendResult = await sendTransactionalEmailWithSmtp(payload);

      counters.sent += 1;

      await supabase
        .from("daily_briefing_runs")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          payload_metadata: {
            source: "scheduled_endpoint",
            message_id: sendResult.messageId,
            delivery_channels: ["dashboard", "email"],
            ai_briefing: buildStoredAiBriefingPayload(briefing),
            section_counts: {
              assigned_follow_ups_due_today: briefing.sections.assignedFollowUpsDueToday.length,
              assigned_high_priority_contacts: briefing.sections.assignedHighPriorityContacts.length,
              todays_meetings_and_visits: briefing.sections.todaysTimelineMeetingsAndVisits.length,
              todays_email_summaries: briefing.sections.todaysEmailSummaries.length,
            },
            credits_used: actionConfig.creditCost,
            billing_mode: deduction.billing_mode ?? null,
            billed_user_id: deduction.billed_user_id ?? null,
            billing_transaction_id: deduction.transaction_id,
            balance_after_charge: deduction.balance,
            absent_profiles_today: absentProfilesToday.map((entry) => ({
              profile_id: entry.profileId,
              first_name: entry.firstName,
              last_name: entry.lastName,
            })),
          },
        })
        .eq("workspace_id", preference.workspace_id)
        .eq("profile_id", preference.profile_id)
        .eq("scheduled_for_local_date", localDate);

      logSchedulerEvent("run_sent", {
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        timezone: briefing.timezone,
        language: briefing.language,
        delivery_channels: ["dashboard", "email"],
        section_counts: {
          assigned_follow_ups_due_today: briefing.sections.assignedFollowUpsDueToday.length,
          assigned_high_priority_contacts: briefing.sections.assignedHighPriorityContacts.length,
          todays_meetings_and_visits: briefing.sections.todaysTimelineMeetingsAndVisits.length,
          todays_email_summaries: briefing.sections.todaysEmailSummaries.length,
        },
      });

      results.push({
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        status: "sent",
        delivery_channels: ["dashboard", "email"],
        credits_used: actionConfig.creditCost,
        billing_transaction_id: deduction.transaction_id,
      });
    } catch (error) {
      counters.failed += 1;

      await supabase
        .from("daily_briefing_runs")
        .update({
          status: "failed",
          failure_code: "compose_or_send_failed",
          failure_message: normalizeErrorMessage(error),
          payload_metadata: {
            source: "scheduled_endpoint",
            failure_scope: "send",
            credits_refunded: false,
            credits_used: actionConfig.creditCost,
            billing_transaction_id: deduction.transaction_id,
          },
        })
        .eq("workspace_id", preference.workspace_id)
        .eq("profile_id", preference.profile_id)
        .eq("scheduled_for_local_date", localDate);

      logSchedulerEvent("run_failed", {
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        reason: "compose_or_send_failed",
        details: normalizeErrorMessage(error),
      });

      results.push({
        workspace_id: preference.workspace_id,
        profile_id: preference.profile_id,
        local_date: localDate,
        status: "failed",
        reason: "send_failed",
        details: normalizeErrorMessage(error),
        creditsRefunded: false,
        creditsUsed: actionConfig.creditCost,
      });
    }
  }

  logSchedulerEvent("run_completed", {
    source: schedulerSource,
    ran_at: now.toISOString(),
    counters,
    skipped_reasons: skippedReasons,
  });

  return NextResponse.json({
    ok: true,
    ranAt: now.toISOString(),
    counters,
    skippedReasons,
    results,
  });
}

async function loadAbsentProfilesForDate(params: {
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>;
  workspaceId: string;
  localDate: string;
  workspaceProfiles: WorkspaceProfileRow[];
}): Promise<AbsentProfileSummary[]> {
  const { data, error } = await params.supabase
    .from("workspace_absences")
    .select("profile_id, starts_on, ends_on, status")
    .eq("workspace_id", params.workspaceId)
    .eq("status", "confirmed")
    .lte("starts_on", params.localDate)
    .gte("ends_on", params.localDate);

  if (error) {
    logSchedulerEvent("absence_lookup_failed", {
      workspace_id: params.workspaceId,
      local_date: params.localDate,
      details: error.message,
    });

    return [];
  }

  const absentRows = (data ?? []) as WorkspaceAbsenceRow[];

  if (absentRows.length === 0) {
    return [];
  }

  const profileById = new Map<string, WorkspaceProfileRow>();

  for (const row of params.workspaceProfiles) {
    profileById.set(row.id, row);
  }

  const absentProfiles: AbsentProfileSummary[] = [];
  const seen = new Set<string>();

  for (const row of absentRows) {
    if (!row.profile_id || seen.has(row.profile_id)) {
      continue;
    }

    seen.add(row.profile_id);

    const profile = profileById.get(row.profile_id);

    absentProfiles.push({
      profileId: row.profile_id,
      firstName: profile?.first_name ?? null,
      lastName: profile?.last_name ?? null,
      email: profile?.email ?? null,
    });
  }

  return absentProfiles;
}

function appendAbsenceNotification(params: {
  baseBriefing: string;
  absentProfiles: AbsentProfileSummary[];
  language: string;
}) {
  if (params.absentProfiles.length === 0) {
    return params.baseBriefing;
  }

  const absentNames = params.absentProfiles.map((profile) => formatProfileName(profile.firstName, profile.lastName));
  const localized = getTakeoverLocaleStrings(params.language);
  const summary = Array.from(new Set(absentNames)).join(", ");
  const notice = localized.absenceAlert(summary);

  return `${params.baseBriefing}\n\n${notice}`;
}

async function loadTakeoverBriefingsForRecipient(params: {
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>;
  workspaceId: string;
  localDate: string;
  timezone: string;
  language: string;
  locale: string | null;
  absentCoworkers: AbsentProfileSummary[];
  cache: Map<string, TakeoverBriefingSnapshot | null>;
}) {
  if (params.absentCoworkers.length === 0) {
    return [] as TakeoverBriefingSnapshot[];
  }

  const takeovers: TakeoverBriefingSnapshot[] = [];

  for (const absent of params.absentCoworkers) {
    const cacheKey = [
      params.workspaceId,
      params.localDate,
      absent.profileId,
      params.timezone,
      params.language,
      params.locale ?? "",
    ].join(":");

    let cached = params.cache.get(cacheKey);

    if (cached === undefined) {
      try {
        const absentBriefing = await composeDailyBriefing({
          supabase: params.supabase,
          workspaceId: params.workspaceId,
          profileId: absent.profileId,
          timezone: params.timezone,
          language: params.language,
          locale: params.locale,
          now: new Date(),
        });

        cached = {
          absentProfileId: absent.profileId,
          absentDisplayName: formatProfileName(absent.firstName, absent.lastName),
          headline: absentBriefing.aiBriefing.headline,
          briefing: absentBriefing.aiBriefing.briefing,
          workspacePulse: absentBriefing.aiBriefing.workspacePulse,
          topActions: absentBriefing.aiBriefing.topActions,
        };
      } catch (error) {
        cached = null;
        logSchedulerEvent("takeover_briefing_compose_failed", {
          workspace_id: params.workspaceId,
          local_date: params.localDate,
          absent_profile_id: absent.profileId,
          details: normalizeErrorMessage(error),
        });
      }

      params.cache.set(cacheKey, cached);
    }

    if (cached) {
      takeovers.push(cached);
    }
  }

  return takeovers;
}

function appendTakeoverSections(params: {
  baseBriefing: string;
  takeoverBriefings: TakeoverBriefingSnapshot[];
  language: string;
}) {
  if (params.takeoverBriefings.length === 0) {
    return params.baseBriefing;
  }

  const localized = getTakeoverLocaleStrings(params.language);

  const blocks = params.takeoverBriefings.map((takeover) => {
    const actionsBlock =
      takeover.topActions.length > 0
        ? takeover.topActions
            .map((action, index) => {
              const duePart = action.dueHint ? ` (${localized.dueLabel}: ${action.dueHint})` : "";
              return `${index + 1}. ${action.title} - ${action.reason}${duePart}`;
            })
            .join("\n")
        : localized.noTopActions;

    return [
      localized.takeoverSectionMarker,
      localized.takeoverHeading(takeover.absentDisplayName),
      `${localized.headlineLabel}: ${takeover.headline}`,
      `${localized.briefingLabel}: ${takeover.briefing}`,
      `${localized.topActionsLabel}:`,
      actionsBlock,
      `${localized.workspacePulseLabel}: ${takeover.workspacePulse}`,
      localized.takeoverSectionMarker,
    ].join("\n");
  });

  return `${params.baseBriefing}\n\n${localized.takeoverIntro}\n\n${blocks.join("\n\n")}`;
}

function normalizeLanguageCode(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized) {
    return "en";
  }

  const twoLetter = normalized.slice(0, 2);
  return /^[a-z]{2}$/.test(twoLetter) ? twoLetter : "en";
}

function getTakeoverLocaleStrings(languageCode: string) {
  const language = normalizeLanguageCode(languageCode);

  if (language === "fr") {
    return {
      absenceAlert: (names: string) => `Alerte absence: ${names} est/sont absent(s) aujourd'hui.`,
      takeoverIntro: "Prise en charge de l'equipe (absences du jour):",
      takeoverSectionMarker: "=== PRISE EN CHARGE ===",
      takeoverHeading: (name: string) => `Dossier de prise en charge - ${name}`,
      headlineLabel: "Titre",
      briefingLabel: "Briefing",
      topActionsLabel: "Actions prioritaires",
      workspacePulseLabel: "Pulse de l'espace",
      dueLabel: "echeance",
      noTopActions: "Aucune action prioritaire identifiee.",
    };
  }

  if (language === "de") {
    return {
      absenceAlert: (names: string) => `Abwesenheitsmeldung: ${names} ist/sind heute abwesend.`,
      takeoverIntro: "Team-Uebernahme (heutige Abwesenheiten):",
      takeoverSectionMarker: "=== UEBERNAHME ===",
      takeoverHeading: (name: string) => `Uebernahme-Briefing - ${name}`,
      headlineLabel: "Ueberschrift",
      briefingLabel: "Briefing",
      topActionsLabel: "Top-Aktionen",
      workspacePulseLabel: "Workspace-Puls",
      dueLabel: "faellig",
      noTopActions: "Keine prioritaeren Aktionen erkannt.",
    };
  }

  if (language === "es") {
    return {
      absenceAlert: (names: string) => `Aviso de ausencia: ${names} esta(n) ausente(s) hoy.`,
      takeoverIntro: "Cobertura del equipo (ausencias de hoy):",
      takeoverSectionMarker: "=== COBERTURA ===",
      takeoverHeading: (name: string) => `Briefing de cobertura - ${name}`,
      headlineLabel: "Titular",
      briefingLabel: "Resumen",
      topActionsLabel: "Acciones prioritarias",
      workspacePulseLabel: "Pulso del espacio",
      dueLabel: "vence",
      noTopActions: "No se identificaron acciones urgentes.",
    };
  }

  if (language === "it") {
    return {
      absenceAlert: (names: string) => `Avviso assenza: ${names} e/sono assente/i oggi.`,
      takeoverIntro: "Copertura team (assenze di oggi):",
      takeoverSectionMarker: "=== COPERTURA ===",
      takeoverHeading: (name: string) => `Briefing di copertura - ${name}`,
      headlineLabel: "Titolo",
      briefingLabel: "Briefing",
      topActionsLabel: "Azioni prioritarie",
      workspacePulseLabel: "Pulse workspace",
      dueLabel: "scadenza",
      noTopActions: "Nessuna azione prioritaria individuata.",
    };
  }

  if (language === "pt") {
    return {
      absenceAlert: (names: string) => `Aviso de ausencia: ${names} esta(o) ausente(s) hoje.`,
      takeoverIntro: "Cobertura da equipa (ausencias de hoje):",
      takeoverSectionMarker: "=== COBERTURA ===",
      takeoverHeading: (name: string) => `Briefing de cobertura - ${name}`,
      headlineLabel: "Titulo",
      briefingLabel: "Briefing",
      topActionsLabel: "Acoes prioritarias",
      workspacePulseLabel: "Pulso do workspace",
      dueLabel: "prazo",
      noTopActions: "Nenhuma acao prioritaria identificada.",
    };
  }

  if (language === "nl") {
    return {
      absenceAlert: (names: string) => `Afwezigheidsmelding: ${names} is/zijn vandaag afwezig.`,
      takeoverIntro: "Teamovername (afwezigheden van vandaag):",
      takeoverSectionMarker: "=== OVERNAME ===",
      takeoverHeading: (name: string) => `Overname-briefing - ${name}`,
      headlineLabel: "Kop",
      briefingLabel: "Briefing",
      topActionsLabel: "Topacties",
      workspacePulseLabel: "Workspace-puls",
      dueLabel: "verval",
      noTopActions: "Geen urgente acties gevonden.",
    };
  }

  if (language === "pl") {
    return {
      absenceAlert: (names: string) => `Powiadomienie o nieobecnosci: ${names} jest/sa dzisiaj nieobecni.`,
      takeoverIntro: "Przejecie zespolowe (dzisiejsze nieobecnosci):",
      takeoverSectionMarker: "=== PRZEJECIE ===",
      takeoverHeading: (name: string) => `Briefing przejecia - ${name}`,
      headlineLabel: "Naglowek",
      briefingLabel: "Briefing",
      topActionsLabel: "Najwazniejsze dzialania",
      workspacePulseLabel: "Pulse workspace",
      dueLabel: "termin",
      noTopActions: "Brak pilnych dzialan.",
    };
  }

  if (language === "sv") {
    return {
      absenceAlert: (names: string) => `Franvaronotis: ${names} ar franvarande idag.`,
      takeoverIntro: "Teamoverlamning (dagens franvaro):",
      takeoverSectionMarker: "=== OEVERLAMNING ===",
      takeoverHeading: (name: string) => `Overlamningsbriefing - ${name}`,
      headlineLabel: "Rubrik",
      briefingLabel: "Briefing",
      topActionsLabel: "Toppatgarder",
      workspacePulseLabel: "Workspace-puls",
      dueLabel: "forfall",
      noTopActions: "Inga prioriterade atgarder identifierades.",
    };
  }

  if (language === "da") {
    return {
      absenceAlert: (names: string) => `Fravaersnote: ${names} er fravaerende i dag.`,
      takeoverIntro: "Team-overtagelse (dagens fravaer):",
      takeoverSectionMarker: "=== OVERTAGELSE ===",
      takeoverHeading: (name: string) => `Overtagelsesbriefing - ${name}`,
      headlineLabel: "Overskrift",
      briefingLabel: "Briefing",
      topActionsLabel: "Tophandlinger",
      workspacePulseLabel: "Workspace-puls",
      dueLabel: "forfalder",
      noTopActions: "Ingen prioriterede handlinger identificeret.",
    };
  }

  if (language === "fi") {
    return {
      absenceAlert: (names: string) => `Poissaoloilmoitus: ${names} on/ovat poissa tanaan.`,
      takeoverIntro: "Tiimin sijaisuus (taman paivan poissaolot):",
      takeoverSectionMarker: "=== SIJAISUUS ===",
      takeoverHeading: (name: string) => `Sijaisuusbriefing - ${name}`,
      headlineLabel: "Otsikko",
      briefingLabel: "Briefing",
      topActionsLabel: "Tarkeimmat toimet",
      workspacePulseLabel: "Workspace-pulssi",
      dueLabel: "eraantyy",
      noTopActions: "Ei tunnistettuja prioriteettitoimia.",
    };
  }

  if (language === "nb") {
    return {
      absenceAlert: (names: string) => `Fravaersvarsel: ${names} er fravaerende i dag.`,
      takeoverIntro: "Team-overtakelse (dagens fravaer):",
      takeoverSectionMarker: "=== OVERTAKELSE ===",
      takeoverHeading: (name: string) => `Overtakelsesbriefing - ${name}`,
      headlineLabel: "Overskrift",
      briefingLabel: "Briefing",
      topActionsLabel: "Toppoppgaver",
      workspacePulseLabel: "Workspace-puls",
      dueLabel: "forfaller",
      noTopActions: "Ingen prioriterte oppgaver ble identifisert.",
    };
  }

  return {
    absenceAlert: (names: string) => `Absence alert: ${names} is/are marked absent today.`,
    takeoverIntro: "Team takeover (today's absences):",
    takeoverSectionMarker: "=== TAKEOVER ===",
    takeoverHeading: (name: string) => `Takeover briefing - ${name}`,
    headlineLabel: "Headline",
    briefingLabel: "Briefing",
    topActionsLabel: "Top actions",
    workspacePulseLabel: "Workspace pulse",
    dueLabel: "due",
    noTopActions: "No urgent action item was identified.",
  };
}

function formatProfileName(firstName: string | null, lastName: string | null) {
  const fullName = [firstName ?? "", lastName ?? ""].join(" ").trim();
  return fullName || "Unnamed coworker";
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

function isCronAuthorized(request: NextRequest, expectedSecret: string) {
  const headerSecret = request.headers.get("x-daily-briefing-secret")?.trim();

  if (headerSecret && headerSecret === expectedSecret) {
    return true;
  }

  const authHeader = request.headers.get("authorization")?.trim();
  const bearerPrefix = "Bearer ";

  if (authHeader?.startsWith(bearerPrefix)) {
    const token = authHeader.slice(bearerPrefix.length).trim();
    return token === expectedSecret;
  }

  return false;
}

function parseTimeToMinutes(value: string) {
  const [hoursText, minutesText] = value.split(":");
  const hours = Number.parseInt(hoursText ?? "0", 10);
  const minutes = Number.parseInt(minutesText ?? "0", 10);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return 0;
  }

  return Math.max(0, Math.min(23, hours)) * 60 + Math.max(0, Math.min(59, minutes));
}

function getLocalDateKey(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getLocalMinutes(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hourText = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minuteText = parts.find((part) => part.type === "minute")?.value ?? "00";
  const hours = Number.parseInt(hourText, 10);
  const minutes = Number.parseInt(minuteText, 10);

  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return 0;
  }

  return hours * 60 + minutes;
}

function getLocalWeekday(date: Date, timeZone: string) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return map[weekday] ?? 0;
}

function isUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";

  return code === "23505" || message.toLowerCase().includes("duplicate key");
}

function normalizeErrorMessage(error: unknown) {
  const value = error instanceof Error ? error.message : "Unexpected daily briefing error";
  const trimmed = value.trim();

  if (trimmed.length <= 1000) {
    return trimmed;
  }

  return `${trimmed.slice(0, 997)}...`;
}

function isInsufficientCreditsError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const message = "message" in error ? String(error.message).toLowerCase() : "";

  return message.includes("insufficient credit") || message.includes("insufficient credits");
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

function logSchedulerEvent(event: string, payload: Record<string, unknown>) {
  if (!shouldLogSchedulerEvents()) {
    return;
  }

  console.info(
    JSON.stringify({
      component: "daily_briefing_scheduler",
      event,
      ...payload,
    }),
  );
}

function shouldLogSchedulerEvents() {
  const raw = process.env.LOG_DAILY_BRIEFING_SCHEDULER?.trim().toLowerCase();

  if (raw === "true" || raw === "1" || raw === "yes") {
    return true;
  }

  if (raw === "false" || raw === "0" || raw === "no") {
    return false;
  }

  return process.env.NODE_ENV !== "production";
}

function hasStoredAIBriefing(payload: Record<string, unknown> | null | undefined) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const aiBriefing = payload.ai_briefing;
  return !!aiBriefing && typeof aiBriefing === "object";
}

function shouldRepairStoredFallback(payload: Record<string, unknown> | null | undefined) {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const aiBriefing = payload.ai_briefing;

  if (!aiBriefing || typeof aiBriefing !== "object") {
    return false;
  }

  const source = aiBriefing as Record<string, unknown>;
  const diagnosticsSource = typeof source.diagnostics_source === "string" ? source.diagnostics_source : "";
  const diagnosticsError = typeof source.diagnostics_error === "string" ? source.diagnostics_error.toLowerCase() : "";

  return diagnosticsSource === "fallback" && diagnosticsError.includes("invalid json");
}

function buildStoredAiBriefingPayload(briefing: Awaited<ReturnType<typeof composeDailyBriefing>>) {
  return {
    headline: briefing.aiBriefing.headline,
    briefing: briefing.aiBriefing.briefing,
    top_actions: briefing.aiBriefing.topActions.map((action) => ({
      title: action.title,
      reason: action.reason,
      due_hint: action.dueHint,
    })),
    workspace_pulse: briefing.aiBriefing.workspacePulse,
    local_date: briefing.localDate,
    timezone: briefing.timezone,
    language: briefing.language,
    diagnostics_source: briefing.diagnostics.source,
    diagnostics_error: briefing.diagnostics.error,
    stage_counts: briefing.sections.workspaceSnapshot.stageCounts,
  };
}

function isMissingWorkspaceTeamLeadBriefingColumn(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message).toLowerCase() : "";

  return code === "42703" || message.includes("team_lead_daily_briefing_enabled") || message.includes("column");
}

function isPermissionDeniedError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message).toLowerCase() : "";

  return code === "42501" || message.includes("permission denied");
}
