import MfaSettingsPanel from "@/components/mfa-settings-panel";
import DailyBriefingSettingsPanel from "@/components/daily-briefing-settings-panel";
import MailboxSettingsPanel from "@/components/mailbox-settings-panel";
import SettingsTwilioSetupSlot from "@/components/settings-twilio-setup-slot";
import SettingsCategoriesMap from "@/components/settings-categories-map";
import { requireUser } from "@/lib/auth/require-user";

export default async function SettingsPage() {
  await requireUser("/settings");

  return (
    <div className="space-y-6">
      <SettingsCategoriesMap />

      <div id="profile-account-settings" className="scroll-mt-24" />
      <div id="workspace-settings" className="scroll-mt-24" />

      <MfaSettingsPanel showCommunicationShortcuts={false} showSecurityCard={false} />

      <div id="mailbox-settings-inline" className="scroll-mt-24">
        <MailboxSettingsPanel embedded />
      </div>

      <div id="daily-briefing-settings-inline" className="scroll-mt-24">
        <DailyBriefingSettingsPanel embedded />
      </div>

      <div id="phone-channel-settings-inline" className="scroll-mt-24">
        <SettingsTwilioSetupSlot />
      </div>

      <div id="security-settings-inline" className="scroll-mt-24">
        <MfaSettingsPanel onlySecurityCard />
      </div>
    </div>
  );
}