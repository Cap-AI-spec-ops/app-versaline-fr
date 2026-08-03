import DailyBriefingSettingsPanel from "@/components/daily-briefing-settings-panel";
import { requireUser } from "@/lib/auth/require-user";

export default async function DailyBriefingSettingsPage() {
  await requireUser("/settings/daily-briefing");

  return <DailyBriefingSettingsPanel />;
}
