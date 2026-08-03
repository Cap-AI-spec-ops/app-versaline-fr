import MailboxSettingsPanel from "@/components/mailbox-settings-panel";
import { requireUser } from "@/lib/auth/require-user";

export default async function MailboxSettingsPage() {
  await requireUser("/settings/mailbox");

  return <MailboxSettingsPanel />;
}
