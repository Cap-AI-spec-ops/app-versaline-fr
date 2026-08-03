import type { MarketContext } from "@/lib/market/context";

export type ListingDescriptionTone = "professional" | "warm" | "premium" | "concise";
export type ListingDescriptionLength = "short" | "medium" | "long";

export type ListingDisclosureDetails = {
  dpeEnergyClass?: string;
  dpeClimateClass?: string;
  feePrice?: string;
  feeCharge?: string;
  coOwnershipLotNumber?: string;
  coOwnershipAnnualCharges?: string;
};

export type ListingDescriptionDraft = {
  title: string;
  description: string;
  bulletPoints: string[];
  secondaryTitle?: string;
  secondaryDescription?: string;
  secondaryBulletPoints?: string[];
  metadata: {
    language: string;
    countryCode: string;
    locale: string;
    timezone: string;
    imageCount: number;
  };
};

export type ListingDescriptionPromptInput = {
  market: MarketContext;
  propertyType: string;
  transactionType: "sale" | "rent";
  descriptionLength: ListingDescriptionLength;
  city: string;
  neighborhood: string;
  rooms: string;
  bathrooms: string;
  surfaceArea: string;
  surfaceUnit: string;
  highlights: string[];
  notes: string;
  tone: ListingDescriptionTone;
  imageCount: number;
  imageNames: string[];
  disclosures?: ListingDisclosureDetails;
  secondaryLanguage?: string | null;
};

export function buildListingDescriptionPrompt(input: ListingDescriptionPromptInput) {
  const lengthInstruction = buildLengthInstruction(input.descriptionLength);

  const lines = [
    "You are a senior real-estate copywriter.",
    "Analyze every uploaded property photo before writing the description.",
    "Do not ask the agent to write the listing manually.",
    `Write in ${input.market.language} for the ${input.market.countryCode} market and respect the locale ${input.market.locale}.`,
    `Primary output language rule: title, description, and bulletPoints must be fully in ${input.market.language} only.`,
    "Never mix multiple languages in the same primary field.",
    "Do not output English words/sentences unless the primary language is English.",
    `Timezone context: ${input.market.timezone}.`,
    `Tone: ${input.tone}.`,
    `Length requirement: ${lengthInstruction}`,
    "Only describe details that are visible in the photos or explicitly provided in the facts below.",
    "Do not invent amenities, room counts, or location details.",
    "Return valid JSON only with this shape: {\"title\": string, \"description\": string, \"bulletPoints\": string[] }.",
    "The title should be concise and market-ready.",
    "The description should read like a polished listing description, not a prompt.",
    "Bullet points should contain the most useful buyer-facing highlights.",
    input.secondaryLanguage
      ? `Also provide secondary-language fields named secondaryTitle, secondaryDescription, and secondaryBulletPoints in ${input.secondaryLanguage} so the user gets a bilingual output.`
      : "Do not add secondary-language fields if translation is not requested.",
    "If disclosure details are provided, append them as a short closing sentence or paragraph in the description.",
    "",
    "Property facts:",
    `- Property type: ${input.propertyType}`,
    `- Listing type: ${input.transactionType === "sale" ? "For sale" : "For rent"}`,
    `- City: ${input.city || ""}`,
    `- Neighborhood: ${input.neighborhood || ""}`,
    `- Rooms: ${input.rooms || ""}`,
    `- Bathrooms: ${input.bathrooms || ""}`,
    `- Surface area: ${input.surfaceArea || ""} ${input.surfaceUnit || ""}`,
    `- Highlights: ${input.highlights.length > 0 ? input.highlights.join(" | ") : "None provided"}`,
    `- Notes: ${input.notes || "None provided"}`,
    `- Uploaded photos: ${input.imageCount}`,
    `- Photo filenames: ${input.imageNames.length > 0 ? input.imageNames.join(", ") : "None"}`,
  ];

  const disclosureLines = buildDisclosurePromptLines(input.disclosures);

  if (disclosureLines.length > 0) {
    lines.push("", "Disclosure details to include when provided:", ...disclosureLines);
  }

  return lines.join("\n");
}

