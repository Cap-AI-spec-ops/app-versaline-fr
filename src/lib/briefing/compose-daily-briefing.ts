import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { resolveMarketContext } from "@/lib/market/context";

type AiProvider = "anthropic" | "gemini" | "mistral" | "xai";
const DAILY_BRIEFING_ACTION_TYPE = "daily_briefing";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DAILY_BRIEFING_PROVIDER_TIMEOUT_MS = Number.parseInt(
  process.env.DAILY_BRIEFING_PROVIDER_TIMEOUT_MS ?? "90000",
  10,
);
type ContactStage = "new_lead" | "qualified" | "viewing" | "negotiating" | "closed_won" | "archived" | "closed_lost";
type TimelineEventType = "note" | "call" | "email" | "meeting" | "visit" | "status_change" | "created" | "email_summary";

type AiModelSettingRow = {
  action_type: string;
  provider: string | null;
  model: string | null;
  text_provider: string | null;
  text_model: string | null;
};

type WorkspaceRow = {
  id: string;
  name: string;
  currency: string | null;
  default_country_code: string | null;
  default_locale: string | null;
  default_language: string | null;
  default_timezone: string | null;
};

type ContactRow = {
  id: string;
  first_name: string;
  last_name: string;
  stage: ContactStage;
  priority: string;
  next_follow_up_at: string | null;
  updated_at: string;
};

type ContactAssigneeRow = {
  contact_id: string;
};

type CrmEventRow = {
  id: string;
  contact_id: string;
  event_type: string;
  title: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
  created_by: string | null;
};

type EmailSummaryRow = {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  created_by: string | null;
  summary_text: string;
  triage_reason_code: string | null;
  triage_confidence: number | null;
  metadata: Record<string, unknown> | null;
  received_at: string;
  created_at: string;
};

type ContactNameRow = {
  id: string;
  first_name: string;
  last_name: string;
};

export type BriefingContactItem = {
  id: string;
  name: string;
  stage: ContactStage;
  priority: string;
  nextFollowUpAt: string | null;
  updatedAt: string;
};

export type BriefingTimelineItem = {
  id: string;
  contactId: string;
  contactName: string;
  eventType: TimelineEventType;
  title: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
  createdAt: string;
  createdBy: string | null;
};

export type BriefingEmailSummaryItem = {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  created_by: string | null;
  summary_text: string;
  triage_reason_code: string | null;
  triage_confidence: number | null;
  metadata: Record<string, unknown> | null;
  received_at: string;
  created_at: string;
  contact_name: string;
};

export type BriefingWorkspaceSnapshot = {
  workspaceName: string;
  currency: string;
  activeContactsCount: number;
  highPriorityCount: number;
  followUpCountNext7Days: number;
  latestActivityAt: string | null;
  stageCounts: Array<{
    key: "new_lead" | "qualified" | "viewing" | "negotiating" | "closed_won";
    label: string;
    count: number;
  }>;
};

export type AIDailyBriefing = {
  headline: string;
  briefing: string;
  topActions: Array<{
    title: string;
    reason: string;
    dueHint: string | null;
  }>;
  workspacePulse: string;
};

export type DailyBriefingComposition = {
  workspaceId: string;
  profileId: string;
  timezone: string;
  language: string;
  locale: string;
  localDate: string;
  generatedAt: string;
  aiBriefing: AIDailyBriefing;
  diagnostics: {
    source: "ai" | "fallback";
    provider: AiProvider;
    model: string;
    error: string | null;
  };
  sections: {
    assignedFollowUpsDueToday: BriefingContactItem[];
    assignedFollowUpsOverdue: BriefingContactItem[];
    assignedHighPriorityContacts: BriefingContactItem[];
    todaysTimelineMeetingsAndVisits: BriefingTimelineItem[];
    todaysEmailSummaries: BriefingEmailSummaryItem[];
    todaysMergedTimeline: BriefingTimelineItem[];
    workspaceSnapshot: BriefingWorkspaceSnapshot;
  };
};

type DailyBriefingAiResult = {
  briefing: AIDailyBriefing;
  diagnostics: DailyBriefingComposition["diagnostics"];
};

export async function composeDailyBriefing(options: {
  supabase: SupabaseClient;
  workspaceId: string;
  profileId: string;
  timezone?: string | null;
  language?: string | null;
  locale?: string | null;
  now?: Date;
  assignedFollowUpLimit?: number;
  assignedHighPriorityLimit?: number;
  timelineLimit?: number;
  summaryLimit?: number;
}): Promise<DailyBriefingComposition> {
  const now = options.now ?? new Date();
  const assignedFollowUpLimit = options.assignedFollowUpLimit ?? 12;
  const assignedHighPriorityLimit = options.assignedHighPriorityLimit ?? 12;
  const timelineLimit = options.timelineLimit ?? 20;
  const summaryLimit = options.summaryLimit ?? 20;

  const { data: workspaceRow, error: workspaceError } = await options.supabase
    .from("workspaces")
    .select("id, name, currency, default_country_code, default_locale, default_language, default_timezone")
    .eq("id", options.workspaceId)
    .maybeSingle<WorkspaceRow>();

  if (workspaceError) {
    throw new Error(`Could not load workspace for briefing: ${workspaceError.message}`);
  }

  if (!workspaceRow) {
    throw new Error("Workspace not found for briefing.");
  }

  const marketContext = resolveMarketContext({
    workspaceDefaults: {
      default_country_code: workspaceRow.default_country_code,
      default_locale: workspaceRow.default_locale,
      default_language: workspaceRow.default_language,
      default_timezone: workspaceRow.default_timezone,
    },
    overrides: {
      timezone: options.timezone?.trim() || undefined,
      language: options.language?.trim() || undefined,
      locale: options.locale?.trim() || undefined,
    },
  });

  const timezone = marketContext.timezone;
  const language = normalizeLanguageCode(marketContext.language);
  const locale = marketContext.locale;
  const localDateKey = getLocalDateKey(now, timezone);

  const [assignedContactIdsResult, workspaceContactsResult, workspaceEventsResult, timelineEventsResult, emailSummariesResult] =
    await Promise.all([
      options.supabase
        .from("crm_contact_assignees")
        .select("contact_id")
        .eq("workspace_id", options.workspaceId)
        .eq("profile_id", options.profileId)
        .limit(1000),
      options.supabase
        .from("crm_contacts")
        .select("id, first_name, last_name, stage, priority, next_follow_up_at, updated_at")
        .eq("workspace_id", options.workspaceId)
        .neq("stage", "archived")
        .neq("stage", "closed_lost")
        .order("updated_at", { ascending: false }),
      options.supabase
        .from("crm_contact_events")
        .select("id, contact_id, event_type, title, occurred_at")
        .eq("workspace_id", options.workspaceId)
        .order("occurred_at", { ascending: false })
        .limit(5),
      options.supabase
        .from("crm_contact_events")
        .select("id, contact_id, event_type, title, body, metadata, occurred_at, created_at, created_by")
        .eq("workspace_id", options.workspaceId)
        .in("event_type", ["meeting", "visit"])
        .order("occurred_at", { ascending: false })
        .limit(200),
      options.supabase
        .from("email_summaries")
        .select(
          "id, workspace_id, contact_id, created_by, summary_text, triage_reason_code, triage_confidence, metadata, received_at, created_at",
        )
        .eq("workspace_id", options.workspaceId)
        .order("received_at", { ascending: false })
        .limit(200),
    ]);

  if (assignedContactIdsResult.error) {
    throw new Error(`Could not load assigned contacts for briefing: ${assignedContactIdsResult.error.message}`);
  }

  if (workspaceContactsResult.error) {
    throw new Error(`Could not load workspace contacts for briefing: ${workspaceContactsResult.error.message}`);
  }

  if (workspaceEventsResult.error) {
    throw new Error(`Could not load workspace activity for briefing: ${workspaceEventsResult.error.message}`);
  }

  if (timelineEventsResult.error) {
    throw new Error(`Could not load timeline events for briefing: ${timelineEventsResult.error.message}`);
  }

  if (emailSummariesResult.error) {
    throw new Error(`Could not load triage summaries for briefing: ${emailSummariesResult.error.message}`);
  }

  const assignedContactIds = new Set(
    ((assignedContactIdsResult.data ?? []) as ContactAssigneeRow[]).map((row) => row.contact_id),
  );
  const workspaceContacts = (workspaceContactsResult.data ?? []) as ContactRow[];
  const assignedContacts = workspaceContacts.filter((contact) => assignedContactIds.has(contact.id));
  const timelineEvents = (timelineEventsResult.data ?? []) as CrmEventRow[];
  const emailSummaries = (emailSummariesResult.data ?? []) as EmailSummaryRow[];

  const assignedFollowUpsDueToday = assignedContacts
    .filter((contact) => resolveFollowUpLocalDateKey(contact.next_follow_up_at, timezone) === localDateKey)
    .sort((left, right) => compareNullableDateAsc(left.next_follow_up_at, right.next_follow_up_at))
    .slice(0, assignedFollowUpLimit)
    .map(mapBriefingContact);

  const assignedFollowUpsOverdue = assignedContacts
    .filter((contact) => {
      const followUpDateKey = resolveFollowUpLocalDateKey(contact.next_follow_up_at, timezone);

      return !!followUpDateKey && followUpDateKey < localDateKey;
    })
    .sort((left, right) => compareNullableDateAsc(left.next_follow_up_at, right.next_follow_up_at))
    .slice(0, assignedFollowUpLimit)
    .map(mapBriefingContact);

  const assignedHighPriorityContacts = assignedContacts
    .filter((contact) => contact.priority === "high")
    .sort((left, right) => {
      const dueOrder = compareNullableDateAsc(left.next_follow_up_at, right.next_follow_up_at);
      if (dueOrder !== 0) {
        return dueOrder;
      }

      return compareDateDesc(left.updated_at, right.updated_at);
    })
    .slice(0, assignedHighPriorityLimit)
    .map(mapBriefingContact);

  const todayTimelineEvents = timelineEvents.filter(
    (event) => resolveTimelineEventLocalDate(event, timezone) === localDateKey,
  );

  const todayEmailSummaries = emailSummaries
    .filter((summary) => isTimestampOnLocalDate(summary.received_at, timezone, localDateKey))
    .slice(0, summaryLimit);

  const contactIdsForNames = new Set<string>();

  for (const event of todayTimelineEvents) {
    contactIdsForNames.add(event.contact_id);
  }

  for (const summary of todayEmailSummaries) {
    if (summary.contact_id) {
      contactIdsForNames.add(summary.contact_id);
    }
  }

  const contactNameById = await loadContactNamesById(options.supabase, Array.from(contactIdsForNames));

  const mappedTimelineEvents = todayTimelineEvents.map((event) => ({
    id: event.id,
    contactId: event.contact_id,
    contactName: contactNameById.get(event.contact_id) ?? "CRM contact",
    eventType: (event.event_type === "meeting" || event.event_type === "visit"
      ? event.event_type
      : "meeting") as TimelineEventType,
    title: event.title,
    body: event.body,
    metadata: event.metadata,
    occurredAt: event.occurred_at,
    createdAt: event.created_at,
    createdBy: event.created_by,
  }));

  const mappedEmailSummaries = todayEmailSummaries.map((summary) => ({
    id: summary.id,
    workspace_id: summary.workspace_id,
    contact_id: summary.contact_id,
    created_by: summary.created_by,
    summary_text: summary.summary_text,
    triage_reason_code: summary.triage_reason_code,
    triage_confidence: summary.triage_confidence,
    metadata: summary.metadata,
    received_at: summary.received_at,
    created_at: summary.created_at,
    contact_name: summary.contact_id ? (contactNameById.get(summary.contact_id) ?? "CRM contact") : "Unknown contact",
  }));

  const summaryTimelineItems: BriefingTimelineItem[] = todayEmailSummaries.map((summary) => ({
    id: `email-summary-${summary.id}`,
    contactId: summary.contact_id ?? "unknown-contact",
    contactName: summary.contact_id ? (contactNameById.get(summary.contact_id) ?? "CRM contact") : "Unknown contact",
    eventType: "email_summary",
    title: "Email summary",
    body: summary.summary_text,
    metadata: {
      ...(summary.metadata ?? {}),
      triage_label: "save_summary",
      triage_reason_code: summary.triage_reason_code,
      triage_confidence: summary.triage_confidence,
      source: "email_summaries",
    },
    occurredAt: summary.received_at,
    createdAt: summary.created_at,
    createdBy: summary.created_by,
  }));

  const todaysMergedTimeline = [...mappedTimelineEvents, ...summaryTimelineItems]
    .sort((left, right) => compareDateDesc(left.occurredAt, right.occurredAt))
    .slice(0, Math.max(timelineLimit, summaryLimit));

  const sevenDaysFromNow = new Date(now);
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7);

  const activeContactsCount = workspaceContacts.length;
  const highPriorityCount = workspaceContacts.filter((contact) => contact.priority === "high").length;
  const followUpCountNext7Days = workspaceContacts.filter((contact) => {
    if (!contact.next_follow_up_at) {
      return false;
    }

    const dueDate = new Date(contact.next_follow_up_at);
    if (Number.isNaN(dueDate.getTime())) {
      return false;
    }

    return dueDate.getTime() <= sevenDaysFromNow.getTime();
  }).length;

  const workspaceEvents = (workspaceEventsResult.data ?? []) as Array<{ occurred_at: string }>;
  const latestActivityAt = workspaceEvents[0]?.occurred_at ?? null;

  const stageOrder = ["new_lead", "qualified", "viewing", "negotiating", "closed_won"] as const;
  const stageLabels: Record<(typeof stageOrder)[number], string> = {
    new_lead: "New leads",
    qualified: "Qualified",
    viewing: "Visits",
    negotiating: "Negotiating",
    closed_won: "Active",
  };

  const stageCounts = stageOrder.map((stage) => ({
    key: stage,
    label: stageLabels[stage],
    count: workspaceContacts.filter((contact) => contact.stage === stage).length,
  }));

  const workspaceSnapshot: BriefingWorkspaceSnapshot = {
    workspaceName: workspaceRow.name,
    currency: workspaceRow.currency ?? "EUR",
    activeContactsCount,
    highPriorityCount,
    followUpCountNext7Days,
    latestActivityAt,
    stageCounts,
  };

  const aiResult = await composeAIDailyBriefing({
    supabase: options.supabase,
    workspaceId: options.workspaceId,
    profileId: options.profileId,
    localDateKey,
    timezone,
    language,
    locale,
    assignedFollowUpsDueToday,
    assignedFollowUpsOverdue,
    assignedHighPriorityContacts,
    todaysTimelineMeetingsAndVisits: mappedTimelineEvents,
    todaysEmailSummaries: mappedEmailSummaries,
    workspaceSnapshot,
  });

  return {
    workspaceId: options.workspaceId,
    profileId: options.profileId,
    timezone,
    language,
    locale,
    localDate: localDateKey,
    generatedAt: now.toISOString(),
    aiBriefing: aiResult.briefing,
    diagnostics: aiResult.diagnostics,
    sections: {
      assignedFollowUpsDueToday,
      assignedFollowUpsOverdue,
      assignedHighPriorityContacts,
      todaysTimelineMeetingsAndVisits: mappedTimelineEvents,
      todaysEmailSummaries: mappedEmailSummaries,
      todaysMergedTimeline,
      workspaceSnapshot,
    },
  };
}

