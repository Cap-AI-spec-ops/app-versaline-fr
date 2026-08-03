import CrmArchiveTable from "@/components/crm-archive-table";
import { requireUser } from "@/lib/auth/require-user";

export default async function ContactsArchivePage() {
  await requireUser("/contacts/archive");

  return <CrmArchiveTable />;
}
