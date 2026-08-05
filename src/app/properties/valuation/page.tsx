import FeaturePageShell from "@/components/feature-page-shell";
import PropertyValuationPanel from "@/components/property-valuation-panel";
import { requireUser } from "@/lib/auth/require-user";

export default async function ValuationPage() {
  await requireUser("/properties/valuation");

  return (
    <FeaturePageShell backHref="/properties" backLabel="Back to properties">
      <PropertyValuationPanel />
    </FeaturePageShell>
  );
}
