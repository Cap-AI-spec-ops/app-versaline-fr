"use client";

import Link from "next/link";
import { ChangeEvent, ClipboardEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/client";

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
  cc: string;
  body: string;
  bodyHtml: string | null;
  receivedAt: string;
  isUnread: boolean;
};

type InboxListResponse = {
  ok?: boolean;
  error?: string;
  messages?: InboxMessage[];
  members?: InboxMember[];
  warnings?: string[];
  diagnostics?: {
    workspaceId: string;
    profileId: string;
    authUserId: string;
    connectionDiagnostics: Array<{
      provider: "gmail" | "outlook";
      status: "connected" | "disconnected" | "pending" | "error";
      lastSyncedAt: string | null;
      hasAccessToken: boolean;
      hasRefreshToken: boolean;
      lastError: string | null;
      accountEmail: string | null;
      fetchedCount: number;
    }>;
  };
};

type CrmContactSuggestion = {
  email: string;
  label: string;
};

type SenderCrmContact = {
  id: string;
  fullName: string;
  email: string | null;
};

type InboxThreadResponse = {
  ok?: boolean;
  error?: string;
  thread?: InboxThreadMessage[];
};

function publishInboxUnreadCount(unreadCount: number) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("inbox-unread-updated", {
      detail: { unreadCount },
    }),
  );
}

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
  const [filter, setFilter] = useState<"priority" | "all" | "unread">("all");
  const [mailbox, setMailbox] = useState<"inbox" | "archive" | "drafts" | "deleted">("inbox");
  const [replyDraft, setReplyDraft] = useState("");
  const [replyDraftHtml, setReplyDraftHtml] = useState("");
  const [isReplyOpen, setIsReplyOpen] = useState(false);
  const [replyMode, setReplyMode] = useState<"reply" | "reply_all">("reply");
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeCc, setComposeCc] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeBodyHtml, setComposeBodyHtml] = useState("");
  const [composeFont, setComposeFont] = useState("Arial");
  const [composeFontSize, setComposeFontSize] = useState("3");
  const [composeColor, setComposeColor] = useState("#1f2937");
  const [replyFont, setReplyFont] = useState("Arial");
  const [replyFontSize, setReplyFontSize] = useState("3");
  const [replyColor, setReplyColor] = useState("#1f2937");
  const [applySignature, setApplySignature] = useState(true);
  const [savedSignatureHtml, setSavedSignatureHtml] = useState("");
  const [crmRecipientSuggestions, setCrmRecipientSuggestions] = useState<CrmContactSuggestion[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<InboxListResponse["diagnostics"] | null>(null);
  const [senderEmail, setSenderEmail] = useState<string | null>(null);
  const [senderCrmContact, setSenderCrmContact] = useState<SenderCrmContact | null>(null);
  const [isSenderCrmLoading, setIsSenderCrmLoading] = useState(false);
  const composeEditorRef = useRef<HTMLDivElement | null>(null);
  const replyEditorRef = useRef<HTMLDivElement | null>(null);
  const composeImageInputRef = useRef<HTMLInputElement | null>(null);
  const replyImageInputRef = useRef<HTMLInputElement | null>(null);
  const autoReadTimeoutRef = useRef<number | null>(null);

  const selectedMessage = useMemo(
    () => messages.find((entry) => entry.key === selectedKey) ?? null,
    [messages, selectedKey],
  );

  const filteredMessages = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return messages.filter((entry) => {
      if (entry.key === selectedKey) {
        return true;
      }

      const receivedAtMs = new Date(entry.receivedAt).getTime();
      const isRecent = !Number.isNaN(receivedAtMs) && Date.now() - receivedAtMs <= 1000 * 60 * 60 * 72;

      if (filter === "unread" && !entry.isUnread) {
        return false;
      }

      if (filter === "priority" && (entry.isArchived || !isRecent)) {
        return false;
      }

      if (!query) {
        return true;
      }

      return [entry.subject, entry.from, entry.snippet].join(" ").toLowerCase().includes(query);
    });
  }, [filter, messages, searchQuery, selectedKey]);

  const unreadCount = useMemo(() => messages.filter((entry) => entry.isUnread).length, [messages]);
  const hasThreadCc = useMemo(() => thread.some((item) => item.cc.trim().length > 0), [thread]);
  const connectedProviders = useMemo(() => {
    return (diagnostics?.connectionDiagnostics ?? [])
      .filter((row) => row.status === "connected")
      .map((row) => row.provider);
  }, [diagnostics]);
  const activeComposeProvider = connectedProviders[0] ?? "gmail";
  const senderPrefill = useMemo(() => {
    if (!senderEmail) {
      return null;
    }

    return parseSenderName(selectedMessage?.from ?? "", senderEmail);
  }, [selectedMessage?.from, senderEmail]);
  const priorityCount = useMemo(() => {
    return messages.filter((entry) => {
      const receivedAtMs = new Date(entry.receivedAt).getTime();
      const isRecent = !Number.isNaN(receivedAtMs) && Date.now() - receivedAtMs <= 1000 * 60 * 60 * 72;
      return !entry.isArchived && isRecent;
    }).length;
  }, [messages]);

  useEffect(() => {
    void loadInbox(false);
    void fetch("/api/mailbox/sync", {
      method: "POST",
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    async function loadCrmSuggestions(workspaceId: string) {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        setCrmRecipientSuggestions([]);
        return;
      }

      const { data, error: fetchError } = await supabase
        .from("crm_contacts")
        .select("first_name, last_name, email, stage")
        .eq("workspace_id", workspaceId)
        .not("email", "is", null)
        .neq("stage", "archived")
        .neq("stage", "closed_lost")
        .order("updated_at", { ascending: false })
        .limit(200);

      if (fetchError) {
        setCrmRecipientSuggestions([]);
        return;
      }

      const seen = new Set<string>();
      const suggestions: CrmContactSuggestion[] = [];

      for (const row of (data ?? []) as Array<{ first_name?: string | null; last_name?: string | null; email?: string | null }>) {
        const email = row.email?.trim();

        if (!email) {
          continue;
        }

        const normalized = email.toLowerCase();

        if (seen.has(normalized)) {
          continue;
        }

        seen.add(normalized);
        const fullName = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();

        suggestions.push({
          email,
          label: fullName || email,
        });
      }

      setCrmRecipientSuggestions(suggestions);
    }

    const workspaceId = diagnostics?.workspaceId?.trim() ?? "";

    if (!workspaceId) {
      setCrmRecipientSuggestions([]);
      return;
    }

    void loadCrmSuggestions(workspaceId);
  }, [diagnostics?.workspaceId]);

  useEffect(() => {
    async function loadSignaturePreference() {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        return;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        return;
      }

      const { data: profileRow } = await supabase
        .from("profiles")
        .select("signature_html")
        .eq("id", user.id)
        .maybeSingle<{ signature_html: string | null }>();
      setSavedSignatureHtml(profileRow?.signature_html?.trim() ?? "");
    }

    void loadSignaturePreference();
  }, []);

  useEffect(() => {
    if (!selectedMessage) {
      setThread([]);
      setIsReplyOpen(false);
      setReplyDraft("");
      setReplyDraftHtml("");
      return;
    }

    setIsReplyOpen(false);
    setReplyDraft("");
    setReplyDraftHtml("");
    void loadThread(selectedMessage);
  }, [selectedMessage?.key]);

  useEffect(() => {
    if (autoReadTimeoutRef.current !== null) {
      window.clearTimeout(autoReadTimeoutRef.current);
      autoReadTimeoutRef.current = null;
    }

    if (!selectedMessage || !selectedMessage.isUnread || isActionLoading) {
      return;
    }

    autoReadTimeoutRef.current = window.setTimeout(() => {
      void runAction({
        action: "mark_read",
        provider: selectedMessage.provider,
        messageId: selectedMessage.messageId,
      });
    }, 2000);

    return () => {
      if (autoReadTimeoutRef.current !== null) {
        window.clearTimeout(autoReadTimeoutRef.current);
        autoReadTimeoutRef.current = null;
      }
    };
  }, [isActionLoading, selectedMessage]);

  useEffect(() => {
    const workspaceId = diagnostics?.workspaceId?.trim() ?? "";
    const nextSenderEmail = extractEmailAddressFromHeader(selectedMessage?.from ?? "");
    setSenderEmail(nextSenderEmail);

    if (!workspaceId || !nextSenderEmail) {
      setSenderCrmContact(null);
      setIsSenderCrmLoading(false);
      return;
    }

    const senderEmailForLookup = nextSenderEmail;

    let isCancelled = false;

    async function loadSenderCrmContact() {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        if (!isCancelled) {
          setSenderCrmContact(null);
          setIsSenderCrmLoading(false);
        }
        return;
      }

      setIsSenderCrmLoading(true);

      try {
        let contactId: string | null = null;

        const lookupResult = await supabase.rpc("find_contact_by_email", {
          p_workspace_id: workspaceId,
          p_email: senderEmailForLookup,
        });

        if (!lookupResult.error) {
          const matchedRows = (lookupResult.data ?? []) as Array<{ id?: string | null }>;
          contactId = matchedRows[0]?.id?.trim() ?? null;
        }

        if (!contactId) {
          const { data: fallbackRow } = await supabase
            .from("crm_contacts")
            .select("id")
            .eq("workspace_id", workspaceId)
            .ilike("email", senderEmailForLookup)
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle<{ id: string }>();

          contactId = fallbackRow?.id?.trim() ?? null;
        }

        if (!contactId) {
          if (!isCancelled) {
            setSenderCrmContact(null);
          }
          return;
        }

        const { data: contactRow } = await supabase
          .from("crm_contacts")
          .select("id, first_name, last_name, email")
          .eq("workspace_id", workspaceId)
          .eq("id", contactId)
          .maybeSingle<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>();

        if (!isCancelled) {
          if (!contactRow) {
            setSenderCrmContact(null);
            return;
          }

          const fullName = `${contactRow.first_name ?? ""} ${contactRow.last_name ?? ""}`.trim() || "Unnamed contact";

          setSenderCrmContact({
            id: contactRow.id,
            fullName,
            email: contactRow.email,
          });
        }
      } finally {
        if (!isCancelled) {
          setIsSenderCrmLoading(false);
        }
      }
    }

    void loadSenderCrmContact();

    return () => {
      isCancelled = true;
    };
  }, [diagnostics?.workspaceId, selectedMessage?.key]);

  useEffect(() => {
    if (!composeEditorRef.current) {
      return;
    }

    if (composeEditorRef.current.innerHTML !== composeBodyHtml) {
      composeEditorRef.current.innerHTML = composeBodyHtml;
    }
  }, [composeBodyHtml]);

  useEffect(() => {
    if (!replyEditorRef.current) {
      return;
    }

    if (replyEditorRef.current.innerHTML !== replyDraftHtml) {
      replyEditorRef.current.innerHTML = replyDraftHtml;
    }
  }, [replyDraftHtml]);

  function updateComposeFromEditor() {
    const editor = composeEditorRef.current;
    if (!editor) {
      return;
    }

    const html = editor.innerHTML;
    setComposeBodyHtml(html);
    setComposeBody(htmlToPlainText(html));
  }

  function updateReplyFromEditor() {
    const editor = replyEditorRef.current;
    if (!editor) {
      return;
    }

    const html = editor.innerHTML;
    setReplyDraftHtml(html);
    setReplyDraft(htmlToPlainText(html));
  }

  function applyEditorCommand(editor: HTMLDivElement | null, command: string, value?: string) {
    if (typeof document === "undefined" || !editor) {
      return;
    }

    editor.focus();
    document.execCommand(command, false, value);
  }

  function applyComposeCommand(command: string, value?: string) {
    applyEditorCommand(composeEditorRef.current, command, value);
    updateComposeFromEditor();
  }

  function applyReplyCommand(command: string, value?: string) {
    applyEditorCommand(replyEditorRef.current, command, value);
    updateReplyFromEditor();
  }

  function readImageAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }

        reject(new Error("Invalid image data."));
      };
      reader.onerror = () => reject(new Error("Could not read image."));
      reader.readAsDataURL(file);
    });
  }

  async function insertImageIntoCompose(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Please select an image file.");
      return;
    }

    try {
      const imageDataUrl = await readImageAsDataUrl(file);
      applyComposeCommand(
        "insertHTML",
        `<img src="${imageDataUrl}" alt="Email image" style="max-width: 280px; height: auto; border-radius: 8px; display: inline-block;" />`,
      );
      setError(null);
    } catch {
      setError("Could not insert image.");
    }
  }

  async function insertImageIntoReply(file: File) {
    if (!file.type.startsWith("image/")) {
      setError("Please select an image file.");
      return;
    }

    try {
      const imageDataUrl = await readImageAsDataUrl(file);
      applyReplyCommand(
        "insertHTML",
        `<img src="${imageDataUrl}" alt="Reply image" style="max-width: 280px; height: auto; border-radius: 8px; display: inline-block;" />`,
      );
      setError(null);
    } catch {
      setError("Could not insert image.");
    }
  }

  function handleComposeImageUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      return;
    }

    void insertImageIntoCompose(file);
    event.target.value = "";
  }

  function handleReplyImageUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      return;
    }

    void insertImageIntoReply(file);
    event.target.value = "";
  }

  function handleComposePaste(event: ClipboardEvent<HTMLDivElement>) {
    const imageItem = Array.from(event.clipboardData.items).find(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );

    const file = imageItem?.getAsFile() ?? null;

    if (!file) {
      return;
    }

    event.preventDefault();
    void insertImageIntoCompose(file);
  }

  function handleReplyPaste(event: ClipboardEvent<HTMLDivElement>) {
    const imageItem = Array.from(event.clipboardData.items).find(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );

    const file = imageItem?.getAsFile() ?? null;

    if (!file) {
      return;
    }

    event.preventDefault();
    void insertImageIntoReply(file);
  }

  async function loadInbox(triggerSync: boolean, mailboxOverride?: "inbox" | "archive" | "drafts" | "deleted") {
    setIsLoading(true);
    setError(null);
    setMessage(null);

    try {
      const targetMailbox = mailboxOverride ?? mailbox;

      if (triggerSync) {
        await fetch("/api/mailbox/sync", {
          method: "POST",
        });
      }

      const response = await fetch(`/api/inbox?mailbox=${targetMailbox}`, {
        cache: "no-store",
      });
      const payload = await readJsonSafe<InboxListResponse>(response);

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "Could not load inbox.");
      }

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? "Could not load inbox.");
      }

      const nextMessages = payload.messages ?? [];
      const nextMembers = payload.members ?? [];
      const nextWarnings = payload.warnings ?? [];
      const nextDiagnostics = payload.diagnostics ?? null;

      setMessages(nextMessages);
      setMembers(nextMembers);
      setDiagnostics(nextDiagnostics);

      if (targetMailbox === "inbox") {
        publishInboxUnreadCount(nextMessages.filter((entry) => entry.isUnread).length);
      }

      if (nextWarnings.length > 0) {
        setMessage(nextWarnings.join(" "));
      }

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
    const trimmedHtml = composeHtmlForEmail(replyDraftHtml);
    const styledReplyHtml = trimmedHtml
      ? buildStyledHtml(trimmedHtml, replyColor)
      : null;

    if (trimmed.length < 2) {
      setError("Reply must contain at least 2 characters.");
      return;
    }

    await runAction({
      action: replyMode,
      provider: selectedMessage.provider,
      messageId: selectedMessage.messageId,
      body: trimmed,
      bodyHtml: styledReplyHtml || undefined,
    });

    setReplyDraft("");
    setReplyDraftHtml("");
    setIsReplyOpen(false);
    setMessage("Reply sent.");
  }

  async function handleComposeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (connectedProviders.length === 0) {
      setError("No connected mailbox available for sending new messages.");
      return;
    }

    const trimmedTo = composeTo.trim();
    const trimmedSubject = composeSubject.trim();
    const trimmedBody = composeBody.trim();
    const composeBodyForEmail = composeHtmlForEmail(composeBodyHtml);

    if (!trimmedTo) {
      setError("Please add at least one recipient in To.");
      return;
    }

    if (!trimmedSubject) {
      setError("Please add a subject.");
      return;
    }

    if (trimmedBody.length < 2) {
      setError("Message body must contain at least 2 characters.");
      return;
    }

    const shouldApplySignature = applySignature && savedSignatureHtml.length > 0;
    const signaturePlainText = savedSignatureHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const finalBody = shouldApplySignature ? `${trimmedBody}\n\n${signaturePlainText}` : trimmedBody;
    const baseBodyHtml = buildStyledHtml(composeBodyForEmail || plainTextToHtml(trimmedBody), composeColor);
    const finalBodyHtml = shouldApplySignature ? `${baseBodyHtml}<br><br>${savedSignatureHtml}` : baseBodyHtml;

    await runAction({
      action: "send_new",
      provider: activeComposeProvider,
      to: trimmedTo,
      cc: composeCc.trim(),
      subject: trimmedSubject,
      body: finalBody,
      bodyHtml: finalBodyHtml,
    });

    setComposeTo("");
    setComposeCc("");
    setComposeSubject("");
    setComposeBody("");
    setComposeBodyHtml("");
    setApplySignature(true);
    setIsComposerOpen(false);
    setMessage("Message sent.");
  }

  function formatDate(value: string) {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return "Unknown date";
    }

    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Paris",
    }).format(parsed);
  }

  function renderThreadBody(item: InboxThreadMessage) {
    if (item.bodyHtml) {
      return (
        <iframe
          title={`Email body from ${item.from}`}
          sandbox=""
          srcDoc={item.bodyHtml}
          className="mt-3 h-[34rem] w-full rounded-xl border border-[var(--border)] bg-white"
        />
      );
    }

    return (
      <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-[var(--foreground)]">
        {item.body || "(No content)"}
      </p>
    );
  }

  return (
    <section className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Unified inbox</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Inbox</h1>
          <button
            type="button"
            onClick={() => {
              setIsComposerOpen(true);
              setError(null);
              setMessage(null);
            }}
            className="mt-3 inline-flex items-center rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-700"
          >
            New message
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/settings/mailbox"
            className="rounded-xl border border-[var(--border)] bg-white/80 px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-white"
          >
            Settings
          </Link>
          <button
            type="button"
            onClick={() => void loadInbox(true)}
            disabled={isLoading || isActionLoading}
            className="rounded-xl border border-[var(--border)] bg-white/80 px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="mx-5 mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : null}

      {message ? (
        <div className="mx-5 mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>
      ) : null}

      {messages.length === 0 && diagnostics ? (
        <div className="mx-5 mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <p className="font-semibold uppercase tracking-[0.08em]">Inbox diagnostics</p>
          <p className="mt-1">
            Workspace: {diagnostics.workspaceId} | Profile: {diagnostics.profileId} | Auth user: {diagnostics.authUserId}
          </p>
          <div className="mt-2 space-y-1">
            {diagnostics.connectionDiagnostics.length === 0 ? (
              <p>No Gmail/Outlook mailbox connection row found for this user in this workspace.</p>
            ) : (
              diagnostics.connectionDiagnostics.map((row) => (
                <p key={row.provider}>
                  {row.provider}: account={row.accountEmail ?? "unknown"}, status={row.status}, fetched={row.fetchedCount}, accessToken={row.hasAccessToken ? "yes" : "no"}, refreshToken={row.hasRefreshToken ? "yes" : "no"}, lastSync={row.lastSyncedAt ?? "never"}
                  {row.lastError ? `, lastError=${row.lastError}` : ""}
                </p>
              ))
            )}
          </div>
        </div>
      ) : null}

      <div className="grid min-h-[70vh] grid-cols-1 md:h-[calc(100vh-14rem)] md:grid-cols-[22rem_minmax(0,1fr)] md:overflow-hidden">
        <aside className="border-r border-[var(--border)] px-4 py-4 md:overflow-y-auto">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {[
                { id: "inbox", label: "Inbox" },
                { id: "archive", label: "Archive" },
                { id: "drafts", label: "Drafts" },
                { id: "deleted", label: "Deleted" },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    const nextMailbox = item.id as "inbox" | "archive" | "drafts" | "deleted";
                    setMailbox(nextMailbox);
                    setFilter("all");
                    void loadInbox(false, nextMailbox);
                  }}
                  className={`rounded-xl border px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.1em] transition ${
                    mailbox === item.id
                      ? "border-sky-300 bg-sky-50 text-[var(--foreground)]"
                      : "border-[var(--border)] bg-white/80 text-[var(--muted)] hover:bg-white"
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <span>{item.label}</span>
                    {item.id === "inbox" && unreadCount > 0 ? (
                      <span
                        className="h-2 w-2 rounded-full bg-sky-500"
                        aria-label={`${unreadCount} unread messages`}
                      />
                    ) : null}
                  </span>
                </button>
              ))}
            </div>

            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search subject, sender, snippet"
              className="w-full rounded-xl border border-[var(--border)] bg-white/80 px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
            />

            <div className="flex flex-wrap gap-2">
              {[
                { id: "priority", label: `Recent (${priorityCount})` },
                { id: "all", label: `All (${messages.length})` },
                { id: "unread", label: `Unread (${unreadCount})` },
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

            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">
              Showing messages from the last 30 days.
            </p>
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
                    <div className="flex min-w-0 items-center gap-2">
                      {entry.isUnread ? <span className="h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-hidden="true" /> : null}
                      <span className={`truncate text-sm font-semibold ${entry.isUnread ? "text-[var(--foreground)]" : "text-[var(--muted)]"}`}>
                        {entry.subject}
                      </span>
                    </div>
                  </div>

                  <p className="mt-1 truncate text-xs text-[var(--muted)]">{entry.from}</p>
                  <p className="mt-1 line-clamp-1 text-xs leading-5 text-[var(--muted)]">{entry.snippet || "No preview"}</p>

                  <div className="mt-1.5 flex items-center justify-between gap-2">
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

        <article className="px-5 py-4 md:overflow-y-auto">
          {!selectedMessage ? (
            <div className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-5 text-sm text-[var(--muted)]">
              Select an email to view the thread.
            </div>
          ) : (
            <div className="space-y-4">
              <header className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-xl font-semibold text-[var(--foreground)]">{selectedMessage.subject}</h2>
                  <div className="flex flex-wrap items-end justify-end gap-2">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        disabled={isActionLoading}
                        onClick={() => {
                          setReplyMode("reply");
                          setIsReplyOpen((value) => (replyMode === "reply" ? !value : true));
                        }}
                        className="rounded-xl bg-sky-600 px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isReplyOpen && replyMode === "reply" ? "Close reply" : "Reply"}
                      </button>

                      {hasThreadCc ? (
                        <button
                          type="button"
                          disabled={isActionLoading}
                          onClick={() => {
                            setReplyMode("reply_all");
                            setIsReplyOpen((value) => (replyMode === "reply_all" ? !value : true));
                          }}
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--foreground)] transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isReplyOpen && replyMode === "reply_all" ? "Close reply all" : "Reply all"}
                        </button>
                      ) : null}
                    </div>

                    {senderEmail ? (
                      <div className="w-full text-right">
                        {senderCrmContact ? (
                          <Link
                            href={`/contacts?contactId=${encodeURIComponent(senderCrmContact.id)}`}
                            className="inline-flex rounded-lg border border-[var(--border)] bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--foreground)] transition hover:bg-slate-50"
                          >
                            Show contact
                          </Link>
                        ) : isSenderCrmLoading ? (
                          <span className="inline-flex rounded-lg border border-[var(--border)] bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                            Checking...
                          </span>
                        ) : (
                          <Link
                            href={`/contacts?createContact=1&email=${encodeURIComponent(senderEmail)}&firstName=${encodeURIComponent(senderPrefill?.firstName ?? "")}&lastName=${encodeURIComponent(senderPrefill?.lastName ?? "")}&source=inbox`}
                            className="inline-flex rounded-lg bg-sky-600 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-white transition hover:bg-sky-700"
                          >
                            Create contact
                          </Link>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
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

                </div>

                {isReplyOpen ? (
                  <form onSubmit={handleReplySubmit} className="mt-4 rounded-2xl border border-[var(--border)] bg-white/80 px-4 py-4">
                    <label htmlFor="reply-message" className="text-sm font-semibold text-[var(--foreground)]">
                      {replyMode === "reply_all" ? "Reply all" : "Reply"}
                    </label>
                    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2">
                      <select
                        value={replyFont}
                        onChange={(event) => {
                          const nextFont = event.target.value;
                          setReplyFont(nextFont);
                          applyReplyCommand("fontName", nextFont);
                        }}
                        className="rounded-lg border border-[var(--border)] bg-white px-2 py-1 text-xs text-[var(--foreground)] outline-none focus:border-sky-400"
                      >
                        <option value="Arial">Arial</option>
                        <option value="Georgia">Georgia</option>
                        <option value="Tahoma">Tahoma</option>
                        <option value="Times New Roman">Times New Roman</option>
                        <option value="Verdana">Verdana</option>
                      </select>
                      <select
                        value={replyFontSize}
                        onChange={(event) => {
                          const nextSize = event.target.value;
                          setReplyFontSize(nextSize);
                          applyReplyCommand("fontSize", nextSize);
                        }}
                        className="rounded-lg border border-[var(--border)] bg-white px-2 py-1 text-xs text-[var(--foreground)] outline-none focus:border-sky-400"
                      >
                        <option value="1">8</option>
                        <option value="2">10</option>
                        <option value="3">12</option>
                        <option value="4">14</option>
                        <option value="5">18</option>
                        <option value="6">24</option>
                      </select>
                      <label className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--foreground)]">
                        Color
                        <input
                          type="color"
                          value={replyColor}
                          onChange={(event) => {
                            const nextColor = event.target.value;
                            setReplyColor(nextColor);
                            replyEditorRef.current?.focus();
                          }}
                          className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => applyReplyCommand("bold")}
                        className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                      >
                        Bold
                      </button>
                      <button
                        type="button"
                        onClick={() => applyReplyCommand("italic")}
                        className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                      >
                        Italic
                      </button>
                      <button
                        type="button"
                        onClick={() => applyReplyCommand("underline")}
                        className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                      >
                        Underline
                      </button>
                      <button
                        type="button"
                        onClick={() => replyImageInputRef.current?.click()}
                        className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                      >
                        Add image
                      </button>
                      <input
                        ref={replyImageInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleReplyImageUpload}
                        className="hidden"
                      />
                    </div>
                    <div
                      id="reply-message"
                      ref={replyEditorRef}
                      contentEditable
                      suppressContentEditableWarning
                      onInput={updateReplyFromEditor}
                      onPaste={handleReplyPaste}
                      className="mt-2 min-h-[140px] w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                      style={{
                        whiteSpace: "pre-wrap",
                        color: replyColor,
                      }}
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
                ) : null}
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
                    {item.cc ? <p className="mt-1 text-xs text-[var(--muted)]">Cc: {item.cc}</p> : null}
                    {renderThreadBody(item)}
                  </article>
                ))}
              </section>

            </div>
          )}
        </article>
      </div>

      {isComposerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4" role="dialog" aria-modal="true" aria-label="New message composer">
          <div className="w-full max-w-3xl rounded-3xl border border-[var(--border)] bg-[var(--surface-strong)] p-5 shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">New message</h2>
              <button
                type="button"
                onClick={() => setIsComposerOpen(false)}
                className="rounded-lg border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--foreground)] transition hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleComposeSubmit} className="mt-4">
              <label className="block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                To
                <input
                  value={composeTo}
                  onChange={(event) => setComposeTo(event.target.value)}
                  list="crm-recipient-suggestions"
                  placeholder="Type email(s), separated by commas"
                  className="mt-1 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                />
              </label>

              <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                Cc
                <input
                  value={composeCc}
                  onChange={(event) => setComposeCc(event.target.value)}
                  list="crm-recipient-suggestions"
                  placeholder="Optional CC recipients"
                  className="mt-1 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                />
              </label>

              <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                Subject
                <input
                  value={composeSubject}
                  onChange={(event) => setComposeSubject(event.target.value)}
                  placeholder="Subject"
                  className="mt-1 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                />
              </label>

              <label className="mt-3 block text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                Message
                <div className="mt-1 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2">
                  <select
                    value={composeFont}
                    onChange={(event) => {
                      const nextFont = event.target.value;
                      setComposeFont(nextFont);
                      applyComposeCommand("fontName", nextFont);
                    }}
                    className="rounded-lg border border-[var(--border)] bg-white px-2 py-1 text-xs text-[var(--foreground)] outline-none focus:border-sky-400"
                  >
                    <option value="Arial">Arial</option>
                    <option value="Georgia">Georgia</option>
                    <option value="Tahoma">Tahoma</option>
                    <option value="Times New Roman">Times New Roman</option>
                    <option value="Verdana">Verdana</option>
                  </select>
                  <select
                    value={composeFontSize}
                    onChange={(event) => {
                      const nextSize = event.target.value;
                      setComposeFontSize(nextSize);
                      applyComposeCommand("fontSize", nextSize);
                    }}
                    className="rounded-lg border border-[var(--border)] bg-white px-2 py-1 text-xs text-[var(--foreground)] outline-none focus:border-sky-400"
                  >
                    <option value="1">8</option>
                    <option value="2">10</option>
                    <option value="3">12</option>
                    <option value="4">14</option>
                    <option value="5">18</option>
                    <option value="6">24</option>
                  </select>
                  <label className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2 py-1 text-xs text-[var(--foreground)]">
                    Color
                    <input
                      type="color"
                      value={composeColor}
                      onChange={(event) => {
                        const nextColor = event.target.value;
                        setComposeColor(nextColor);
                        composeEditorRef.current?.focus();
                      }}
                      className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => applyComposeCommand("bold")}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                  >
                    Bold
                  </button>
                  <button
                    type="button"
                    onClick={() => applyComposeCommand("italic")}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                  >
                    Italic
                  </button>
                  <button
                    type="button"
                    onClick={() => applyComposeCommand("underline")}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                  >
                    Underline
                  </button>
                  <button
                    type="button"
                    onClick={() => composeImageInputRef.current?.click()}
                    className="rounded-lg border border-[var(--border)] px-2 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                  >
                    Add image
                  </button>
                  <input
                    ref={composeImageInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleComposeImageUpload}
                    className="hidden"
                  />
                </div>
                <div
                  ref={composeEditorRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={updateComposeFromEditor}
                  onPaste={handleComposePaste}
                  className="mt-2 min-h-[190px] w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                  style={{
                    whiteSpace: "pre-wrap",
                    color: composeColor,
                  }}
                />
                <p className="mt-1 text-[11px] normal-case tracking-normal text-[var(--muted)]">
                  Paste images directly into the message body with Ctrl+V.
                </p>
              </label>

              <label className="mt-3 flex items-center gap-2 text-sm text-[var(--foreground)]">
                <input
                  type="checkbox"
                  checked={applySignature}
                  onChange={(event) => setApplySignature(event.target.checked)}
                  disabled={!savedSignatureHtml}
                  className="h-4 w-4"
                />
                Apply saved signature
              </label>
              {!savedSignatureHtml ? (
                <p className="mt-1 text-xs text-[var(--muted)]">No saved signature. Configure it in Mailbox Settings.</p>
              ) : null}

              <datalist id="crm-recipient-suggestions">
                {crmRecipientSuggestions.map((item) => (
                  <option key={item.email} value={item.email} label={item.label} />
                ))}
              </datalist>

              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsComposerOpen(false)}
                  className="rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isActionLoading || connectedProviders.length === 0}
                  className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isActionLoading ? "Sending..." : "Send message"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function plainTextToHtml(value: string) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function htmlToPlainText(value: string) {
  if (typeof document === "undefined") {
    return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  const container = document.createElement("div");
  container.innerHTML = value;
  return (container.textContent ?? "").replace(/\u00a0/g, " ").trim();
}

function composeHtmlForEmail(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  const normalized = trimmed
    .replace(/<br\s*\/?\s*>/gi, "")
    .replace(/&nbsp;/gi, "")
    .replace(/\s+/g, "")
    .trim();

  return normalized ? trimmed : "";
}

function buildStyledHtml(html: string, color: string) {
  return `<div style="color: ${sanitizeCssValue(color)};">${html}</div>`;
}

function sanitizeCssValue(value: string) {
  return value.replace(/[<>"']/g, "");
}

function extractEmailAddressFromHeader(value: string) {
  const bracketMatch = value.match(/<([^<>\s]+@[^<>\s]+)>/);

  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim().toLowerCase();
  }

  const directMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  if (!directMatch?.[0]) {
    return null;
  }

  return directMatch[0].trim().toLowerCase();
}

function parseSenderName(fromValue: string, fallbackEmail: string) {
  const visibleName = fromValue
    .replace(/<[^>]+>/g, " ")
    .replace(/\"/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (visibleName && !visibleName.includes("@")) {
    const chunks = visibleName.split(" ").filter(Boolean);

    if (chunks.length >= 2) {
      return {
        firstName: chunks[0],
        lastName: chunks.slice(1).join(" "),
      };
    }

    if (chunks.length === 1) {
      return {
        firstName: chunks[0],
        lastName: "Contact",
      };
    }
  }

  const localPart = fallbackEmail.split("@")[0] ?? "";
  const normalized = localPart.replace(/[._-]+/g, " ").trim();
  const chunks = normalized.split(" ").filter(Boolean);

  if (chunks.length >= 2) {
    return {
      firstName: capitalizeWord(chunks[0]),
      lastName: chunks.slice(1).map(capitalizeWord).join(" "),
    };
  }

  if (chunks.length === 1) {
    return {
      firstName: capitalizeWord(chunks[0]),
      lastName: "Contact",
    };
  }

  return {
    firstName: "Email",
    lastName: "Contact",
  };
}

function capitalizeWord(value: string) {
  if (!value) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}