export function normalizeListingDescriptionDraft(value: unknown, market: MarketContext, imageCount: number, disclosures?: ListingDisclosureDetails): ListingDescriptionDraft {
  if (!value || typeof value !== "object") {
    throw new Error("Listing description response is empty");
  }

  const candidate = value as Record<string, unknown>;
  const title = readString(candidate.title);
  const description = readString(candidate.description);
  const bulletPoints = readStringArray(candidate.bulletPoints);
  const secondaryTitle = readString(candidate.secondaryTitle);
  const secondaryDescription = readString(candidate.secondaryDescription);
  const secondaryBulletPoints = readStringArray(candidate.secondaryBulletPoints);

  if (!title || !description || bulletPoints.length === 0) {
    throw new Error("Listing description response is missing required fields");
  }

  return {
    title,
    description,
    bulletPoints,
    secondaryTitle: secondaryTitle || undefined,
    secondaryDescription: secondaryDescription || undefined,
    secondaryBulletPoints: secondaryBulletPoints.length > 0 ? secondaryBulletPoints : undefined,
    metadata: {
      language: market.language,
      countryCode: market.countryCode,
      locale: market.locale,
      timezone: market.timezone,
      imageCount,
    },
  };
}

function buildLengthInstruction(length: ListingDescriptionLength) {
  if (length === "short") {
    return "Write a short description (about 70-110 words) and 4-6 bullet points.";
  }

  if (length === "long") {
    return "Write a long description (about 180-260 words) and 6-9 bullet points.";
  }

  return "Write a medium description (about 120-170 words) and 5-7 bullet points.";
}

function buildDisclosurePromptLines(disclosures?: ListingDisclosureDetails) {
  const lines: string[] = [];
  const dpeEnergyClass = normalizeOptionalText(disclosures?.dpeEnergyClass);
  const dpeClimateClass = normalizeOptionalText(disclosures?.dpeClimateClass);
  const feePrice = normalizeOptionalText(disclosures?.feePrice);
  const feeCharge = normalizeOptionalText(disclosures?.feeCharge);
  const coOwnershipLotNumber = normalizeOptionalText(disclosures?.coOwnershipLotNumber);
  const coOwnershipAnnualCharges = normalizeOptionalText(disclosures?.coOwnershipAnnualCharges);

  if (dpeEnergyClass || dpeClimateClass) {
    const energyText = dpeEnergyClass ? `DPE class ${dpeEnergyClass}` : "DPE class not specified";
    const climateText = dpeClimateClass ? `GES class ${dpeClimateClass}` : "GES class not specified";
    lines.push(`- Energy performance disclosure: ${energyText} - ${climateText}`);
  }

  if (feePrice || feeCharge) {
    const feeText = feePrice ? `Price: ${feePrice}` : "Price disclosed";
    const feeChargeText = feeCharge ? `Fees at the ${feeCharge.toLowerCase() === "buyer" ? "buyer's" : "seller's"} expense` : "Fees responsibility not specified";
    lines.push(`- Fee transparency disclosure: ${feeText} - ${feeChargeText}`);
  }

  if (coOwnershipLotNumber || coOwnershipAnnualCharges) {
    const lotText = coOwnershipLotNumber ? `Lot number: ${coOwnershipLotNumber}` : "Lot number not specified";
    const chargesText = coOwnershipAnnualCharges ? `Annual charges: ${coOwnershipAnnualCharges}` : "Annual charges not specified";
    lines.push(`- Co-ownership disclosure: ${lotText} - ${chargesText}`);
  }

  return lines;
}

function normalizeOptionalText(value?: string) {
  return typeof value === "string" ? value.trim() : "";
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}
