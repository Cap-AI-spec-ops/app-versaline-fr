"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";
import { useAccessibleWorkspaces } from "@/lib/workspace/use-accessible-workspaces";
import { useWorkspaceMembers } from "@/lib/workspace/use-workspace-members";

type ClientType = "buyer" | "seller" | "tenant" | "landlord" | "investor" | "vendor" | "other";
type ContactStage =
  | "new_lead"
  | "qualified"
  | "viewing"
  | "negotiating"
  | "closed_won"
  | "archived"
  | "closed_lost";
type VisibleContactStage = "new_lead" | "qualified" | "viewing" | "negotiating" | "closed_won";
type ContactPriority = "low" | "normal" | "high";
type ContactChannel = "phone" | "email" | "whatsapp" | "sms" | "other";

type ContactEventType = "note" | "call" | "email" | "meeting" | "visit" | "status_change" | "created";
type TimelineEventType = ContactEventType | "email_summary";

type CrmContact = {
  id: string;
  workspace_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  budget: number | null;
  currency: string;
  client_type: ClientType;
  stage: ContactStage;
  priority: ContactPriority;
  source: string | null;
  preferred_channel: ContactChannel;
  notes: string | null;
  assigned_to: string | null;
  next_follow_up_at: string | null;
  last_contact_at: string | null;
  created_at: string;
  updated_at: string;
};

type CrmContactEvent = {
  id: string;
  contact_id: string;
  workspace_id: string;
  created_by: string | null;
  event_type: TimelineEventType;
  title: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
  created_at: string;
};

type EmailSummaryRow = {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  created_by: string | null;
  summary_text: string;
  triage_reason_code: string | null;
  triage_confidence: number | null;
  model_provider: string | null;
  model_name: string | null;
  metadata: Record<string, unknown> | null;
  received_at: string;
  created_at: string;
};

type ContactFormState = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  budget: string;
  currency: string;
  client_type: ClientType;
  priority: ContactPriority;
  source: string;
  preferred_channel: ContactChannel;
  notes: string;
  next_follow_up_at: string;
  assignee_profile_ids: string[];
};

type ContactAssigneeRow = {
  contact_id: string;
  profile_id: string;
};

type TimelineFormState = {
  event_type: Exclude<ContactEventType, "created" | "status_change">;
  title: string;
  body: string;
  due_date: string;
};

const STAGE_COLUMNS: Array<{ key: VisibleContactStage; label: string; accentClass: string }> = [
  { key: "new_lead", label: "New Lead", accentClass: "from-sky-400 to-cyan-300" },
  { key: "qualified", label: "Qualified", accentClass: "from-indigo-400 to-blue-300" },
  { key: "viewing", label: "Visits", accentClass: "from-amber-400 to-orange-300" },
  { key: "negotiating", label: "Negotiating", accentClass: "from-rose-400 to-pink-300" },
  { key: "closed_won", label: "Active", accentClass: "from-emerald-400 to-green-300" },
];

const EMPTY_CONTACT_FORM: ContactFormState = {
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  address: "",
  budget: "",
  currency: "EUR",
  client_type: "buyer",
  priority: "normal",
  source: "",
  preferred_channel: "phone",
  notes: "",
  next_follow_up_at: "",
  assignee_profile_ids: [],
};

const EMPTY_TIMELINE_FORM: TimelineFormState = {
  event_type: "note",
  title: "",
  body: "",
  due_date: "",
};

const CURRENCY_OPTIONS = ["EUR", "USD", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "BRL"] as const;

function requiresBudget(clientType: ClientType) {
  return clientType !== "seller" && clientType !== "tenant";
}

