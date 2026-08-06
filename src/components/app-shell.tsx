"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { ChatAssistantWidget } from "@/components/chat-assistant-widget";
import { CreditBalanceBadge } from "@/components/credit-balance-badge";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { resolveAppearancePreferences } from "@/lib/preferences/appearance";
import { useAccessibleWorkspaces } from "@/lib/workspace/use-accessible-workspaces";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";
import { useWorkspaceMembers } from "@/lib/workspace/use-workspace-members";

type NavItem = {
  href: string;
  label: string;
  shortLabel: string;
};

const baseNavItems: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", shortLabel: "DB" },
  { href: "/calendar", label: "Calendar", shortLabel: "CAL" },
  { href: "/properties", label: "Properties", shortLabel: "PR" },
  { href: "/contacts", label: "CRM", shortLabel: "CRM" },
  {
    href: "/document-generator",
    label: "Document generator",
    shortLabel: "AI",
  },
];

const titles: Record<string, { title: string; subtitle: string }> = {
  "/dashboard": {
    title: "Dashboard",
    subtitle: "Monitor your property operations and document flow.",
  },
  "/calendar": {
    title: "Calendar",
    subtitle: "Plan personal events and coworker absences in one timeline.",
  },
  "/properties": {
    title: "Properties",
    subtitle: "A dedicated workspace for your listings and assets.",
  },
  "/contacts": {
    title: "CRM",
    subtitle: "Organize owners, tenants, partners, and leads.",
  },
  "/document-generator": {
    title: "Document generator",
    subtitle: "Prepare contracts, letters, and supporting documents.",
  },
  "/admin": {
    title: "Admin",
    subtitle: "Create and manage workspaces at the company level.",
  },
  "/settings": {
    title: "Settings",
    subtitle: "Manage workspace preferences and account configuration.",
  },
  "/settings/mailbox": {
    title: "Mailbox",
    subtitle: "Connect inbox providers and tune personal email summary preferences.",
  },
  "/settings/daily-briefing": {
    title: "Daily Briefing",
    subtitle: "Configure your AI daily summary schedule, language, and delivery settings.",
  },
  "/admin/email-policy": {
    title: "Email Policy",
    subtitle: "Configure workspace-level triage controls and compliance defaults.",
  },
};

function getHeaderContent(pathname: string) {
  return titles[pathname] ?? titles["/dashboard"];
}

function buildInitialsFromProfile(firstName: string | null | undefined, lastName: string | null | undefined, email: string | undefined) {
  const normalizedFirstName = typeof firstName === "string" ? firstName.trim() : "";
  const normalizedLastName = typeof lastName === "string" ? lastName.trim() : "";

  if (normalizedFirstName || normalizedLastName) {
    const first = normalizedFirstName.charAt(0).toUpperCase();
    const last = normalizedLastName.charAt(0).toUpperCase();
    return `${first}${last}`.trim() || "US";
  }

  if (email) {
    return email.charAt(0).toUpperCase();
  }

  return "US";
}

function formatRoleLabel(role: "agent" | "team_lead" | "owner" | "super_admin") {
  return role.replace("_", " ");
}

