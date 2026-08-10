"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";
import { useAccessibleWorkspaces } from "@/lib/workspace/use-accessible-workspaces";
import { useWorkspaceMembers } from "@/lib/workspace/use-workspace-members";

type ClientType = "buyer" | "seller" | "tenant" | "landlord" | "investor" | "other";
type ContactRole = ClientType;
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
type TimelineEventType = ContactEventType | "email_summary" | "sms_summary" | "whatsapp_summary" | "call_summary";

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
  contact_roles: ContactRole[] | null;
  stage: ContactStage;
  priority: ContactPriority;
  source: string | null;
  preferred_channel: ContactChannel;
  notes: string | null;
  assigned_to: string | null;
  next_follow_up_at: string | null;
  last_contact_at: string | null;
  buyer_target_locations: string[] | null;
  buyer_property_types: string[] | null;
  buyer_budget_min: number | null;
  buyer_budget_max: number | null;
  buyer_bedrooms_min: number | null;
  buyer_surface_min_m2: number | null;
  buyer_move_in_window: string | null;
  buyer_country_details: Record<string, unknown> | null;
  tenant_target_locations: string[] | null;
  tenant_property_types: string[] | null;
  tenant_budget_min: number | null;
  tenant_budget_max: number | null;
  tenant_bedrooms_min: number | null;
  tenant_surface_min_m2: number | null;
  tenant_move_in_window: string | null;
  tenant_country_details: Record<string, unknown> | null;
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

type TwilioSummaryRow = {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  created_by: string | null;
  summary_text: string;
  channel: "sms" | "whatsapp" | "voice";
  direction: "inbound" | "outbound";
  triage_reason_code: string | null;
  triage_confidence: number | null;
  model_provider: string | null;
  model_name: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
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
  contact_roles: ContactRole[];
  priority: ContactPriority;
  source: string;
  preferred_channel: ContactChannel;
  notes: string;
  next_follow_up_at: string;
  buyer_target_locations: string;
  buyer_property_types: ContactPropertyType[];
  buyer_budget_min: string;
  buyer_budget_max: string;
  buyer_bedrooms_min: string;
  buyer_surface_min_m2: string;
  buyer_move_in_window: string;
  buyer_country_notes: string;
  buyer_wants_garden: boolean;
  buyer_wants_balcony: boolean;
  buyer_floor_wanted: string;
  buyer_floor_avoid: string;
  tenant_target_locations: string;
  tenant_property_types: ContactPropertyType[];
  tenant_budget_min: string;
  tenant_budget_max: string;
  tenant_bedrooms_min: string;
  tenant_surface_min_m2: string;
  tenant_move_in_window: string;
  tenant_country_notes: string;
  tenant_wants_garden: boolean;
  tenant_wants_balcony: boolean;
  tenant_floor_wanted: string;
  tenant_floor_avoid: string;
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

type ContactPropertyType = "apartment" | "house" | "land" | "commercial" | "parking" | "other";

type TimelineEventTypeFilter = "all" | TimelineEventType;

type ContactDetailsDraftSnapshot = {
  contact: CrmContact;
  followUpInput: string;
  assigneeProfileIds: string[];
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
  contact_roles: ["buyer"],
  priority: "normal",
  source: "",
  preferred_channel: "phone",
  notes: "",
  next_follow_up_at: "",
  buyer_target_locations: "",
  buyer_property_types: [],
  buyer_budget_min: "",
  buyer_budget_max: "",
  buyer_bedrooms_min: "",
  buyer_surface_min_m2: "",
  buyer_move_in_window: "",
  buyer_country_notes: "",
  buyer_wants_garden: false,
  buyer_wants_balcony: false,
  buyer_floor_wanted: "",
  buyer_floor_avoid: "",
  tenant_target_locations: "",
  tenant_property_types: [],
  tenant_budget_min: "",
  tenant_budget_max: "",
  tenant_bedrooms_min: "",
  tenant_surface_min_m2: "",
  tenant_move_in_window: "",
  tenant_country_notes: "",
  tenant_wants_garden: false,
  tenant_wants_balcony: false,
  tenant_floor_wanted: "",
  tenant_floor_avoid: "",
  assignee_profile_ids: [],
};

const EMPTY_TIMELINE_FORM: TimelineFormState = {
  event_type: "note",
  title: "",
  body: "",
  due_date: "",
};

const CURRENCY_OPTIONS = ["EUR", "USD", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "BRL"] as const;

const CONTACT_ROLE_OPTIONS: ContactRole[] = ["buyer", "seller", "tenant", "landlord", "investor", "other"];
const CONTACT_PROPERTY_TYPE_OPTIONS: ContactPropertyType[] = ["apartment", "house", "land", "commercial", "parking", "other"];
const FOLLOW_UP_PRESETS: Array<{ label: string; days: number }> = [
  { label: "+3d", days: 3 },
  { label: "+7d", days: 7 },
  { label: "+14d", days: 14 },
  { label: "+1m", days: 30 },
  { label: "+3m", days: 90 },
];
const TIMELINE_EVENT_FILTER_OPTIONS: Array<{ label: string; value: TimelineEventTypeFilter }> = [
  { label: "All", value: "all" },
  { label: "Note", value: "note" },
  { label: "Call", value: "call" },
  { label: "Email", value: "email" },
  { label: "Meeting", value: "meeting" },
  { label: "Visit", value: "visit" },
  { label: "Status", value: "status_change" },
  { label: "Created", value: "created" },
  { label: "Emails", value: "email_summary" },
  { label: "SMS", value: "sms_summary" },
  { label: "WhatsApp", value: "whatsapp_summary" },
  { label: "Calls", value: "call_summary" },
];

function requiresBudget(clientType: ClientType) {
  return clientType === "buyer" || clientType === "tenant";
}

function normalizeContactRoles(roles: ContactRole[] | null | undefined, fallbackRole: ContactRole): ContactRole[] {
  const source = Array.isArray(roles) && roles.length > 0 ? roles : [fallbackRole];
  return Array.from(new Set(source.filter((role): role is ContactRole => CONTACT_ROLE_OPTIONS.includes(role))));
}

function getPrimaryRoleFromRoles(roles: ContactRole[] | null | undefined, fallbackRole: ContactRole) {
  const normalized = normalizeContactRoles(roles, fallbackRole);
  return normalized[0] ?? "buyer";
}

function hasBuyerRole(roles: ContactRole[]) {
  return roles.includes("buyer");
}

function hasTenantRole(roles: ContactRole[]) {
  return roles.includes("tenant");
}

function formatRoleLabel(role: ContactRole) {
  return role.replace(/_/g, " ");
}

function formatPropertyTypeLabel(type: ContactPropertyType) {
  return type.replace(/_/g, " ");
}

function getCountryDetailString(
  details: Record<string, unknown> | null | undefined,
  key: "notes" | "preferred_floor" | "avoid_floor",
) {
  const value = details?.[key];
  return typeof value === "string" ? value : "";
}

function getCountryDetailBoolean(
  details: Record<string, unknown> | null | undefined,
  key: "wants_garden" | "wants_balcony",
) {
  return details?.[key] === true;
}

function buildCountryDetails(
  notes: string,
  wantsGarden: boolean,
  wantsBalcony: boolean,
  preferredFloor: string,
  avoidFloor: string,
) {
  const next: Record<string, unknown> = {};

  if (notes.trim()) {
    next.notes = notes.trim();
  }

  if (wantsGarden) {
    next.wants_garden = true;
  }

  if (wantsBalcony) {
    next.wants_balcony = true;
  }

  if (preferredFloor.trim()) {
    next.preferred_floor = preferredFloor.trim();
  }

  if (avoidFloor.trim()) {
    next.avoid_floor = avoidFloor.trim();
  }

  return Object.keys(next).length > 0 ? next : null;
}

function patchCountryDetails(
  details: Record<string, unknown> | null | undefined,
  patch: Partial<Record<"notes" | "preferred_floor" | "avoid_floor" | "wants_garden" | "wants_balcony", string | boolean>>,
) {
  const next: Record<string, unknown> = {
    ...(details ?? {}),
  };

  if ("notes" in patch) {
    const value = typeof patch.notes === "string" ? patch.notes.trim() : "";
    if (value) {
      next.notes = value;
    } else {
      delete next.notes;
    }
  }

  if ("preferred_floor" in patch) {
    const value = typeof patch.preferred_floor === "string" ? patch.preferred_floor.trim() : "";
    if (value) {
      next.preferred_floor = value;
    } else {
      delete next.preferred_floor;
    }
  }

  if ("avoid_floor" in patch) {
    const value = typeof patch.avoid_floor === "string" ? patch.avoid_floor.trim() : "";
    if (value) {
      next.avoid_floor = value;
    } else {
      delete next.avoid_floor;
    }
  }

  if ("wants_garden" in patch) {
    if (patch.wants_garden === true) {
      next.wants_garden = true;
    } else {
      delete next.wants_garden;
    }
  }

  if ("wants_balcony" in patch) {
    if (patch.wants_balcony === true) {
      next.wants_balcony = true;
    } else {
      delete next.wants_balcony;
    }
  }

  return Object.keys(next).length > 0 ? next : null;
}

function parseCommaSeparatedList(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  );
}

