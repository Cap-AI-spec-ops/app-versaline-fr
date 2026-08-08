import InboxPanel from "@/components/inbox-panel";
import { requireUser } from "@/lib/auth/require-user";

export default async function InboxPage() {
  await requireUser("/inbox");

  return <InboxPanel />;
}