const dailyBriefingSchema = z.object({
  headline: z.string().trim().min(4).max(160),
  briefing: z.string().trim().min(24).max(1800),
  top_actions: z
    .array(
      z.object({
        title: z.string().trim().min(2).max(160),
        reason: z.string().trim().min(3).max(320),
        due_hint: z.string().trim().max(120).nullable().optional(),
      }),
    )
    .max(6)
    .default([]),
  workspace_pulse: z.string().trim().min(4).max(420),
});

async function composeAIDailyBriefing(input: {
  supabase: SupabaseClient;
  workspaceId: string;
  profileId: string;
  localDateKey: string;
  timezone: string;
  language: string;
  locale: string;
  assignedFollowUpsDueToday: BriefingContactItem[];
  assignedFollowUpsOverdue: BriefingContactItem[];
  assignedHighPriorityContacts: BriefingContactItem[];
  todaysTimelineMeetingsAndVisits: BriefingTimelineItem[];
  todaysEmailSummaries: BriefingEmailSummaryItem[];
  workspaceSnapshot: BriefingWorkspaceSnapshot;
}): Promise<DailyBriefingAiResult> {
  const modelSelection = await resolveDailyBriefingModelSettings(input.supabase, input.workspaceId);
  const targetLanguageName = resolveLanguageName(input.language);

  const timelineContext = input.todaysTimelineMeetingsAndVisits.map((item) => {
      const localTime = resolveTimelineLocalTime(item.occurredAt, input.timezone, item.metadata);
      const hasPreciseTime = isLikelyPreciseTime(localTime, item.metadata);
      const resolvedLocalDate =
        resolveTimelineMetadataDate(item.metadata) ?? getLocalDateKey(new Date(item.occurredAt), input.timezone);

      return {
        event_id: item.id,
        event_type: item.eventType,
        contact_name: item.contactName,
        local_date: resolvedLocalDate,
        local_time: localTime,
        has_precise_time: hasPreciseTime,
        title: item.title,
        body: item.body,
      };
    });

  const contextPayload = {
    local_date: input.localDateKey,
    timezone: input.timezone,
    language: input.language,
    locale: input.locale,
    target_language_name: targetLanguageName,
    workspace: input.workspaceSnapshot,
    assigned_follow_ups_due_today: input.assignedFollowUpsDueToday.slice(0, 12),
    assigned_follow_ups_overdue: input.assignedFollowUpsOverdue.slice(0, 12),
    assigned_high_priority_contacts: input.assignedHighPriorityContacts.slice(0, 12),
    assigned_follow_ups_due_today_count: input.assignedFollowUpsDueToday.length,
    assigned_follow_ups_overdue_count: input.assignedFollowUpsOverdue.length,
    assigned_high_priority_contacts_count: input.assignedHighPriorityContacts.length,
    must_mention_contacts: Array.from(
      new Set(
        [
          ...input.assignedFollowUpsDueToday,
          ...input.assignedFollowUpsOverdue,
          ...input.assignedHighPriorityContacts,
        ]
          .map((contact) => contact.name)
          .filter((name) => name && name !== "Unnamed contact"),
      ),
    ).slice(0, 20),
    todays_meetings_and_visits: timelineContext,
    todays_meetings_and_visits_count: timelineContext.length,
    todays_email_summaries: input.todaysEmailSummaries.slice(0, 20).map((item) => ({
      contact_name: item.contact_name,
      summary_text: item.summary_text,
      triage_reason_code: item.triage_reason_code,
      triage_confidence: item.triage_confidence,
      received_at: item.received_at,
    })),
  };

  const prompt = [
    "You are a real-estate CRM daily briefing assistant.",
    "Produce an operational daily brief for one user.",
    "Use the provided JSON context only. Do not invent entities, dates, times, calls, meetings, or visits.",
    "The brief must prioritize assigned tasks first, then include a concise workspace pulse.",
    "Output must follow the schema exactly.",
    "Rules:",
    "- headline: one line, concrete and action-oriented.",
    "- briefing: exactly 2 paragraphs, practical and specific, with at least 4 total sentences.",
    "- top_actions: at most 5, sorted by urgency and business impact.",
    "- workspace_pulse: one concise sentence summarizing team context.",
    "- The final sentence of the briefing must be a short closing next-step sentence.",
    "- Start from assigned_follow_ups_due_today and assigned_follow_ups_overdue before any general commentary.",
    "- If assigned_follow_ups_due_today or assigned_follow_ups_overdue are non-empty, mention each listed contact_name at least once in briefing or top_actions.",
    "- If assigned_high_priority_contacts is non-empty, mention each listed contact_name at least once in briefing or top_actions.",
    "- Mention only events from todays_meetings_and_visits where local_date matches local_date in context.",
    "- Cover all events from todays_meetings_and_visits in the briefing narrative. Do not omit any event.",
    "- Every meeting/visit mention must include contact_name.",
    "- Use neutral wording for time. Never use relative daypart language such as morning/afternoon/evening/tonight or matin/apres-midi/soir/ce soir.",
    "- If has_precise_time is true, you may mention local_time (HH:mm). If has_precise_time is false, do not mention any specific time.",
    "- Do not infer schedule dates or times from title/body text. Date/time facts must come from local_date/local_time fields only.",
    "- top_actions related to meeting/visit must include the contact name directly in title or reason.",
    `- Target language is '${targetLanguageName}' (language code '${input.language}', locale '${input.locale}').`,
    "- Write every field entirely in the target language.",
    "- Do not mix languages. Do not output English unless the target language is English.",
    "- Keep language plain, direct, and literal. Avoid inferred claims.",
    "Context JSON:",
    JSON.stringify(contextPayload),
  ].join("\n");

  try {
    const result = await generateDailyBriefingWithProvider({
      provider: modelSelection.provider,
      model: modelSelection.model,
      prompt,
    });

    const finalizedBriefing = ensureBriefingDetail(result.briefing, input);

    return {
      briefing: {
        headline: result.headline,
        briefing: finalizedBriefing,
        topActions: result.top_actions.map((action) => ({
          title: action.title,
          reason: action.reason,
          dueHint: action.due_hint ?? null,
        })),
        workspacePulse: result.workspace_pulse,
      },
      diagnostics: {
        source: "ai" as const,
        provider: modelSelection.provider,
        model: modelSelection.model,
        error: null,
      },
    };
  } catch (error) {
    const details = normalizeErrorMessage(error);
    console.warn("Daily briefing AI generation failed; using fallback.", {
      provider: modelSelection.provider,
      model: modelSelection.model,
      details,
    });
    return {
      briefing: buildFallbackBriefing(input, "ai-generation-failed"),
      diagnostics: {
        source: "fallback" as const,
        provider: modelSelection.provider,
        model: modelSelection.model,
        error: details,
      },
    };
  }
}

