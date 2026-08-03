import DocumentGeneratorPanel from "@/components/document-generator-panel";
import { requireUser } from "@/lib/auth/require-user";

export default async function MandatVenteGeneratorPage() {
  await requireUser("/document-generator/mandat-vente");

  return <DocumentGeneratorPanel />;
}