function listToInputValue(values: string[] | null) {
  if (!values || values.length === 0) {
    return "";
  }

  return values.join(", ");
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDateAsInputValue(date: Date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function toNumberOrNull(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeStringArrayForCompare(values: string[]) {
  return [...values].sort();
}

function dedupeContactsById(contacts: CrmContact[]) {
  const deduped = new Map<string, CrmContact>();

  for (const contact of contacts) {
    if (!contact?.id) {
      continue;
    }

    const existing = deduped.get(contact.id);

    if (!existing) {
      deduped.set(contact.id, contact);
      continue;
    }

    const existingTs = Date.parse(existing.updated_at ?? "");
    const incomingTs = Date.parse(contact.updated_at ?? "");

    if (Number.isFinite(incomingTs) && (!Number.isFinite(existingTs) || incomingTs >= existingTs)) {
      deduped.set(contact.id, contact);
    }
  }

  return Array.from(deduped.values()).sort(
    (left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime(),
  );
}

function createContactDetailsDraftSnapshot(
  contact: CrmContact,
  followUpInput: string,
  assigneeProfileIds: string[],
): ContactDetailsDraftSnapshot {
  return {
    contact: {
      ...contact,
      contact_roles: contact.contact_roles ? [...contact.contact_roles] : null,
      buyer_target_locations: contact.buyer_target_locations ? [...contact.buyer_target_locations] : null,
      buyer_property_types: contact.buyer_property_types ? [...contact.buyer_property_types] : null,
      tenant_target_locations: contact.tenant_target_locations ? [...contact.tenant_target_locations] : null,
      tenant_property_types: contact.tenant_property_types ? [...contact.tenant_property_types] : null,
      buyer_country_details: contact.buyer_country_details ? { ...contact.buyer_country_details } : null,
      tenant_country_details: contact.tenant_country_details ? { ...contact.tenant_country_details } : null,
    },
    followUpInput,
    assigneeProfileIds: normalizeStringArrayForCompare(assigneeProfileIds),
  };
}

function areContactDetailsDraftSnapshotsEqual(
  left: ContactDetailsDraftSnapshot,
  right: ContactDetailsDraftSnapshot,
) {
  return (
    JSON.stringify(left.contact) === JSON.stringify(right.contact) &&
    left.followUpInput === right.followUpInput &&
    JSON.stringify(left.assigneeProfileIds) === JSON.stringify(right.assigneeProfileIds)
  );
}

export default function CrmBoard() {
  const router = useRouter();
  const searchParams = useSearchParams();
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
  const [areAssigneesLoaded, setAreAssigneesLoaded] = useState(false);
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
  const [isContactDetailsOpen, setIsContactDetailsOpen] = useState(false);
  const [contactDetailsDraftBaseline, setContactDetailsDraftBaseline] = useState<ContactDetailsDraftSnapshot | null>(null);
  const [isDiscardChangesDialogOpen, setIsDiscardChangesDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);
  const [outboundChannel, setOutboundChannel] = useState<"sms" | "whatsapp" | null>(null);
  const [outboundMessage, setOutboundMessage] = useState("");
  const [isSendingOutbound, setIsSendingOutbound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [contactSearchQuery, setContactSearchQuery] = useState("");
  const [onlyHighPriorityContacts, setOnlyHighPriorityContacts] = useState(false);
  const [timelineSearchQuery, setTimelineSearchQuery] = useState("");
  const [timelineEventTypeFilter, setTimelineEventTypeFilter] = useState<TimelineEventTypeFilter>("all");
  const [timelineFromDate, setTimelineFromDate] = useState("");
  const [timelineToDate, setTimelineToDate] = useState("");
  const [timelineOnlyWithDueDate, setTimelineOnlyWithDueDate] = useState(false);
  const [isEmailFeatureEnabled, setIsEmailFeatureEnabled] = useState(false);
  const [isTwilioFeatureEnabled, setIsTwilioFeatureEnabled] = useState(false);
  const [isEmailPolicyLoading, setIsEmailPolicyLoading] = useState(true);
  const contactDetailsPanelRef = useRef<HTMLElement | null>(null);
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
        normalizeContactRoles(contact.contact_roles, contact.client_type).join(" "),
        listToInputValue(contact.buyer_target_locations),
        listToInputValue(contact.tenant_target_locations),
      ]
        .join(" ")
        .toLowerCase();

      return searchableText.includes(normalizedQuery);
    });
  }, [contacts, onlyHighPriorityContacts, contactSearchQuery]);

  const filteredEvents = useMemo(
    () => {
      const TWILIO_EVENT_TYPES: TimelineEventType[] = ["sms_summary", "whatsapp_summary", "call_summary"];

      const visibleEvents = events.filter((event) => {
        if (event.event_type === "email_summary" && !isEmailFeatureEnabled) return false;
        if ((TWILIO_EVENT_TYPES as string[]).includes(event.event_type) && !isTwilioFeatureEnabled) return false;
        return true;
      });

      const normalizedQuery = timelineSearchQuery.trim().toLowerCase();
      const fromIso = parseDisplayDateToIso(timelineFromDate);
      const toIso = parseDisplayDateToIso(timelineToDate);

      return visibleEvents.filter((event) => {
        if (timelineEventTypeFilter !== "all" && event.event_type !== timelineEventTypeFilter) {
          return false;
        }

        if (timelineOnlyWithDueDate && !getTimelineEventDueDate(event)) {
          return false;
        }

        if (fromIso || toIso) {
          const eventDateIso = new Date(event.occurred_at).toISOString().slice(0, 10);

          if (fromIso && eventDateIso < fromIso) {
            return false;
          }

          if (toIso && eventDateIso > toIso) {
            return false;
          }
        }

        if (!normalizedQuery) {
          return true;
        }

        const haystack = [
          event.title,
          event.body ?? "",
          event.event_type,
          typeof event.metadata?.triage_reason_code === "string" ? event.metadata.triage_reason_code : "",
          getTimelineEventDueDate(event) ?? "",
        ]
          .join(" ")
          .toLowerCase();

        return haystack.includes(normalizedQuery);
      });
    },
    [
      events,
      isEmailFeatureEnabled,
      isTwilioFeatureEnabled,
      timelineSearchQuery,
      timelineEventTypeFilter,
      timelineFromDate,
      timelineToDate,
      timelineOnlyWithDueDate,
    ],
  );

  const keptSummaryCount = useMemo(
    () => (isEmailFeatureEnabled ? events.filter((event) => event.event_type === "email_summary").length : 0),
    [events, isEmailFeatureEnabled],
  );

  const keptSmsSummaryCount = useMemo(
    () => (isTwilioFeatureEnabled ? events.filter((event) => event.event_type === "sms_summary").length : 0),
    [events, isTwilioFeatureEnabled],
  );

  const keptWhatsAppSummaryCount = useMemo(
    () => (isTwilioFeatureEnabled ? events.filter((event) => event.event_type === "whatsapp_summary").length : 0),
    [events, isTwilioFeatureEnabled],
  );

  const keptCallSummaryCount = useMemo(
    () => (isTwilioFeatureEnabled ? events.filter((event) => event.event_type === "call_summary").length : 0),
    [events, isTwilioFeatureEnabled],
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
    const queryContactId = searchParams.get("contactId")?.trim() ?? "";
    const shouldOpenDetails = searchParams.get("details") === "1";

    if (!queryContactId || contacts.length === 0) {
      return;
    }

    const matched = contacts.find((contact) => contact.id === queryContactId);

    if (!matched) {
      return;
    }

    if (selectedContactId !== queryContactId) {
      setSelectedContactId(queryContactId);
    }

    if (shouldOpenDetails && (!isContactDetailsOpen || selectedContactId !== queryContactId)) {
      openContactDetails(queryContactId);
      const nextParams = new URLSearchParams(searchParams.toString());
      nextParams.delete("details");
      const nextQuery = nextParams.toString();
      router.replace(nextQuery ? `/contacts?${nextQuery}` : "/contacts", { scroll: false });
    }
  }, [contacts, isContactDetailsOpen, router, searchParams, selectedContactId]);

  useEffect(() => {
    const shouldOpenCreateContact = searchParams.get("createContact") === "1";

    if (!shouldOpenCreateContact) {
      return;
    }

    const prefillEmail = searchParams.get("email")?.trim() ?? "";
    const prefillFirstName = searchParams.get("firstName")?.trim() || "Email";
    const prefillLastName = searchParams.get("lastName")?.trim() || "Contact";
    const prefillSource = searchParams.get("source")?.trim() || "inbox";

    setContactForm({
      ...EMPTY_CONTACT_FORM,
      first_name: prefillFirstName,
      last_name: prefillLastName,
      email: prefillEmail,
      source: prefillSource,
      preferred_channel: "email",
      currency: workspace?.currency ?? "EUR",
      assignee_profile_ids: currentUserId ? [currentUserId] : [],
    });
    setContactFollowUpDateError(null);
    setIsCreateFormOpen(true);
    setError(null);
    setMessage("Complete contact details, then click Create contact.");

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("createContact");
    nextParams.delete("email");
    nextParams.delete("firstName");
    nextParams.delete("lastName");
    nextParams.delete("source");
    const nextQuery = nextParams.toString();
    router.replace(nextQuery ? `/contacts?${nextQuery}` : "/contacts", { scroll: false });
  }, [currentUserId, router, searchParams, workspace?.currency]);

  useEffect(() => {
    async function loadEmailPolicy(companyId: string, workspaceId: string) {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        setIsEmailFeatureEnabled(false);
        setIsEmailPolicyLoading(false);
        return;
      }

      setIsEmailPolicyLoading(true);

      const [policyResult, twilioResult] = await Promise.all([
        supabase
          .from("email_ingestion_policies")
          .select("feature_enabled")
          .eq("company_id", companyId)
          .maybeSingle(),
        supabase.rpc("get_effective_workspace_twilio_enabled", { p_workspace_id: workspaceId }),
      ]);

      const policyRow = policyResult.data as { feature_enabled?: boolean } | null;
      setIsEmailFeatureEnabled(Boolean(policyRow?.feature_enabled));
      setIsTwilioFeatureEnabled(Boolean(twilioResult.data));
      setIsEmailPolicyLoading(false);
    }

    const companyId = workspace?.company_id ?? null;
    const workspaceId = workspace?.id ?? null;

    if (!companyId || !workspaceId) {
      setIsEmailFeatureEnabled(false);
      setIsEmailPolicyLoading(false);
      return;
    }

    void loadEmailPolicy(companyId, workspaceId);
  }, [workspace?.company_id, workspace?.id]);

  useEffect(() => {
    if (!workspace?.id || !selectedContactId) {
      return;
    }

    void loadTimeline(workspace.id, selectedContactId);
    // Re-run when Twilio feature toggles so Twilio summaries appear/disappear immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTwilioFeatureEnabled]);

  useEffect(() => {
    if (!workspace?.id || !selectedContactId) {
      setEvents([]);
      return;
    }

    void loadTimeline(workspace.id, selectedContactId);
  }, [workspace?.id, selectedContactId, isEmailFeatureEnabled]);

  useEffect(() => {
    if (!selectedContactId) {
      setIsContactDetailsOpen(false);
    }
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
    setContacts(dedupeContactsById(rows));

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
      setAreAssigneesLoaded(true);
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setAreAssigneesLoaded(true);
      return;
    }

    setAreAssigneesLoaded(false);

    const { data, error: assigneesError } = await supabase
      .from("crm_contact_assignees")
      .select("contact_id, profile_id")
      .eq("workspace_id", workspaceId)
      .in("contact_id", contactIds);

    if (assigneesError) {
      setError(withSessionReloadFallback(assigneesError.message, "Could not load contact assignees."));
      setAreAssigneesLoaded(true);
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
    setAreAssigneesLoaded(true);
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
        event_type: "email_summary" as TimelineEventType,
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

    let twilioSummaryEvents: CrmContactEvent[] = [];

    if (isTwilioFeatureEnabled) {
      const { data: twilioRows, error: twilioError } = await supabase
        .from("twilio_summaries")
        .select("id, workspace_id, contact_id, created_by, summary_text, channel, direction, triage_reason_code, triage_confidence, model_provider, model_name, metadata, occurred_at, created_at")
        .eq("workspace_id", workspaceId)
        .eq("contact_id", contactId)
        .order("occurred_at", { ascending: false })
        .limit(100);

      if (twilioError) {
        setError(withSessionReloadFallback(twilioError.message, "Could not load Twilio summaries."));
        return;
      }

      twilioSummaryEvents = ((twilioRows ?? []) as TwilioSummaryRow[]).map((summary) => {
        const eventType: TimelineEventType =
          summary.channel === "whatsapp" ? "whatsapp_summary"
          : summary.channel === "voice" ? "call_summary"
          : "sms_summary";

        const channelLabel =
          summary.channel === "whatsapp" ? "WhatsApp summary"
          : summary.channel === "voice" ? "Call summary"
          : "SMS summary";

        return {
          id: `twilio-summary-${summary.id}`,
          contact_id: summary.contact_id ?? contactId,
          workspace_id: summary.workspace_id,
          created_by: summary.created_by,
          event_type: eventType,
          title: channelLabel,
          body: summary.summary_text,
          metadata: {
            ...(summary.metadata ?? {}),
            triage_label: "save_summary",
            triage_reason_code: summary.triage_reason_code,
            triage_confidence: summary.triage_confidence,
            model_provider: summary.model_provider,
            model_name: summary.model_name,
            channel: summary.channel,
            direction: summary.direction,
            source: "twilio_summaries",
          },
          occurred_at: summary.occurred_at,
          created_at: summary.created_at,
        };
      });
    }

    const mergedEvents = [
      ...((data ?? []) as CrmContactEvent[]),
      ...summaryEvents,
      ...twilioSummaryEvents,
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

    const roleSelection = normalizeContactRoles(contactForm.contact_roles, "buyer");
    const primaryRole = roleSelection[0] ?? "buyer";
    const budgetValue = contactForm.budget.trim() ? Number(contactForm.budget) : null;
    const hasBuyerProfile = hasBuyerRole(roleSelection);
    const hasTenantProfile = hasTenantRole(roleSelection);
    const shouldStoreBudget = hasBuyerProfile || hasTenantProfile;
    const nextFollowUpIso = parseDisplayDateToIso(contactForm.next_follow_up_at);
    const createFollowUpError = getDisplayDateError(contactForm.next_follow_up_at);
    const buyerLocations = parseCommaSeparatedList(contactForm.buyer_target_locations);
    const tenantLocations = parseCommaSeparatedList(contactForm.tenant_target_locations);

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
      client_type: primaryRole,
      contact_roles: roleSelection,
      stage: "new_lead" as ContactStage,
      priority: contactForm.priority,
      source: contactForm.source.trim() || null,
      preferred_channel: contactForm.preferred_channel,
      notes: contactForm.notes.trim() || null,
      next_follow_up_at: nextFollowUpIso,
      buyer_target_locations: hasBuyerProfile ? buyerLocations : null,
      buyer_property_types: hasBuyerProfile ? contactForm.buyer_property_types : null,
      buyer_budget_min: null,
      buyer_budget_max: hasBuyerProfile ? budgetValue : null,
      buyer_bedrooms_min: hasBuyerProfile ? toNumberOrNull(contactForm.buyer_bedrooms_min) : null,
      buyer_surface_min_m2: hasBuyerProfile ? toNumberOrNull(contactForm.buyer_surface_min_m2) : null,
      buyer_move_in_window: hasBuyerProfile ? contactForm.buyer_move_in_window.trim() || null : null,
      buyer_country_details: hasBuyerProfile
        ? buildCountryDetails(
            contactForm.buyer_country_notes,
            contactForm.buyer_wants_garden,
            contactForm.buyer_wants_balcony,
            contactForm.buyer_floor_wanted,
            contactForm.buyer_floor_avoid,
          )
        : null,
      tenant_target_locations: hasTenantProfile ? tenantLocations : null,
      tenant_property_types: hasTenantProfile ? contactForm.tenant_property_types : null,
      tenant_budget_min: null,
      tenant_budget_max: hasTenantProfile ? budgetValue : null,
      tenant_bedrooms_min: hasTenantProfile ? toNumberOrNull(contactForm.tenant_bedrooms_min) : null,
      tenant_surface_min_m2: hasTenantProfile ? toNumberOrNull(contactForm.tenant_surface_min_m2) : null,
      tenant_move_in_window: hasTenantProfile ? contactForm.tenant_move_in_window.trim() || null : null,
      tenant_country_details: hasTenantProfile
        ? buildCountryDetails(
            contactForm.tenant_country_notes,
            contactForm.tenant_wants_garden,
            contactForm.tenant_wants_balcony,
            contactForm.tenant_floor_wanted,
            contactForm.tenant_floor_avoid,
          )
        : null,
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

    setContacts((previous) => dedupeContactsById([created, ...previous]));
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

    const roleSelection = normalizeContactRoles(selectedContact.contact_roles, selectedContact.client_type);
    const primaryRole = roleSelection[0] ?? "buyer";
    const budgetText = selectedContact.budget === null ? "" : String(selectedContact.budget);
    const budgetValue = budgetText.trim() ? Number(budgetText) : null;
    const hasBuyerProfile = hasBuyerRole(roleSelection);
    const hasTenantProfile = hasTenantRole(roleSelection);
    const shouldStoreBudget = hasBuyerProfile || hasTenantProfile;
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
        client_type: primaryRole,
        contact_roles: roleSelection,
        priority: selectedContact.priority,
        source: selectedContact.source?.trim() || null,
        preferred_channel: selectedContact.preferred_channel,
        notes: selectedContact.notes?.trim() || null,
        next_follow_up_at: nextFollowUpIso,
        buyer_target_locations: hasBuyerProfile ? selectedContact.buyer_target_locations : null,
        buyer_property_types: hasBuyerProfile ? selectedContact.buyer_property_types : null,
        buyer_budget_min: null,
        buyer_budget_max: hasBuyerProfile ? budgetValue : null,
        buyer_bedrooms_min: hasBuyerProfile ? selectedContact.buyer_bedrooms_min : null,
        buyer_surface_min_m2: hasBuyerProfile ? selectedContact.buyer_surface_min_m2 : null,
        buyer_move_in_window: hasBuyerProfile ? selectedContact.buyer_move_in_window : null,
        buyer_country_details: hasBuyerProfile ? selectedContact.buyer_country_details : null,
        tenant_target_locations: hasTenantProfile ? selectedContact.tenant_target_locations : null,
        tenant_property_types: hasTenantProfile ? selectedContact.tenant_property_types : null,
        tenant_budget_min: null,
        tenant_budget_max: hasTenantProfile ? budgetValue : null,
        tenant_bedrooms_min: hasTenantProfile ? selectedContact.tenant_bedrooms_min : null,
        tenant_surface_min_m2: hasTenantProfile ? selectedContact.tenant_surface_min_m2 : null,
        tenant_move_in_window: hasTenantProfile ? selectedContact.tenant_move_in_window : null,
        tenant_country_details: hasTenantProfile ? selectedContact.tenant_country_details : null,
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

    setContacts((previous) => dedupeContactsById(previous.map((contact) => (contact.id === updated.id ? updated : contact))));
    const savedFollowUpInput = formatDateOnly(updated.next_follow_up_at, "");
    setSelectedFollowUpInput(savedFollowUpInput);
    setContactDetailsDraftBaseline(
      createContactDetailsDraftSnapshot(updated, savedFollowUpInput, assigneesByContact[selectedContact.id] ?? []),
    );
    setIsDiscardChangesDialogOpen(false);
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

    setContacts(dedupeContactsById(optimistic));

    const { data, error: updateError } = await supabase
      .from("crm_contacts")
      .update({ stage: nextStage })
      .eq("id", contactId)
      .eq("workspace_id", workspace.id)
      .select("*")
      .single();

    if (updateError) {
      setContacts((previous) =>
        dedupeContactsById(previous.map((contact) => (contact.id === contactId ? { ...contact, stage: source.stage } : contact))),
      );
      setError(withSessionReloadFallback(updateError.message, "Could not update contact stage."));
      return;
    }

    const updated = data as CrmContact;

    setContacts((previous) => dedupeContactsById(previous.map((contact) => (contact.id === updated.id ? updated : contact))));
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
    setContacts(dedupeContactsById(remaining));
    setSelectedContactId(remaining[0]?.id ?? null);
    setMessage("Contact archived.");
    setIsSaving(false);
  }

  async function turnOffFollowUpReminder() {
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

    const { error: updateError } = await supabase
      .from("crm_contacts")
      .update({ next_follow_up_at: null })
      .eq("id", selectedContact.id)
      .eq("workspace_id", workspace.id);

    if (updateError) {
      setError(withSessionReloadFallback(updateError.message, "Could not turn off follow-up reminder."));
      setIsSaving(false);
      return;
    }

    setContacts((previous) =>
      dedupeContactsById(
        previous.map((contact) =>
          contact.id === selectedContact.id
            ? { ...contact, next_follow_up_at: null, updated_at: new Date().toISOString() }
            : contact,
        ),
      ),
    );
    setSelectedFollowUpInput("");
    setSelectedFollowUpDateError(null);
    setMessage("Follow-up reminder turned off.");
    setIsSaving(false);
  }

  function startDeleteSelectedContact() {
    if (!canDeleteContacts) {
      setError("Only super admins, owners, and team leads can delete contacts.");
      return;
    }

    if (!selectedContact) {
      return;
    }

    const confirmed = window.confirm(
      `Delete ${getContactName(selectedContact)} permanently? This cannot be undone.`,
    );

    if (!confirmed) {
      return;
    }

    void deleteSelectedContact();
    setError(null);
    setMessage(null);
  }

  function openContactDetails(contactId: string) {
    const sourceContact = contacts.find((contact) => contact.id === contactId);
    if (sourceContact) {
      const followUpInput = formatDateOnly(sourceContact.next_follow_up_at, "");
      const assigneeIds = assigneesByContact[contactId] ?? [];
      setContactDetailsDraftBaseline(createContactDetailsDraftSnapshot(sourceContact, followUpInput, assigneeIds));
    }

    setSelectedContactId(contactId);
    setIsContactDetailsOpen(true);
    setIsDiscardChangesDialogOpen(false);
  }

  function closeContactDetails() {
    setIsContactDetailsOpen(false);
    setIsDiscardChangesDialogOpen(false);
    setContactDetailsDraftBaseline(null);

    if (searchParams.get("details") === "1") {
      const nextParams = new URLSearchParams(searchParams.toString());
      nextParams.delete("details");
      const nextQuery = nextParams.toString();
      router.replace(nextQuery ? `/contacts?${nextQuery}` : "/contacts", { scroll: false });
    }
  }

  function hasUnsavedContactDetailsChanges() {
    if (!selectedContact || !contactDetailsDraftBaseline) {
      return false;
    }

    const currentSnapshot = createContactDetailsDraftSnapshot(
      selectedContact,
      selectedFollowUpInput,
      assigneesByContact[selectedContact.id] ?? [],
    );

    return !areContactDetailsDraftSnapshotsEqual(currentSnapshot, contactDetailsDraftBaseline);
  }

  useEffect(() => {
    if (!isContactDetailsOpen || !selectedContact || !contactDetailsDraftBaseline || !areAssigneesLoaded) {
      return;
    }

    const currentSnapshot = createContactDetailsDraftSnapshot(
      selectedContact,
      selectedFollowUpInput,
      assigneesByContact[selectedContact.id] ?? [],
    );

    const sameContactPayload = JSON.stringify(currentSnapshot.contact) === JSON.stringify(contactDetailsDraftBaseline.contact);
    const sameFollowUpInput = currentSnapshot.followUpInput === contactDetailsDraftBaseline.followUpInput;
    const differentAssignees =
      JSON.stringify(currentSnapshot.assigneeProfileIds) !== JSON.stringify(contactDetailsDraftBaseline.assigneeProfileIds);

    if (sameContactPayload && sameFollowUpInput && differentAssignees) {
      setContactDetailsDraftBaseline(currentSnapshot);
    }
  }, [
    areAssigneesLoaded,
    assigneesByContact,
    contactDetailsDraftBaseline,
    isContactDetailsOpen,
    selectedContact,
    selectedFollowUpInput,
  ]);

  function requestCloseContactDetails() {
    if (hasUnsavedContactDetailsChanges()) {
      setIsDiscardChangesDialogOpen(true);
      return;
    }

    closeContactDetails();
  }

  useEffect(() => {
    if (!isContactDetailsOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (isDiscardChangesDialogOpen) {
        return;
      }

      const panel = contactDetailsPanelRef.current;
      const targetNode = event.target as Node | null;

      if (!panel || !targetNode) {
        return;
      }

      if (panel.contains(targetNode)) {
        return;
      }

      requestCloseContactDetails();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [isContactDetailsOpen, isDiscardChangesDialogOpen, requestCloseContactDetails]);

  function cancelDiscardContactDetailsChanges() {
    setIsDiscardChangesDialogOpen(false);
  }

  function discardContactDetailsChangesAndClose() {
    if (selectedContactId && contactDetailsDraftBaseline) {
      const baselineContact = contactDetailsDraftBaseline.contact;

      setContacts((previous) =>
        dedupeContactsById(previous.map((contact) =>
          contact.id === selectedContactId
            ? {
                ...baselineContact,
                contact_roles: baselineContact.contact_roles ? [...baselineContact.contact_roles] : null,
                buyer_target_locations: baselineContact.buyer_target_locations
                  ? [...baselineContact.buyer_target_locations]
                  : null,
                buyer_property_types: baselineContact.buyer_property_types
                  ? [...baselineContact.buyer_property_types]
                  : null,
                tenant_target_locations: baselineContact.tenant_target_locations
                  ? [...baselineContact.tenant_target_locations]
                  : null,
                tenant_property_types: baselineContact.tenant_property_types
                  ? [...baselineContact.tenant_property_types]
                  : null,
                buyer_country_details: baselineContact.buyer_country_details
                  ? { ...baselineContact.buyer_country_details }
                  : null,
                tenant_country_details: baselineContact.tenant_country_details
                  ? { ...baselineContact.tenant_country_details }
                  : null,
              }
            : contact,
        )),
      );
      setSelectedFollowUpInput(contactDetailsDraftBaseline.followUpInput);
      setSelectedFollowUpDateError(null);
      setAssigneesByContact((previous) => ({
        ...previous,
        [selectedContactId]: [...contactDetailsDraftBaseline.assigneeProfileIds],
      }));
    }

    closeContactDetails();
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
    setContacts(dedupeContactsById(remaining));
    setAssigneesByContact((previous) => {
      const next = { ...previous };
      delete next[deletingId];
      return next;
    });
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
      dedupeContactsById(
        previous.map((contact) => (contact.id === selectedContactId ? { ...contact, [key]: value } : contact)),
      ),
    );
  }

  function toggleCreateRole(role: ContactRole) {
    setContactForm((previous) => {
      const hasRole = previous.contact_roles.includes(role);
      const nextRoles = hasRole
        ? previous.contact_roles.filter((candidate) => candidate !== role)
        : [...previous.contact_roles, role];

      if (nextRoles.length === 0) {
        return previous;
      }

      return {
        ...previous,
        contact_roles: nextRoles,
      };
    });
  }

  function toggleSelectedContactRole(role: ContactRole) {
    if (!selectedContactId) {
      return;
    }

    setContacts((previous) =>
      dedupeContactsById(previous.map((contact) => {
        if (contact.id !== selectedContactId) {
          return contact;
        }

        const currentRoles = normalizeContactRoles(contact.contact_roles, contact.client_type);
        const hasRole = currentRoles.includes(role);
        const nextRoles = hasRole
          ? currentRoles.filter((candidate) => candidate !== role)
          : [...currentRoles, role];

        if (nextRoles.length === 0) {
          return contact;
        }

        const primaryRole = nextRoles[0] ?? contact.client_type;
        const shouldKeepBudget = nextRoles.some((nextRole) => requiresBudget(nextRole));

        return {
          ...contact,
          contact_roles: nextRoles,
          client_type: primaryRole,
          budget: shouldKeepBudget ? contact.budget : null,
        };
      })),
    );
  }

  function toggleCreateBuyerPropertyType(value: ContactPropertyType) {
    setContactForm((previous) => {
      const hasValue = previous.buyer_property_types.includes(value);
      return {
        ...previous,
        buyer_property_types: hasValue
          ? previous.buyer_property_types.filter((type) => type !== value)
          : [...previous.buyer_property_types, value],
      };
    });
  }

  function toggleSelectedBuyerPropertyType(value: ContactPropertyType) {
    if (!selectedContact) {
      return;
    }

    const current = Array.isArray(selectedContact.buyer_property_types)
      ? (selectedContact.buyer_property_types as ContactPropertyType[])
      : [];
    const hasValue = current.includes(value);

    updateSelectedContact(
      "buyer_property_types",
      (hasValue ? current.filter((type) => type !== value) : [...current, value]) as CrmContact["buyer_property_types"],
    );
  }

  function toggleCreateTenantPropertyType(value: ContactPropertyType) {
    setContactForm((previous) => {
      const hasValue = previous.tenant_property_types.includes(value);
      return {
        ...previous,
        tenant_property_types: hasValue
          ? previous.tenant_property_types.filter((type) => type !== value)
          : [...previous.tenant_property_types, value],
      };
    });
  }

  function toggleSelectedTenantPropertyType(value: ContactPropertyType) {
    if (!selectedContact) {
      return;
    }

    const current = Array.isArray(selectedContact.tenant_property_types)
      ? (selectedContact.tenant_property_types as ContactPropertyType[])
      : [];
    const hasValue = current.includes(value);

    updateSelectedContact(
      "tenant_property_types",
      (hasValue ? current.filter((type) => type !== value) : [...current, value]) as CrmContact["tenant_property_types"],
    );
  }

  function applyCreateFollowUpPreset(days: number) {
    const presetValue = formatDateAsInputValue(addDays(new Date(), days));
    setContactForm((previous) => ({
      ...previous,
      next_follow_up_at: presetValue,
    }));
    setContactFollowUpDateError(null);
  }

  function applySelectedFollowUpPreset(days: number) {
    const presetValue = formatDateAsInputValue(addDays(new Date(), days));
    setSelectedFollowUpInput(presetValue);
    setSelectedFollowUpDateError(null);
  }

  function applyTimelineDueDatePreset(days: number) {
    const presetValue = formatDateAsInputValue(addDays(new Date(), days));
    setTimelineForm((previous) => ({
      ...previous,
      due_date: presetValue,
    }));
    setTimelineDueDateError(null);
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
    if (eventType === "email_summary" || eventType === "sms_summary" || eventType === "whatsapp_summary" || eventType === "call_summary") {
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

  async function handleSendMessage() {
    if (!workspace?.id || !selectedContactId || !selectedContact?.phone || !outboundChannel || !outboundMessage.trim()) {
      return;
    }

    setIsSendingOutbound(true);
    setError(null);

    const response = await fetch("/api/twilio/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        contactId: selectedContactId,
        to: selectedContact.phone,
        message: outboundMessage.trim(),
        channel: outboundChannel,
      }),
    });

    setIsSendingOutbound(false);

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Could not send message.");
      return;
    }

    setOutboundChannel(null);
    setOutboundMessage("");
    setMessage(`${outboundChannel === "whatsapp" ? "WhatsApp" : "SMS"} sent.`);
    void loadTimeline(workspace.id, selectedContactId);
  }

  async function handleInitiateCall() {
    if (!workspace?.id || !selectedContactId || !selectedContact?.phone) {
      return;
    }

    if (!window.confirm(`Call ${getContactName(selectedContact)} at ${selectedContact.phone}?`)) {
      return;
    }

    setIsSendingOutbound(true);
    setError(null);

    const response = await fetch("/api/twilio/initiate-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        contactId: selectedContactId,
        to: selectedContact.phone,
      }),
    });

    setIsSendingOutbound(false);

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Could not initiate call.");
      return;
    }

    setMessage("Call initiated.");
    void loadTimeline(workspace.id, selectedContactId);
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
        <div className="bg-gradient-to-r from-slate-900 via-blue-900 to-slate-900 px-6 py-3 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-blue-100">CRM Cockpit</p>
          <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_240px] md:items-end">
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
                  className="rounded-xl border border-white/30 bg-white/10 px-3 py-1.5 text-sm font-medium normal-case tracking-normal text-white outline-none transition hover:bg-white/15"
                >
                  {(accessibleWorkspaces.length > 0 ? accessibleWorkspaces : workspace ? [{ workspace_id: workspace.id, workspace_name: workspace.name, company_id: workspace.company_id, company_name: workspace.company_name, user_role: "agent", is_current: true }] : []).map((item) => (
                    <option key={item.workspace_id} value={item.workspace_id} className="text-slate-900">
                      {item.workspace_name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="rounded-xl border border-white/30 bg-white/10 px-3 py-1.5 text-sm font-medium normal-case tracking-normal text-white">
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
            <div className="min-w-0 md:col-span-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Contact roles</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {CONTACT_ROLE_OPTIONS.map((role) => {
                  const isSelected = contactForm.contact_roles.includes(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      onClick={() => toggleCreateRole(role)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] leading-none transition ${
                        isSelected
                          ? "border-blue-400 bg-blue-50 text-blue-700"
                          : "border-[var(--border)] bg-white text-[var(--muted)] hover:bg-slate-50"
                      }`}
                    >
                      {formatRoleLabel(role)}
                    </button>
                  );
                })}
              </div>
            </div>
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
              <div className="flex flex-wrap gap-1.5">
                {FOLLOW_UP_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => applyCreateFollowUpPreset(preset.days)}
                    className="rounded-full border border-[var(--border)] bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)] hover:bg-slate-50"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
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
            {hasBuyerRole(contactForm.contact_roles) ? (
              <div className="md:col-span-2 xl:col-span-4 rounded-xl border border-[var(--border)] bg-white px-3 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Buyer details</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <input
                    value={contactForm.buyer_target_locations}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, buyer_target_locations: event.target.value }))
                    }
                    placeholder="Where to buy (cities/areas)"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)] xl:col-span-2"
                  />
                  <div className="grid grid-cols-[minmax(0,1fr)_104px] gap-2 sm:col-span-2 xl:col-span-2">
                    <input
                      value={contactForm.budget}
                      onChange={(event) => setContactForm((previous) => ({ ...previous, budget: event.target.value }))}
                      placeholder={`Budget (${contactForm.currency})`}
                      inputMode="decimal"
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                    />
                    <select
                      value={contactForm.currency}
                      onChange={(event) => setContactForm((previous) => ({ ...previous, currency: event.target.value }))}
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      aria-label="Budget currency"
                    >
                      {CURRENCY_OPTIONS.map((currency) => (
                        <option key={currency} value={currency}>
                          {currency}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                    <input
                      type="checkbox"
                      checked={contactForm.buyer_wants_garden}
                      onChange={(event) =>
                        setContactForm((previous) => ({ ...previous, buyer_wants_garden: event.target.checked }))
                      }
                      className="h-4 w-4"
                    />
                    Wants garden
                  </label>
                  <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                    <input
                      type="checkbox"
                      checked={contactForm.buyer_wants_balcony}
                      onChange={(event) =>
                        setContactForm((previous) => ({ ...previous, buyer_wants_balcony: event.target.checked }))
                      }
                      className="h-4 w-4"
                    />
                    Wants balcony
                  </label>
                  <input
                    value={contactForm.buyer_bedrooms_min}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, buyer_bedrooms_min: event.target.value }))
                    }
                    placeholder="Min bedrooms"
                    inputMode="numeric"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={contactForm.buyer_surface_min_m2}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, buyer_surface_min_m2: event.target.value }))
                    }
                    placeholder="Min surface (m2)"
                    inputMode="decimal"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={contactForm.buyer_move_in_window}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, buyer_move_in_window: event.target.value }))
                    }
                    placeholder="Move-in window"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={contactForm.buyer_floor_wanted}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, buyer_floor_wanted: event.target.value }))
                    }
                    placeholder="Preferred floor (e.g. 2nd, 3rd+)"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={contactForm.buyer_floor_avoid}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, buyer_floor_avoid: event.target.value }))
                    }
                    placeholder="Avoid floor (e.g. ground, top)"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={contactForm.buyer_country_notes}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, buyer_country_notes: event.target.value }))
                    }
                    placeholder="Country-specific notes"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {CONTACT_PROPERTY_TYPE_OPTIONS.map((propertyType) => {
                    const isSelected = contactForm.buyer_property_types.includes(propertyType);
                    return (
                      <button
                        key={propertyType}
                        type="button"
                        onClick={() => toggleCreateBuyerPropertyType(propertyType)}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] leading-none transition ${
                          isSelected
                            ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                            : "border-[var(--border)] bg-white text-[var(--muted)] hover:bg-slate-50"
                        }`}
                      >
                        {formatPropertyTypeLabel(propertyType)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {hasTenantRole(contactForm.contact_roles) ? (
              <div className="md:col-span-2 xl:col-span-4 rounded-xl border border-[var(--border)] bg-white px-3 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Tenant details</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <input
                    value={contactForm.tenant_target_locations}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, tenant_target_locations: event.target.value }))
                    }
                    placeholder="Where to rent (cities/areas)"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)] xl:col-span-2"
                  />
                  <div className="grid grid-cols-[minmax(0,1fr)_104px] gap-2 sm:col-span-2 xl:col-span-2">
                    <input
                      value={contactForm.budget}
                      onChange={(event) => setContactForm((previous) => ({ ...previous, budget: event.target.value }))}
                      placeholder={`Budget (${contactForm.currency})`}
                      inputMode="decimal"
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                    />
                    <select
                      value={contactForm.currency}
                      onChange={(event) => setContactForm((previous) => ({ ...previous, currency: event.target.value }))}
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      aria-label="Budget currency"
                    >
                      {CURRENCY_OPTIONS.map((currency) => (
                        <option key={`tenant-${currency}`} value={currency}>
                          {currency}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                    <input
                      type="checkbox"
                      checked={contactForm.tenant_wants_garden}
                      onChange={(event) =>
                        setContactForm((previous) => ({ ...previous, tenant_wants_garden: event.target.checked }))
                      }
                      className="h-4 w-4"
                    />
                    Wants garden
                  </label>
                  <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                    <input
                      type="checkbox"
                      checked={contactForm.tenant_wants_balcony}
                      onChange={(event) =>
                        setContactForm((previous) => ({ ...previous, tenant_wants_balcony: event.target.checked }))
                      }
                      className="h-4 w-4"
                    />
                    Wants balcony
                  </label>
                  <input
                    value={contactForm.tenant_bedrooms_min}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, tenant_bedrooms_min: event.target.value }))
                    }
                    placeholder="Min bedrooms"
                    inputMode="numeric"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={contactForm.tenant_surface_min_m2}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, tenant_surface_min_m2: event.target.value }))
                    }
                    placeholder="Min surface (m2)"
                    inputMode="decimal"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={contactForm.tenant_move_in_window}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, tenant_move_in_window: event.target.value }))
                    }
                    placeholder="Move-in window"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={contactForm.tenant_floor_wanted}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, tenant_floor_wanted: event.target.value }))
                    }
                    placeholder="Preferred floor (e.g. 2nd, 3rd+)"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={contactForm.tenant_floor_avoid}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, tenant_floor_avoid: event.target.value }))
                    }
                    placeholder="Avoid floor (e.g. ground, top)"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={contactForm.tenant_country_notes}
                    onChange={(event) =>
                      setContactForm((previous) => ({ ...previous, tenant_country_notes: event.target.value }))
                    }
                    placeholder="Country-specific notes"
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {CONTACT_PROPERTY_TYPE_OPTIONS.map((propertyType) => {
                    const isSelected = contactForm.tenant_property_types.includes(propertyType);
                    return (
                      <button
                        key={`tenant-${propertyType}`}
                        type="button"
                        onClick={() => toggleCreateTenantPropertyType(propertyType)}
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] leading-none transition ${
                          isSelected
                            ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                            : "border-[var(--border)] bg-white text-[var(--muted)] hover:bg-slate-50"
                        }`}
                      >
                        {formatPropertyTypeLabel(propertyType)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
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
                    {columnContacts.map((contact, index) => (
                      <button
                        key={`${contact.id}-${column.key}-${index}`}
                        type="button"
                        draggable
                        onDragStart={() => setDraggedContactId(contact.id)}
                        onClick={() => {
                          setSelectedContactId(contact.id);
                          setIsContactDetailsOpen(false);
                        }}
                        onDoubleClick={() => openContactDetails(contact.id)}
                        className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                          selectedContactId === contact.id
                            ? "border-blue-500 bg-blue-50"
                            : "border-[var(--border)] bg-white hover:border-blue-300"
                        }`}
                      >
                        <p className="text-sm font-semibold text-[var(--foreground)]">{getContactName(contact)}</p>
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                            {normalizeContactRoles(contact.contact_roles, contact.client_type)
                              .map((role) => formatRoleLabel(role))
                              .join(" / ")}
                          </p>
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
            <p className="text-sm text-[var(--muted)]">
              Click a contact card once to show its timeline here. Double click to open full contact details.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">
                  Timeline for {getContactName(selectedContact)}
                </p>
              </div>
              <div className="grid gap-2 rounded-xl border border-[var(--border)] bg-white p-3 sm:grid-cols-2 lg:grid-cols-4">
                <input
                  type="search"
                  value={timelineSearchQuery}
                  onChange={(event) => setTimelineSearchQuery(event.target.value)}
                  placeholder="Search timeline"
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] sm:col-span-2 lg:col-span-2"
                />
                <select
                  value={timelineEventTypeFilter}
                  onChange={(event) => setTimelineEventTypeFilter(event.target.value as TimelineEventTypeFilter)}
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                  aria-label="Filter timeline by type"
                >
                  {TIMELINE_EVENT_FILTER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={timelineOnlyWithDueDate}
                    onChange={(event) => setTimelineOnlyWithDueDate(event.target.checked)}
                    className="h-4 w-4"
                  />
                  Due only
                </label>
                <input
                  value={timelineFromDate}
                  onChange={(event) => setTimelineFromDate(event.target.value)}
                  type="text"
                  inputMode="numeric"
                  placeholder="From (dd/mm/yyyy)"
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                />
                <input
                  value={timelineToDate}
                  onChange={(event) => setTimelineToDate(event.target.value)}
                  type="text"
                  inputMode="numeric"
                  placeholder="To (dd/mm/yyyy)"
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div className="overflow-x-auto pb-2">
                <div className="flex min-w-max gap-3">
                  {filteredEvents.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--muted)]">
                      No timeline events match your filters.
                    </p>
                  ) : (
                    filteredEvents.map((timelineEvent) => (
                      <article
                        key={`horizontal-${timelineEvent.id}`}
                        className="w-[290px] shrink-0 rounded-xl border border-[var(--border)] bg-white px-3 py-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-semibold text-[var(--foreground)]">{timelineEvent.title}</p>
                          <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600">
                            {timelineEvent.event_type}
                          </span>
                        </div>
                        {timelineEvent.body ? (
                          <p className="mt-1 text-sm leading-6 text-[var(--muted)] line-clamp-4">
                            {timelineEvent.event_type === "status_change"
                              ? formatStatusChangeBody(timelineEvent)
                              : timelineEvent.body}
                          </p>
                        ) : null}
                        {getTimelineEventDueDate(timelineEvent) ? (
                          <p className="mt-2 text-xs font-medium text-[var(--muted)]">
                            Due: {formatDateOnly(getTimelineEventDueDate(timelineEvent))}
                          </p>
                        ) : null}
                        <p className="mt-2 text-xs text-[var(--muted)]">{formatDateTime(timelineEvent.occurred_at)}</p>
                        <p className="text-[11px] text-[var(--muted)]">
                          By {getEventActorLabel(timelineEvent, workspaceMemberNameById)}
                        </p>
                      </article>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </aside>

        {isContactDetailsOpen ? (
          <button
            type="button"
            aria-label="Close contact details"
            onClick={requestCloseContactDetails}
            className="fixed inset-0 z-40 bg-slate-950/45"
          />
        ) : null}

        <aside
          ref={contactDetailsPanelRef}
          className={`${isContactDetailsOpen ? "fixed left-1/2 top-4 z-50 max-h-[92vh] w-[min(1120px,calc(100vw-1.5rem))] -translate-x-1/2 overflow-y-auto rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] p-4 shadow-2xl" : "hidden"}`}
        >
          <div className="mb-3 flex items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">
              Contact details
            </p>
            <button
              type="button"
              onClick={requestCloseContactDetails}
              className="rounded-lg border border-[var(--border)] bg-white px-2.5 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
            >
              Close
            </button>
          </div>
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
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    <div className="min-w-0 sm:col-span-2 xl:col-span-3 rounded-xl border border-[var(--border)] bg-white px-3 py-2">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Contact roles</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {CONTACT_ROLE_OPTIONS.map((role) => {
                          const selectedRoles = normalizeContactRoles(selectedContact.contact_roles, selectedContact.client_type);
                          const isSelected = selectedRoles.includes(role);

                          return (
                            <button
                              key={role}
                              type="button"
                              onClick={() => toggleSelectedContactRole(role)}
                              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] leading-none transition ${
                                isSelected
                                  ? "border-blue-400 bg-blue-50 text-blue-700"
                                  : "border-[var(--border)] bg-white text-[var(--muted)] hover:bg-slate-50"
                              }`}
                            >
                              {formatRoleLabel(role)}
                            </button>
                          );
                        })}
                      </div>
                    </div>

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
                  </div>
                  {hasBuyerRole(normalizeContactRoles(selectedContact.contact_roles, selectedContact.client_type)) ? (
                    <div className="rounded-xl border border-[var(--border)] bg-white px-3 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Buyer details</p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        <input
                          value={listToInputValue(selectedContact.buyer_target_locations)}
                          onChange={(event) =>
                            updateSelectedContact("buyer_target_locations", parseCommaSeparatedList(event.target.value))
                          }
                          placeholder="Where to buy (cities/areas)"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)] xl:col-span-2"
                        />
                        <div className="grid grid-cols-[minmax(0,1fr)_104px] gap-2 sm:col-span-2 xl:col-span-2">
                          <input
                            value={selectedContact.budget ?? ""}
                            onChange={(event) => updateSelectedContact("budget", event.target.value ? Number(event.target.value) : null)}
                            placeholder={`Budget (${selectedContact.currency})`}
                            inputMode="decimal"
                            className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                          />
                          <select
                            value={selectedContact.currency}
                            onChange={(event) => updateSelectedContact("currency", event.target.value)}
                            className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                            aria-label="Budget currency"
                          >
                            {CURRENCY_OPTIONS.map((currency) => (
                              <option key={`buyer-edit-${currency}`} value={currency}>
                                {currency}
                              </option>
                            ))}
                          </select>
                        </div>
                        <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                          <input
                            type="checkbox"
                            checked={getCountryDetailBoolean(selectedContact.buyer_country_details, "wants_garden")}
                            onChange={(event) =>
                              updateSelectedContact(
                                "buyer_country_details",
                                patchCountryDetails(selectedContact.buyer_country_details, {
                                  wants_garden: event.target.checked,
                                }),
                              )
                            }
                            className="h-4 w-4"
                          />
                          Wants garden
                        </label>
                        <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                          <input
                            type="checkbox"
                            checked={getCountryDetailBoolean(selectedContact.buyer_country_details, "wants_balcony")}
                            onChange={(event) =>
                              updateSelectedContact(
                                "buyer_country_details",
                                patchCountryDetails(selectedContact.buyer_country_details, {
                                  wants_balcony: event.target.checked,
                                }),
                              )
                            }
                            className="h-4 w-4"
                          />
                          Wants balcony
                        </label>
                        <input
                          value={selectedContact.buyer_bedrooms_min ?? ""}
                          onChange={(event) => updateSelectedContact("buyer_bedrooms_min", toNumberOrNull(event.target.value))}
                          placeholder="Min bedrooms"
                          inputMode="numeric"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={selectedContact.buyer_surface_min_m2 ?? ""}
                          onChange={(event) => updateSelectedContact("buyer_surface_min_m2", toNumberOrNull(event.target.value))}
                          placeholder="Min surface (m2)"
                          inputMode="decimal"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={selectedContact.buyer_move_in_window ?? ""}
                          onChange={(event) => updateSelectedContact("buyer_move_in_window", event.target.value || null)}
                          placeholder="Move-in window"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={getCountryDetailString(selectedContact.buyer_country_details, "preferred_floor")}
                          onChange={(event) =>
                            updateSelectedContact(
                              "buyer_country_details",
                              patchCountryDetails(selectedContact.buyer_country_details, {
                                preferred_floor: event.target.value,
                              }),
                            )
                          }
                          placeholder="Preferred floor (e.g. 2nd, 3rd+)"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={getCountryDetailString(selectedContact.buyer_country_details, "avoid_floor")}
                          onChange={(event) =>
                            updateSelectedContact(
                              "buyer_country_details",
                              patchCountryDetails(selectedContact.buyer_country_details, {
                                avoid_floor: event.target.value,
                              }),
                            )
                          }
                          placeholder="Avoid floor (e.g. ground, top)"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={getCountryDetailString(selectedContact.buyer_country_details, "notes")}
                          onChange={(event) =>
                            updateSelectedContact(
                              "buyer_country_details",
                              patchCountryDetails(selectedContact.buyer_country_details, {
                                notes: event.target.value,
                              }),
                            )
                          }
                          placeholder="Country-specific notes"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {CONTACT_PROPERTY_TYPE_OPTIONS.map((propertyType) => {
                          const selectedPropertyTypes = (selectedContact.buyer_property_types ?? []) as ContactPropertyType[];
                          const isSelected = selectedPropertyTypes.includes(propertyType);
                          return (
                            <button
                              key={propertyType}
                              type="button"
                              onClick={() => toggleSelectedBuyerPropertyType(propertyType)}
                              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] leading-none transition ${
                                isSelected
                                  ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                                  : "border-[var(--border)] bg-white text-[var(--muted)] hover:bg-slate-50"
                              }`}
                            >
                              {formatPropertyTypeLabel(propertyType)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  {hasTenantRole(normalizeContactRoles(selectedContact.contact_roles, selectedContact.client_type)) ? (
                    <div className="rounded-xl border border-[var(--border)] bg-white px-3 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">Tenant details</p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                        <input
                          value={listToInputValue(selectedContact.tenant_target_locations)}
                          onChange={(event) =>
                            updateSelectedContact("tenant_target_locations", parseCommaSeparatedList(event.target.value))
                          }
                          placeholder="Where to rent (cities/areas)"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)] xl:col-span-2"
                        />
                        <div className="grid grid-cols-[minmax(0,1fr)_104px] gap-2 sm:col-span-2 xl:col-span-2">
                          <input
                            value={selectedContact.budget ?? ""}
                            onChange={(event) => updateSelectedContact("budget", event.target.value ? Number(event.target.value) : null)}
                            placeholder={`Budget (${selectedContact.currency})`}
                            inputMode="decimal"
                            className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                          />
                          <select
                            value={selectedContact.currency}
                            onChange={(event) => updateSelectedContact("currency", event.target.value)}
                            className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                            aria-label="Budget currency"
                          >
                            {CURRENCY_OPTIONS.map((currency) => (
                              <option key={`tenant-edit-${currency}`} value={currency}>
                                {currency}
                              </option>
                            ))}
                          </select>
                        </div>
                        <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                          <input
                            type="checkbox"
                            checked={getCountryDetailBoolean(selectedContact.tenant_country_details, "wants_garden")}
                            onChange={(event) =>
                              updateSelectedContact(
                                "tenant_country_details",
                                patchCountryDetails(selectedContact.tenant_country_details, {
                                  wants_garden: event.target.checked,
                                }),
                              )
                            }
                            className="h-4 w-4"
                          />
                          Wants garden
                        </label>
                        <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                          <input
                            type="checkbox"
                            checked={getCountryDetailBoolean(selectedContact.tenant_country_details, "wants_balcony")}
                            onChange={(event) =>
                              updateSelectedContact(
                                "tenant_country_details",
                                patchCountryDetails(selectedContact.tenant_country_details, {
                                  wants_balcony: event.target.checked,
                                }),
                              )
                            }
                            className="h-4 w-4"
                          />
                          Wants balcony
                        </label>
                        <input
                          value={selectedContact.tenant_bedrooms_min ?? ""}
                          onChange={(event) => updateSelectedContact("tenant_bedrooms_min", toNumberOrNull(event.target.value))}
                          placeholder="Min bedrooms"
                          inputMode="numeric"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={selectedContact.tenant_surface_min_m2 ?? ""}
                          onChange={(event) => updateSelectedContact("tenant_surface_min_m2", toNumberOrNull(event.target.value))}
                          placeholder="Min surface (m2)"
                          inputMode="decimal"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={selectedContact.tenant_move_in_window ?? ""}
                          onChange={(event) => updateSelectedContact("tenant_move_in_window", event.target.value || null)}
                          placeholder="Move-in window"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={getCountryDetailString(selectedContact.tenant_country_details, "preferred_floor")}
                          onChange={(event) =>
                            updateSelectedContact(
                              "tenant_country_details",
                              patchCountryDetails(selectedContact.tenant_country_details, {
                                preferred_floor: event.target.value,
                              }),
                            )
                          }
                          placeholder="Preferred floor (e.g. 2nd, 3rd+)"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={getCountryDetailString(selectedContact.tenant_country_details, "avoid_floor")}
                          onChange={(event) =>
                            updateSelectedContact(
                              "tenant_country_details",
                              patchCountryDetails(selectedContact.tenant_country_details, {
                                avoid_floor: event.target.value,
                              }),
                            )
                          }
                          placeholder="Avoid floor (e.g. ground, top)"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <input
                          value={getCountryDetailString(selectedContact.tenant_country_details, "notes")}
                          onChange={(event) =>
                            updateSelectedContact(
                              "tenant_country_details",
                              patchCountryDetails(selectedContact.tenant_country_details, {
                                notes: event.target.value,
                              }),
                            )
                          }
                          placeholder="Country-specific notes"
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {CONTACT_PROPERTY_TYPE_OPTIONS.map((propertyType) => {
                          const selectedPropertyTypes = (selectedContact.tenant_property_types ?? []) as ContactPropertyType[];
                          const isSelected = selectedPropertyTypes.includes(propertyType);
                          return (
                            <button
                              key={`tenant-edit-${propertyType}`}
                              type="button"
                              onClick={() => toggleSelectedTenantPropertyType(propertyType)}
                              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] leading-none transition ${
                                isSelected
                                  ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                                  : "border-[var(--border)] bg-white text-[var(--muted)] hover:bg-slate-50"
                              }`}
                            >
                              {formatPropertyTypeLabel(propertyType)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
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
                </form>
              </div>

              <div className="space-y-4">
                {isTwilioFeatureEnabled && selectedContact.phone ? (
                  <div className="space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Send message / Call</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setOutboundChannel(outboundChannel === "sms" ? null : "sms")}
                        disabled={isSendingOutbound}
                        className={`rounded-xl border px-3 py-2 text-xs font-semibold transition disabled:opacity-60 ${outboundChannel === "sms" ? "border-emerald-500 bg-emerald-500 text-white" : "border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-slate-50"}`}
                      >
                        SMS
                      </button>
                      <button
                        type="button"
                        onClick={() => setOutboundChannel(outboundChannel === "whatsapp" ? null : "whatsapp")}
                        disabled={isSendingOutbound}
                        className={`rounded-xl border px-3 py-2 text-xs font-semibold transition disabled:opacity-60 ${outboundChannel === "whatsapp" ? "border-teal-500 bg-teal-500 text-white" : "border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-slate-50"}`}
                      >
                        WhatsApp
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleInitiateCall()}
                        disabled={isSendingOutbound}
                        className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:opacity-60"
                      >
                        {isSendingOutbound ? "Calling..." : "Call"}
                      </button>
                    </div>
                    {outboundChannel ? (
                      <div className="space-y-2">
                        <textarea
                          value={outboundMessage}
                          onChange={(event) => setOutboundMessage(event.target.value)}
                          rows={3}
                          placeholder={`Type your ${outboundChannel === "whatsapp" ? "WhatsApp" : "SMS"} message...`}
                          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={isSendingOutbound || !outboundMessage.trim()}
                            onClick={() => void handleSendMessage()}
                            className="rounded-xl border border-blue-500 bg-blue-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-blue-600 disabled:opacity-60"
                          >
                            {isSendingOutbound ? "Sending..." : "Send"}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setOutboundChannel(null); setOutboundMessage(""); }}
                            className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Log interaction</p>
                  <form onSubmit={handleCreateInteraction} className="grid gap-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="grid gap-2 rounded-xl border border-[var(--border)] bg-white p-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Interaction</p>
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
                      </div>

                      <div className="grid gap-2 rounded-xl border border-[var(--border)] bg-white p-3">
                        <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
                          Next follow-up date
                          <div className="flex flex-wrap gap-1.5">
                            {FOLLOW_UP_PRESETS.map((preset) => (
                              <button
                                key={`timeline-${preset.label}`}
                                type="button"
                                onClick={() => applyTimelineDueDatePreset(preset.days)}
                                className="rounded-full border border-[var(--border)] bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)] hover:bg-slate-50"
                              >
                                {preset.label}
                              </button>
                            ))}
                          </div>
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
                        </label>
                        <label className="min-w-0 flex flex-col gap-1 text-xs font-medium text-[var(--muted)]">
                          Follow-up note
                          <textarea
                            value={timelineForm.body}
                            onChange={(event) => setTimelineForm((previous) => ({ ...previous, body: event.target.value }))}
                            rows={3}
                            placeholder="What should happen on this follow-up?"
                            className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                          />
                        </label>
                      </div>
                    </div>

                    {timelineDueDateError ? <span className="text-[11px] text-red-600">{timelineDueDateError}</span> : null}
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
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Timeline</p>
                  </div>
                  <div className="grid gap-2 rounded-xl border border-[var(--border)] bg-white p-3 sm:grid-cols-2">
                    <input
                      type="search"
                      value={timelineSearchQuery}
                      onChange={(event) => setTimelineSearchQuery(event.target.value)}
                      placeholder="Search timeline text"
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)] sm:col-span-2"
                    />
                    <select
                      value={timelineEventTypeFilter}
                      onChange={(event) => setTimelineEventTypeFilter(event.target.value as TimelineEventTypeFilter)}
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
                      aria-label="Filter timeline by type"
                    >
                      {TIMELINE_EVENT_FILTER_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                      <input
                        type="checkbox"
                        checked={timelineOnlyWithDueDate}
                        onChange={(event) => setTimelineOnlyWithDueDate(event.target.checked)}
                        className="h-4 w-4"
                      />
                      Due only
                    </label>
                    <input
                      value={timelineFromDate}
                      onChange={(event) => setTimelineFromDate(event.target.value)}
                      type="text"
                      inputMode="numeric"
                      placeholder="From (dd/mm/yyyy)"
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                    />
                    <input
                      value={timelineToDate}
                      onChange={(event) => setTimelineToDate(event.target.value)}
                      type="text"
                      inputMode="numeric"
                      placeholder="To (dd/mm/yyyy)"
                      className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                  {(isEmailFeatureEnabled || isTwilioFeatureEnabled) ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {isEmailFeatureEnabled ? (
                        <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-blue-700">
                          Emails {keptSummaryCount}
                        </span>
                      ) : null}
                      {isTwilioFeatureEnabled ? (
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-emerald-700">
                          SMS {keptSmsSummaryCount}
                        </span>
                      ) : null}
                      {isTwilioFeatureEnabled ? (
                        <span className="rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-teal-700">
                          WhatsApp {keptWhatsAppSummaryCount}
                        </span>
                      ) : null}
                      {isTwilioFeatureEnabled ? (
                        <span className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-violet-700">
                          Calls {keptCallSummaryCount}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
                    {selectedContact.next_follow_up_at ? (
                      <article className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-amber-900">Follow-up reminder</p>
                            {selectedContact.notes ? (
                              <p className="mt-1 text-sm leading-6 text-amber-800 line-clamp-3">{selectedContact.notes}</p>
                            ) : (
                              <p className="mt-1 text-sm leading-6 text-amber-800">
                                No note yet. Add one to clarify what should happen on this follow-up.
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-1.5">
                            <span className="rounded-full border border-amber-300 bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700">
                              follow-up
                            </span>
                            <button
                              type="button"
                              disabled={isSaving}
                              onClick={() => void turnOffFollowUpReminder()}
                              className="rounded-lg border border-amber-300 bg-white px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Turn off
                            </button>
                          </div>
                        </div>
                        <p className="mt-2 text-xs font-medium text-amber-800">
                          Due: {formatDateOnly(selectedContact.next_follow_up_at)}
                        </p>
                      </article>
                    ) : null}
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
                            {(timelineEvent.event_type === "email_summary" || timelineEvent.event_type === "sms_summary" || timelineEvent.event_type === "whatsapp_summary" || timelineEvent.event_type === "call_summary") ? (
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                {timelineEvent.event_type === "sms_summary" ? (
                                  <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-emerald-700">SMS</span>
                                ) : timelineEvent.event_type === "whatsapp_summary" ? (
                                  <span className="rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-teal-700">WhatsApp</span>
                                ) : timelineEvent.event_type === "call_summary" ? (
                                  <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-violet-700">Call</span>
                                ) : (
                                  <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-blue-700">Email</span>
                                )}
                                <span className="text-[10px] text-[var(--muted)]">AI can make mistakes</span>
                                {typeof timelineEvent.metadata?.triage_confidence === "number" ? (
                                  <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-600">
                                    confidence {((timelineEvent.metadata.triage_confidence as number) * 100).toFixed(0)}%
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
                        No timeline events match your filters.
                      </p>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          )}
        </aside>

        {isDiscardChangesDialogOpen ? (
          <div className="fixed inset-0 z-[60] grid place-items-center bg-slate-950/55 px-4">
            <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface-strong)] p-5 shadow-2xl">
              <p className="text-sm font-semibold text-[var(--foreground)]">Unsaved changes</p>
              <p className="mt-2 text-sm text-[var(--muted)]">
                You have unsaved changes in this contact. Do you want to discard them before closing?
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelDiscardContactDetailsChanges}
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={discardContactDetailsChangesAndClose}
                  className="rounded-xl border border-red-500 bg-red-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-600"
                >
                  Discard
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