async function resolveDailyBriefingModelSettings(supabase: SupabaseClient, workspaceId: string) {
  const workspaceRow = await getAiModelSettingRow(supabase, DAILY_BRIEFING_ACTION_TYPE, workspaceId);

  if (workspaceRow) {
    const resolved = resolveProviderAndModel(workspaceRow);
    if (resolved) {
      return resolved;
    }
  }

  const globalRow = await getAiModelSettingRow(supabase, DAILY_BRIEFING_ACTION_TYPE, null);

  if (globalRow) {
    const resolved = resolveProviderAndModel(globalRow);
    if (resolved) {
      return resolved;
    }
  }

  return {
    provider: normalizeProvider(process.env.DAILY_BRIEFING_PROVIDER),
    model: process.env.DAILY_BRIEFING_MODEL?.trim() || process.env.INBOUND_EMAIL_MODEL?.trim() || "gemini-2.0-flash",
  };
}

async function getAiModelSettingRow(supabase: SupabaseClient, actionType: string, workspaceId: string | null) {
  let query = supabase
    .from("ai_model_settings")
    .select("action_type, provider, model, text_provider, text_model")
    .eq("is_active", true)
    .eq("action_type", actionType)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);

  query = workspaceId ? query.eq("workspace_id", workspaceId) : query.is("workspace_id", null);

  const { data, error } = await query.maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as AiModelSettingRow;
}

function resolveProviderAndModel(row: AiModelSettingRow) {
  const provider = normalizeProvider(row.text_provider ?? row.provider ?? undefined);
  const model = firstNonEmpty(row.text_model, row.model);

  if (!model) {
    return null;
  }

  return {
    provider,
    model,
  };
}

async function generateDailyBriefingWithProvider(options: {
  provider: AiProvider;
  model: string;
  prompt: string;
}) {
  if (options.provider === "gemini") {
    return generateDailyBriefingWithGemini({ model: options.model, prompt: options.prompt });
  }

  if (options.provider === "anthropic") {
    return generateDailyBriefingWithAnthropic({ model: options.model, prompt: options.prompt });
  }

  if (options.provider === "mistral") {
    return generateDailyBriefingWithOpenAICompatible({
      provider: "mistral",
      model: options.model,
      prompt: options.prompt,
      baseUrl: process.env.MISTRAL_API_BASE_URL?.trim() || DEFAULT_MISTRAL_BASE_URL,
      apiKey: process.env.MISTRAL_API_KEY?.trim(),
    });
  }

  return generateDailyBriefingWithOpenAICompatible({
    provider: "xai",
    model: options.model,
    prompt: options.prompt,
    baseUrl: process.env.XAI_API_BASE_URL?.trim() || DEFAULT_XAI_BASE_URL,
    apiKey: process.env.XAI_API_KEY?.trim(),
  });
}

async function generateDailyBriefingWithGemini(options: {
  model: string;
  prompt: string;
}) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing");
  }

  const baseUrl = process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL;
  const response = await fetchWithTimeout(
    `${baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(options.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: options.prompt,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.35,
          topP: 0.95,
          maxOutputTokens: 1400,
          responseMimeType: "application/json",
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini generation failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
        }>;
      };
    }>;
  };

  const rawText =
    payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("\n")
      .trim() ?? "";

  try {
    return parseDailyBriefingResponse(rawText, "Gemini");
  } catch (parseError) {
    if (!shouldRetryJsonParse(parseError)) {
      throw parseError;
    }

    const repairedRawText = await repairDailyBriefingJsonWithGemini({
      apiKey,
      baseUrl,
      model: options.model,
      malformedText: rawText,
    });

    return parseDailyBriefingResponse(repairedRawText, "Gemini");
  }
}

async function generateDailyBriefingWithAnthropic(options: {
  model: string;
  prompt: string;
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is missing");
  }

  const baseUrl = process.env.ANTHROPIC_API_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL;
  const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: 1400,
      temperature: 0.35,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: options.prompt,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic generation failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };

  const rawText = (payload.content ?? [])
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("\n")
    .trim();

  try {
    return parseDailyBriefingResponse(rawText, "Anthropic");
  } catch (parseError) {
    if (!shouldRetryJsonParse(parseError)) {
      throw parseError;
    }

    const repairedRawText = await repairDailyBriefingJsonWithAnthropic({
      apiKey,
      baseUrl,
      model: options.model,
      malformedText: rawText,
    });

    return parseDailyBriefingResponse(repairedRawText, "Anthropic");
  }
}

async function generateDailyBriefingWithOpenAICompatible(options: {
  provider: "mistral" | "xai";
  model: string;
  prompt: string;
  baseUrl: string;
  apiKey: string | undefined;
}) {
  if (!options.apiKey) {
    throw new Error(`${options.provider.toUpperCase()}_API_KEY is missing`);
  }

  const response = await fetchWithTimeout(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        {
          role: "user",
          content: options.prompt,
        },
      ],
      temperature: 0.35,
      top_p: 0.95,
      max_tokens: 1400,
      response_format: {
        type: "json_object",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${options.provider.toUpperCase()} generation failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{
          type?: string;
          text?: string;
        }>;
      };
    }>;
  };

  const messageContent = payload.choices?.[0]?.message?.content;
  const rawText =
    typeof messageContent === "string"
      ? messageContent.trim()
      : Array.isArray(messageContent)
        ? messageContent
            .map((part) => (part.type === "text" ? part.text?.trim() ?? "" : ""))
            .filter((part) => part.length > 0)
            .join("\n")
            .trim()
        : "";

  const providerName = options.provider.toUpperCase();

  try {
    return parseDailyBriefingResponse(rawText, providerName);
  } catch (parseError) {
    if (!shouldRetryJsonParse(parseError)) {
      throw parseError;
    }

    const repairedRawText = await repairDailyBriefingJsonWithOpenAICompatible({
      provider: options.provider,
      model: options.model,
      malformedText: rawText,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
    });

    return parseDailyBriefingResponse(repairedRawText, providerName);
  }
}

function parseDailyBriefingResponse(rawText: string, providerName: string) {
  if (!rawText) {
    throw new Error(`${providerName} returned an empty response`);
  }

  const parsed = parseJsonWithVariants(rawText);

  if (!parsed.ok) {
    throw new Error(`${providerName} returned invalid JSON`);
  }

  const normalizedParsed = normalizeDailyBriefingShape(parsed.value);

  const validated = dailyBriefingSchema.safeParse(normalizedParsed);

  if (!validated.success) {
    throw new Error(`${providerName} response failed schema validation: ${validated.error.issues[0]?.message ?? "invalid format"}`);
  }

  return validated.data;
}

function normalizeProvider(value: string | undefined): AiProvider {
  const normalized = value?.trim().toLowerCase();

  if (normalized === "anthropic" || normalized === "gemini" || normalized === "mistral" || normalized === "xai") {
    return normalized;
  }

  return "gemini";
}

function normalizeLanguageCode(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (normalized.length === 0) {
    return "en";
  }

  const twoLetter = normalized.slice(0, 2);
  if (/^[a-z]{2}$/.test(twoLetter)) {
    return twoLetter;
  }

  return "en";
}

function resolveLanguageName(languageCode: string) {
  const normalized = normalizeLanguageCode(languageCode);

  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(normalized) ?? normalized;
  } catch {
    return normalized;
  }
}

function firstNonEmpty(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return null;
}

function stripMarkdownCodeFence(value: string) {
  const trimmed = value.trim();

  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "").trim();
}

function normalizeJsonCandidateText(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\u00A0/g, " ")
    .trim();
}

function parseJsonWithVariants(rawText: string): { ok: true; value: unknown } | { ok: false } {
  const base = normalizeJsonCandidateText(stripMarkdownCodeFence(rawText));
  const extracted = extractJsonObject(base);

  const candidates = [
    base,
    extracted,
    base ? base.replace(/,\s*([}\]])/g, "$1") : null,
    extracted ? extracted.replace(/,\s*([}\]])/g, "$1") : null,
    base
      ? base
          .replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, '$1"$2":')
          .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')
      : null,
  ];

  for (const candidate of candidates) {
    if (!candidate || candidate.trim().length === 0) {
      continue;
    }

    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      // Try next variant.
    }
  }

  return { ok: false };
}

function shouldRetryJsonParse(error: unknown) {
  const message = normalizeErrorMessage(error).toLowerCase();
  return message.includes("invalid json") || message.includes("schema validation") || message.includes("empty response");
}

async function repairDailyBriefingJsonWithGemini(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  malformedText: string;
}) {
  const response = await fetchWithTimeout(
    `${input.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
                  "Fix the following malformed JSON and return one valid JSON object only.",
                  "Do not add markdown fences.",
                  "Do not add explanations.",
                  "Required keys: headline, briefing, top_actions, workspace_pulse.",
                  "Malformed payload:",
                  input.malformedText,
                ].join("\n"),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          topP: 0.9,
          maxOutputTokens: 1400,
          responseMimeType: "application/json",
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini JSON repair failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
        }>;
      };
    }>;
  };

  return (
    payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("\n")
      .trim() ?? ""
  );
}

