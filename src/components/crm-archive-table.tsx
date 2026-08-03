"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { withSessionReloadFallback } from "@/lib/auth/session-error-message";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

type ContactPriority = "low" | "normal" | "high";

type ArchivedContact = {
  id: string;
  workspace_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  client_type: string;
  budget: number | null;
  currency: string;
  priority: ContactPriority;
  updated_at: string;
};

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

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
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

function fullName(contact: ArchivedContact) {
  return `${contact.first_name} ${contact.last_name}`.trim() || "Unnamed contact";
}

export default function CrmArchiveTable() {
  const { workspace, isLoading: isWorkspaceLoading, error: workspaceError } = useCurrentWorkspace();
  const [rows, setRows] = useState<ArchivedContact[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isRestoringId, setIsRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace?.id) {
      return;
    }

    void loadArchive(workspace.id);
  }, [workspace?.id]);

  async function loadArchive(workspaceId: string) {
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
      .select("id, workspace_id, first_name, last_name, email, phone, client_type, budget, currency, priority, updated_at, stage")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false });

    if (fetchError) {
      setRows([]);
      setError(withSessionReloadFallback(fetchError.message, "Could not load archived contacts."));
      setIsLoading(false);
      return;
    }

    const contacts = (data ?? []) as Array<ArchivedContact & { stage: string }>;
    setRows(contacts.filter((item) => item.stage === "archived" || item.stage === "closed_lost"));
    setIsLoading(false);
  }

  async function restoreContact(contactId: string) {
    if (!workspace?.id) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setIsRestoringId(contactId);
    setError(null);
    setMessage(null);

    const { error: restoreError } = await supabase
      .from("crm_contacts")
      .update({ stage: "new_lead" })
      .eq("id", contactId)
      .eq("workspace_id", workspace.id);

    if (restoreError) {
      setError(withSessionReloadFallback(restoreError.message, "Could not restore contact."));
      setIsRestoringId(null);
      return;
    }

    setRows((previous) => previous.filter((item) => item.id !== contactId));
    setMessage("Contact restored to New Lead.");
    setIsRestoringId(null);
  }

  if (workspaceError) {
    return <p className="text-sm text-red-600">{workspaceError}</p>;
  }

  if (isWorkspaceLoading || isLoading) {
    return <p className="text-sm text-[var(--muted)]">Loading archive...</p>;
  }

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredRows = rows.filter((contact) => {
    if (!normalizedQuery) {
      return true;
    }

    const haystacks = [
      fullName(contact),
      contact.email ?? "",
      contact.phone ?? "",
      contact.client_type,
      contact.priority,
      formatMoney(contact.budget, contact.currency),
    ];

    return haystacks.some((value) => value.toLowerCase().includes(normalizedQuery));
  });

  return (
    <section className="crm-surface flex min-h-full flex-col gap-4">
      <div className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">CRM Archive</p>
            <h2 className="mt-1 text-xl font-semibold text-[var(--foreground)]">
              Archived contacts for {workspace?.name ?? "current workspace"}
            </h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              This table is workspace-scoped and only displays contacts archived in the current workspace.
            </p>
          </div>
          <Link
            href="/contacts"
            className="inline-flex items-center rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
          >
            Back to CRM board
          </Link>
        </div>
      </div>

      {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
      {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}

      <div className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] p-4">
        <label className="flex flex-col gap-2 text-sm text-[var(--muted)]">
          <span className="text-xs font-semibold uppercase tracking-[0.14em]">Search archive</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search by name, email, phone, or type"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
            aria-label="Search archived contacts"
          />
        </label>
      </div>

      <div className="overflow-x-auto rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)]">
        <table className="min-w-full divide-y divide-[var(--border)] text-sm">
          <thead className="bg-slate-50">
            <tr className="text-left text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Budget</th>
              <th className="px-4 py-3">Updated</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
            {filteredRows.map((contact) => (
              <tr key={contact.id}>
                <td className="px-4 py-3">
                  <p className="font-semibold text-[var(--foreground)]">{fullName(contact)}</p>
                  <p className="text-xs text-[var(--muted)]">{contact.email ?? contact.phone ?? "No email or phone"}</p>
                </td>
                <td className="px-4 py-3 text-[var(--foreground)]">{contact.client_type}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${getPriorityBadgeClasses(contact.priority)}`}
                  >
                    {contact.priority}
                  </span>
                </td>
                <td className="px-4 py-3 text-[var(--foreground)]">{formatMoney(contact.budget, contact.currency)}</td>
                <td className="px-4 py-3 text-[var(--foreground)]">{formatDate(contact.updated_at)}</td>
                <td className="px-4 py-3">
                  <button
                    type="button"
                    disabled={isRestoringId === contact.id}
                    onClick={() => void restoreContact(contact.id)}
                    className="rounded-lg border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:opacity-60"
                  >
                    Restore
                  </button>
                </td>
              </tr>
            ))}
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-[var(--muted)]">
                  {rows.length === 0 ? "No archived contacts in this workspace." : "No archived contacts match your search."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
