import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
} from "@react-pdf/renderer";

import type {
  AvenantData,
  BailLocationData,
  MandatRechercheData,
  MandatVenteData,
} from "@/lib/documents/schemas";
import { buildMandatVenteContractSections } from "@/lib/documents/mandat-vente-contract";

type BrandingLike = {
  agencyName: string;
  logoUrl?: string | null;
  primaryColor: string;
  accentColor: string;
  carteTNumber: string;
  carteTCci: string;
  siret: string;
  rcpPolicyNumber?: string | null;
  rcpInsurer: string;
  guarantorName?: string | null;
  guarantorAmountEur?: number | null;
};

type StandardPdfProps<TDocument> = {
  data: TDocument;
};

export function MandatVentePDF({ data }: StandardPdfProps<MandatVenteData>) {
  const contractSections = buildMandatVenteContractSections(data);

  return (
    <StandardDocumentLayout branding={data.workspaceBranding} title={data.title} subtitle="Mandat de vente">
      {contractSections.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text style={styles.sectionTitle}>{section.title}</Text>
          {section.paragraphs.map((paragraph, index) => (
            <Text key={`${section.title}-paragraph-${index}`} style={styles.contractParagraph}>
              {paragraph}
            </Text>
          ))}
          {(section.bulletLines ?? []).map((line, index) => (
            <Text key={`${section.title}-bullet-${index}`} style={styles.contractBullet}>
              {`- ${line}`}
            </Text>
          ))}
        </View>
      ))}
      {data.specialClauses.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Clauses particulieres</Text>
          {data.specialClauses.map((clause, index) => (
            <Text key={`special-clause-${index}`} style={styles.contractBullet}>
              {`- ${clause}`}
            </Text>
          ))}
        </View>
      ) : null}
    </StandardDocumentLayout>
  );
}

export function MandatRecherchePDF({ data }: StandardPdfProps<MandatRechercheData>) {
  return (
    <StandardDocumentLayout branding={data.workspaceBranding} title={data.title} subtitle="Mandat de recherche">
      <FactSection
        title="Mandant"
        rows={[
          ["Nom", data.buyer.fullName],
          ["Email", data.buyer.email ?? "Non renseigné"],
          ["Téléphone", data.buyer.phone ?? "Non renseigné"],
        ]}
      />
      <FactSection
        title="Recherche"
        rows={[
          ["Villes cibles", data.targetMarket.preferredCities.join(", ")],
          ["Budget maximum", formatEuro(data.targetMarket.budgetMaxEur)],
          ["Surface cible", data.targetMarket.targetSurfaceSqm ? `${data.targetMarket.targetSurfaceSqm} m²` : "Non renseignée"],
          ["Type de bien", data.targetMarket.targetPropertyType ?? "Libre"],
        ]}
      />
      <Text style={styles.blockText}>{buildClausesBlock(data.specialClauses)}</Text>
    </StandardDocumentLayout>
  );
}

export function BailLocationPDF({ data }: StandardPdfProps<BailLocationData>) {
  return (
    <StandardDocumentLayout branding={data.workspaceBranding} title={data.title} subtitle="Bail de location">
      <FactSection
        title="Parties"
        rows={[
          ["Bailleur", data.landlord.fullName],
          ["Locataire", data.tenant.fullName],
          ["Type de bail", data.bailType],
          ["Prise d'effet", data.leaseStartDate],
        ]}
      />
      <FactSection
        title="Bien loué"
        rows={[
          ["Adresse", `${data.property.addressLine1}, ${data.property.postalCode} ${data.property.city}`],
          ["Cadastre", data.property.cadastreReference ?? "Non renseigné"],
          ["Surface habitable", data.property.habitableSurfaceSqm ? `${data.property.habitableSurfaceSqm} m²` : "Non renseignée"],
          ["DPE", `${data.property.dpeEnergyRating} / ${data.property.dpeClimateRating}`],
        ]}
      />
      <FactSection
        title="Conditions locatives"
        rows={[
          ["Loyer HC", formatEuro(data.economics.monthlyRentExcludingChargesEur)],
          ["Charges", formatEuro(data.economics.monthlyChargesEur)],
          ["Dépôt de garantie", formatEuro(data.economics.securityDepositEur)],
          ["Durée", `${data.leaseDurationMonths} mois`],
        ]}
      />
      <Text style={styles.blockText}>{buildClausesBlock(data.specialClauses)}</Text>
    </StandardDocumentLayout>
  );
}

