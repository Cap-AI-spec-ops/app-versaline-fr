"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type InboxMember = {
  profileId: string;
  fullName: string;
  role: "agent" | "team_lead" | "owner" | "super_admin";
};

type InboxMessage = {
  key: string;
  provider: "gmail" | "outlook";
  messageId: string;
  threadId: string | null;
  subject: string;
  from: string;
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  isArchived: boolean;
  assignedToProfileId: string | null;
};

type InboxThreadMessage = {
  provider: "gmail" | "outlook";
  messageId: string;
  threadId: string | null;
  subject: string;
  from: string;
  to: string;
  body: string;
  receivedAt: string;
  isUnread: boolean;
};

type InboxListResponse = {
  ok?: boolean;
  error?: string;
  messages?: InboxMessage[];
  members?: InboxMember[];
};

type InboxThreadResponse = {
  ok?: boolean;
  error?: string;
  thread?: InboxThreadMessage[];
};

async function readJsonSafe<T>(response: Response): Promise<T> {
  const raw = await response.text();

  if (!raw.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Unexpected response format (${response.status}).`);
  }
}

export default function InboxPanel() {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [members, setMembers] = useState<InboxMember[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [thread, setThread] = useState<InboxThreadMessage[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<"priority" | "all" | "unread">("priority");
  const [replyDraft, setReplyDraft] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selectedMessage = useMemo(
    () => messages.find((entry) => entry.key === selectedKey) ?? null,
    [messages, selectedKey],
  );

  const filteredMessages = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return messages.filter((entry) => {
      if (filter === "unread" && !entry.isUnread) {
        return false;
      }

      if (filter === "priority" && entry.isArchived) {
        return false;
      }

      if (!query) {
        return true;
      }

      return [entry.subject, entry.from, entry.snippet].join(" ").toLowerCase().includes(query);
    });
  }, [filter, messages, searchQuery]);

  const selectedThreadAssignedTo = selectedMessage?.assignedToProfileId ?? null;

  useEffect(() => {
    void loadInbox(true);
  }, []);

  useEffect(() => {
    if (!selectedMessage) {
      setThread([]);
      return;
    }

    void loadThread(selectedMessage);
  }, [selectedMessage?.key]);

  async function loadInbox(triggerSync: boolean) {
    setIsLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (triggerSync) {
        await fetch("/api/mailbox/sync", {
          method: "POST",
        });
      }

      const response = await fetch("/api/inbox", {
        cache: "no-store",
      });
      const payload = await readJsonSafe<InboxListResponse>(response);

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "Could not load inbox.");
      }

      const nextMessages = payload.messages ?? [];
      const nextMembers = payload.members ?? [];

      setMessages(nextMessages);
      setMembers(nextMembers);

      if (nextMessages.length === 0) {
        setSelectedKey(null);
      } else if (!selectedKey || !nextMessages.some((entry) => entry.key === selectedKey)) {
        setSelectedKey(nextMessages[0].key);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load inbox.");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadThread(target: InboxMessage) {
    setIsThreadLoading(true);
    setError(null);

    try {
      const search = new URLSearchParams({
        view: "thread",
        provider: target.provider,
        messageId: target.messageId,
      });

      if (target.threadId) {
        search.set("threadId", target.threadId);
      }

      const response = await fetch(`/api/inbox?${search.toString()}`, {
        cache: "no-store",
      });
      const payload = await readJsonSafe<InboxThreadResponse>(response);

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "Could not load thread.");
      }

      setThread(payload.thread ?? []);
    } catch (threadError) {
      setError(threadError instanceof Error ? threadError.message : "Could not load thread.");
      setThread([]);
    } finally {
      setIsThreadLoading(false);
    }
  }

  async function runAction(body: Record<string, unknown>) {
    setIsActionLoading(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/inbox", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const payload = await readJsonSafe<{ ok?: boolean; error?: string }>(response);

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `Action failed (${response.status}).`);
      }

      setMessage("Action completed.");
      await loadInbox(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Action failed.");
    } finally {
      setIsActionLoading(false);
    }
  }

  async function handleReplySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedMessage) {
      return;
    }

    const trimmed = replyDraft.trim();

    if (trimmed.length < 2) {
      setError("Reply must contain at least 2 characters.");
      return;
    }

    await runAction({
      action: "reply",
      provider: selectedMessage.provider,
      messageId: selectedMessage.messageId,
      body: trimmed,
    });

    setReplyDraft("");
    setMessage("Reply sent.");
  }

  function formatDate(value: string) {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return "Unknown date";
    }

    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(parsed);
  }

  return (
    <section className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Unified inbox</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Inbox</h1>
        </div>
        <button
          type="button"
          onClick={() => void loadInbox(true)}
          disabled={isLoading || isActionLoading}
          className="rounded-xl border border-[var(--border)] bg-white/80 px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className="mx-5 mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : null}

      {message ? (
        <div className="mx-5 mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>
      ) : null}

      <div className="grid min-h-[70vh] grid-cols-1 md:grid-cols-[22rem_minmax(0,1fr)]">
        <aside className="border-r border-[var(--border)] px-4 py-4">
          <div className="space-y-3">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search subject, sender, snippet"
              className="w-full rounded-xl border border-[var(--border)] bg-white/80 px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
            />

            <div className="flex flex-wrap gap-2">
              {[
                { id: "priority", label: "Priority" },
                { id: "all", label: "All" },
                { id: "unread", label: "Unread" },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFilter(item.id as "priority" | "all" | "unread")}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] transition ${
                    filter === item.id
                      ? "bg-sky-600 text-white"
                      : "border border-[var(--border)] bg-white/80 text-[var(--muted)] hover:bg-white"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {isLoading ? (
              <p className="rounded-xl border border-[var(--border)] bg-white/70 px-3 py-3 text-sm text-[var(--muted)]">
                Loading emails...
              </p>
            ) : null}

            {!isLoading && filteredMessages.length === 0 ? (
              <p className="rounded-xl border border-[var(--border)] bg-white/70 px-3 py-3 text-sm text-[var(--muted)]">
                No emails match this filter yet.
              </p>
            ) : null}

            {filteredMessages.map((entry) => {
              const isSelected = selectedKey === entry.key;
              const assigned = members.find((member) => member.profileId === entry.assignedToProfileId);

              return (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => setSelectedKey(entry.key)}
                  className={`w-full rounded-2xl border px-3 py-3 text-left transition ${
                    isSelected
                      ? "border-sky-300 bg-sky-50"
                      : "border-[var(--border)] bg-white/80 hover:bg-white"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm font-semibold ${entry.isUnread ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                      {entry.subject}
                    </span>
                    <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[var(--muted)]">
                      {entry.provider}
                    </span>
                  </div>

                  <p className="mt-1 truncate text-xs text-[var(--muted)]">{entry.from}</p>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--muted)]">{entry.snippet || "No preview"}</p>

                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-[var(--muted)]">{formatDate(entry.receivedAt)}</span>
                    {assigned ? (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-amber-700">
                        {assigned.fullName}
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <article className="px-5 py-4">
          {!selectedMessage ? (
            <div className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-5 text-sm text-[var(--muted)]">
              Select an email to view the thread.
            </div>
          ) : (
            <div className="space-y-4">
              <header className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-4">
                <h2 className="text-xl font-semibold text-[var(--foreground)]">{selectedMessage.subject}</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">From: {selectedMessage.from}</p>
                <p className="text-sm text-[var(--muted)]">Received: {formatDate(selectedMessage.receivedAt)}</p>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={isActionLoading}
                    onClick={() =>
                      void runAction({
                        action: selectedMessage.isUnread ? "mark_read" : "mark_unread",
                        provider: selectedMessage.provider,
                        messageId: selectedMessage.messageId,
                      })
                    }
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {selectedMessage.isUnread ? "Mark read" : "Mark unread"}
                  </button>

                  <button
                    type="button"
                    disabled={isActionLoading}
                    onClick={() =>
                      void runAction({
                        action: "archive",
                        provider: selectedMessage.provider,
                        messageId: selectedMessage.messageId,
                      })
                    }
                    className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Archive
                  </button>

                  <label className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted)]">
                    Assign
                    <select
                      value={selectedThreadAssignedTo ?? ""}
                      onChange={(event) =>
                        void runAction({
                          action: "assign",
                          provider: selectedMessage.provider,
                          messageId: selectedMessage.messageId,
                          threadId: selectedMessage.threadId,
                          assignedToProfileId: event.target.value || null,
                        })
                      }
                      disabled={isActionLoading}
                      className="rounded-lg border border-[var(--border)] bg-white px-2 py-1.5 text-xs font-medium text-[var(--foreground)] outline-none"
                    >
                      <option value="">Unassigned</option>
                      {members.map((member) => (
                        <option key={member.profileId} value={member.profileId}>
                          {member.fullName} ({member.role})
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </header>

              <section className="space-y-3">
                {isThreadLoading ? (
                  <p className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-3 text-sm text-[var(--muted)]">
                    Loading thread...
                  </p>
                ) : null}

                {!isThreadLoading && thread.length === 0 ? (
                  <p className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-3 text-sm text-[var(--muted)]">
                    No messages found for this thread.
                  </p>
                ) : null}

                {thread.map((item) => (
                  <article key={`${item.provider}:${item.messageId}`} className="rounded-2xl border border-[var(--border)] bg-white px-4 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-[var(--foreground)]">{item.from}</p>
                      <p className="text-xs text-[var(--muted)]">{formatDate(item.receivedAt)}</p>
                    </div>
                    {item.to ? <p className="mt-1 text-xs text-[var(--muted)]">To: {item.to}</p> : null}
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-[var(--foreground)]">{item.body || "(No content)"}</p>
                  </article>
                ))}
              </section>

              <form onSubmit={handleReplySubmit} className="rounded-2xl border border-[var(--border)] bg-white/80 px-4 py-4">
                <label htmlFor="reply-message" className="text-sm font-semibold text-[var(--foreground)]">
                  Reply
                </label>
                <textarea
                  id="reply-message"
                  value={replyDraft}
                  onChange={(event) => setReplyDraft(event.target.value)}
                  rows={5}
                  placeholder="Write your reply here..."
                  className="mt-2 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                />
                <div className="mt-3 flex justify-end">
                  <button
                    type="submit"
                    disabled={isActionLoading || replyDraft.trim().length < 2}
                    className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isActionLoading ? "Sending..." : "Send reply"}
                  </button>
                </div>
              </form>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}