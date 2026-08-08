import MfaSettingsPanel from "@/components/mfa-settings-panel";
import SettingsTwilioSetupSlot from "@/components/settings-twilio-setup-slot";
import { requireUser } from "@/lib/auth/require-user";

export default async function SettingsPage() {
  await requireUser("/settings");

  return (
    <div className="space-y-6">
      <MfaSettingsPanel />
      <SettingsTwilioSetupSlot />
    </div>
  );
}