export function AvenantPDF({ data }: StandardPdfProps<AvenantData>) {
  return (
    <StandardDocumentLayout branding={data.workspaceBranding} title={data.title} subtitle="Avenant">
      <FactSection
        title="Avenant"
        rows={[
          ["Type", data.amendmentType],
          ["Partie principale", data.principalParty.fullName],
          ["Date d'effet", data.effectiveDate],
          ["Document parent", data.referenceDocumentId ?? "À rattacher"],
        ]}
      />
      <FactSection
        title="Synthèse"
        rows={[
          ["Avant", data.previousTermsSummary],
          ["Après", data.updatedTermsSummary],
        ]}
      />
      <Text style={styles.blockText}>{buildClausesBlock(data.specialClauses)}</Text>
    </StandardDocumentLayout>
  );
}

function StandardDocumentLayout(options: {
  branding: BrandingLike;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const styles = createStyles(options.branding);
  const rcpLine = options.branding.rcpPolicyNumber
    ? `SIRET ${options.branding.siret} · RCP ${options.branding.rcpInsurer} / ${options.branding.rcpPolicyNumber}`
    : `SIRET ${options.branding.siret} · RCP ${options.branding.rcpInsurer}`;
  const guaranteeLine =
    options.branding.guarantorName && typeof options.branding.guarantorAmountEur === "number"
      ? `Garantie financière ${options.branding.guarantorName} · ${formatEuro(options.branding.guarantorAmountEur)}`
      : null;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{options.subtitle}</Text>
            <Text style={styles.title}>{options.title}</Text>
            <Text style={styles.company}>{options.branding.agencyName}</Text>
          </View>
          {options.branding.logoUrl ? <Image src={options.branding.logoUrl} style={styles.logo} /> : null}
        </View>
        <View style={styles.body}>{options.children}</View>
        <View style={styles.footer}>
          <Text>
            Carte T {options.branding.carteTNumber} · {options.branding.carteTCci}
          </Text>
          <Text>{rcpLine}</Text>
          {guaranteeLine ? <Text>{guaranteeLine}</Text> : null}
        </View>
      </Page>
    </Document>
  );
}

function FactSection(options: { title: string; rows: Array<[string, string]> }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{options.title}</Text>
      {options.rows.map(([label, value]) => (
        <View key={`${options.title}-${label}`} style={styles.factRow}>
          <Text style={styles.factLabel}>{label}</Text>
          <Text style={styles.factValue}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

function buildClausesBlock(clauses: string[]) {
  if (clauses.length === 0) {
    return "Aucune clause particulière renseignée.";
  }

  return `Clauses particulières : ${clauses.join(" ")}`;
}

function formatEuro(amount: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(amount);
}

function createStyles(branding: BrandingLike) {
  return StyleSheet.create({
    page: {
      backgroundColor: "#FFFFFF",
      color: "#0F172A",
      fontSize: 11,
      paddingHorizontal: 36,
      paddingVertical: 32,
    },
    header: {
      alignItems: "flex-start",
      borderBottomColor: branding.accentColor,
      borderBottomWidth: 2,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingBottom: 16,
    },
    headerCopy: {
      flexGrow: 1,
      flexShrink: 1,
      gap: 4,
    },
    eyebrow: {
      color: branding.accentColor,
      fontSize: 9,
      textTransform: "uppercase",
    },
    title: {
      color: branding.primaryColor,
      fontSize: 22,
      fontWeight: 700,
    },
    company: {
      color: "#334155",
      fontSize: 11,
    },
    logo: {
      height: 54,
      objectFit: "contain",
      width: 120,
    },
    body: {
      gap: 14,
      paddingTop: 18,
    },
    footer: {
      borderTopColor: "#CBD5E1",
      borderTopWidth: 1,
      color: "#475569",
      fontSize: 9,
      gap: 2,
      marginTop: 18,
      paddingTop: 12,
    },
  });
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: "#F8FAFC",
    borderColor: "#E2E8F0",
    borderRadius: 12,
    borderWidth: 1,
    gap: 6,
    padding: 14,
  },
  sectionTitle: {
    color: "#0F172A",
    fontSize: 12,
    fontWeight: 700,
    marginBottom: 4,
  },
  factRow: {
    flexDirection: "row",
    gap: 8,
  },
  factLabel: {
    color: "#475569",
    width: 140,
  },
  factValue: {
    color: "#0F172A",
    flexGrow: 1,
    flexShrink: 1,
  },
  blockText: {
    color: "#0F172A",
    fontSize: 10,
    lineHeight: 1.5,
  },
  contractParagraph: {
    color: "#0F172A",
    fontSize: 10,
    lineHeight: 1.45,
  },
  contractBullet: {
    color: "#0F172A",
    fontSize: 10,
    lineHeight: 1.4,
    marginLeft: 4,
  },
});