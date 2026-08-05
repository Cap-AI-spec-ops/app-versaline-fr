"use client";

import { useEffect, useMemo, useState } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type WorkspaceContactOption = {
  id: string;
  label: string;
  email: string | null;
  clientType: string;
  contactRoles: string[];
};

type WorkspaceContactPickerProps = {
  workspaceId: string | null | undefined;
  value: string;
  onChange: (nextId: string) => void;
  onPick?: (contact: WorkspaceContactOption | null) => void;
  label?: string;
  helperText?: string;
  emptyOptionLabel?: string;
  roleFilter?: "seller" | "tenant";
};

type ContactRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  client_type: string;
  contact_roles: string[] | null;
  stage: string;
};

function getContactLabel(contact: ContactRow) {
  const fullName = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim();
  return fullName || contact.email || "Unnamed contact";
}

function normalizeRoles(contact: ContactRow) {
  return Array.isArray(contact.contact_roles) && contact.contact_roles.length > 0
    ? contact.contact_roles
    : [contact.client_type];
}

export default function WorkspaceContactPicker({
  workspaceId,
  value,
  onChange,
  onPick,
  label = "Linked contact",
  helperText = "Select a CRM contact in this workspace.",
  emptyOptionLabel = "No linked contact",
  roleFilter,
}: WorkspaceContactPickerProps) {
  const [contacts, setContacts] = useState<WorkspaceContactOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!onPick) {
      return;
    }

    if (!value) {
      onPick(null);
      return;
    }

    const selected = contacts.find((contact) => contact.id === value) ?? null;
    onPick(selected);
  }, [contacts, onPick, value]);

  useEffect(() => {
    async function load(workspaceScope: string) {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        setContacts([]);
        setError("Supabase is not configured.");
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from("crm_contacts")
        .select("id, first_name, last_name, email, client_type, contact_roles, stage")
        .eq("workspace_id", workspaceScope)
        .neq("stage", "archived")
        .neq("stage", "closed_lost")
        .order("updated_at", { ascending: false });

      if (fetchError) {
        setContacts([]);
        setError(fetchError.message);
        setIsLoading(false);
        return;
      }

      const mapped = ((data ?? []) as ContactRow[])
        .filter((contact) => {
          if (!roleFilter) {
            return true;
          }

          const roles = normalizeRoles(contact);
          return roles.includes(roleFilter) || contact.client_type === roleFilter;
        })
        .map((contact) => ({
          id: contact.id,
          label: getContactLabel(contact),
          email: contact.email,
          clientType: contact.client_type,
          contactRoles: normalizeRoles(contact),
        }));

      setContacts(mapped);
      setIsLoading(false);
    }

    if (!workspaceId) {
      setContacts([]);
      setError(null);
      setIsLoading(false);
      return;
    }

    void load(workspaceId);
  }, [roleFilter, workspaceId]);

  const helper = useMemo(() => {
    if (roleFilter === "seller") {
      return helperText || "Select which CRM seller contact owns this property.";
    }

    if (roleFilter === "tenant") {
      return helperText || "Select which CRM tenant contact is linked to this rental property.";
    }

    return helperText;
  }, [helperText, roleFilter]);

  return (
    <div>
      <label className="block text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">{label}</span>
        <select
          value={value}
          onChange={(event) => {
            const nextId = event.target.value;
            onChange(nextId);

            if (!onPick) {
              return;
            }

            const selected = contacts.find((contact) => contact.id === nextId) ?? null;
            onPick(selected);
          }}
          className="settings-field w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          disabled={isLoading}
        >
          <option value="">{isLoading ? "Loading contacts..." : emptyOptionLabel}</option>
          {contacts.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.label}
              {contact.email ? ` - ${contact.email}` : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs text-[var(--muted)]">{helper}</p>
      {error ? <p className="mt-2 text-xs font-medium text-amber-700">Could not load contacts ({error}).</p> : null}
    </div>
  );
}