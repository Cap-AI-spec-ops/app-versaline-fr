import PropertiesHub from "@/components/properties-hub";
import { requireUser } from "@/lib/auth/require-user";

export default async function PropertiesPage() {
  await requireUser("/properties");

  return <PropertiesHub />;
}