async function repairDailyBriefingJsonWithAnthropic(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  malformedText: string;
}) {
  const response = await fetchWithTimeout(`${input.baseUrl.replace(/\/$/, "")}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: input.model,
      max_tokens: 1400,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildJsonRepairPrompt(input.malformedText),
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic JSON repair failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };

  return (payload.content ?? [])
    .map((part) => (part.type === "text" ? part.text ?? "" : ""))
    .join("\n")
    .trim();
}

async function repairDailyBriefingJsonWithOpenAICompatible(input: {
  provider: "mistral" | "xai";
  model: string;
  malformedText: string;
  baseUrl: string;
  apiKey: string;
}) {
  const response = await fetchWithTimeout(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        {
          role: "user",
          content: buildJsonRepairPrompt(input.malformedText),
        },
      ],
      temperature: 0,
      top_p: 0.9,
      max_tokens: 1400,
      response_format: {
        type: "json_object",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${input.provider.toUpperCase()} JSON repair failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{
          type?: string;
          text?: string;
        }>;
      };
    }>;
  };

  const messageContent = payload.choices?.[0]?.message?.content;

  if (typeof messageContent === "string") {
    return messageContent.trim();
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .map((part) => (part.type === "text" ? part.text?.trim() ?? "" : ""))
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
  }

  return "";
}

function buildJsonRepairPrompt(malformedText: string) {
  return [
    "Fix the following malformed JSON and return one valid JSON object only.",
    "Do not add markdown fences.",
    "Do not add explanations.",
    "Required keys: headline, briefing, top_actions, workspace_pulse.",
    "Malformed payload:",
    malformedText,
  ].join("\n");
}

function extractJsonObject(value: string) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");

  if (start < 0 || end <= start) {
    return null;
  }

  return value.slice(start, end + 1);
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DAILY_BRIEFING_PROVIDER_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Provider request timed out after ${DAILY_BRIEFING_PROVIDER_TIMEOUT_MS}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeDailyBriefingShape(parsed: unknown) {
  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }

  const source = parsed as Record<string, unknown>;
  const normalized = { ...source } as Record<string, unknown>;

  const headline = coerceModelText(source.headline) ?? coerceModelText(source.title);
  if (headline) {
    normalized.headline = headline;
  }

  const briefing =
    coerceModelText(source.briefing) ??
    coerceModelText(source.body) ??
    coerceModelText(source.summary) ??
    coerceModelText(source.message);
  if (briefing) {
    normalized.briefing = briefing;
  }

  if (!Array.isArray(normalized.top_actions) && Array.isArray(source.topActions)) {
    normalized.top_actions = source.topActions;
  }

  if (!Array.isArray(normalized.top_actions) && source.top_actions && typeof source.top_actions === "object") {
    const topActionsObject = source.top_actions as Record<string, unknown>;
    if (Array.isArray(topActionsObject.items)) {
      normalized.top_actions = topActionsObject.items;
    } else if (Array.isArray(topActionsObject.actions)) {
      normalized.top_actions = topActionsObject.actions;
    }
  }

  if (typeof normalized.workspace_pulse !== "string") {
    const pulse =
      coerceModelText(source.workspace_pulse) ??
      coerceModelText(source.workspacePulse) ??
      coerceModelText(source.pulse);
    if (pulse) {
      normalized.workspace_pulse = pulse;
    }
  }

  if (Array.isArray(normalized.top_actions)) {
    normalized.top_actions = (normalized.top_actions as unknown[])
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const row = item as Record<string, unknown>;
        const title =
          coerceModelText(row.title) ?? coerceModelText(row.action) ?? coerceModelText(row.name) ?? coerceModelText(row.label) ?? "";
        const reason =
          coerceModelText(row.reason) ??
          coerceModelText(row.rationale) ??
          coerceModelText(row.explanation) ??
          coerceModelText(row.why) ??
          "";
        const dueHintRaw = row.due_hint ?? row.dueHint ?? row.due ?? row.deadline;
        const dueHint = coerceModelText(dueHintRaw);

        return {
          title: ensureMinLength(title, 2, "Task"),
          reason: ensureMinLength(reason, 3, "Action required"),
          due_hint: dueHint && dueHint.length > 0 ? dueHint : null,
        };
      })
      .filter((item): item is { title: string; reason: string; due_hint: string | null } => {
        return !!item && item.title.trim().length > 0 && item.reason.trim().length > 0;
      });
  }

  const normalizedHeadline = ensureMinLength(coerceModelText(normalized.headline), 4, "Daily briefing update");
  const normalizedBriefing = ensureMinLength(
    coerceModelText(normalized.briefing),
    24,
    `${normalizedHeadline}. Action summary is available in this daily briefing.`,
  );
  const normalizedWorkspacePulse = ensureMinLength(
    coerceModelText(normalized.workspace_pulse),
    4,
    "Workspace activity overview is available.",
  );

  normalized.headline = normalizedHeadline;
  normalized.briefing = normalizedBriefing;
  normalized.workspace_pulse = normalizedWorkspacePulse;

  return normalized;
}

function ensureMinLength(value: string | null, minLength: number, fallback: string) {
  const candidate = (value ?? "").replace(/\s+/g, " ").trim();
  if (candidate.length >= minLength) {
    return candidate;
  }

  const fallbackCandidate = fallback.replace(/\s+/g, " ").trim();
  if (fallbackCandidate.length >= minLength) {
    return fallbackCandidate;
  }

  return fallbackCandidate.padEnd(minLength, ".");
}

function coerceModelText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => coerceModelText(item))
      .filter((item): item is string => !!item && item.length > 0);

    if (parts.length === 0) {
      return null;
    }

    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const row = value as Record<string, unknown>;
  const commonKeys = ["text", "content", "value", "message", "summary", "title", "description", "reason"];

  for (const key of commonKeys) {
    const candidate = coerceModelText(row[key]);
    if (candidate) {
      return candidate;
    }
  }

  try {
    const serialized = JSON.stringify(row);
    const trimmed = serialized.replace(/\s+/g, " ").trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function normalizeErrorMessage(error: unknown) {
  const value = error instanceof Error ? error.message : "Unexpected daily briefing error";
  const trimmed = value.trim();

  if (trimmed.length <= 1000) {
    return trimmed;
  }

  return `${trimmed.slice(0, 997)}...`;
}

function buildFallbackBriefing(
  input: Parameters<typeof composeAIDailyBriefing>[0],
  reason: "missing-provider-config" | "ai-generation-failed",
): AIDailyBriefing {
  const copy = getBriefingLocaleStrings(input.language);
  const topActions: AIDailyBriefing["topActions"] = [];

  for (const contact of input.assignedFollowUpsDueToday.slice(0, 3)) {
    topActions.push({
      title: copy.followUpActionTitle(contact.name),
      reason: copy.followUpActionReason,
      dueHint: contact.nextFollowUpAt,
    });
  }

  for (const contact of input.assignedHighPriorityContacts.slice(0, 3)) {
    if (topActions.length >= 5) {
      break;
    }

    const exists = topActions.some((item) => item.title.toLowerCase().includes(contact.name.toLowerCase()));
    if (exists) {
      continue;
    }

    topActions.push({
      title: copy.highPriorityActionTitle(contact.name),
      reason: copy.highPriorityActionReason,
      dueHint: contact.nextFollowUpAt,
    });
  }

  const latestTimeline = input.todaysTimelineMeetingsAndVisits[0];
  const latestSummary = input.todaysEmailSummaries[0];

  const sourceHint =
    reason === "missing-provider-config"
      ? copy.fallbackMissingModel
      : copy.fallbackAiFailed;

  return {
    headline: copy.fallbackHeadline(input.workspaceSnapshot.workspaceName),
    briefing: [
      copy.fallbackCounts(input.assignedFollowUpsDueToday.length, input.assignedHighPriorityContacts.length),
      latestTimeline
        ? copy.latestTimeline(latestTimeline.title, latestTimeline.contactName)
        : copy.noTimeline,
      latestSummary
        ? copy.latestSummary(latestSummary.contact_name, truncate(latestSummary.summary_text, 140))
        : copy.noSummary,
      sourceHint,
    ].join(" "),
    topActions,
    workspacePulse: copy.workspacePulse(
      input.workspaceSnapshot.activeContactsCount,
      input.workspaceSnapshot.highPriorityCount,
      input.workspaceSnapshot.followUpCountNext7Days,
    ),
  };
}

function truncate(value: string, maxLength: number) {
  const cleaned = value.replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function mapBriefingContact(contact: ContactRow): BriefingContactItem {
  return {
    id: contact.id,
    name: formatPersonName(contact.first_name, contact.last_name),
    stage: contact.stage,
    priority: contact.priority,
    nextFollowUpAt: contact.next_follow_up_at,
    updatedAt: contact.updated_at,
  };
}

async function loadContactNamesById(supabase: SupabaseClient, contactIds: string[]) {
  const map = new Map<string, string>();

  if (contactIds.length === 0) {
    return map;
  }

  const { data, error } = await supabase.from("crm_contacts").select("id, first_name, last_name").in("id", contactIds);

  if (error) {
    throw new Error(`Could not load contact names for briefing: ${error.message}`);
  }

  for (const row of (data ?? []) as ContactNameRow[]) {
    map.set(row.id, formatPersonName(row.first_name, row.last_name));
  }

  return map;
}

function formatPersonName(firstName: string | null | undefined, lastName: string | null | undefined) {
  const fullName = `${firstName ?? ""} ${lastName ?? ""}`.trim();
  return fullName || "Unnamed contact";
}

function getLocalDateKey(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getLocalTimeHHmm(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);

  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;

  if (!hour || !minute) {
    return null;
  }

  return `${hour}:${minute}`;
}

function normalizeIsoDateOnly(value: string | null | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : null;
}

function resolveTimelineMetadataDate(metadata: Record<string, unknown> | null) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const candidates = [
    metadata.due_date,
    metadata.date,
    metadata.local_date,
    metadata.scheduled_date,
    metadata.visit_date,
    metadata.meeting_date,
  ];

  for (const value of candidates) {
    const normalized = normalizeIsoDateOnly(typeof value === "string" ? value : null);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function resolveTimelineEventLocalDate(event: CrmEventRow, timeZone: string) {
  const metadataDate = resolveTimelineMetadataDate(event.metadata);
  if (metadataDate) {
    return metadataDate;
  }

  const occurredAt = new Date(event.occurred_at);
  if (Number.isNaN(occurredAt.getTime())) {
    return null;
  }

  return getLocalDateKey(occurredAt, timeZone);
}

function resolveTimelineLocalTime(
  occurredAt: string,
  timeZone: string,
  metadata: Record<string, unknown> | null,
): string | null {
  if (metadata && typeof metadata === "object") {
    const keys = ["local_time", "time", "start_time", "scheduled_time", "scheduled_time_local"];
    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === "string") {
        const match = value.trim().match(/^(\d{2}:\d{2})/);
        if (match) {
          return match[1];
        }
      }
    }
  }

  if (resolveTimelineMetadataDate(metadata)) {
    return null;
  }

  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return getLocalTimeHHmm(date, timeZone);
}

function isLikelyPreciseTime(localTime: string | null, metadata: Record<string, unknown> | null) {
  if (!localTime) {
    return false;
  }

  if (metadata && typeof metadata === "object") {
    if (metadata.all_day === true || metadata.is_all_day === true || metadata.date_only === true) {
      return false;
    }
  }

  if (localTime === "00:00") {
    return false;
  }

  return true;
}

function isTimestampOnLocalDate(value: string | null | undefined, timeZone: string, localDateKey: string) {
  if (!value) {
    return false;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return getLocalDateKey(date, timeZone) === localDateKey;
}

function resolveFollowUpLocalDateKey(value: string | null | undefined, timeZone: string) {
  if (!value) {
    return null;
  }

  const isoDatePrefix = normalizeIsoDateOnly(value.slice(0, 10));
  if (isoDatePrefix) {
    return isoDatePrefix;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return getLocalDateKey(date, timeZone);
}

function countSentences(value: string) {
  const chunks = value
    .split(/[.!?]+/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);

  return chunks.length;
}

function ensureBriefingDetail(value: string, input: Parameters<typeof composeAIDailyBriefing>[0]) {
  const copy = getBriefingLocaleStrings(input.language);
  const dueNames = input.assignedFollowUpsDueToday.slice(0, 4).map((contact) => contact.name);
  const overdueNames = input.assignedFollowUpsOverdue.slice(0, 4).map((contact) => contact.name);
  const highNames = input.assignedHighPriorityContacts.slice(0, 4).map((contact) => contact.name);
  const normalized = normalizeBriefingClosingSentence(value, input, dueNames, overdueNames, highNames);
  const compact = value.replace(/\s+/g, " ").trim();
  const hasEnoughSentences = countSentences(compact) >= 4;
  const hasEnoughLength = compact.length >= 220;
  const paragraphCount = compact.split(/\n\s*\n/).filter((part) => part.trim().length > 0).length;

  if (paragraphCount >= 2 && hasEnoughSentences && hasEnoughLength) {
    return normalized;
  }

  const expanded = buildNarrativeFallbackBriefing(input, copy, dueNames, overdueNames, highNames);
  const normalizedExpanded = normalizeBriefingClosingSentence(expanded, input, dueNames, overdueNames, highNames);

  if (normalizedExpanded.length <= 1800) {
    return normalizedExpanded;
  }

  return normalizedExpanded.slice(0, 1797).trimEnd() + "...";
}

type BriefingLocaleCopy = {
  followUpActionTitle: (name: string) => string;
  followUpActionReason: string;
  highPriorityActionTitle: (name: string) => string;
  highPriorityActionReason: string;
  fallbackMissingModel: string;
  fallbackAiFailed: string;
  fallbackHeadline: (workspaceName: string) => string;
  fallbackCounts: (dueToday: number, highPriority: number) => string;
  latestTimeline: (title: string, contactName: string) => string;
  noTimeline: string;
  latestSummary: (contactName: string, summaryText: string) => string;
  noSummary: string;
  workspacePulse: (activeContacts: number, highPriority: number, followUps7Days: number) => string;
  detailDueToday: (count: number, names: string[]) => string;
  detailOverdue: (count: number, names: string[]) => string;
  detailHighPriority: (count: number, names: string[]) => string;
  detailMeetingsAndEmails: (meetingsAndVisits: number, emailSummaries: number) => string;
};

function buildNarrativeFallbackBriefing(
  input: Parameters<typeof composeAIDailyBriefing>[0],
  copy: BriefingLocaleCopy,
  dueNames: string[],
  overdueNames: string[],
  highNames: string[],
) {
  const dueCount = input.assignedFollowUpsDueToday.length;
  const overdueCount = input.assignedFollowUpsOverdue.length;
  const highCount = input.assignedHighPriorityContacts.length;
  const meetingsCount = input.todaysTimelineMeetingsAndVisits.length;
  const emailCount = input.todaysEmailSummaries.length;

  const firstDue = dueNames[0] ?? null;
  const firstOverdue = overdueNames[0] ?? null;
  const firstHigh = highNames[0] ?? null;

  const dueSentence = buildLocalizedSentence(input.language, {
    fr: () =>
      dueCount > 0
        ? `Votre priorité du jour est claire: ${firstDue ?? "un suivi"} est a traiter aujourd'hui${dueCount > 1 ? `, avec ${dueCount - 1} autre${dueCount - 1 === 1 ? "" : "s"} suivi${dueCount - 1 === 1 ? "" : "s"} a garder en vue` : ""}.`
        : `La journée reste légère et vous laisse de l'espace pour avancer proprement.`,
    de: () =>
      dueCount > 0
        ? `Die Prioritat fur heute ist klar: ${firstDue ?? "ein Follow-up"} sollte heute bearbeitet werden${dueCount > 1 ? `, dazu kommen noch ${dueCount - 1} weitere offene Follow-ups` : ""}.`
        : `Der Tag bleibt leicht und gibt Raum fur konzentriertes Arbeiten.`,
    es: () =>
      dueCount > 0
        ? `La prioridad de hoy es clara: ${firstDue ?? "un seguimiento"} debe resolverse hoy${dueCount > 1 ? `, con ${dueCount - 1} seguimiento${dueCount - 1 === 1 ? "" : "s"} adicional${dueCount - 1 === 1 ? "" : "es"} a tener en cuenta` : ""}.`
        : `La jornada es ligera y deja espacio para avanzar con calma.`,
    it: () =>
      dueCount > 0
        ? `La priorita di oggi e chiara: ${firstDue ?? "un follow-up"} va gestito oggi${dueCount > 1 ? `, con altri ${dueCount - 1} follow-up da tenere a vista` : ""}.`
        : `La giornata e leggera e lascia spazio per lavorare con calma.`,
    pt: () =>
      dueCount > 0
        ? `A prioridade de hoje esta clara: ${firstDue ?? "um acompanhamento"} deve ser tratado hoje${dueCount > 1 ? `, com mais ${dueCount - 1} acompanhamento${dueCount - 1 === 1 ? "" : "s"} para acompanhar` : ""}.`
        : `O dia esta leve e deixa espaco para avancar com calma.`,
    nl: () =>
      dueCount > 0
        ? `De prioriteit voor vandaag is duidelijk: ${firstDue ?? "een opvolging"} moet vandaag worden opgepakt${dueCount > 1 ? `, met nog ${dueCount - 1} extra opvolging${dueCount - 1 === 1 ? "" : "en"} om in de gaten te houden` : ""}.`
        : `De dag is licht en geeft ruimte om rustig voort te werken.`,
    pl: () =>
      dueCount > 0
        ? `Dzisiejszy priorytet jest jasny: ${firstDue ?? "follow-up"} trzeba zalatwic dzisiaj${dueCount > 1 ? `, a dodatkowo warto pamietac o jeszcze ${dueCount - 1} innych follow-upach` : ""}.`
        : `Dzien jest lekki i daje przestrzen do spokojnej pracy.`,
    sv: () =>
      dueCount > 0
        ? `Dagens prioritet ar tydlig: ${firstDue ?? "en uppfoljning"} ska hanteras idag${dueCount > 1 ? `, med ytterligare ${dueCount - 1} uppfoljning${dueCount - 1 === 1 ? "" : "ar"} att ha koll pa` : ""}.`
        : `Dagen ar lugn och ger utrymme att arbeta i ett bra tempo.`,
    da: () =>
      dueCount > 0
        ? `Dagens prioritet er tydelig: ${firstDue ?? "en opfoelgning"} skal behandles i dag${dueCount > 1 ? `, med ${dueCount - 1} ekstra opfoelgning${dueCount - 1 === 1 ? "" : "er"} at holde oeje med` : ""}.`
        : `Dagen er let og giver plads til at arbejde roligt videre.`,
    fi: () =>
      dueCount > 0
        ? `Taman paivan prioriteetti on selkea: ${firstDue ?? "seuranta"} kannattaa hoitaa tanaan${dueCount > 1 ? `, ja lisaksi ${dueCount - 1} muuta seurantaa on syyta pitaa mielessa` : ""}.`
        : `Paiva on kevyt ja antaa tilaa edetä rauhassa.`,
    nb: () =>
      dueCount > 0
        ? `Dagens prioritet er tydelig: ${firstDue ?? "en oppfolging"} bor tas i dag${dueCount > 1 ? `, med ${dueCount - 1} ekstra oppfolging${dueCount - 1 === 1 ? "" : "er"} a holde oyne pa` : ""}.`
        : `Dagen er lett og gir plass til a jobbe rolig videre.`,
    en: () =>
      dueCount > 0
        ? `Today's priority is clear: ${firstDue ?? "a follow-up"} should be handled today${dueCount > 1 ? `, with ${dueCount - 1} more follow-up${dueCount - 1 === 1 ? "" : "s"} to keep in view` : ""}.`
        : `The day is light and gives you room to move at a steady pace.`,
  });

  const secondSentence = buildLocalizedSentence(input.language, {
    fr: () =>
      `Vous avez ${highCount} contact${highCount === 1 ? "" : "s"} prioritaire${highCount === 1 ? "" : "s"}${firstHigh ? `, dont ${firstHigh}` : ""}${overdueCount > 0 ? `; le retard doit d'abord se regler sur ${firstOverdue ?? "les suivis en retard"}` : "."}`,
    de: () =>
      `Sie haben ${highCount} Kontakt${highCount === 1 ? "" : "e"} mit hoher Prioritat${firstHigh ? `, darunter ${firstHigh}` : ""}${overdueCount > 0 ? `; zuerst sollten die uberfalligen Punkte geklart werden${firstOverdue ? `, beginnend mit ${firstOverdue}` : ""}` : "."}`,
    es: () =>
      `Tiene ${highCount} contacto${highCount === 1 ? "" : "s"} de alta prioridad${firstHigh ? `, incluido ${firstHigh}` : ""}${overdueCount > 0 ? `; primero conviene cerrar los vencidos${firstOverdue ? `, empezando por ${firstOverdue}` : ""}` : "."}`,
    it: () =>
      `Hai ${highCount} contatto${highCount === 1 ? "" : "i"} ad alta priorita${firstHigh ? `, incluso ${firstHigh}` : ""}${overdueCount > 0 ? `; prima conviene chiudere i ritardi${firstOverdue ? `, a partire da ${firstOverdue}` : ""}` : "."}`,
    pt: () =>
      `Tem ${highCount} contacto${highCount === 1 ? "" : "s"} de alta prioridade${firstHigh ? `, incluindo ${firstHigh}` : ""}${overdueCount > 0 ? `; primeiro vale a pena resolver os atrasos${firstOverdue ? `, comecando por ${firstOverdue}` : ""}` : "."}`,
    nl: () =>
      `Je hebt ${highCount} contact${highCount === 1 ? "" : "en"} met hoge prioriteit${firstHigh ? `, waaronder ${firstHigh}` : ""}${overdueCount > 0 ? `; eerst is het goed om de achterstanden af te ronden${firstOverdue ? `, te beginnen bij ${firstOverdue}` : ""}` : "."}`,
    pl: () =>
      `Masz ${highCount} kontakt${highCount === 1 ? "" : "y"} o wysokim priorytecie${firstHigh ? `, w tym ${firstHigh}` : ""}${overdueCount > 0 ? `; najpierw warto domknac zaleglosci${firstOverdue ? `, zaczynajac od ${firstOverdue}` : ""}` : "."}`,
    sv: () =>
      `Du har ${highCount} kontakt${highCount === 1 ? "" : "er"} med hog prioritet${firstHigh ? `, inklusive ${firstHigh}` : ""}${overdueCount > 0 ? `; forst bor forseningarna stangas${firstOverdue ? `, med start pa ${firstOverdue}` : ""}` : "."}`,
    da: () =>
      `Du har ${highCount} kontakt${highCount === 1 ? "" : "er"} med hoj prioritet${firstHigh ? `, inklusive ${firstHigh}` : ""}${overdueCount > 0 ? `; forst bor de forsinkede punkter lukkes${firstOverdue ? `, startende med ${firstOverdue}` : ""}` : "."}`,
    fi: () =>
      `Sinulla on ${highCount} korkean prioriteetin kontakti${highCount === 1 ? "" : "a"}${firstHigh ? `, mukaan lukien ${firstHigh}` : ""}${overdueCount > 0 ? `; ensin kannattaa hoitaa myohassa olevat seurannat${firstOverdue ? `, alkaen ${firstOverdue}` : ""}` : "."}`,
    nb: () =>
      `Du har ${highCount} kontakt${highCount === 1 ? "" : "er"} med hoy prioritet${firstHigh ? `, inkludert ${firstHigh}` : ""}${overdueCount > 0 ? `; forst bor etterslep lukkes${firstOverdue ? `, med start pa ${firstOverdue}` : ""}` : "."}`,
    en: () =>
      `You have ${highCount} high-priority contact${highCount === 1 ? "" : "s"}${firstHigh ? `, including ${firstHigh}` : ""}${overdueCount > 0 ? `; the overdue items deserve first attention${firstOverdue ? `, starting with ${firstOverdue}` : ""}` : "."}`,
  });

  const contextLine = buildLocalizedSentence(input.language, {
    fr: () =>
      `Il n'y a ${meetingsCount > 0 ? "pas encore" : "aucun"} rendez-vous ni visite a faire ressortir${meetingsCount > 0 ? `, et ${emailCount} resume${emailCount === 1 ? "" : "s"} d'email est${emailCount === 1 ? "" : "s"} disponible${emailCount === 1 ? "" : "s"}` : " aujourd'hui"}.`,
    de: () =>
      `${meetingsCount > 0 ? "Es gibt bereits" : "Es gibt"} ${meetingsCount} Meeting${meetingsCount === 1 ? "" : "s"}/Besuch${meetingsCount === 1 ? "" : "e"}${emailCount > 0 ? ` und ${emailCount} E-Mail-Zusammenfassung${emailCount === 1 ? "" : "en"}` : ""}.`,
    es: () =>
      `${meetingsCount > 0 ? "Ya hay" : "No hay"} ${meetingsCount} reunion${meetingsCount === 1 ? "" : "es"}/visita${meetingsCount === 1 ? "" : "s"}${emailCount > 0 ? ` y ${emailCount} resumen${emailCount === 1 ? "" : "es"} de correo` : ""}.`,
    it: () =>
      `${meetingsCount > 0 ? "Ci sono gia" : "Non ci sono"} ${meetingsCount} incontro${meetingsCount === 1 ? "" : "i"}/visita${meetingsCount === 1 ? "" : "e"}${emailCount > 0 ? ` e ${emailCount} riepilogo${emailCount === 1 ? "" : "i"} email` : ""}.`,
    pt: () =>
      `${meetingsCount > 0 ? "Ja ha" : "Nao ha"} ${meetingsCount} reuniao${meetingsCount === 1 ? "" : "es"}/visita${meetingsCount === 1 ? "" : "s"}${emailCount > 0 ? ` e ${emailCount} resumo${emailCount === 1 ? "" : "s"} de email` : ""}.`,
    nl: () =>
      `${meetingsCount > 0 ? "Er zijn al" : "Er zijn"} ${meetingsCount} afspraak${meetingsCount === 1 ? "" : "afspraken"}/bezoek${meetingsCount === 1 ? "" : "en"}${emailCount > 0 ? ` en ${emailCount} e-mailsamenvatting${emailCount === 1 ? "" : "en"}` : ""}.`,
    pl: () =>
      `${meetingsCount > 0 ? "Jest juz" : "Nie ma"} ${meetingsCount} spotkani${meetingsCount === 1 ? "e" : "a"}/wizyt${meetingsCount === 1 ? "a" : "y"}${emailCount > 0 ? ` oraz ${emailCount} podsumowan${emailCount === 1 ? "ie" : "ia"} email` : ""}.`,
    sv: () =>
      `${meetingsCount > 0 ? "Det finns redan" : "Det finns"} ${meetingsCount} mote${meetingsCount === 1 ? "" : "n"}/besok${meetingsCount === 1 ? "" : ""}${emailCount > 0 ? ` och ${emailCount} e-postsammanfattning${emailCount === 1 ? "" : "ar"}` : ""}.`,
    da: () =>
      `${meetingsCount > 0 ? "Der er allerede" : "Der er"} ${meetingsCount} mode${meetingsCount === 1 ? "" : "r"}/besog${meetingsCount === 1 ? "" : ""}${emailCount > 0 ? ` og ${emailCount} email-resume${emailCount === 1 ? "" : "r"}` : ""}.`,
    fi: () =>
      `${meetingsCount > 0 ? "Loytyy jo" : "Ei ole"} ${meetingsCount} tapaami${meetingsCount === 1 ? "nen" : "sta"}/kaynti${meetingsCount === 1 ? "" : "a"}${emailCount > 0 ? ` ja ${emailCount} sahkopostiyhteenveto${emailCount === 1 ? "" : "a"}` : ""}.`,
    nb: () =>
      `${meetingsCount > 0 ? "Det finnes allerede" : "Det finnes"} ${meetingsCount} mote${meetingsCount === 1 ? "" : "r"}/besok${meetingsCount === 1 ? "" : ""}${emailCount > 0 ? ` og ${emailCount} e-postsammendrag${emailCount === 1 ? "" : "er"}` : ""}.`,
    en: () =>
      `${meetingsCount > 0 ? "There are already" : "There are"} ${meetingsCount} meeting${meetingsCount === 1 ? "" : "s"}/visit${meetingsCount === 1 ? "" : "s"}${emailCount > 0 ? ` and ${emailCount} email summary${emailCount === 1 ? "" : "ies"}` : ""}.`,
  });

  const closingLine = buildLocalizedNextStepLine(input.language, dueNames, overdueNames, highNames);

  return `${dueSentence} ${secondSentence}\n\n${contextLine}\n\n${closingLine}`.trim();
}

