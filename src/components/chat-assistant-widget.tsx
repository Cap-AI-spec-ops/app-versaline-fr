"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import assistantLogo from "@/public/assistant-logo.png.jpg";
import { dispatchCreditsBalanceRefresh } from "@/lib/credits/client-refresh";

type ChatAssistantWidgetProps = {
  workspaceId: string | null;
  workspaceName?: string | null;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type UiClickEvent = {
  at: string;
  path: string;
  targetType: string;
  label: string;
};

type VisibleScreenError = {
  message: string;
  source: string;
  detectedAt: number;
};

type ChatAssistantResponse = {
  ok?: boolean;
  reply?: string;
  creditsUsed?: number;
  newBalance?: number | null;
  error?: string;
};

const MAX_EVENTS = 5;
const MAX_HISTORY_MESSAGES = 8;
const MAX_VISIBLE_ERRORS = 3;
const SCREEN_ERROR_STICKY_MS = 15000;
const GENERIC_PUBLIC_ERROR = "Something went wrong.";
const INSUFFICIENT_CREDITS_MESSAGE =
  "You ran out of credits: please top up your balance in the top right of the screen to persue this conversation.";
const SCREEN_ERROR_HELP_PROMPT = "Need help with that ?";
const SCREEN_ERROR_KEYWORDS = /(error|failed|invalid|not found|could not|unable|mismatch|wrong|missing or invalid)/i;

function normalizeScreenText(content: string) {
  return content.replace(/\s+/g, " ").trim();
}

function isElementVisible(element: HTMLElement) {
  if (element.hidden) {
    return false;
  }

  const style = window.getComputedStyle(element);

  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  return element.getClientRects().length > 0;
}

function getErrorSource(element: HTMLElement) {
  const role = element.getAttribute("role");
  const ariaLive = element.getAttribute("aria-live");

  if (role) {
    return role;
  }

  if (ariaLive) {
    return `aria-live:${ariaLive}`;
  }

  return element.tagName.toLowerCase();
}

function collectVisibleScreenErrors() {
  const candidates = document.querySelectorAll<HTMLElement>(
    "[role='alert'], [aria-live='assertive'], [class*='text-red'], [class*='border-red'], [class*='bg-red']",
  );
  const deduped = new Set<string>();
  const matches: VisibleScreenError[] = [];

  for (const element of candidates) {
    if (element.closest("[data-chat-assistant-root='true']")) {
      continue;
    }

    if (element.matches("button, a, input, textarea, select")) {
      continue;
    }

    if (!isElementVisible(element)) {
      continue;
    }

    const message = normalizeScreenText(element.textContent ?? "");

    if (message.length < 8 || message.length > 220) {
      continue;
    }

    const className = typeof element.className === "string" ? element.className : "";
    const isAlertSurface = element.getAttribute("role") === "alert" || element.getAttribute("aria-live") === "assertive";
    const looksLikeErrorSurface = /text-red|border-red|bg-red/.test(className);

    const shouldInclude =
      isAlertSurface ||
      looksLikeErrorSurface ||
      SCREEN_ERROR_KEYWORDS.test(message);

    if (!shouldInclude) {
      continue;
    }

    if (deduped.has(message)) {
      continue;
    }

    deduped.add(message);
    matches.push({ message, source: getErrorSource(element), detectedAt: Date.now() });

    if (matches.length >= MAX_VISIBLE_ERRORS) {
      break;
    }
  }

  return matches;
}

function isInsufficientCreditsError(message: string | undefined) {
  const normalized = message?.toLowerCase() ?? "";

  return normalized.includes("insufficient credit") || normalized.includes("insufficient credits");
}

function normalizeAssistantMessage(content: string) {
  return content.replace(/^\s*assistant\s*:\s*/i, "").trimStart();
}

function resolveAssistantErrorMessage(message: string | undefined) {
  const normalized = message?.trim();
  return normalized && normalized.length > 0 ? normalized : GENERIC_PUBLIC_ERROR;
}

function summarizeClickedElement(element: HTMLElement): { targetType: string; label: string } {
  const clickable = element.closest("button, a, input, textarea, select, [role='button']") as HTMLElement | null;

  if (!clickable) {
    return {
      targetType: element.tagName.toLowerCase(),
      label: "Unknown target",
    };
  }

  const rawLabel =
    clickable.getAttribute("aria-label") ||
    clickable.getAttribute("title") ||
    clickable.textContent ||
    clickable.getAttribute("name") ||
    clickable.getAttribute("placeholder") ||
    clickable.tagName;

  const cleanedLabel = rawLabel.replace(/\s+/g, " ").trim().slice(0, 80);

  return {
    targetType: clickable.tagName.toLowerCase(),
    label: cleanedLabel || clickable.tagName.toLowerCase(),
  };
}

function buildIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `chat-assistant:${crypto.randomUUID()}`;
  }

  return `chat-assistant:${Date.now()}`;
}

