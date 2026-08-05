import FeaturePageShell from "@/components/feature-page-shell";
import PropertyInventoryPanel from "@/components/property-inventory-panel";
import { requireUser } from "@/lib/auth/require-user";

export default async function InventoryPage() {
  await requireUser("/properties/inventory");

  return (
    <FeaturePageShell backHref="/properties" backLabel="Back to properties">
      <PropertyInventoryPanel />
    </FeaturePageShell>
  );
}
