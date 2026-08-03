import AdminEmailPolicyPanel from "@/components/admin-email-policy-panel";
import { requireAdmin } from "@/lib/auth/require-admin";

export default async function AdminEmailPolicyPage() {
  await requireAdmin("/admin/email-policy");

  return <AdminEmailPolicyPanel />;
}
