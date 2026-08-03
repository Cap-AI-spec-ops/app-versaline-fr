import FeaturePageShell from "@/components/feature-page-shell";
import PropertyDescriptionPanel from "@/components/property-description-panel";
import { requireUser } from "@/lib/auth/require-user";

export default async function ListingDescriptionPage() {
  await requireUser("/properties/listing-description");

  return (
    <FeaturePageShell backHref="/properties" backLabel="Back to properties">
      <PropertyDescriptionPanel />
    </FeaturePageShell>
  );
}
