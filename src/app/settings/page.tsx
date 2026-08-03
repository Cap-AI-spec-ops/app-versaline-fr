import MfaSettingsPanel from "@/components/mfa-settings-panel";
import { requireUser } from "@/lib/auth/require-user";

export default async function SettingsPage() {
  await requireUser("/settings");

  return <MfaSettingsPanel />;
}