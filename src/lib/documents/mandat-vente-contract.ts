import type { MandatVenteData } from "@/lib/documents/schemas";

export type MandatVenteContractSection = {
  title: string;
  paragraphs: string[];
  bulletLines?: string[];
};

export function buildMandatVenteContractSections(data: MandatVenteData): MandatVenteContractSection[] {
  const mandateTypeLabel = mapMandateType(data.mandateType);
  const sellerAddress = valueOrPlaceholder(data.principalSeller.address, "adresse du mandant");
  const sellerEmail = valueOrPlaceholder(data.principalSeller.email, "email du mandant");
  const sellerPhone = valueOrPlaceholder(data.principalSeller.phone, "telephone du mandant");
  const propertyLabel = `${data.property.addressLine1}, ${data.property.postalCode} ${data.property.city}`;
  const propertyType = valueOrPlaceholder(data.property.propertyType, "type de bien");
  const cadastre = valueOrPlaceholder(data.property.cadastreReference, "references cadastrales");
  const loiCarrez = `${formatNumber(data.property.loiCarrezSurfaceSqm)} m2`;
  const habitableSurface = data.property.habitableSurfaceSqm
    ? `${formatNumber(data.property.habitableSurfaceSqm)} m2`
    : "[A COMPLETER: surface habitable]";
  const propertyReference = valueOrPlaceholder(data.property.reference, "reference bien");
  const chargeLabel = mapFeePayer(data.economics.feePayer);
  const agencyName = valueOrPlaceholder(data.workspaceBranding.agencyName, "nom de l'agence");
  const rcpPolicyNumber = valueOrPlaceholder(data.workspaceBranding.rcpPolicyNumber, "numero de police RCP");
  const guarantorName = valueOrPlaceholder(data.workspaceBranding.guarantorName, "organisme de garantie financiere");
  const guarantorAmount =
    typeof data.workspaceBranding.guarantorAmountEur === "number"
      ? formatEuro(data.workspaceBranding.guarantorAmountEur)
      : "[A COMPLETER: montant garantie financiere]";
  const marketingCommitments =
    data.marketingCommitments.length > 0
      ? data.marketingCommitments
      : ["[A COMPLETER: missions du mandataire]"];
  const signatureDate = formatDateFr(data.mandateTiming.signatureDate);
  const effectiveDate = formatDateFr(data.mandateTiming.effectiveDate);
  const expirationDate = formatDateFr(data.mandateTiming.expirationDate);
  const tacitRenewal = data.mandateTiming.tacitRenewalAllowed ? "avec" : "sans";

  return [
    {
      title: "Parties",
      paragraphs: [
        `Le present contrat de mandat de vente ${mandateTypeLabel.toLowerCase()} est conclu entre les soussignes :`,
        `${data.principalSeller.fullName}, demeurant ${sellerAddress}, email ${sellerEmail}, telephone ${sellerPhone}.`,
        "Designe ci-apres le Mandant.",
        `${agencyName}, titulaire de la carte professionnelle transactions sur immeubles et fonds de commerce numero ${valueOrPlaceholder(data.workspaceBranding.carteTNumber, "numero carte T")}, delivree par ${valueOrPlaceholder(data.workspaceBranding.carteTCci, "CCI")}, immatriculee sous le numero SIRET ${valueOrPlaceholder(data.workspaceBranding.siret, "SIRET")}, assuree en responsabilite civile professionnelle aupres de ${valueOrPlaceholder(data.workspaceBranding.rcpInsurer, "assureur RCP")} sous la police ${rcpPolicyNumber}, garantie financiere par ${guarantorName} pour un montant de ${guarantorAmount}.`,
        "Designe ci-apres le Mandataire.",
        "Les parties confirment l'exactitude des indications les concernant et declarent disposer de leur pleine capacite pour contracter.",
      ],
    },
    {
      title: "Article 1 - Objet du contrat",
      paragraphs: [
        "Par les presentes, le Mandant confere au Mandataire, qui accepte, mandat de vendre au mieux de ses interets les biens et droits immobiliers ci-apres designes.",
      ],
    },
    {
      title: "Article 2 - Designation des biens et droits immobiliers",
      paragraphs: [
        "Le bien objet du mandat est decrit comme suit :",
      ],
      bulletLines: [
        `Adresse: ${propertyLabel}`,
        `Reference du bien: ${propertyReference}`,
        `Nature du bien: ${propertyType}`,
        `References cadastrales: ${cadastre}`,
        `Surface Loi Carrez: ${loiCarrez}`,
        `Surface habitable: ${habitableSurface}`,
        `DPE energie / climat: ${data.property.dpeEnergyRating} / ${data.property.dpeClimateRating}`,
        "Autres elements, annexes, equipements, servitudes ou hypotheques: [A COMPLETER].",
      ],
    },
    {
      title: "Article 3 - Origine de propriete",
      paragraphs: [
        "Le Mandant s'engage a indiquer l'origine de propriete du bien et, le cas echeant, la date du precedent acte de vente, l'identite du precedent proprietaire et les references notariales utiles.",
        "Le Mandant remettra au notaire redacteur de l'acte authentique tout document necessaire a la realisation de la vente.",
      ],
    },
    {
      title: "Article 4 - Jouissance",
      paragraphs: [
        `A la date de signature de l'acte authentique, le bien sera: [A COMPLETER: libre, libre a compter du..., loue, etc.]. La prise d'effet du present mandat est fixee au ${effectiveDate}.`,
      ],
    },
    {
      title: "Article 5 - Obligations du Mandataire",
      paragraphs: [
        "Le Mandataire a pour mission de rechercher un acquereur et de parvenir a la vente du bien. Il agit avec soin, competence et professionnalisme dans la promotion et la vente du bien.",
        "Conformement au present mandat, le Mandataire s'acquittera notamment des missions suivantes:",
      ],
      bulletLines: marketingCommitments,
    },
    {
      title: "Article 6 - Obligations du Mandant",
      paragraphs: [
        "Le Mandant s'oblige a faciliter l'execution de la mission du Mandataire et a communiquer sans delai toute information utile a la vente.",
        "Il autorise le Mandataire a faire visiter le bien a tout acquereur potentiel, selon des modalites raisonnables a convenir entre les parties.",
        "Le Mandant conserve la garde du bien jusqu'a la realisation de la vente et veille a sa bonne conservation, notamment par la souscription des assurances necessaires.",
      ],
    },
    {
      title: "Article 7 - Prix de vente",
      paragraphs: [
        `La vente ne pourra se conclure pour un montant inferieur a ${formatEuro(data.economics.listingPriceEur)}.`,
        `Le prix se decompose comme suit: prix net vendeur ${formatEuro(data.economics.netSellerPriceEur)} et remuneration de l'agence ${formatEuro(data.economics.agencyFeesEur)}.`,
      ],
    },
    {
      title: "Article 8 - Remuneration du Mandataire",
      paragraphs: [
        `En cas de realisation de la vente avec un acheteur presente par le Mandataire, le Mandant s'oblige a payer une remuneration TTC de ${formatEuro(data.economics.agencyFeesEur)}.`,
        `Cette remuneration est a la charge ${chargeLabel}. Elle est exigible au jour de la signature de l'acte authentique constatant la vente.`,
      ],
    },
    {
      title: "Article 9 - Duree - Resiliation - Reconduction",
      paragraphs: [
        `Le present mandat est consenti a compter du ${signatureDate} jusqu'au ${expirationDate}.`,
        "En cas d'inexecution contractuelle, la resiliation pourra intervenir apres mise en demeure adressee par lettre recommandee avec accuse de reception, restee sans effet.",
        `Le mandat est prevu ${tacitRenewal} reconduction tacite, dans les conditions legalement admises et pour une duree maximale a preciser.`,
        `Le Mandant dispose d'un delai de retractation de ${data.coolingOff.coolingOffPeriodDays} jours, a exercer par lettre recommandee avec accuse de reception.`,
      ],
    },
    {
      title: "Article 10 - Droit de preemption",
      paragraphs: [
        "Le bien est soumis ou non a un droit de preemption selon la reglementation applicable. Les parties completent ce point avant signature definitive: [A COMPLETER].",
      ],
    },
    {
      title: "Article 11 - Force majeure",
      paragraphs: [
        "Aucune des parties ne pourra etre tenue responsable d'un evenement de force majeure imprevisible, irresistible et exterieur echappant a sa volonte. La partie concernee en informera l'autre sans delai.",
      ],
    },
    {
      title: "Article 12 - Election de domicile",
      paragraphs: [
        "Pour l'execution du present contrat et de ses suites, les parties elisent domicile a leurs adresses respectives, sauf stipulation contraire expresse.",
        "Fait a [A COMPLETER: ville], le [A COMPLETER: date], en [A COMPLETER: nombre] exemplaires originaux.",
      ],
    },
    {
      title: "Signatures",
      paragraphs: [
        "Le Mandataire: ____________________",
        "Le Mandant: ____________________",
      ],
    },
  ];
}

function mapMandateType(value: MandatVenteData["mandateType"]) {
  if (value === "exclusif") {
    return "Exclusif";
  }

  if (value === "semi_exclusif") {
    return "Semi-exclusif";
  }

  return "Simple";
}

function mapFeePayer(value: MandatVenteData["economics"]["feePayer"]) {
  if (value === "charge_acquereur") {
    return "de l'acquereur";
  }

  if (value === "partage") {
    return "du vendeur et de l'acquereur";
  }

  return "du vendeur";
}

function valueOrPlaceholder(value: string | null | undefined, placeholder: string) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `[A COMPLETER: ${placeholder}]`;
}

function formatDateFr(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);

  if (Number.isNaN(date.valueOf())) {
    return isoDate;
  }

  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: 2,
  }).format(value);
}

function formatEuro(amount: number) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(amount);
}