function normalizeBriefingClosingSentence(
  value: string,
  input: Parameters<typeof composeAIDailyBriefing>[0],
  dueNames: string[],
  overdueNames: string[],
  highNames: string[],
) {
  const closingLine = buildLocalizedNextStepLine(input.language, dueNames, overdueNames, highNames);
  const stripped = value.replace(new RegExp(escapeRegExp(closingLine), "g"), "").trim();

  if (stripped.length === 0) {
    return closingLine;
  }

  return `${stripped.replace(/\n{3,}/g, "\n\n")}\n\n${closingLine}`.trim();
}

function buildLocalizedSentence(languageCode: string, options: Record<string, () => string>) {
  const language = normalizeLanguageCode(languageCode);
  return (options[language] ?? options.en)();
}

function formatNames(names: string[]) {
  return names.length > 0 ? ` (${names.join(", ")})` : "";
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLocalizedNextStepLine(
  languageCode: string,
  dueNames: string[],
  overdueNames: string[],
  highNames: string[],
) {
  const language = normalizeLanguageCode(languageCode);
  const nextDue = dueNames[0] ?? null;
  const nextOverdue = overdueNames[0] ?? null;
  const nextHigh = highNames[0] ?? null;

  if (language === "fr") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Cloture: commencez par ${nextDue ?? nextOverdue ?? nextHigh ?? "le prochain dossier"}.`;
    }

    return "Cloture: gardez le rythme et restez concentre sur les dossiers importants.";
  }

  if (language === "de") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Abschluss: beginnen Sie mit ${nextDue ?? nextOverdue ?? nextHigh ?? "dem naechsten Schritt"}.`;
    }

    return "Abschluss: den Rhythmus halten und den Fokus auf die wichtigen Themen behalten.";
  }

  if (language === "es") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Cierre: empieza por ${nextDue ?? nextOverdue ?? nextHigh ?? "el siguiente paso"}.`;
    }

    return "Cierre: mantente en ritmo y centrate en los asuntos importantes.";
  }

  if (language === "it") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Chiusura: inizia da ${nextDue ?? nextOverdue ?? nextHigh ?? "il prossimo passo"}.`;
    }

    return "Chiusura: mantieni il ritmo e concentrati sui temi importanti.";
  }

  if (language === "pt") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Fecho: comeca por ${nextDue ?? nextOverdue ?? nextHigh ?? "o proximo passo"}.`;
    }

    return "Fecho: mantem o ritmo e foca no que e importante hoje.";
  }

  if (language === "nl") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Afsluiting: begin met ${nextDue ?? nextOverdue ?? nextHigh ?? "de volgende stap"}.`;
    }

    return "Afsluiting: houd het tempo vast en focus op de belangrijke dossiers.";
  }

  if (language === "pl") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Zakonczenie: zaczynaj od ${nextDue ?? nextOverdue ?? nextHigh ?? "nastepnego kroku"}.`;
    }

    return "Zakonczenie: utrzymaj rytm i skup sie na waznych sprawach.";
  }

  if (language === "sv") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Avslut: borja med ${nextDue ?? nextOverdue ?? nextHigh ?? "nasta steg"}.`;
    }

    return "Avslut: behall tempot och fokusera pa det som ar viktigast.";
  }

  if (language === "da") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Afslutning: begynd med ${nextDue ?? nextOverdue ?? nextHigh ?? "naeste skridt"}.`;
    }

    return "Afslutning: hold rytmen og fokuser pa det vigtigste.";
  }

  if (language === "fi") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Lopetus: aloita ${nextDue ?? nextOverdue ?? nextHigh ?? "seuraavasta askeleesta"}.`;
    }

    return "Lopetus: pidä tahti tasaisena ja keskity olennaisiin asioihin.";
  }

  if (language === "nb") {
    if (nextDue || nextOverdue || nextHigh) {
      return `Avslutning: start med ${nextDue ?? nextOverdue ?? nextHigh ?? "neste steg"}.`;
    }

    return "Avslutning: hold tempoet og fokuser pa det som er viktigst.";
  }

  if (nextDue || nextOverdue || nextHigh) {
    return `Closing step: start with ${nextDue ?? nextOverdue ?? nextHigh ?? "the next step"}.`;
  }

  return "Closing step: keep the pace steady and focus on the important work.";
}

