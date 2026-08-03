import AdminManagementPanel from "@/components/admin-management-panel";
import { requireAdmin } from "@/lib/auth/require-admin";

export default async function AdminPage() {
  await requireAdmin("/admin");

  return <AdminManagementPanel />;
}