export function ChatAssistantWidget({ workspaceId, workspaceName }: ChatAssistantWidgetProps) {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastChargedCredits, setLastChargedCredits] = useState<number | null>(null);
  const [balanceAfter, setBalanceAfter] = useState<number | null>(null);
  const [recentEvents, setRecentEvents] = useState<UiClickEvent[]>([]);
  const [visibleScreenErrors, setVisibleScreenErrors] = useState<VisibleScreenError[]>([]);
  const lastVisibleErrorsRef = useRef<VisibleScreenError[]>([]);
  const brandedWorkspaceLabel = (workspaceName?.trim() || "workspace").replace(/\s+/g, " ");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        `Hello. I can help with contacts, properties, documents, and navigation in your ${brandedWorkspaceLabel} workspace in Versaline.`,
    },
  ]);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const conversationForApi = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-MAX_HISTORY_MESSAGES),
    [messages],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isOpen]);

  useEffect(() => {
    let frame = 0;

    const refreshVisibleErrors = () => {
      frame = 0;
      const detectedErrors = collectVisibleScreenErrors();
      const now = Date.now();
      const stickyRecentErrors = lastVisibleErrorsRef.current.filter((entry) => now - entry.detectedAt < SCREEN_ERROR_STICKY_MS);
      const mergedErrors = [...detectedErrors];

      for (const entry of stickyRecentErrors) {
        if (mergedErrors.some((candidate) => candidate.message === entry.message)) {
          continue;
        }

        mergedErrors.push(entry);

        if (mergedErrors.length >= MAX_VISIBLE_ERRORS) {
          break;
        }
      }

      lastVisibleErrorsRef.current = mergedErrors;
      setVisibleScreenErrors(mergedErrors);
    };

    const scheduleRefresh = () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }

      frame = window.requestAnimationFrame(refreshVisibleErrors);
    };

    scheduleRefresh();

    const observer = new MutationObserver(() => {
      scheduleRefresh();
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "role", "aria-live"],
    });

    window.addEventListener("error", scheduleRefresh);
    window.addEventListener("unhandledrejection", scheduleRefresh);

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }

      observer.disconnect();
      window.removeEventListener("error", scheduleRefresh);
      window.removeEventListener("unhandledrejection", scheduleRefresh);
    };
  }, [pathname, isOpen]);

  useEffect(() => {
    lastVisibleErrorsRef.current = [];
    setVisibleScreenErrors([]);
  }, [pathname]);

  useEffect(() => {
    const clickHandler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;

      if (!target) {
        return;
      }

      if (target.closest("[data-chat-assistant-root='true']")) {
        return;
      }

      const summary = summarizeClickedElement(target);

      setRecentEvents((previous) => {
        const nextEvent: UiClickEvent = {
          at: new Date().toISOString(),
          path: pathname,
          targetType: summary.targetType,
          label: summary.label,
        };

        return [...previous.slice(-(MAX_EVENTS - 1)), nextEvent];
      });
    };

    document.addEventListener("click", clickHandler, true);

    return () => {
      document.removeEventListener("click", clickHandler, true);
    };
  }, [pathname]);

  const sendMessage = async () => {
    const message = input.trim();

    if (!message || isSending) {
      return;
    }

    if (!workspaceId) {
      setErrorMessage(GENERIC_PUBLIC_ERROR);
      return;
    }

    const nextMessages = [...messages, { role: "user" as const, content: message }];

    setMessages(nextMessages);
    setInput("");
    setIsSending(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/chat-assistant", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": buildIdempotencyKey(),
        },
        body: JSON.stringify({
          workspaceId,
          routePath: pathname,
          message,
          recentEvents,
          conversation: conversationForApi,
          visibleErrors: visibleScreenErrors.map((entry) => entry.message),
        }),
      });

      const payload = (await response.json()) as ChatAssistantResponse;

      if (response.status === 402 || isInsufficientCreditsError(payload.error)) {
        setErrorMessage(null);
        setMessages((previous) => [
          ...previous,
          {
            role: "assistant",
            content: INSUFFICIENT_CREDITS_MESSAGE,
          },
        ]);
        return;
      }

      if (!response.ok || !payload.ok || !payload.reply) {
        const apiErrorMessage = resolveAssistantErrorMessage(payload.error);
        setErrorMessage(apiErrorMessage);
        setMessages((previous) => [
          ...previous,
          {
            role: "assistant",
            content: apiErrorMessage,
          },
        ]);
        return;
      }

      setMessages((previous) => [
        ...previous,
        { role: "assistant", content: normalizeAssistantMessage(payload.reply ?? "") },
      ]);
      setLastChargedCredits(typeof payload.creditsUsed === "number" ? payload.creditsUsed : null);
      setBalanceAfter(typeof payload.newBalance === "number" ? payload.newBalance : null);

      if (typeof payload.newBalance === "number") {
        dispatchCreditsBalanceRefresh({
          workspaceId,
          newBalance: payload.newBalance,
          source: "chat-assistant",
        });
      }
    } catch {
      setErrorMessage(GENERIC_PUBLIC_ERROR);
      setMessages((previous) => [
        ...previous,
        {
          role: "assistant",
          content: GENERIC_PUBLIC_ERROR,
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  if (!workspaceId) {
    return null;
  }

  const primaryVisibleError = visibleScreenErrors[0]?.message ?? null;
  const hasVisibleScreenError = visibleScreenErrors.length > 0;

  const openAssistantForScreenError = () => {
    setIsOpen(true);
    setInput((previous) => {
      if (!primaryVisibleError || previous.trim().length > 0) {
        return previous;
      }

      return `Can you help me understand this error and how to fix it?\n\n\"${primaryVisibleError}\"`;
    });
  };

  return (
    <div data-chat-assistant-root="true" className="pointer-events-none fixed bottom-4 right-4 z-40 sm:bottom-5 sm:right-5">
      {isOpen ? (
        <aside className="pointer-events-auto mb-3 flex h-[70vh] max-h-[36rem] w-[min(28rem,calc(100vw-1.5rem))] flex-col rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] shadow-2xl shadow-[rgba(15,23,42,0.24)]">
          <div className="border-b border-[var(--border)] px-4 pt-4 pb-1">
            <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
              <div aria-hidden="true" />
              <div className="flex flex-col items-center">
                <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface)]">
                  <Image src={assistantLogo} alt="" aria-hidden="true" className="h-full w-full object-cover" />
                </span>
                <p className="mt-2 text-sm font-semibold text-[var(--foreground)]">Workspace assistant</p>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
                  aria-label="Close assistant"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="mt-1 flex justify-end">
              <p className="text-[11px] italic text-[var(--muted)]">0.1 credit per message</p>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <div className="space-y-3">
              {messages.map((message, index) => (
                (() => {
                  const displayContent =
                    message.role === "assistant" ? normalizeAssistantMessage(message.content) : message.content;

                  return (
                <div
                  key={`${message.role}-${index}`}
                  className={`flex items-end gap-2 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {message.role === "assistant" ? (
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface)]">
                      <Image src={assistantLogo} alt="" aria-hidden="true" className="h-full w-full object-cover" />
                    </span>
                  ) : null}
                  <div
                    className={`max-w-[92%] rounded-2xl border px-3 py-2 text-sm leading-6 ${
                      message.role === "user"
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--foreground)]"
                        : "border-[var(--border)] bg-white/80 text-[var(--foreground)]"
                    }`}
                  >
                    {displayContent}
                  </div>
                </div>
                  );
                })()
              ))}

              {isSending ? (
                <div className="mr-auto max-w-[92%] rounded-2xl border border-[var(--border)] bg-white/80 px-3 py-2 text-sm text-[var(--muted)]">
                  Thinking...
                </div>
              ) : null}

              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="border-t border-[var(--border)] px-4 py-3">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                rows={2}
                className="w-full resize-none rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
                placeholder="Ask anything about your current workspace..."
              />
              <button
                type="button"
                onClick={() => void sendMessage()}
                disabled={isSending || input.trim().length === 0}
                className="rounded-xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-3 py-2 text-sm font-semibold text-white shadow-md shadow-[rgba(59,130,246,0.22)] disabled:opacity-60"
              >
                Send
              </button>
            </div>

            {errorMessage ? <p className="mt-2 text-xs text-red-600">{errorMessage}</p> : null}
            {!errorMessage && lastChargedCredits !== null ? (
              <p className="mt-2 text-xs text-[var(--muted)]">
                Last charge: {lastChargedCredits.toFixed(2)} credit
                {balanceAfter !== null ? ` | New balance: ${balanceAfter.toFixed(2)}` : ""}
              </p>
            ) : null}
          </div>
        </aside>
      ) : null}

      {!isOpen && hasVisibleScreenError ? (
        <div className="pointer-events-auto mb-2 flex justify-end">
          <button
            type="button"
            onClick={openAssistantForScreenError}
            className="max-w-[16rem] rounded-[20px] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-right shadow-lg shadow-[rgba(15,23,42,0.18)] transition hover:-translate-y-0.5 hover:brightness-105"
            aria-label="Open assistant to explain the current screen error"
          >
            <p className="text-sm italic text-[var(--foreground)]">{SCREEN_ERROR_HELP_PROMPT}</p>
            <p className="mt-1 truncate text-xs text-[var(--muted)]">{primaryVisibleError}</p>
          </button>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => {
          if (!isOpen && primaryVisibleError) {
            openAssistantForScreenError();
            return;
          }

          setIsOpen((open) => !open);
        }}
        aria-label="Open workspace assistant"
        className="pointer-events-auto flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface)] shadow-xl shadow-[rgba(15,23,42,0.24)] transition hover:brightness-105"
      >
        <Image src={assistantLogo} alt="" aria-hidden="true" className="h-full w-full object-cover" priority />
      </button>
    </div>
  );
}