function formatMemberName(firstName: string | null, lastName: string | null) {
  const fullName = [firstName ?? "", lastName ?? ""].join(" ").trim();
  return fullName || "Unnamed member";
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = useState(false);
  const [userInitials, setUserInitials] = useState("US");
  const [themeMode, setThemeMode] = useState<"light" | "dark">("light");
  const [isSupportModalOpen, setIsSupportModalOpen] = useState(false);
  const [supportSubject, setSupportSubject] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [supportStatus, setSupportStatus] = useState<string | null>(null);
  const [isSendingSupport, setIsSendingSupport] = useState(false);
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);
  const [workspaceSwitchMessage, setWorkspaceSwitchMessage] = useState<string | null>(null);
  const workspaceMenuRef = useRef<HTMLDivElement | null>(null);
  const { workspace } = useCurrentWorkspace();
  const { members: workspaceMembers, isLoading: isMembersLoading, currentUserId, refresh: refreshMembers } = useWorkspaceMembers();
  const { workspaces: accessibleWorkspaces, isLoading: isAccessibleWorkspacesLoading, error: accessibleWorkspacesError, refresh: refreshAccessibleWorkspaces } = useAccessibleWorkspaces();
  const isAuthRoute = pathname === "/login" || pathname === "/signup" || pathname === "/mfa/verify" || pathname === "/onboarding";
  const canSwitchWorkspaces = accessibleWorkspaces.length > 1;
  const currentWorkspaceEntry = accessibleWorkspaces.find((item) => item.is_current) ?? accessibleWorkspaces[0];
  const currentWorkspaceId = workspace?.id ?? currentWorkspaceEntry?.workspace_id ?? null;
  const workspaceButtonLabel = workspace?.name ?? currentWorkspaceEntry?.workspace_name ?? "Select workspace";
  const isAdminUser = currentWorkspaceEntry?.user_role === "super_admin" || currentWorkspaceEntry?.user_role === "owner";
  const navItems = isAdminUser
    ? [...baseNavItems, { href: "/admin", label: "Admin", shortLabel: "AD" }]
    : baseNavItems;

  useEffect(() => {
    setIsSidebarOpen(false);
    setIsUserMenuOpen(false);
    setIsWorkspaceMenuOpen(false);
    setIsSupportModalOpen(false);
  }, [pathname]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (!isWorkspaceMenuOpen || !workspaceMenuRef.current) {
        return;
      }

      const target = event.target as Node;

      if (!workspaceMenuRef.current.contains(target)) {
        setIsWorkspaceMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isWorkspaceMenuOpen]);

  useEffect(() => {
    const handleWorkspaceListUpdated = () => {
      void refreshAccessibleWorkspaces();
    };

    window.addEventListener("workspace-list-updated", handleWorkspaceListUpdated);

    return () => {
      window.removeEventListener("workspace-list-updated", handleWorkspaceListUpdated);
    };
  }, [refreshAccessibleWorkspaces]);

  useEffect(() => {
    const syncAppearancePreferences = async () => {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        return;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      const { data: profileData } = await supabase.rpc("get_current_profile");
      const profile = profileData as { first_name?: string | null; last_name?: string | null; email?: string | null } | null;

      setUserInitials(
        buildInitialsFromProfile(
          profile?.first_name,
          profile?.last_name,
          profile?.email ?? user?.email
        )
      );

      const { theme } = resolveAppearancePreferences(
        (user?.user_metadata as Record<string, unknown> | undefined) ?? undefined
      );

      const root = document.documentElement;

      if (theme === "dark") {
        setThemeMode("dark");
      } else {
        setThemeMode("light");
      }

      if (theme === "light" || theme === "dark") {
        root.dataset.theme = theme;
      } else {
        delete root.dataset.theme;
      }

    };

    void syncAppearancePreferences();
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") {
      return;
    }

    let isCancelled = false;

    const triggerHeartbeat = async () => {
      if (isCancelled) {
        return;
      }

      try {
        await fetch("/api/dev/daily-briefing-heartbeat", {
          method: "POST",
          cache: "no-store",
        });
      } catch {
        // Ignore heartbeat failures in dev; scheduler route has its own logs.
      }
    };

    void triggerHeartbeat();
    const intervalId = window.setInterval(() => {
      void triggerHeartbeat();
    }, 60_000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const handleThemeToggle = async () => {
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

    const metadata = (user.user_metadata as Record<string, unknown> | undefined) ?? {};
    const appearancePreferences =
      typeof metadata.appearance_preferences === "object" && metadata.appearance_preferences !== null
        ? (metadata.appearance_preferences as Record<string, unknown>)
        : {};

    const nextTheme: "light" | "dark" = themeMode === "dark" ? "light" : "dark";

    const { error } = await supabase.auth.updateUser({
      data: {
        appearance_preferences: {
          ...appearancePreferences,
          theme: nextTheme,
        },
      },
    });

    if (error) {
      return;
    }

    setThemeMode(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  };

  const handleSignOut = async () => {
    const supabase = getSupabaseBrowserClient();

    if (supabase) {
      await supabase.auth.signOut();
    }

    router.replace("/login");
    router.refresh();
  };

  const handleOpenSupportModal = () => {
    const supportWindow = window.open("https://www.support.versaline.fr", "_blank", "noopener,noreferrer");

    if (!supportWindow) {
      window.location.href = "https://www.support.versaline.fr";
    }
  };

  const handleSupportSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!currentWorkspaceId) {
      setSupportStatus("No active workspace found. Please refresh and retry.");
      return;
    }

    const trimmedSubject = supportSubject.trim();
    const trimmedMessage = supportMessage.trim();

    if (trimmedSubject.length < 4) {
      setSupportStatus("Subject must have at least 4 characters.");
      return;
    }

    if (trimmedMessage.length < 10) {
      setSupportStatus("Message must have at least 10 characters.");
      return;
    }

    setIsSendingSupport(true);
    setSupportStatus(null);

    try {
      const response = await fetch("/api/support", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subject: trimmedSubject,
          message: trimmedMessage,
          routePath: pathname,
          workspaceId: currentWorkspaceId,
          workspaceName: workspaceButtonLabel,
        }),
      });

      const payload = (await response.json()) as { ok?: boolean; error?: string };

      if (!response.ok || !payload.ok) {
        setSupportStatus(payload.error ?? "Could not send support request.");
        return;
      }

      setSupportMessage("");
      setSupportStatus("Support request sent. Our team will get back to you shortly.");
    } catch {
      setSupportStatus("Could not send support request.");
    } finally {
      setIsSendingSupport(false);
    }
  };

  const handleWorkspaceSwitch = async (targetWorkspaceId: string) => {
    const supabase = getSupabaseBrowserClient();

    if (!supabase || targetWorkspaceId === currentWorkspaceId) {
      return;
    }

    setIsSwitchingWorkspace(true);
    setWorkspaceSwitchMessage(null);

    const { error } = await supabase.rpc("switch_workspace", {
      p_workspace_id: targetWorkspaceId,
    });

    if (error) {
      setIsSwitchingWorkspace(false);
      setWorkspaceSwitchMessage(error.message);
      return;
    }

    await refreshAccessibleWorkspaces();
    await refreshMembers();

    setIsSwitchingWorkspace(false);
    setWorkspaceSwitchMessage("Workspace switched.");
    window.location.reload();
  };

  if (isAuthRoute) {
    return <div className="min-h-screen text-[var(--foreground)]">{children}</div>;
  }

  return (
    <div className="min-h-screen text-[var(--foreground)] md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <div
        className={`fixed inset-0 z-30 bg-[rgba(10,17,40,0.42)] transition md:hidden ${
          isSidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setIsSidebarOpen(false)}
      />

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 overflow-y-auto border-r border-white/10 bg-[linear-gradient(180deg,rgba(10,17,40,0.98)_0%,rgba(15,23,42,0.96)_55%,rgba(17,24,39,0.94)_100%)] px-4 py-5 text-white shadow-2xl shadow-[rgba(10,17,40,0.28)] backdrop-blur transition-transform duration-200 md:sticky md:top-0 md:z-10 md:h-screen md:translate-x-0 md:pointer-events-auto md:shadow-none ${
          isSidebarOpen ? "translate-x-0 pointer-events-auto" : "-translate-x-[120%] pointer-events-none"
        }`}
      >
          <div className="flex h-full flex-col">
            <div className="border-b border-white/10 px-1 pb-5">
              <h1 className="brand-wordmark mt-3 text-[1.55rem] leading-tight" aria-label="Versaline">
                VERS<span className="brand-wordmark-a" aria-hidden="true">Λ</span>LINE
              </h1>
            </div>

            <nav className="mt-6 flex-1 space-y-1 px-1">
              {navItems.map((item) => {
                const isActive = pathname === item.href;

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 transition ${
                      isActive
                        ? "bg-white/8 text-white"
                        : "text-white/74 hover:bg-white/6 hover:text-white"
                    }`}
                  >
                    <span
                      className={`h-5 w-0.5 rounded-full transition ${
                        isActive
                          ? "bg-white"
                          : "bg-transparent group-hover:bg-white/35"
                      }`}
                      aria-hidden="true"
                    />
                    <span className="text-[0.94rem] font-medium tracking-[0.01em]">{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            <div className="mx-1 mt-6 border-t border-white/10 pt-4">
              <p className="text-sm font-medium text-white/75">
                ® Versaline by Cap AI
              </p>
            </div>
          </div>
        </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 px-5 py-3 md:justify-end md:px-6 md:py-4">
          <button
            type="button"
            aria-label="Open sidebar"
            onClick={() => setIsSidebarOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border)] bg-white/80 text-[var(--muted)] shadow-sm transition hover:bg-white md:hidden"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Support"
            onClick={handleOpenSupportModal}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-white/80 text-sm font-semibold text-[var(--muted)] shadow-sm transition hover:bg-white"
          >
            ?
          </button>
          <Link
            href="/settings"
            aria-label="Settings"
            className={`flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-white/80 text-[var(--muted)] shadow-sm transition hover:bg-white ${
              pathname === "/settings" ? "border-slate-300 bg-white text-[var(--foreground)]" : ""
            }`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82L4.21 7.2a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 .99-1.5V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 .99 1.5h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.5.99H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.5.99z" />
            </svg>
          </Link>
          <button
            type="button"
            onClick={() => void handleThemeToggle()}
            aria-label={themeMode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--border)] bg-white/80 text-xs font-semibold text-[var(--muted)] shadow-sm transition hover:bg-white"
          >
            {themeMode === "dark" ? (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-4 w-4 text-[var(--muted)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="4" />
                <line x1="12" y1="2.5" x2="12" y2="5" />
                <line x1="12" y1="19" x2="12" y2="21.5" />
                <line x1="2.5" y1="12" x2="5" y2="12" />
                <line x1="19" y1="12" x2="21.5" y2="12" />
                <line x1="5.2" y1="5.2" x2="7" y2="7" />
                <line x1="17" y1="17" x2="18.8" y2="18.8" />
                <line x1="17" y1="7" x2="18.8" y2="5.2" />
                <line x1="5.2" y1="18.8" x2="7" y2="17" />
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-4 w-4 text-[var(--muted)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5Z" />
              </svg>
            )}
          </button>
          <div ref={workspaceMenuRef} className="relative hidden sm:block">
              <button
                type="button"
                onClick={() => setIsWorkspaceMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={isWorkspaceMenuOpen}
                aria-label="Open workspace members"
                className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-2 text-sm text-[var(--muted)] transition hover:bg-white"
              >
                {workspaceButtonLabel}
              </button>

              {isWorkspaceMenuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 top-12 z-30 w-72 rounded-2xl border border-[var(--border)] bg-white p-3 shadow-xl shadow-[rgba(15,23,42,0.12)]"
                >
                  {isAdminUser ? (
                    <>
                      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Workspace switcher</p>
                      <div className="mt-3 space-y-2">
                        {isAccessibleWorkspacesLoading ? (
                          <p className="text-sm text-[var(--muted)]">Loading workspaces...</p>
                        ) : canSwitchWorkspaces ? (
                          accessibleWorkspaces.map((item) => (
                            <button
                              key={item.workspace_id}
                              type="button"
                              disabled={isSwitchingWorkspace || item.is_current}
                              onClick={() => void handleWorkspaceSwitch(item.workspace_id)}
                              className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                                item.is_current
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-[var(--border)] bg-slate-50 text-[var(--foreground)] hover:bg-white"
                              } disabled:cursor-not-allowed disabled:opacity-70`}
                            >
                              <p className="truncate text-sm font-medium">
                                {item.workspace_name || "Unnamed workspace"}
                              </p>
                              <p className="truncate text-xs text-[var(--muted)]">
                                {item.company_name || "No company"}
                              </p>
                            </button>
                          ))
                        ) : (
                          <p className="text-sm text-[var(--muted)]">No other accessible workspace.</p>
                        )}
                        {accessibleWorkspacesError ? (
                          <p className="text-sm font-medium text-red-500">{accessibleWorkspacesError}</p>
                        ) : null}
                        {workspaceSwitchMessage ? (
                          <p className={`text-sm font-medium ${workspaceSwitchMessage === "Workspace switched." ? "text-emerald-700" : "text-red-500"}`}>
                            {workspaceSwitchMessage}
                          </p>
                        ) : null}
                      </div>
                    </>
                  ) : null}

                  <p className={`${isAdminUser ? "mt-4" : "mt-0"} text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]`}>Workspace members</p>
                  <div className="mt-3 space-y-2">
                    {isMembersLoading ? (
                      <p className="text-sm text-[var(--muted)]">Loading members...</p>
                    ) : workspaceMembers.length > 0 ? (
                      workspaceMembers.map((member) => (
                        <div key={member.profile_id} className="rounded-xl border border-[var(--border)] bg-slate-50 px-3 py-2">
                          <p className="truncate text-sm font-medium text-[var(--foreground)]">
                            {formatMemberName(member.first_name, member.last_name)}
                            {member.profile_id === currentUserId ? " (You)" : ""}
                          </p>
                          <p className="text-xs capitalize tracking-[0.12em] text-[var(--muted)]">{formatRoleLabel(member.role)}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-[var(--muted)]">No members found.</p>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          <CreditBalanceBadge workspaceId={currentWorkspaceId} className="hidden xl:inline-flex" />
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsUserMenuOpen((open) => !open)}
              className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.18)]"
              aria-haspopup="menu"
              aria-expanded={isUserMenuOpen}
              aria-label="Open user menu"
            >
              {userInitials}
            </button>

            {isUserMenuOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-14 z-30 w-44 rounded-2xl border border-[var(--border)] bg-white p-2 shadow-xl shadow-[rgba(15,23,42,0.12)]"
              >
                <Link
                  href="/settings"
                  role="menuitem"
                  className="block rounded-xl px-3 py-2 text-sm text-[var(--foreground)] transition hover:bg-slate-100"
                >
                  Settings
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleSignOut()}
                  className="mt-1 w-full rounded-xl px-3 py-2 text-left text-sm text-red-700 transition hover:bg-red-50"
                >
                  Log out
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <main className="flex-1 px-5 pb-4 md:px-6 md:pb-6">
          {children}
        </main>
      </div>

      {isSupportModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,17,40,0.55)] px-4"
          role="dialog"
          aria-modal="true"
          aria-label="Support request"
        >
          <div className="w-full max-w-xl rounded-3xl border border-[var(--border)] bg-white p-5 shadow-2xl shadow-[rgba(15,23,42,0.22)]">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Contact support</h2>
              <button
                type="button"
                onClick={() => setIsSupportModalOpen(false)}
                className="rounded-xl border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] transition hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <p className="mt-2 text-sm text-[var(--muted)]">
              Share what happened and we will receive it with your workspace context.
            </p>

            <form className="mt-4 space-y-3" onSubmit={(event) => void handleSupportSubmit(event)}>
              <label className="block space-y-1">
                <span className="text-sm font-medium text-[var(--foreground)]">Subject</span>
                <input
                  type="text"
                  value={supportSubject}
                  onChange={(event) => setSupportSubject(event.target.value)}
                  maxLength={140}
                  className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-slate-400"
                  placeholder="Short summary"
                  required
                />
              </label>

              <label className="block space-y-1">
                <span className="text-sm font-medium text-[var(--foreground)]">Message</span>
                <textarea
                  value={supportMessage}
                  onChange={(event) => setSupportMessage(event.target.value)}
                  minLength={10}
                  maxLength={4000}
                  rows={6}
                  className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-slate-400"
                  placeholder="What did you try, what happened, and what did you expect?"
                  required
                />
              </label>

              {supportStatus ? (
                <p className={`text-sm ${supportStatus.startsWith("Support request sent") ? "text-emerald-700" : "text-red-600"}`}>
                  {supportStatus}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsSupportModalOpen(false)}
                  className="rounded-xl border border-[var(--border)] px-4 py-2 text-sm text-[var(--muted)] transition hover:bg-slate-50"
                  disabled={isSendingSupport}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[rgba(59,130,246,0.2)] disabled:opacity-70"
                  disabled={isSendingSupport}
                >
                  {isSendingSupport ? "Sending..." : "Send request"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      <ChatAssistantWidget workspaceId={currentWorkspaceId} workspaceName={workspaceButtonLabel} />
    </div>
  );
}