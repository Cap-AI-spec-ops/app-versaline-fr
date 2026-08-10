"use client";

import { useEffect, useMemo, useState } from "react";

import AdminSmsCallsSetupPanel from "@/components/admin-sms-calls-setup-panel";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

export default function SettingsTwilioSetupSlot() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const { currentRole, workspace } = useCurrentWorkspace();
  const [isEnabled, setIsEnabled] = useState(false);

  useEffect(() => {
    if (!supabase || !workspace?.id) {
      setIsEnabled(false);
      return;
    }

    let isMounted = true;

    void (async () => {
      try {
        const result = await supabase.rpc("get_effective_workspace_twilio_enabled", {
          p_workspace_id: workspace.id,
        });

        if (!isMounted) return;
        setIsEnabled(Boolean(result.data));
      } catch {
        if (!isMounted) return;
        setIsEnabled(false);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [supabase, workspace?.id]);

  const canConfigureChannels = currentRole === "team_lead" && isEnabled;

  const currentStateLabel = canConfigureChannels
    ? "Phone channels are ready to configure."
    : currentRole !== "team_lead"
      ? "This step is available to team leads only."
      : "Phone channels are currently disabled for this workspace.";

  const whyItMattersLabel = "SMS and call channels let your team respond faster when email is too slow for urgent conversations.";

  const nextActionLabel = canConfigureChannels
    ? "Complete sender setup, then run a test message and a test call."
    : currentRole !== "team_lead"
      ? "Ask a team lead to configure phone channels for this workspace."
      : "Ask an owner or admin to enable Twilio channels for this workspace.";

  return (
    <section className="settings-surface w-full space-y-4">
      <div className="settings-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Communication - Step 3</p>
        <h3 className="mt-2 text-xl font-semibold tracking-tight text-[var(--foreground)]">Configure SMS and calls</h3>
        <div className="mt-3 space-y-2 text-sm">
          <p className="text-[var(--foreground)]"><span className="font-semibold">Current state:</span> {currentStateLabel}</p>
          <p className="text-[var(--foreground)]"><span className="font-semibold">Why it matters:</span> {whyItMattersLabel}</p>
          <p className="text-[var(--foreground)]"><span className="font-semibold">Next action:</span> {nextActionLabel}</p>
        </div>
      </div>

      {canConfigureChannels ? <AdminSmsCallsSetupPanel /> : null}
    </section>
  );
}
