import CrmBoard from "@/components/crm-board";
import { requireUser } from "@/lib/auth/require-user";

export default async function ContactsPage() {
  await requireUser("/contacts");

  return <CrmBoard />;
}