import FeaturePageShell from "@/components/feature-page-shell";
import PropertyDetailsPanel from "@/components/property-details-panel";
import { requireUser } from "@/lib/auth/require-user";

type PropertyDetailsPageProps = {
  params: Promise<{
    propertyId: string;
  }>;
};

export default async function PropertyDetailsPage({ params }: PropertyDetailsPageProps) {
  await requireUser("/properties");

  const resolved = await params;

  return (
    <FeaturePageShell backHref="/properties" backLabel="Back to properties">
      <PropertyDetailsPanel propertyId={resolved.propertyId} />
    </FeaturePageShell>
  );
}