function formatMoney(value: number | null, currency: string) {
  if (value === null) {
    return "No budget";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(value: string | null) {
  if (!value) {
    return "Not set";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatDateOnly(value: string | null, emptyLabel = "Not set") {
  if (!value) {
    return emptyLabel;
  }

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${day}/${month}/${year}`;
  }

  const displayMatch = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);

  if (displayMatch) {
    return value;
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(value));
}

function getTimelineEventDueDate(event: CrmContactEvent) {
  const metadata = event.metadata;

  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const dueDate = "due_date" in metadata ? metadata.due_date : null;

  if (typeof dueDate !== "string" || !dueDate.trim()) {
    return null;
  }

  return dueDate;
}

function parseDisplayDateToIso(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, yearText, monthText, dayText] = isoMatch;
    const year = Number.parseInt(yearText, 10);
    const month = Number.parseInt(monthText, 10);
    const day = Number.parseInt(dayText, 10);

    if (!isValidDateParts(day, month, year)) {
      return null;
    }

    return `${yearText}-${monthText}-${dayText}`;
  }

  const displayMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!displayMatch) {
    return null;
  }

  const [, dayText, monthText, yearText] = displayMatch;
  const day = Number.parseInt(dayText, 10);
  const month = Number.parseInt(monthText, 10);
  const year = Number.parseInt(yearText, 10);

  if (!isValidDateParts(day, month, year)) {
    return null;
  }

  return `${yearText}-${monthText}-${dayText}`;
}

function getDisplayDateError(value: string) {
  if (!value.trim()) {
    return null;
  }

  return parseDisplayDateToIso(value)
    ? null
    : "Use dd/mm/yyyy (example: 31/07/2026).";
}

function isValidDateParts(day: number, month: number, year: number) {
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
    return false;
  }

  if (year < 1900 || year > 2100) {
    return false;
  }

  if (month < 1 || month > 12) {
    return false;
  }

  if (day < 1 || day > 31) {
    return false;
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return (
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() === month - 1 &&
    utcDate.getUTCDate() === day
  );
}

function formatStageLabel(value: string | null | undefined) {
  if (!value) {
    return "Unknown";
  }

  if (value === "closed_won") {
    return "Active";
  }

  return value.replace(/_/g, " ");
}

function formatStatusChangeBody(event: CrmContactEvent) {
  const fromStage = typeof event.metadata?.from_stage === "string" ? event.metadata.from_stage : null;
  const toStage = typeof event.metadata?.to_stage === "string" ? event.metadata.to_stage : null;

  if (fromStage && toStage) {
    return `Moved from ${formatStageLabel(fromStage)} to ${formatStageLabel(toStage)}`;
  }

  return event.body;
}

function getContactName(contact: CrmContact) {
  const full = `${contact.first_name} ${contact.last_name}`.trim();
  return full || "Unnamed contact";
}

function getPriorityBadgeClasses(priority: ContactPriority) {
  if (priority === "high") {
    return "border-red-200 bg-red-100 text-red-700";
  }

  if (priority === "low") {
    return "border-emerald-200 bg-emerald-100 text-emerald-700";
  }

  return "border-amber-200 bg-amber-100 text-amber-700";
}

function getEventActorLabel(event: CrmContactEvent, memberNameById: Record<string, string>) {
  if (!event.created_by) {
    return "System";
  }

  return memberNameById[event.created_by] ?? "Former teammate";
}

export default function CrmBoard() {
  const { workspace, currentRole, isLoading: isWorkspaceLoading, error: workspaceError } = useCurrentWorkspace();
  const {
    workspaces: accessibleWorkspaces,
    isLoading: isAccessibleWorkspacesLoading,
    error: accessibleWorkspacesError,
    refresh: refreshAccessibleWorkspaces,
  } = useAccessibleWorkspaces();
  const { members: workspaceMembers, currentUserId } = useWorkspaceMembers();
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [events, setEvents] = useState<CrmContactEvent[]>([]);
  const [assigneesByContact, setAssigneesByContact] = useState<Record<string, string[]>>({});
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState<ContactFormState>(EMPTY_CONTACT_FORM);
  const [timelineForm, setTimelineForm] = useState<TimelineFormState>(EMPTY_TIMELINE_FORM);
  const [selectedFollowUpInput, setSelectedFollowUpInput] = useState("");
  const [contactFollowUpDateError, setContactFollowUpDateError] = useState<string | null>(null);
  const [selectedFollowUpDateError, setSelectedFollowUpDateError] = useState<string | null>(null);
  const [timelineDueDateError, setTimelineDueDateError] = useState<string | null>(null);
  const [draggedContactId, setDraggedContactId] = useState<string | null>(null);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [editingEventTitle, setEditingEventTitle] = useState("");
  const [editingEventBody, setEditingEventBody] = useState("");
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [deletePhraseInput, setDeletePhraseInput] = useState("");
  const [isDeleteFinalCheckEnabled, setIsDeleteFinalCheckEnabled] = useState(false);
  const [contactSearchQuery, setContactSearchQuery] = useState("");
  const [onlyHighPriorityContacts, setOnlyHighPriorityContacts] = useState(false);
  const [onlyEmailSummaries, setOnlyEmailSummaries] = useState(false);
  const [isEmailFeatureEnabled, setIsEmailFeatureEnabled] = useState(false);
  const [isEmailPolicyLoading, setIsEmailPolicyLoading] = useState(true);
  const canSwitchWorkspaceScope = currentRole === "super_admin" || currentRole === "owner";
  const canDeleteContacts = currentRole === "super_admin" || currentRole === "owner" || currentRole === "team_lead";
  const inviteTeammateHref = canSwitchWorkspaceScope ? "/admin" : "/settings";

  const selectedContact = useMemo(
    () => contacts.find((contact) => contact.id === selectedContactId) ?? null,
    [contacts, selectedContactId],
  );

  useEffect(() => {
    setSelectedFollowUpInput(formatDateOnly(selectedContact?.next_follow_up_at ?? null, ""));
    setSelectedFollowUpDateError(null);
  }, [selectedContactId, selectedContact?.next_follow_up_at]);

  const workspaceMemberNameById = useMemo(() => {
    const names: Record<string, string> = {};

    for (const member of workspaceMembers) {
      const fullName = `${member.first_name ?? ""} ${member.last_name ?? ""}`.trim();
      names[member.profile_id] = fullName || "Unnamed teammate";
    }

    return names;
  }, [workspaceMembers]);
  const deleteConfirmationPhrase = selectedContact ? `DELETE ${getContactName(selectedContact)}` : "";
  const filteredContacts = useMemo(() => {
    const normalizedQuery = contactSearchQuery.trim().toLowerCase();

    const priorityFiltered = onlyHighPriorityContacts
      ? contacts.filter((contact) => contact.priority === "high")
      : contacts;

    if (!normalizedQuery) {
      return priorityFiltered;
    }

    return priorityFiltered.filter((contact) => {
      const searchableText = [
        contact.first_name,
        contact.last_name,
        contact.email ?? "",
        contact.phone ?? "",
        contact.source ?? "",
      ]
        .join(" ")
        .toLowerCase();

      return searchableText.includes(normalizedQuery);
    });
  }, [contacts, onlyHighPriorityContacts, contactSearchQuery]);

  const filteredEvents = useMemo(
    () => {
      const visibleEvents = isEmailFeatureEnabled
        ? events
        : events.filter((event) => event.event_type !== "email_summary");

      return onlyEmailSummaries ? visibleEvents.filter((event) => event.event_type === "email_summary") : visibleEvents;
    },
    [events, onlyEmailSummaries, isEmailFeatureEnabled],
  );

  const keptSummaryCount = useMemo(
    () => (isEmailFeatureEnabled ? events.filter((event) => event.event_type === "email_summary").length : 0),
    [events, isEmailFeatureEnabled],
  );

  function getAssigneePreview(contactId: string) {
    const ids = assigneesByContact[contactId] ?? [];

    if (ids.length === 0) {
      return "Unassigned";
    }

    const names = ids.map((id) => workspaceMemberNameById[id] ?? "Unknown teammate");

    if (names.length <= 2) {
      return names.join(", ");
    }

    return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
  }

  useEffect(() => {
    if (!workspace?.currency) {
      return;
    }

    setContactForm((previous) => ({
      ...previous,
      currency: previous.currency || workspace.currency || "EUR",
    }));
  }, [workspace?.currency]);

  useEffect(() => {
    if (!currentUserId) {
      return;
    }

    setContactForm((previous) => {
      if (previous.assignee_profile_ids.length > 0) {
        return previous;
      }

      return {
        ...previous,
        assignee_profile_ids: [currentUserId],
      };
    });
  }, [currentUserId]);

  useEffect(() => {
    if (!workspace?.id) {
      return;
    }

    void loadContacts(workspace.id);
  }, [workspace?.id]);

  useEffect(() => {
    async function loadEmailPolicy(companyId: string) {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        setIsEmailFeatureEnabled(false);
        setIsEmailPolicyLoading(false);
        return;
      }

      setIsEmailPolicyLoading(true);

      const { data, error: policyError } = await supabase
        .from("email_ingestion_policies")
        .select("feature_enabled")
        .eq("company_id", companyId)
        .maybeSingle();

      if (policyError) {
        setIsEmailFeatureEnabled(false);
        setIsEmailPolicyLoading(false);
        return;
      }

      setIsEmailFeatureEnabled(Boolean((data as { feature_enabled?: boolean } | null)?.feature_enabled));
      setIsEmailPolicyLoading(false);
    }

    const companyId = workspace?.company_id ?? null;

    if (!companyId) {
      setIsEmailFeatureEnabled(false);
      setIsEmailPolicyLoading(false);
      return;
    }

    void loadEmailPolicy(companyId);
  }, [workspace?.company_id]);

  useEffect(() => {
    if (!isEmailFeatureEnabled) {
      setOnlyEmailSummaries(false);
    }
  }, [isEmailFeatureEnabled]);

  useEffect(() => {
    if (!workspace?.id || !selectedContactId) {
      setEvents([]);
      return;
    }

    void loadTimeline(workspace.id, selectedContactId);
  }, [workspace?.id, selectedContactId, isEmailFeatureEnabled]);

  useEffect(() => {
    setIsDeleteConfirmOpen(false);
    setDeletePhraseInput("");
    setIsDeleteFinalCheckEnabled(false);
  }, [selectedContactId]);

  async function loadContacts(workspaceId: string) {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from("crm_contacts")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false });

    if (fetchError) {
      setContacts([]);
      setSelectedContactId(null);
      setError(withSessionReloadFallback(fetchError.message, "Could not load CRM contacts."));
      setIsLoading(false);
      return;
    }

    const rows = ((data ?? []) as CrmContact[]).filter(
      (contact) => contact.stage !== "archived" && contact.stage !== "closed_lost",
    );
    setContacts(rows);

    const contactIds = rows.map((row) => row.id);
    void loadAssigneesForContacts(workspaceId, contactIds);

    if (!selectedContactId && rows[0]) {
      setSelectedContactId(rows[0].id);
    }

    if (selectedContactId && !rows.some((row) => row.id === selectedContactId)) {
      setSelectedContactId(rows[0]?.id ?? null);
    }

    setIsLoading(false);
  }

  async function loadAssigneesForContacts(workspaceId: string, contactIds: string[]) {
    if (contactIds.length === 0) {
      setAssigneesByContact({});
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      return;
    }

    const { data, error: assigneesError } = await supabase
      .from("crm_contact_assignees")
      .select("contact_id, profile_id")
      .eq("workspace_id", workspaceId)
      .in("contact_id", contactIds);

    if (assigneesError) {
      setError(withSessionReloadFallback(assigneesError.message, "Could not load contact assignees."));
      return;
    }

    const mapped: Record<string, string[]> = {};

    for (const row of (data ?? []) as ContactAssigneeRow[]) {
      if (!mapped[row.contact_id]) {
        mapped[row.contact_id] = [];
      }

      mapped[row.contact_id].push(row.profile_id);
    }

    setAssigneesByContact(mapped);
  }

  async function syncContactAssignees(contactId: string, workspaceId: string, nextAssigneeIds: string[]) {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      throw new Error("Supabase is not configured.");
    }

    const uniqueAssignees = Array.from(new Set(nextAssigneeIds.filter(Boolean)));

    if (uniqueAssignees.length === 0) {
      throw new Error("At least one assignee is required.");
    }

    const { data: existingRows, error: existingError } = await supabase
      .from("crm_contact_assignees")
      .select("id, profile_id")
      .eq("workspace_id", workspaceId)
      .eq("contact_id", contactId);

    if (existingError) {
      throw new Error(existingError.message);
    }

    const existing = (existingRows ?? []) as Array<{ id: string; profile_id: string }>;
    const existingIds = new Set(existing.map((row) => row.profile_id));

    const toDeleteIds = existing.filter((row) => !uniqueAssignees.includes(row.profile_id)).map((row) => row.id);

    if (toDeleteIds.length > 0) {
      const { error: deleteError } = await supabase.from("crm_contact_assignees").delete().in("id", toDeleteIds);

      if (deleteError) {
        throw new Error(deleteError.message);
      }
    }

    const toInsert = uniqueAssignees
      .filter((profileId) => !existingIds.has(profileId))
      .map((profileId) => ({
        workspace_id: workspaceId,
        contact_id: contactId,
        profile_id: profileId,
      }));

    if (toInsert.length > 0) {
      const { error: insertError } = await supabase.from("crm_contact_assignees").insert(toInsert);

      if (insertError) {
        throw new Error(insertError.message);
      }
    }

    setAssigneesByContact((previous) => ({
      ...previous,
      [contactId]: uniqueAssignees,
    }));
  }

  async function loadTimeline(workspaceId: string, contactId: string) {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      return;
    }

    const { data, error: fetchError } = await supabase
      .from("crm_contact_events")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("contact_id", contactId)
      .order("occurred_at", { ascending: false })
      .limit(100);

    if (fetchError) {
      setError(withSessionReloadFallback(fetchError.message, "Could not load timeline events."));
      return;
    }

    let summaryEvents: CrmContactEvent[] = [];

    if (isEmailFeatureEnabled) {
      const { data: summaryRows, error: summariesError } = await supabase
        .from("email_summaries")
        .select("id, workspace_id, contact_id, created_by, summary_text, triage_reason_code, triage_confidence, model_provider, model_name, metadata, received_at, created_at")
        .eq("workspace_id", workspaceId)
        .eq("contact_id", contactId)
        .order("received_at", { ascending: false })
        .limit(100);

      if (summariesError) {
        setError(withSessionReloadFallback(summariesError.message, "Could not load email summaries."));
        return;
      }

      summaryEvents = ((summaryRows ?? []) as EmailSummaryRow[]).map((summary) => ({
        id: `email-summary-${summary.id}`,
        contact_id: summary.contact_id ?? contactId,
        workspace_id: summary.workspace_id,
        created_by: summary.created_by,
        event_type: "email_summary",
        title: "Email summary",
        body: summary.summary_text,
        metadata: {
          ...(summary.metadata ?? {}),
          triage_label: "save_summary",
          triage_reason_code: summary.triage_reason_code,
          triage_confidence: summary.triage_confidence,
          model_provider: summary.model_provider,
          model_name: summary.model_name,
          source: "email_summaries",
        },
        occurred_at: summary.received_at,
        created_at: summary.created_at,
      }));
    }

    const mergedEvents = [
      ...((data ?? []) as CrmContactEvent[]),
      ...summaryEvents,
    ].sort((left, right) => new Date(right.occurred_at).getTime() - new Date(left.occurred_at).getTime());

    setEvents(mergedEvents);
  }

  async function handleCreateContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!workspace?.id) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const budgetValue = contactForm.budget.trim() ? Number(contactForm.budget) : null;
    const shouldStoreBudget = requiresBudget(contactForm.client_type);
    const nextFollowUpIso = parseDisplayDateToIso(contactForm.next_follow_up_at);
    const createFollowUpError = getDisplayDateError(contactForm.next_follow_up_at);

    if (shouldStoreBudget && budgetValue !== null && Number.isNaN(budgetValue)) {
      setError("Budget must be a valid number.");
      setIsSaving(false);
      return;
    }

    if (createFollowUpError) {
      setContactFollowUpDateError(createFollowUpError);
      setError("Next follow-up date must use dd/mm/yyyy.");
      setIsSaving(false);
      return;
    }

    const payload = {
      workspace_id: workspace.id,
      first_name: contactForm.first_name.trim(),
      last_name: contactForm.last_name.trim(),
      email: contactForm.email.trim() || null,
      phone: contactForm.phone.trim() || null,
      address: contactForm.address.trim() || null,
      budget: shouldStoreBudget ? budgetValue : null,
      currency: contactForm.currency.trim().toUpperCase() || "EUR",
      client_type: contactForm.client_type,
      stage: "new_lead" as ContactStage,
      priority: contactForm.priority,
      source: contactForm.source.trim() || null,
      preferred_channel: contactForm.preferred_channel,
      notes: contactForm.notes.trim() || null,
      next_follow_up_at: nextFollowUpIso,
    };

    const { data, error: insertError } = await supabase
      .from("crm_contacts")
      .insert(payload)
      .select("*")
      .single();

    if (insertError) {
      setError(withSessionReloadFallback(insertError.message, "Could not create contact."));
      setIsSaving(false);
      return;
    }

    const created = data as CrmContact;

    const createAssignees =
      contactForm.assignee_profile_ids.length > 0
        ? contactForm.assignee_profile_ids
        : currentUserId
          ? [currentUserId]
          : [];

    try {
      await syncContactAssignees(created.id, workspace.id, createAssignees);
    } catch (assigneeError) {
      setError(
        withSessionReloadFallback(
          assigneeError instanceof Error ? assigneeError.message : null,
          "Could not assign teammates.",
        ),
      );
      setIsSaving(false);
      return;
    }

    setContacts((previous) => [created, ...previous]);
    setSelectedContactId(created.id);
    setContactForm({
      ...EMPTY_CONTACT_FORM,
      currency: workspace.currency ?? "EUR",
      assignee_profile_ids: currentUserId ? [currentUserId] : [],
    });
    setContactFollowUpDateError(null);
    setIsCreateFormOpen(false);
    setMessage("Contact created.");
    setIsSaving(false);
  }

  async function handleUpdateSelectedContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!workspace?.id || !selectedContact) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const budgetText = selectedContact.budget === null ? "" : String(selectedContact.budget);
    const budgetValue = budgetText.trim() ? Number(budgetText) : null;
    const shouldStoreBudget = requiresBudget(selectedContact.client_type);
    const nextFollowUpIso = parseDisplayDateToIso(selectedFollowUpInput);
    const editFollowUpError = getDisplayDateError(selectedFollowUpInput);

    if (shouldStoreBudget && budgetValue !== null && Number.isNaN(budgetValue)) {
      setError("Budget must be a valid number.");
      setIsSaving(false);
      return;
    }

    if (editFollowUpError) {
      setSelectedFollowUpDateError(editFollowUpError);
      setError("Next follow-up date must use dd/mm/yyyy.");
      setIsSaving(false);
      return;
    }

    const { data, error: updateError } = await supabase
      .from("crm_contacts")
      .update({
        first_name: selectedContact.first_name.trim(),
        last_name: selectedContact.last_name.trim(),
        email: selectedContact.email?.trim() || null,
        phone: selectedContact.phone?.trim() || null,
        address: selectedContact.address?.trim() || null,
        budget: shouldStoreBudget ? budgetValue : null,
        currency: selectedContact.currency.trim().toUpperCase() || "EUR",
        client_type: selectedContact.client_type,
        priority: selectedContact.priority,
        source: selectedContact.source?.trim() || null,
        preferred_channel: selectedContact.preferred_channel,
        notes: selectedContact.notes?.trim() || null,
        next_follow_up_at: nextFollowUpIso,
      })
      .eq("id", selectedContact.id)
      .eq("workspace_id", workspace.id)
      .select("*")
      .single();

    if (updateError) {
      setError(withSessionReloadFallback(updateError.message, "Could not update contact."));
      setIsSaving(false);
      return;
    }

    const updated = data as CrmContact;

    const selectedAssignees =
      assigneesByContact[selectedContact.id]?.length > 0
        ? assigneesByContact[selectedContact.id]
        : currentUserId
          ? [currentUserId]
          : [];

    try {
      await syncContactAssignees(selectedContact.id, workspace.id, selectedAssignees);
    } catch (assigneeError) {
      setError(
        withSessionReloadFallback(
          assigneeError instanceof Error ? assigneeError.message : null,
          "Could not update assignees.",
        ),
      );
      setIsSaving(false);
      return;
    }

    setContacts((previous) => previous.map((contact) => (contact.id === updated.id ? updated : contact)));
    setSelectedFollowUpDateError(null);
    setMessage("Contact updated.");
    setIsSaving(false);
  }

  async function moveContactToStage(contactId: string, nextStage: VisibleContactStage) {
    if (!workspace?.id) {
      return;
    }

    const source = contacts.find((contact) => contact.id === contactId);

    if (!source || source.stage === nextStage) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setError(null);
    setMessage(null);

    const optimistic = contacts.map((contact) =>
      contact.id === contactId ? { ...contact, stage: nextStage, updated_at: new Date().toISOString() } : contact,
    );

    setContacts(optimistic);

    const { data, error: updateError } = await supabase
      .from("crm_contacts")
      .update({ stage: nextStage })
      .eq("id", contactId)
      .eq("workspace_id", workspace.id)
      .select("*")
      .single();

    if (updateError) {
      setContacts((previous) =>
        previous.map((contact) => (contact.id === contactId ? { ...contact, stage: source.stage } : contact)),
      );
      setError(withSessionReloadFallback(updateError.message, "Could not update contact stage."));
      return;
    }

    const updated = data as CrmContact;

    setContacts((previous) => previous.map((contact) => (contact.id === updated.id ? updated : contact)));
    setMessage(`${getContactName(updated)} moved to ${STAGE_COLUMNS.find((column) => column.key === nextStage)?.label}.`);

    if (selectedContactId === contactId) {
      void loadTimeline(workspace.id, contactId);
    }
  }

  async function archiveSelectedContact() {
    if (!workspace?.id || !selectedContact) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const { error: archiveError } = await supabase
      .from("crm_contacts")
      .update({ stage: "archived" })
      .eq("id", selectedContact.id)
      .eq("workspace_id", workspace.id);

    if (archiveError) {
      setError(withSessionReloadFallback(archiveError.message, "Could not archive contact."));
      setIsSaving(false);
      return;
    }

    const archivedId = selectedContact.id;
    const remaining = contacts.filter((contact) => contact.id !== archivedId);
    setContacts(remaining);
    setSelectedContactId(remaining[0]?.id ?? null);
    setMessage("Contact archived.");
    setIsSaving(false);
  }

  function startDeleteSelectedContact() {
    if (!canDeleteContacts) {
      setError("Only super admins, owners, and team leads can delete contacts.");
      return;
    }

    setIsDeleteConfirmOpen(true);
    setDeletePhraseInput("");
    setIsDeleteFinalCheckEnabled(false);
    setError(null);
    setMessage(null);
  }

  function cancelDeleteSelectedContact() {
    setIsDeleteConfirmOpen(false);
    setDeletePhraseInput("");
    setIsDeleteFinalCheckEnabled(false);
  }

  async function deleteSelectedContact() {
    if (!workspace?.id || !selectedContact) {
      return;
    }

    if (!canDeleteContacts) {
      setError("Only super admins, owners, and team leads can delete contacts.");
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    if (deletePhraseInput.trim() !== deleteConfirmationPhrase) {
      setError("Confirmation phrase mismatch. Deletion aborted.");
      return;
    }

    if (!isDeleteFinalCheckEnabled) {
      setError("Please confirm that deletion is permanent.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const deletingId = selectedContact.id;

    const { error: deleteError } = await supabase
      .from("crm_contacts")
      .delete()
      .eq("id", deletingId)
      .eq("workspace_id", workspace.id);

    if (deleteError) {
      setError(withSessionReloadFallback(deleteError.message, "Could not delete contact."));
      setIsSaving(false);
      return;
    }

    const remaining = contacts.filter((contact) => contact.id !== deletingId);
    setContacts(remaining);
    setAssigneesByContact((previous) => {
      const next = { ...previous };
      delete next[deletingId];
      return next;
    });
    cancelDeleteSelectedContact();
    setSelectedContactId(remaining[0]?.id ?? null);
    setMessage("Contact permanently deleted.");
    setIsSaving(false);
  }

  async function handleCreateInteraction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!workspace?.id || !selectedContactId) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const dueDateIso = parseDisplayDateToIso(timelineForm.due_date);
    const dueDateError = getDisplayDateError(timelineForm.due_date);

    if (dueDateError) {
      setTimelineDueDateError(dueDateError);
      setError("Reminder date must use dd/mm/yyyy.");
      setIsSaving(false);
      return;
    }

    const payload = {
      workspace_id: workspace.id,
      contact_id: selectedContactId,
      event_type: timelineForm.event_type,
      title: timelineForm.title.trim() || timelineForm.event_type.toUpperCase(),
      body: timelineForm.body.trim() || null,
      occurred_at: new Date().toISOString(),
      metadata: dueDateIso
        ? {
            due_date: dueDateIso,
          }
        : null,
    };

    const { data, error: insertError } = await supabase
      .from("crm_contact_events")
      .insert(payload)
      .select("*")
      .single();

    if (insertError) {
      setError(withSessionReloadFallback(insertError.message, "Could not create timeline event."));
      setIsSaving(false);
      return;
    }

    const created = data as CrmContactEvent;

    setEvents((previous) => [created, ...previous]);
    setTimelineForm(EMPTY_TIMELINE_FORM);
    setTimelineDueDateError(null);
    setMessage("Interaction logged.");
    setIsSaving(false);
  }

  async function handleWorkspaceScopeChange(targetWorkspaceId: string) {
    if (!canSwitchWorkspaceScope || !workspace?.id || targetWorkspaceId === workspace.id) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setIsSwitchingWorkspace(true);
    setError(null);
    setMessage(null);

    const { error: switchError } = await supabase.rpc("switch_workspace", {
      p_workspace_id: targetWorkspaceId,
    });

    if (switchError) {
      setError(withSessionReloadFallback(switchError.message, "Could not switch workspace."));
      setIsSwitchingWorkspace(false);
      return;
    }

    await refreshAccessibleWorkspaces();
    setMessage("Workspace switched.");
    window.location.reload();
  }

  function updateSelectedContact<K extends keyof CrmContact>(key: K, value: CrmContact[K]) {
    if (!selectedContactId) {
      return;
    }

    setContacts((previous) =>
      previous.map((contact) => (contact.id === selectedContactId ? { ...contact, [key]: value } : contact)),
    );
  }

  function toggleCreateAssignee(profileId: string) {
    setContactForm((previous) => {
      const hasAssignee = previous.assignee_profile_ids.includes(profileId);

      if (hasAssignee) {
        const filtered = previous.assignee_profile_ids.filter((id) => id !== profileId);
        return {
          ...previous,
          assignee_profile_ids: filtered,
        };
      }

      return {
        ...previous,
        assignee_profile_ids: [...previous.assignee_profile_ids, profileId],
      };
    });
  }

  function toggleSelectedContactAssignee(profileId: string) {
    if (!selectedContactId) {
      return;
    }

    setAssigneesByContact((previous) => {
      const existing = previous[selectedContactId] ?? [];
      const hasAssignee = existing.includes(profileId);
      const next = hasAssignee ? existing.filter((id) => id !== profileId) : [...existing, profileId];

      return {
        ...previous,
        [selectedContactId]: next,
      };
    });
  }

  function canEditTimelineEvent(eventType: TimelineEventType) {
    return eventType === "note";
  }

  function canDeleteTimelineEvent(eventType: TimelineEventType) {
    if (eventType === "email_summary") {
      return false;
    }

    return eventType !== "status_change" && eventType !== "created";
  }

  function startEditingEvent(timelineEvent: CrmContactEvent) {
    setEditingEventId(timelineEvent.id);
    setEditingEventTitle(timelineEvent.title);
    setEditingEventBody(timelineEvent.body ?? "");
  }

  function cancelEditingEvent() {
    setEditingEventId(null);
    setEditingEventTitle("");
    setEditingEventBody("");
  }

  async function saveEditedEvent(eventId: string) {
    if (!workspace?.id || !selectedContactId) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const { data, error: updateError } = await supabase
      .from("crm_contact_events")
      .update({
        title: editingEventTitle.trim() || "Note",
        body: editingEventBody.trim() || null,
      })
      .eq("id", eventId)
      .eq("workspace_id", workspace.id)
      .eq("contact_id", selectedContactId)
      .select("*")
      .single();

    if (updateError) {
      setError(withSessionReloadFallback(updateError.message, "Could not update timeline event."));
      setIsSaving(false);
      return;
    }

    const updated = data as CrmContactEvent;

    setEvents((previous) => previous.map((item) => (item.id === updated.id ? updated : item)));
    cancelEditingEvent();
    setMessage("Timeline note updated.");
    setIsSaving(false);
  }

  async function deleteTimelineEvent(eventId: string, eventType: TimelineEventType, eventTitle: string) {
    if (!workspace?.id || !selectedContactId) {
      return;
    }

    const confirmationMessage =
      eventType === "note"
        ? `Delete this note permanently?\n\n\"${eventTitle || "Untitled note"}\"`
        : "Delete this timeline event permanently?";

    if (!window.confirm(confirmationMessage)) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    const { error: deleteError } = await supabase
      .from("crm_contact_events")
      .delete()
      .eq("id", eventId)
      .eq("workspace_id", workspace.id)
      .eq("contact_id", selectedContactId);

    if (deleteError) {
      setError(withSessionReloadFallback(deleteError.message, "Could not delete timeline event."));
      setIsSaving(false);
      return;
    }

    setEvents((previous) => previous.filter((item) => item.id !== eventId));

    if (editingEventId === eventId) {
      cancelEditingEvent();
    }

    setMessage("Timeline event deleted.");
    setIsSaving(false);
  }

  if (workspaceError) {
    return <p className="text-sm text-red-600">{workspaceError}</p>;
  }

  if (isWorkspaceLoading || isLoading || isEmailPolicyLoading) {
    return <p className="text-sm text-[var(--muted)]">Loading CRM board...</p>;
  }

  return (
    <section className="crm-surface flex min-h-full flex-col gap-6">
      <div className="overflow-hidden rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] shadow-sm">
        <div className="bg-gradient-to-r from-slate-900 via-blue-900 to-slate-900 px-6 py-4 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-blue-100">CRM Cockpit</p>
          <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_240px] md:items-end">
            <p className="text-sm text-blue-100/90">
              Workspace-scoped CRM with Kanban stages, summaries, and live interaction timelines.
            </p>
            <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-[0.1em] text-blue-100">
              Workspace scope
              {canSwitchWorkspaceScope ? (
                <select
                  value={workspace?.id ?? ""}
                  onChange={(event) => void handleWorkspaceScopeChange(event.target.value)}
                  disabled={isSwitchingWorkspace || isAccessibleWorkspacesLoading}
                  className="rounded-xl border border-white/30 bg-white/10 px-3 py-2 text-sm font-medium normal-case tracking-normal text-white outline-none transition hover:bg-white/15"
                >
                  {(accessibleWorkspaces.length > 0 ? accessibleWorkspaces : workspace ? [{ workspace_id: workspace.id, workspace_name: workspace.name, company_id: workspace.company_id, company_name: workspace.company_name, user_role: "agent", is_current: true }] : []).map((item) => (
                    <option key={item.workspace_id} value={item.workspace_id} className="text-slate-900">
                      {item.workspace_name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="rounded-xl border border-white/30 bg-white/10 px-3 py-2 text-sm font-medium normal-case tracking-normal text-white">
                  {workspace?.name ?? "Current workspace"}
                </div>
              )}
            </label>
          </div>
          {accessibleWorkspacesError ? <p className="mt-2 text-xs text-amber-200">{accessibleWorkspacesError}</p> : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] bg-white/70 px-6 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={contactSearchQuery}
              onChange={(event) => setContactSearchQuery(event.target.value)}
              placeholder="Search contacts (name, email, phone, source)"
              className="w-[min(100%,420px)] rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
              aria-label="Search contacts"
            />
            <button
              type="button"
              onClick={() => setIsCreateFormOpen((previous) => !previous)}
              className="inline-flex items-center rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
              aria-expanded={isCreateFormOpen}
            >
              {isCreateFormOpen ? "Hide new contact form" : "Add new contact"}
            </button>
            <Link
              href="/contacts/archive"
              className="inline-flex items-center rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
            >
              View archive
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
              <input
                type="checkbox"
                checked={onlyHighPriorityContacts}
                onChange={(event) => setOnlyHighPriorityContacts(event.target.checked)}
                className="h-4 w-4"
              />
              High-priority only
            </label>
            {isEmailFeatureEnabled ? (
              <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                <input
                  type="checkbox"
                  checked={onlyEmailSummaries}
                  onChange={(event) => setOnlyEmailSummaries(event.target.checked)}
                  className="h-4 w-4"
                />
                Email summaries only
              </label>
            ) : null}
          </div>
        </div>

        <div
          className={`overflow-hidden transition-all duration-300 ${isCreateFormOpen ? "max-h-[920px] border-t border-[var(--border)] opacity-100" : "max-h-0 opacity-0"}`}
        >
          <form onSubmit={handleCreateContact} className="grid items-start gap-3 px-6 py-5 md:grid-cols-2 xl:grid-cols-4">
            <input
              value={contactForm.first_name}
              onChange={(event) => setContactForm((previous) => ({ ...previous, first_name: event.target.value }))}
              required
              placeholder="First name"
              className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            />
            <input
              value={contactForm.last_name}
              onChange={(event) => setContactForm((previous) => ({ ...previous, last_name: event.target.value }))}
              required
              placeholder="Last name"
              className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            />
            <input
              value={contactForm.email}
              onChange={(event) => setContactForm((previous) => ({ ...previous, email: event.target.value }))}
              placeholder="Email"
              type="email"
              className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            />
            <input
              value={contactForm.phone}
              onChange={(event) => setContactForm((previous) => ({ ...previous, phone: event.target.value }))}
              placeholder="Phone"
              className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
            />
            <label className="min-w-0 md:col-span-2 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
              Address
              <input
                value={contactForm.address}
                onChange={(event) => setContactForm((previous) => ({ ...previous, address: event.target.value }))}
                placeholder="Street, city..."
                className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label className="min-w-0 md:col-span-2 xl:col-span-2 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
              Budget and currency
              <div className="grid grid-cols-[minmax(0,1fr)_104px] gap-2">
                <input
                  value={contactForm.budget}
                  onChange={(event) => setContactForm((previous) => ({ ...previous, budget: event.target.value }))}
                  placeholder={
                    requiresBudget(contactForm.client_type)
                      ? `Budget (${contactForm.currency})`
                      : "Not needed for seller/tenant"
                  }
                  inputMode="decimal"
                  disabled={!requiresBudget(contactForm.client_type)}
                  className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
                />
                <select
                  value={contactForm.currency}
                  onChange={(event) => setContactForm((previous) => ({ ...previous, currency: event.target.value }))}
                  className="w-full rounded-2xl border border-[var(--border)] bg-white px-3 py-3 text-sm outline-none focus:border-[var(--accent)]"
                  aria-label="Budget currency"
                >
                  {CURRENCY_OPTIONS.map((currency) => (
                    <option key={currency} value={currency}>
                      {currency}
                    </option>
                  ))}
                </select>
              </div>
            </label>
            <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
              Client type
              <select
                value={contactForm.client_type}
                onChange={(event) => {
                  const nextType = event.target.value as ClientType;
                  setContactForm((previous) => ({
                    ...previous,
                    client_type: nextType,
                    budget: requiresBudget(nextType) ? previous.budget : "",
                  }));
                }}
                className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              >
                <option value="buyer">Buyer</option>
                <option value="seller">Seller</option>
                <option value="tenant">Tenant</option>
                <option value="landlord">Landlord</option>
                <option value="investor">Investor</option>
                <option value="vendor">Vendor</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
              Priority
              <select
                value={contactForm.priority}
                onChange={(event) =>
                  setContactForm((previous) => ({ ...previous, priority: event.target.value as ContactPriority }))
                }
                className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
              Preferred channel
              <select
                value={contactForm.preferred_channel}
                onChange={(event) =>
                  setContactForm((previous) => ({ ...previous, preferred_channel: event.target.value as ContactChannel }))
                }
                className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              >
                <option value="phone">Phone</option>
                <option value="email">Email</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="sms">SMS</option>
                <option value="other">Other</option>
              </select>
            </label>
            <div className="md:col-span-2 xl:col-span-4 rounded-xl border border-[var(--border)] bg-white px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Assigned teammates</p>
                <Link
                  href={inviteTeammateHref}
                  className="rounded-full border border-[var(--border)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)] transition hover:bg-slate-50"
                >
                  Invite teammate
                </Link>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {!workspaceMembers.some((member) => member.profile_id !== currentUserId) ? (
                  <p className="text-[11px] text-[var(--muted)]">Only you in this workspace.</p>
                ) : null}
                {workspaceMembers.map((member) => {
                  const label = `${member.first_name ?? ""} ${member.last_name ?? ""}`.trim() || member.profile_id;
                  const isSelected = contactForm.assignee_profile_ids.includes(member.profile_id);
                  const isCurrent = currentUserId === member.profile_id;

                  return (
                    <button
                      key={member.profile_id}
                      type="button"
                      onClick={() => toggleCreateAssignee(member.profile_id)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-none transition ${
                        isSelected
                          ? "border-blue-400 bg-blue-50 text-blue-700"
                          : "border-[var(--border)] bg-white text-[var(--muted)] hover:bg-slate-50"
                      }`}
                    >
                      {isCurrent ? `${label} (You)` : label}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
              Lead source
              <input
                value={contactForm.source}
                onChange={(event) => setContactForm((previous) => ({ ...previous, source: event.target.value }))}
                placeholder="Portal, referral..."
                className="w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
              Next follow-up date
              <input
                value={contactForm.next_follow_up_at}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setContactForm((previous) => ({ ...previous, next_follow_up_at: nextValue }));
                  setContactFollowUpDateError(getDisplayDateError(nextValue));
                }}
                type="text"
                inputMode="numeric"
                placeholder="dd/mm/yyyy"
                className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
              />
              {contactFollowUpDateError ? <span className="text-[11px] text-red-600">{contactFollowUpDateError}</span> : null}
            </label>
            <textarea
              value={contactForm.notes}
              onChange={(event) => setContactForm((previous) => ({ ...previous, notes: event.target.value }))}
              placeholder="Context and intent"
              className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)] md:col-span-2 xl:col-span-3"
              rows={2}
            />
            <button
              type="submit"
              disabled={isSaving}
              className="rounded-2xl border border-blue-500 bg-blue-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-blue-600 disabled:opacity-60"
            >
              Add contact
            </button>
          </form>
        </div>
      </div>

      {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
      {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}

      <div className="grid grid-cols-1 gap-4">
        <div className="overflow-x-auto rounded-[24px] border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="mx-auto grid min-w-[920px] grid-cols-5 gap-3">
            {STAGE_COLUMNS.map((column) => {
              const columnContacts = filteredContacts.filter((contact) => contact.stage === column.key);

              return (
                <div
                  key={column.key}
                  className="flex h-[520px] flex-col rounded-2xl border border-[var(--border)] bg-[var(--surface-strong)] p-3"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();

                    if (!draggedContactId) {
                      return;
                    }

                    void moveContactToStage(draggedContactId, column.key);
                    setDraggedContactId(null);
                  }}
                >
                  <div className={`rounded-xl bg-gradient-to-r ${column.accentClass} px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-900`}>
                    {column.label} ({columnContacts.length})
                  </div>

                  <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                    {columnContacts.map((contact) => (
                      <button
                        key={contact.id}
                        type="button"
                        draggable
                        onDragStart={() => setDraggedContactId(contact.id)}
                        onClick={() => setSelectedContactId(contact.id)}
                        className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                          selectedContactId === contact.id
                            ? "border-blue-500 bg-blue-50"
                            : "border-[var(--border)] bg-white hover:border-blue-300"
                        }`}
                      >
                        <p className="text-sm font-semibold text-[var(--foreground)]">{getContactName(contact)}</p>
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">{contact.client_type}</p>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${getPriorityBadgeClasses(contact.priority)}`}
                          >
                            {contact.priority}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-[var(--muted)]">{formatMoney(contact.budget, contact.currency)}</p>
                        <p className="mt-1 text-xs text-[var(--muted)]">Assigned: {getAssigneePreview(contact.id)}</p>
                        <p className="mt-1 text-xs text-[var(--muted)]">Next follow-up: {formatDateOnly(contact.next_follow_up_at)}</p>
                      </button>
                    ))}
                    {columnContacts.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--muted)]">
                        Drop contacts here
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] p-4">
          {!selectedContact ? (
            <p className="text-sm text-[var(--muted)]">Pick a contact card to open profile details and timeline.</p>
          ) : (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start">
              <div className="space-y-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Contact profile</p>
                  <h3 className="mt-2 text-xl font-semibold text-[var(--foreground)]">{getContactName(selectedContact)}</h3>
                  <p className="mt-1 text-xs text-[var(--muted)]">Last updated {formatDateTime(selectedContact.updated_at)}</p>
                </div>

                <form onSubmit={handleUpdateSelectedContact} className="grid gap-3">
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={selectedContact.first_name}
                      onChange={(event) => updateSelectedContact("first_name", event.target.value)}
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      placeholder="First name"
                    />
                    <input
                      value={selectedContact.last_name}
                      onChange={(event) => updateSelectedContact("last_name", event.target.value)}
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      placeholder="Last name"
                    />
                  </div>
                  <input
                    value={selectedContact.email ?? ""}
                    onChange={(event) => updateSelectedContact("email", event.target.value || null)}
                    type="email"
                    placeholder="Email"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={selectedContact.phone ?? ""}
                    onChange={(event) => updateSelectedContact("phone", event.target.value || null)}
                    placeholder="Phone"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={selectedContact.address ?? ""}
                    onChange={(event) => updateSelectedContact("address", event.target.value || null)}
                    placeholder="Address"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
                    Budget and currency
                    <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
                      <input
                        value={selectedContact.budget ?? ""}
                        onChange={(event) => updateSelectedContact("budget", event.target.value ? Number(event.target.value) : null)}
                        placeholder={
                          requiresBudget(selectedContact.client_type)
                            ? `Budget (${selectedContact.currency})`
                            : "Not needed for seller/tenant"
                        }
                        inputMode="decimal"
                        disabled={!requiresBudget(selectedContact.client_type)}
                        className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      />
                      <select
                        value={selectedContact.currency}
                        onChange={(event) => updateSelectedContact("currency", event.target.value)}
                        className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        aria-label="Budget currency"
                      >
                        {CURRENCY_OPTIONS.map((currency) => (
                          <option key={currency} value={currency}>
                            {currency}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>

                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
                      Client type
                      <select
                        value={selectedContact.client_type}
                        onChange={(event) => {
                          const nextType = event.target.value as ClientType;
                          updateSelectedContact("client_type", nextType);

                          if (!requiresBudget(nextType)) {
                            updateSelectedContact("budget", null);
                          }
                        }}
                        className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      >
                        <option value="buyer">Buyer</option>
                        <option value="seller">Seller</option>
                        <option value="tenant">Tenant</option>
                        <option value="landlord">Landlord</option>
                        <option value="investor">Investor</option>
                        <option value="vendor">Vendor</option>
                        <option value="other">Other</option>
                      </select>
                    </label>

                    <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
                      Priority
                      <select
                        value={selectedContact.priority}
                        onChange={(event) => updateSelectedContact("priority", event.target.value as ContactPriority)}
                        className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      >
                        <option value="low">Low</option>
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                      </select>
                    </label>

                    <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
                      Preferred channel
                      <select
                        value={selectedContact.preferred_channel}
                        onChange={(event) =>
                          updateSelectedContact("preferred_channel", event.target.value as ContactChannel)
                        }
                        className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      >
                        <option value="phone">Phone</option>
                        <option value="email">Email</option>
                        <option value="whatsapp">WhatsApp</option>
                        <option value="sms">SMS</option>
                        <option value="other">Other</option>
                      </select>
                    </label>
                  </div>
                  <div className="rounded-xl border border-[var(--border)] bg-white px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Assigned teammates</p>
                      <Link
                        href={inviteTeammateHref}
                        className="rounded-full border border-[var(--border)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)] transition hover:bg-slate-50"
                      >
                        Invite teammate
                      </Link>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {!workspaceMembers.some((member) => member.profile_id !== currentUserId) ? (
                        <p className="text-[11px] text-[var(--muted)]">Only you in this workspace.</p>
                      ) : null}
                      {workspaceMembers.map((member) => {
                        const label = `${member.first_name ?? ""} ${member.last_name ?? ""}`.trim() || member.profile_id;
                        const selectedAssignees = assigneesByContact[selectedContact.id] ?? [];
                        const isSelected = selectedAssignees.includes(member.profile_id);
                        const isCurrent = currentUserId === member.profile_id;

                        return (
                          <button
                            key={member.profile_id}
                            type="button"
                            onClick={() => toggleSelectedContactAssignee(member.profile_id)}
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-none transition ${
                              isSelected
                                ? "border-blue-400 bg-blue-50 text-blue-700"
                                : "border-[var(--border)] bg-white text-[var(--muted)] hover:bg-slate-50"
                            }`}
                          >
                            {isCurrent ? `${label} (You)` : label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
                      Lead source
                      <input
                        value={selectedContact.source ?? ""}
                        onChange={(event) => updateSelectedContact("source", event.target.value || null)}
                        placeholder="Portal, referral..."
                        className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      />
                    </label>
                    <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
                      Next follow-up date
                      <input
                        value={selectedFollowUpInput}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setSelectedFollowUpInput(nextValue);
                          setSelectedFollowUpDateError(getDisplayDateError(nextValue));
                        }}
                        type="text"
                        inputMode="numeric"
                        placeholder="dd/mm/yyyy"
                        className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                      />
                      {selectedFollowUpDateError ? <span className="text-[11px] text-red-600">{selectedFollowUpDateError}</span> : null}
                    </label>
                  </div>
                  <textarea
                    value={selectedContact.notes ?? ""}
                    onChange={(event) => updateSelectedContact("notes", event.target.value || null)}
                    rows={3}
                    placeholder="Notes"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:opacity-60"
                  >
                    Save profile
                  </button>
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={() => void archiveSelectedContact()}
                    className="rounded-xl border border-slate-300 bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-200 disabled:opacity-60"
                  >
                    Archive contact
                  </button>
                  <button
                    type="button"
                    disabled={isSaving || !canDeleteContacts}
                    onClick={startDeleteSelectedContact}
                    className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                    title={
                      canDeleteContacts
                        ? "Permanently delete this contact"
                        : "Only super admins, owners, and team leads can delete contacts"
                    }
                  >
                    Delete contact permanently
                  </button>
                  {isDeleteConfirmOpen ? (
                    <div className="rounded-xl border border-red-300 bg-red-50/70 p-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-red-700">Final deletion check</p>
                      <p className="mt-1 text-xs text-red-700">
                        This permanently removes this contact, timeline, and assignments.
                      </p>
                      <p className="mt-2 text-xs text-red-700">
                        Type exactly: <span className="font-semibold">{deleteConfirmationPhrase}</span>
                      </p>
                      <input
                        value={deletePhraseInput}
                        onChange={(event) => setDeletePhraseInput(event.target.value)}
                        placeholder={deleteConfirmationPhrase}
                        className="mt-2 w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm outline-none focus:border-red-400"
                      />
                      <label className="mt-2 flex items-center gap-2 text-xs text-red-700">
                        <input
                          type="checkbox"
                          checked={isDeleteFinalCheckEnabled}
                          onChange={(event) => setIsDeleteFinalCheckEnabled(event.target.checked)}
                          className="h-4 w-4 rounded border border-red-300"
                        />
                        I understand this action is permanent and cannot be undone.
                      </label>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={
                            isSaving ||
                            deletePhraseInput.trim() !== deleteConfirmationPhrase ||
                            !isDeleteFinalCheckEnabled
                          }
                          onClick={() => void deleteSelectedContact()}
                          className="rounded-lg border border-red-500 bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Permanently delete now
                        </button>
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={cancelDeleteSelectedContact}
                          className="rounded-lg border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </form>
              </div>

              <div className="space-y-4">
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Log interaction</p>
                  <form onSubmit={handleCreateInteraction} className="grid gap-2">
                    <select
                      value={timelineForm.event_type}
                      onChange={(event) =>
                        setTimelineForm((previous) => ({
                          ...previous,
                          event_type: event.target.value as TimelineFormState["event_type"],
                        }))
                      }
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                    >
                      <option value="note">Note</option>
                      <option value="call">Call</option>
                      <option value="email">Email</option>
                      <option value="meeting">Meeting</option>
                      <option value="visit">Visit</option>
                    </select>
                    <input
                      value={timelineForm.title}
                      onChange={(event) => setTimelineForm((previous) => ({ ...previous, title: event.target.value }))}
                      placeholder="Title"
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                    />
                    <textarea
                      value={timelineForm.body}
                      onChange={(event) => setTimelineForm((previous) => ({ ...previous, body: event.target.value }))}
                      rows={2}
                      placeholder="What happened?"
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                    />
                    <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
                      Due or reminder date
                      <input
                        value={timelineForm.due_date}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setTimelineForm((previous) => ({
                            ...previous,
                            due_date: nextValue,
                          }));
                          setTimelineDueDateError(getDisplayDateError(nextValue));
                        }}
                        type="text"
                        inputMode="numeric"
                        placeholder="dd/mm/yyyy"
                        className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                      />
                      {timelineDueDateError ? <span className="text-[11px] text-red-600">{timelineDueDateError}</span> : null}
                    </label>
                    <button
                      type="submit"
                      disabled={isSaving}
                      className="rounded-xl border border-blue-500 bg-blue-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-600 disabled:opacity-60"
                    >
                      Add to timeline
                    </button>
                  </form>
                </div>

                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Timeline</p>
                  <p className="text-xs text-[var(--muted)]">
                    Next follow-up: {formatDateOnly(selectedContact.next_follow_up_at)}
                  </p>
                  {isEmailFeatureEnabled ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-blue-700">
                        AI kept emails {keptSummaryCount}
                      </span>
                    </div>
                  ) : null}
                  <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
                    {filteredEvents.map((timelineEvent) => (
                      <article key={timelineEvent.id} className="rounded-xl border border-[var(--border)] bg-white px-3 py-3">
                        {editingEventId === timelineEvent.id ? (
                          <div className="space-y-2">
                            <input
                              value={editingEventTitle}
                              onChange={(event) => setEditingEventTitle(event.target.value)}
                              className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                              placeholder="Title"
                            />
                            <textarea
                              value={editingEventBody}
                              onChange={(event) => setEditingEventBody(event.target.value)}
                              rows={3}
                              className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                              placeholder="Note"
                            />
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={isSaving}
                                onClick={() => void saveEditedEvent(timelineEvent.id)}
                                className="rounded-lg border border-blue-500 bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-600 disabled:opacity-60"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                disabled={isSaving}
                                onClick={cancelEditingEvent}
                                className="rounded-lg border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:opacity-60"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-semibold text-[var(--foreground)]">{timelineEvent.title}</p>
                                {timelineEvent.body ? (
                                  <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
                                    {timelineEvent.event_type === "status_change"
                                      ? formatStatusChangeBody(timelineEvent)
                                      : timelineEvent.body}
                                  </p>
                                ) : null}
                              </div>
                              <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                                {timelineEvent.event_type}
                              </span>
                            </div>
                            {timelineEvent.event_type === "email_summary" ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-blue-700">
                                  AI kept
                                </span>
                                {typeof timelineEvent.metadata?.triage_confidence === "number" ? (
                                  <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-600">
                                    confidence {(timelineEvent.metadata.triage_confidence as number * 100).toFixed(0)}%
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            {getTimelineEventDueDate(timelineEvent) ? (
                              <p className="mt-2 text-xs font-medium text-[var(--muted)]">
                                Due: {formatDateOnly(getTimelineEventDueDate(timelineEvent))}
                              </p>
                            ) : null}
                            <div className="mt-2 flex items-end justify-between gap-2">
                              <div>
                                <p className="text-xs text-[var(--muted)]">{formatDateTime(timelineEvent.occurred_at)}</p>
                                <p className="text-[11px] text-[var(--muted)]">
                                  By {getEventActorLabel(timelineEvent, workspaceMemberNameById)}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                {canEditTimelineEvent(timelineEvent.event_type) ? (
                                  <button
                                    type="button"
                                    onClick={() => startEditingEvent(timelineEvent)}
                                    className="rounded-lg border border-[var(--border)] bg-white px-2 py-1 text-[11px] font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                                  >
                                    Edit
                                  </button>
                                ) : null}
                                {canDeleteTimelineEvent(timelineEvent.event_type) ? (
                                  <button
                                    type="button"
                                    disabled={isSaving}
                                    onClick={() =>
                                      void deleteTimelineEvent(
                                        timelineEvent.id,
                                        timelineEvent.event_type,
                                        timelineEvent.title,
                                      )
                                    }
                                    className="rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-60"
                                  >
                                    Delete
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          </>
                        )}
                      </article>
                    ))}
                    {filteredEvents.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--muted)]">
                        No interactions yet.
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
