"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import assistantLogo from "@/public/assistant-logo.png.jpg";

type ChatAssistantWidgetProps = {
  workspaceId: string | null;
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

type ChatAssistantResponse = {
  ok?: boolean;
  reply?: string;
  creditsUsed?: number;
  newBalance?: number | null;
  error?: string;
};

const MAX_EVENTS = 5;
const MAX_HISTORY_MESSAGES = 8;
const GENERIC_PUBLIC_ERROR = "Something went wrong.";

function normalizeAssistantMessage(content: string) {
  return content.replace(/^\s*assistant\s*:\s*/i, "").trimStart();
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

export function ChatAssistantWidget({ workspaceId }: ChatAssistantWidgetProps) {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastChargedCredits, setLastChargedCredits] = useState<number | null>(null);
  const [balanceAfter, setBalanceAfter] = useState<number | null>(null);
  const [recentEvents, setRecentEvents] = useState<UiClickEvent[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Hello. I can help with contacts, properties, documents, and navigation inside your current workspace.",
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
        }),
      });

      const payload = (await response.json()) as ChatAssistantResponse;

      if (!response.ok || !payload.ok || !payload.reply) {
        setErrorMessage(GENERIC_PUBLIC_ERROR);
        setMessages((previous) => [
          ...previous,
          {
            role: "assistant",
            content: GENERIC_PUBLIC_ERROR,
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

  return (
    <div data-chat-assistant-root="true" className="pointer-events-none fixed bottom-4 right-4 z-40 sm:bottom-5 sm:right-5">
      {isOpen ? (
        <aside className="pointer-events-auto mb-3 h-[70vh] max-h-[36rem] w-[min(28rem,calc(100vw-1.5rem))] rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] shadow-2xl shadow-[rgba(15,23,42,0.24)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-[var(--foreground)]">Workspace assistant</p>
              <p className="text-xs text-[var(--muted)]">0.1 credit per message</p>
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:bg-slate-50"
              aria-label="Close assistant"
            >
              Close
            </button>
          </div>

          <div className="h-[calc(100%-8.5rem)] overflow-y-auto px-4 py-3">
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

      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-label="Open workspace assistant"
        className="pointer-events-auto flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface)] shadow-xl shadow-[rgba(15,23,42,0.24)] transition hover:brightness-105"
      >
        <Image src={assistantLogo} alt="" aria-hidden="true" className="h-full w-full object-cover" priority />
      </button>
    </div>
  );
}