function getBriefingLocaleStrings(languageCode: string): BriefingLocaleCopy {
  const language = normalizeLanguageCode(languageCode);
  if (language === "fr") {
    return {
      followUpActionTitle: (name) => `Suivi a faire avec ${name}`,
      followUpActionReason: "Le suivi assigne est a faire aujourd'hui.",
      highPriorityActionTitle: (name) => `Verifier le contact prioritaire ${name}`,
      highPriorityActionReason: "Ce contact assigne est marque comme prioritaire.",
      fallbackMissingModel: "Le modele IA n'est pas configure, ce briefing de secours est automatique.",
      fallbackAiFailed: "La generation IA a echoue temporairement, ce briefing de secours est automatique.",
      fallbackHeadline: (workspaceName) => `Briefing quotidien pour ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Vous avez ${dueToday} suivi(s) assigne(s) a faire aujourd'hui et ${highPriority} contact(s) assigne(s) prioritaire(s).`,
      latestTimeline: (title, contactName) => `Derniere activite rendez-vous/visite: ${title} (${contactName}).`,
      noTimeline: "Aucun rendez-vous ou visite enregistre aujourd'hui.",
      latestSummary: (contactName, summaryText) => `Dernier resume d'email: ${contactName} - ${summaryText}`,
      noSummary: "Aucun resume d'email enregistre aujourd'hui.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} contacts actifs, ${highPriority} prioritaires, ${followUps7Days} suivis a faire sur 7 jours.`,
      detailDueToday: (count, names) => `Suivis assignes a faire aujourd'hui: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Suivis assignes en retard: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Contacts assignes prioritaires: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Rendez-vous/visites aujourd'hui: ${meetingsAndVisits}. Resumes d'email aujourd'hui: ${emailSummaries}.`,
    };
  }

  if (language === "de") {
    return {
      followUpActionTitle: (name) => `Nachfassen bei ${name}`,
      followUpActionReason: "Das zugewiesene Follow-up ist heute fallig.",
      highPriorityActionTitle: (name) => `Kontakt mit hoher Prioritat prufen: ${name}`,
      highPriorityActionReason: "Dieser zugewiesene Kontakt ist als hohe Prioritat markiert.",
      fallbackMissingModel: "Das KI-Modell ist nicht konfiguriert; dies ist ein automatisches Ersatz-Briefing.",
      fallbackAiFailed: "Die KI-Generierung ist vorubergehend fehlgeschlagen; dies ist ein automatisches Ersatz-Briefing.",
      fallbackHeadline: (workspaceName) => `Tagesbriefing fur ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Sie haben ${dueToday} zugewiesene Follow-ups fur heute und ${highPriority} zugewiesene Kontakte mit hoher Prioritat.`,
      latestTimeline: (title, contactName) => `Neueste Meeting-/Besuchsaktivitat: ${title} (${contactName}).`,
      noTimeline: "Heute sind keine Meetings oder Besuche erfasst.",
      latestSummary: (contactName, summaryText) => `Neueste E-Mail-Zusammenfassung: ${contactName} - ${summaryText}`,
      noSummary: "Heute wurden keine E-Mail-Zusammenfassungen erfasst.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} aktive Kontakte, ${highPriority} mit hoher Prioritat, ${followUps7Days} Follow-ups in 7 Tagen fallig.`,
      detailDueToday: (count, names) => `Heute fallige zugewiesene Follow-ups: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Uberfallige zugewiesene Follow-ups: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Zugewiesene Kontakte mit hoher Prioritat: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Meetings/Besuche heute: ${meetingsAndVisits}. E-Mail-Zusammenfassungen heute: ${emailSummaries}.`,
    };
  }

  if (language === "es") {
    return {
      followUpActionTitle: (name) => `Hacer seguimiento con ${name}`,
      followUpActionReason: "El seguimiento asignado vence hoy.",
      highPriorityActionTitle: (name) => `Revisar contacto de alta prioridad ${name}`,
      highPriorityActionReason: "Este contacto asignado esta marcado como de alta prioridad.",
      fallbackMissingModel: "El modelo de IA no esta configurado; este es un resumen de respaldo automatico.",
      fallbackAiFailed: "La generacion con IA fallo temporalmente; este es un resumen de respaldo automatico.",
      fallbackHeadline: (workspaceName) => `Resumen diario para ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Tienes ${dueToday} seguimientos asignados para hoy y ${highPriority} contactos asignados de alta prioridad.`,
      latestTimeline: (title, contactName) => `Ultima actividad de reunion/visita: ${title} (${contactName}).`,
      noTimeline: "No hay reuniones ni visitas registradas para hoy.",
      latestSummary: (contactName, summaryText) => `Ultimo resumen de correo: ${contactName} - ${summaryText}`,
      noSummary: "No se registraron resumenes de correo hoy.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} contactos activos, ${highPriority} de alta prioridad, ${followUps7Days} seguimientos vencen en 7 dias.`,
      detailDueToday: (count, names) => `Seguimientos asignados para hoy: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Seguimientos asignados vencidos: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Contactos asignados de alta prioridad: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Reuniones/visitas hoy: ${meetingsAndVisits}. Resumenes de correo hoy: ${emailSummaries}.`,
    };
  }

  if (language === "it") {
    return {
      followUpActionTitle: (name) => `Fai follow-up con ${name}`,
      followUpActionReason: "Il follow-up assegnato e previsto per oggi.",
      highPriorityActionTitle: (name) => `Rivedi il contatto ad alta priorita ${name}`,
      highPriorityActionReason: "Questo contatto assegnato e contrassegnato come alta priorita.",
      fallbackMissingModel: "Il modello IA non e configurato; questo e un briefing di fallback automatico.",
      fallbackAiFailed: "La generazione IA e fallita temporaneamente; questo e un briefing di fallback automatico.",
      fallbackHeadline: (workspaceName) => `Briefing giornaliero per ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Hai ${dueToday} follow-up assegnati in scadenza oggi e ${highPriority} contatti assegnati ad alta priorita.`,
      latestTimeline: (title, contactName) => `Ultima attivita incontro/visita: ${title} (${contactName}).`,
      noTimeline: "Nessun incontro o visita registrato per oggi.",
      latestSummary: (contactName, summaryText) => `Ultimo riepilogo email: ${contactName} - ${summaryText}`,
      noSummary: "Nessun riepilogo email registrato oggi.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} contatti attivi, ${highPriority} ad alta priorita, ${followUps7Days} follow-up in scadenza entro 7 giorni.`,
      detailDueToday: (count, names) => `Follow-up assegnati in scadenza oggi: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Follow-up assegnati in ritardo: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Contatti assegnati ad alta priorita: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Incontri/visite oggi: ${meetingsAndVisits}. Riepiloghi email oggi: ${emailSummaries}.`,
    };
  }

  if (language === "pt") {
    return {
      followUpActionTitle: (name) => `Fazer acompanhamento com ${name}`,
      followUpActionReason: "O acompanhamento atribuido vence hoje.",
      highPriorityActionTitle: (name) => `Rever contacto de alta prioridade ${name}`,
      highPriorityActionReason: "Este contacto atribuido esta marcado como alta prioridade.",
      fallbackMissingModel: "O modelo de IA nao esta configurado; este e um briefing de contingencia automatico.",
      fallbackAiFailed: "A geracao com IA falhou temporariamente; este e um briefing de contingencia automatico.",
      fallbackHeadline: (workspaceName) => `Briefing diario para ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Tem ${dueToday} acompanhamentos atribuidos para hoje e ${highPriority} contactos atribuidos de alta prioridade.`,
      latestTimeline: (title, contactName) => `Atividade mais recente de reuniao/visita: ${title} (${contactName}).`,
      noTimeline: "Nao ha reunioes ou visitas registadas para hoje.",
      latestSummary: (contactName, summaryText) => `Resumo de email mais recente: ${contactName} - ${summaryText}`,
      noSummary: "Nao foram registados resumos de email hoje.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} contactos ativos, ${highPriority} de alta prioridade, ${followUps7Days} acompanhamentos a vencer em 7 dias.`,
      detailDueToday: (count, names) => `Acompanhamentos atribuidos para hoje: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Acompanhamentos atribuidos em atraso: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Contactos atribuidos de alta prioridade: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Reunioes/visitas hoje: ${meetingsAndVisits}. Resumos de email hoje: ${emailSummaries}.`,
    };
  }

  if (language === "nl") {
    return {
      followUpActionTitle: (name) => `Opvolgen met ${name}`,
      followUpActionReason: "De toegewezen opvolging is vandaag verschuldigd.",
      highPriorityActionTitle: (name) => `Controleer contact met hoge prioriteit ${name}`,
      highPriorityActionReason: "Dit toegewezen contact is gemarkeerd als hoge prioriteit.",
      fallbackMissingModel: "Het AI-model is niet geconfigureerd; dit is een automatische reservebriefing.",
      fallbackAiFailed: "AI-generatie is tijdelijk mislukt; dit is een automatische reservebriefing.",
      fallbackHeadline: (workspaceName) => `Dagelijkse briefing voor ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Je hebt ${dueToday} toegewezen opvolgingen voor vandaag en ${highPriority} toegewezen contacten met hoge prioriteit.`,
      latestTimeline: (title, contactName) => `Laatste activiteit voor afspraak/bezoek: ${title} (${contactName}).`,
      noTimeline: "Geen afspraken of bezoeken geregistreerd voor vandaag.",
      latestSummary: (contactName, summaryText) => `Laatste e-mailsamenvatting: ${contactName} - ${summaryText}`,
      noSummary: "Er zijn vandaag geen e-mailsamenvattingen geregistreerd.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} actieve contacten, ${highPriority} met hoge prioriteit, ${followUps7Days} opvolgingen vervallen binnen 7 dagen.`,
      detailDueToday: (count, names) => `Toegewezen opvolgingen voor vandaag: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Achterstallige toegewezen opvolgingen: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Toegewezen contacten met hoge prioriteit: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Afspraken/bezoeken vandaag: ${meetingsAndVisits}. E-mailsamenvattingen vandaag: ${emailSummaries}.`,
    };
  }

  if (language === "pl") {
    return {
      followUpActionTitle: (name) => `Wykonaj follow-up z ${name}`,
      followUpActionReason: "Przypisany follow-up jest na dzisiaj.",
      highPriorityActionTitle: (name) => `Sprawdz kontakt o wysokim priorytecie ${name}`,
      highPriorityActionReason: "Ten przypisany kontakt ma wysoki priorytet.",
      fallbackMissingModel: "Model AI nie jest skonfigurowany; to automatyczny briefing awaryjny.",
      fallbackAiFailed: "Generowanie AI tymczasowo nie powiodlo sie; to automatyczny briefing awaryjny.",
      fallbackHeadline: (workspaceName) => `Codzienny briefing dla ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Masz ${dueToday} przypisanych follow-upow na dzisiaj oraz ${highPriority} przypisanych kontaktow o wysokim priorytecie.`,
      latestTimeline: (title, contactName) => `Najnowsza aktywnosc spotkania/wizyty: ${title} (${contactName}).`,
      noTimeline: "Brak zarejestrowanych spotkan lub wizyt na dzisiaj.",
      latestSummary: (contactName, summaryText) => `Najnowsze podsumowanie email: ${contactName} - ${summaryText}`,
      noSummary: "Brak zarejestrowanych podsumowan email dzisiaj.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} aktywnych kontaktow, ${highPriority} o wysokim priorytecie, ${followUps7Days} follow-upow w terminie 7 dni.`,
      detailDueToday: (count, names) => `Przypisane follow-upy na dzisiaj: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Zalegle przypisane follow-upy: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Przypisane kontakty o wysokim priorytecie: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Spotkania/wizyty dzisiaj: ${meetingsAndVisits}. Podsumowania email dzisiaj: ${emailSummaries}.`,
    };
  }

  if (language === "sv") {
    return {
      followUpActionTitle: (name) => `Folj upp med ${name}`,
      followUpActionReason: "Den tilldelade uppfoljningen forfaller idag.",
      highPriorityActionTitle: (name) => `Granska hogprioriterad kontakt ${name}`,
      highPriorityActionReason: "Denna tilldelade kontakt ar markerad som hog prioritet.",
      fallbackMissingModel: "AI-modellen ar inte konfigurerad; detta ar en automatisk reservbriefing.",
      fallbackAiFailed: "AI-generering misslyckades tillfalligt; detta ar en automatisk reservbriefing.",
      fallbackHeadline: (workspaceName) => `Daglig briefing for ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Du har ${dueToday} tilldelade uppfoljningar for idag och ${highPriority} tilldelade hogprioriterade kontakter.`,
      latestTimeline: (title, contactName) => `Senaste mote-/besoksaktivitet: ${title} (${contactName}).`,
      noTimeline: "Inga moten eller besok ar registrerade for idag.",
      latestSummary: (contactName, summaryText) => `Senaste e-postsammanfattning: ${contactName} - ${summaryText}`,
      noSummary: "Inga e-postsammanfattningar registrerades idag.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} aktiva kontakter, ${highPriority} hog prioritet, ${followUps7Days} uppfoljningar forfaller inom 7 dagar.`,
      detailDueToday: (count, names) => `Tilldelade uppfoljningar for idag: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Forsenade tilldelade uppfoljningar: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Tilldelade hogprioriterade kontakter: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Moten/besok idag: ${meetingsAndVisits}. E-postsammanfattningar idag: ${emailSummaries}.`,
    };
  }

  if (language === "da") {
    return {
      followUpActionTitle: (name) => `Foelg op med ${name}`,
      followUpActionReason: "Den tildelte opfoelgning forfalder i dag.",
      highPriorityActionTitle: (name) => `Gennemga kontakt med hoej prioritet ${name}`,
      highPriorityActionReason: "Denne tildelte kontakt er markeret som hoej prioritet.",
      fallbackMissingModel: "AI-modellen er ikke konfigureret; dette er en automatisk reservebriefing.",
      fallbackAiFailed: "AI-generering mislykkedes midlertidigt; dette er en automatisk reservebriefing.",
      fallbackHeadline: (workspaceName) => `Daglig briefing for ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Du har ${dueToday} tildelte opfoelgninger for i dag og ${highPriority} tildelte kontakter med hoej prioritet.`,
      latestTimeline: (title, contactName) => `Seneste moede-/besoegsaktivitet: ${title} (${contactName}).`,
      noTimeline: "Ingen moeder eller besoeg er registreret i dag.",
      latestSummary: (contactName, summaryText) => `Seneste email-resume: ${contactName} - ${summaryText}`,
      noSummary: "Ingen email-resumeer blev registreret i dag.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} aktive kontakter, ${highPriority} med hoej prioritet, ${followUps7Days} opfoelgninger forfalder inden for 7 dage.`,
      detailDueToday: (count, names) => `Tildelte opfoelgninger for i dag: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Forsinkede tildelte opfoelgninger: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Tildelte kontakter med hoej prioritet: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Moeder/besoeg i dag: ${meetingsAndVisits}. Email-resumeer i dag: ${emailSummaries}.`,
    };
  }

  if (language === "fi") {
    return {
      followUpActionTitle: (name) => `Tee seuranta yhteydelle ${name}`,
      followUpActionReason: "Maaratty seuranta eraaantyy tanaan.",
      highPriorityActionTitle: (name) => `Tarkista korkean prioriteetin kontakti ${name}`,
      highPriorityActionReason: "Tama maaratty kontakti on merkitty korkeaksi prioriteetiksi.",
      fallbackMissingModel: "AI-mallia ei ole maaritetty; tama on automaattinen varabriefing.",
      fallbackAiFailed: "AI-generointi epaonnistui valiaikaisesti; tama on automaattinen varabriefing.",
      fallbackHeadline: (workspaceName) => `Paivittainen briefing: ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Sinulla on ${dueToday} maarattya tanaan eraaantyvaa seurantaa ja ${highPriority} maarattya korkean prioriteetin kontaktia.`,
      latestTimeline: (title, contactName) => `Uusin tapaamis-/kayntitapahtuma: ${title} (${contactName}).`,
      noTimeline: "Tanaan ei ole kirjattuja tapaamisia tai kaynteja.",
      latestSummary: (contactName, summaryText) => `Uusin sahkopostiyhteenveto: ${contactName} - ${summaryText}`,
      noSummary: "Tanaan ei kirjattu sahkopostiyhteenvetoja.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} aktiivista kontaktia, ${highPriority} korkealla prioriteetilla, ${followUps7Days} seurantaa eraaantyy 7 paivan sisalla.`,
      detailDueToday: (count, names) => `Tanaan eraaantyvat maaratyt seurannat: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Myohastyneet maaratyt seurannat: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Maaratyt korkean prioriteetin kontaktit: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Tapaamiset/kaynnit tanaan: ${meetingsAndVisits}. Sahkopostiyhteenvedot tanaan: ${emailSummaries}.`,
    };
  }

  if (language === "nb") {
    return {
      followUpActionTitle: (name) => `Folg opp med ${name}`,
      followUpActionReason: "Den tildelte oppfolgingen forfaller i dag.",
      highPriorityActionTitle: (name) => `Gjennomga kontakt med hoy prioritet ${name}`,
      highPriorityActionReason: "Denne tildelte kontakten er markert med hoy prioritet.",
      fallbackMissingModel: "AI-modellen er ikke konfigurert; dette er en automatisk reservebriefing.",
      fallbackAiFailed: "AI-generering feilet midlertidig; dette er en automatisk reservebriefing.",
      fallbackHeadline: (workspaceName) => `Daglig briefing for ${workspaceName}`,
      fallbackCounts: (dueToday, highPriority) =>
        `Du har ${dueToday} tildelte oppfolginger for i dag og ${highPriority} tildelte kontakter med hoy prioritet.`,
      latestTimeline: (title, contactName) => `Siste mote-/besoksaktivitet: ${title} (${contactName}).`,
      noTimeline: "Ingen moter eller besok er registrert i dag.",
      latestSummary: (contactName, summaryText) => `Siste e-postsammendrag: ${contactName} - ${summaryText}`,
      noSummary: "Ingen e-postsammendrag ble registrert i dag.",
      workspacePulse: (activeContacts, highPriority, followUps7Days) =>
        `${activeContacts} aktive kontakter, ${highPriority} med hoy prioritet, ${followUps7Days} oppfolginger forfaller innen 7 dager.`,
      detailDueToday: (count, names) => `Tildelte oppfolginger for i dag: ${count}${formatNames(names)}.`,
      detailOverdue: (count, names) => `Forsinkede tildelte oppfolginger: ${count}${formatNames(names)}.`,
      detailHighPriority: (count, names) => `Tildelte kontakter med hoy prioritet: ${count}${formatNames(names)}.`,
      detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
        `Moter/besok i dag: ${meetingsAndVisits}. E-postsammendrag i dag: ${emailSummaries}.`,
    };
  }

  return {
    followUpActionTitle: (name) => `Follow up with ${name}`,
    followUpActionReason: "Assigned follow-up is due today.",
    highPriorityActionTitle: (name) => `Review high-priority contact ${name}`,
    highPriorityActionReason: "This assigned contact is marked high priority.",
    fallbackMissingModel: "AI model is not configured, so this is an automatic fallback brief.",
    fallbackAiFailed: "AI generation failed temporarily, so this is an automatic fallback brief.",
    fallbackHeadline: (workspaceName) => `Daily brief for ${workspaceName}`,
    fallbackCounts: (dueToday, highPriority) =>
      `You have ${dueToday} assigned follow-ups due today and ${highPriority} high-priority assigned contacts.`,
    latestTimeline: (title, contactName) => `Latest meeting/visit activity: ${title} (${contactName}).`,
    noTimeline: "No meeting or visit events are logged for today.",
    latestSummary: (contactName, summaryText) => `Latest triage summary: ${contactName} - ${summaryText}`,
    noSummary: "No email triage summaries were recorded today.",
    workspacePulse: (activeContacts, highPriority, followUps7Days) =>
      `${activeContacts} active contacts, ${highPriority} high priority, ${followUps7Days} follow-ups due in 7 days.`,
    detailDueToday: (count, names) => `Assigned follow-ups due today: ${count}${formatNames(names)}.`,
    detailOverdue: (count, names) => `Overdue assigned follow-ups: ${count}${formatNames(names)}.`,
    detailHighPriority: (count, names) => `Assigned high-priority contacts: ${count}${formatNames(names)}.`,
    detailMeetingsAndEmails: (meetingsAndVisits, emailSummaries) =>
      `Meetings/visits today: ${meetingsAndVisits}. Email summaries today: ${emailSummaries}.`,
  };
}

function compareNullableDateAsc(left: string | null, right: string | null) {
  if (!left && !right) {
    return 0;
  }

  if (!left) {
    return 1;
  }

  if (!right) {
    return -1;
  }

  return new Date(left).getTime() - new Date(right).getTime();
}

function compareDateDesc(left: string, right: string) {
  return new Date(right).getTime() - new Date(left).getTime();
}
