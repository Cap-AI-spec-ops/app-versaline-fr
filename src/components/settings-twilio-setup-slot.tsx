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
    if (!supabase || currentRole !== "team_lead" || !workspace?.id) {
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
  }, [supabase, currentRole, workspace?.id]);

  if (currentRole !== "team_lead") {
    return null;
  }

  if (!isEnabled) {
    return null;
  }

  return <AdminSmsCallsSetupPanel />;
}
