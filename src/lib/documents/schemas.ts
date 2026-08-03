import { z } from "zod";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected date format YYYY-MM-DD.");
const trimmedStringSchema = z.string().trim().min(1);
const optionalTrimmedStringSchema = z.string().trim().optional().nullable();
const currencyAmountSchema = z.number().finite().nonnegative();
const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/u, "Expected a 6-digit hex color.");
const ratingSchema = z.enum(["A", "B", "C", "D", "E", "F", "G", "N/A"]);

export const documentTypeSchema = z.enum([
  "mandat_vente",
  "mandat_recherche",
  "bail_location",
  "avenant",
]);
export const templateSourceSchema = z.enum(["versaline_standard", "agency_custom"]);
export const mandateTypeSchema = z.enum(["simple", "exclusif", "semi_exclusif"]);
export const bailTypeSchema = z.enum(["habitation_vide", "habitation_meublee"]);
export const amendmentTypeSchema = z.enum(["price_drop", "extension", "fee_adjustment"]);
export const feePayerSchema = z.enum([
  "charge_vendeur",
  "charge_acquereur",
  "charge_bailleur",
  "charge_locataire",
  "partage",
]);

export const workspaceBrandingSchema = z.object({
  agencyName: trimmedStringSchema,
  logoUrl: optionalTrimmedStringSchema,
  primaryColor: hexColorSchema.default("#000000"),
  accentColor: hexColorSchema.default("#3B82F6"),
  carteTNumber: trimmedStringSchema,
  carteTCci: trimmedStringSchema,
  siret: trimmedStringSchema,
  rcpPolicyNumber: optionalTrimmedStringSchema,
  rcpInsurer: trimmedStringSchema,
  guarantorName: optionalTrimmedStringSchema,
  guarantorAmountEur: currencyAmountSchema.optional().nullable(),
}).strict();

export const partySchema = z.object({
  fullName: trimmedStringSchema,
  email: z.string().email().optional().nullable(),
  phone: optionalTrimmedStringSchema,
  address: optionalTrimmedStringSchema,
  companyName: optionalTrimmedStringSchema,
}).strict();

export const frenchPropertySchema = z.object({
  reference: optionalTrimmedStringSchema,
  addressLine1: trimmedStringSchema,
  addressLine2: optionalTrimmedStringSchema,
  postalCode: trimmedStringSchema,
  city: trimmedStringSchema,
  cadastreReference: optionalTrimmedStringSchema,
  propertyType: optionalTrimmedStringSchema,
  loiCarrezSurfaceSqm: z.number().finite().positive(),
  habitableSurfaceSqm: z.number().finite().positive().optional().nullable(),
  dpeEnergyRating: ratingSchema,
  dpeClimateRating: ratingSchema,
  furnishedInventoryIncluded: z.boolean().optional(),
}).strict();

export const coolingOffSchema = z.object({
  consumerInformationDelivered: z.boolean(),
  coolingOffPeriodDays: z.number().int().min(14).default(14),
}).strict();

export const saleEconomicsSchema = z.object({
  listingPriceEur: currencyAmountSchema,
  netSellerPriceEur: currencyAmountSchema,
  agencyFeesEur: currencyAmountSchema,
  agencyFeesVatRate: z.number().finite().min(0).max(100).optional().nullable(),
  feePayer: feePayerSchema,
}).strict();

export const rentalEconomicsSchema = z.object({
  monthlyRentExcludingChargesEur: currencyAmountSchema,
  monthlyChargesEur: currencyAmountSchema,
  securityDepositEur: currencyAmountSchema,
  agencyFeesEur: currencyAmountSchema,
  inventoryFeesEur: currencyAmountSchema.optional().nullable(),
  feePayer: feePayerSchema,
}).strict();

export const mandateTimingSchema = z.object({
  signatureDate: isoDateSchema,
  effectiveDate: isoDateSchema,
  expirationDate: isoDateSchema,
  tacitRenewalAllowed: z.boolean(),
}).strict();

export const sharedDocumentMetaSchema = z.object({
  countryCode: z.string().trim().length(2).default("FR"),
  jurisdiction: trimmedStringSchema.default("france"),
  templateVersion: trimmedStringSchema.default("v1"),
  templateSource: templateSourceSchema,
  title: trimmedStringSchema,
  specialClauses: z.array(trimmedStringSchema).default([]),
}).strict();

export const MandatVenteSchema = sharedDocumentMetaSchema.extend({
  type: z.literal("mandat_vente"),
  mandateType: mandateTypeSchema,
  workspaceBranding: workspaceBrandingSchema,
  principalSeller: partySchema,
  coSellers: z.array(partySchema).default([]),
  property: frenchPropertySchema,
  economics: saleEconomicsSchema,
  marketingCommitments: z.array(trimmedStringSchema).min(1),
  coolingOff: coolingOffSchema,
  mandateTiming: mandateTimingSchema,
}).strict();

export const MandatRechercheSchema = sharedDocumentMetaSchema.extend({
  type: z.literal("mandat_recherche"),
  workspaceBranding: workspaceBrandingSchema,
  buyer: partySchema,
  searchMandateType: mandateTypeSchema.default("simple"),
  targetMarket: z.object({
    preferredCities: z.array(trimmedStringSchema).min(1),
    budgetMaxEur: currencyAmountSchema,
    targetSurfaceSqm: z.number().finite().positive().optional().nullable(),
    targetPropertyType: optionalTrimmedStringSchema,
  }).strict(),
  economics: z.object({
    agencyFeesEur: currencyAmountSchema,
    feePayer: feePayerSchema,
  }).strict(),
  marketingCommitments: z.array(trimmedStringSchema).min(1),
  coolingOff: coolingOffSchema,
  mandateTiming: mandateTimingSchema,
}).strict();

export const BailLocationSchema = sharedDocumentMetaSchema.extend({
  type: z.literal("bail_location"),
  bailType: bailTypeSchema,
  workspaceBranding: workspaceBrandingSchema,
  landlord: partySchema,
  tenant: partySchema,
  property: frenchPropertySchema,
  economics: rentalEconomicsSchema,
  leaseStartDate: isoDateSchema,
  leaseDurationMonths: z.number().int().positive(),
  alurDisclosures: z.object({
    dpeAttached: z.boolean(),
    erpAttached: z.boolean(),
    inventoryPlanned: z.boolean(),
    marketingCommitments: z.array(trimmedStringSchema).min(1),
  }).strict(),
}).strict();

export const AvenantSchema = sharedDocumentMetaSchema.extend({
  type: z.literal("avenant"),
  amendmentType: amendmentTypeSchema,
  workspaceBranding: workspaceBrandingSchema,
  referenceDocumentId: z.string().uuid().optional().nullable(),
  principalParty: partySchema,
  property: frenchPropertySchema.optional(),
  previousTermsSummary: trimmedStringSchema,
  updatedTermsSummary: trimmedStringSchema,
  effectiveDate: isoDateSchema,
  economics: saleEconomicsSchema.partial().optional(),
  coolingOff: coolingOffSchema.optional(),
}).strict();

export const supportedDocumentSchema = z.discriminatedUnion("type", [
  MandatVenteSchema,
  MandatRechercheSchema,
  BailLocationSchema,
  AvenantSchema,
]);

export type DocumentType = z.infer<typeof documentTypeSchema>;
export type TemplateSource = z.infer<typeof templateSourceSchema>;
export type MandatVenteData = z.infer<typeof MandatVenteSchema>;
export type MandatRechercheData = z.infer<typeof MandatRechercheSchema>;
export type BailLocationData = z.infer<typeof BailLocationSchema>;
export type AvenantData = z.infer<typeof AvenantSchema>;
export type SupportedDocumentData = z.infer<typeof supportedDocumentSchema>;

const documentSchemaByType = {
  mandat_vente: MandatVenteSchema,
  mandat_recherche: MandatRechercheSchema,
  bail_location: BailLocationSchema,
  avenant: AvenantSchema,
} as const;

export function parseDocumentData<TType extends DocumentType>(
  type: TType,
  payload: unknown,
) {
  return documentSchemaByType[type].parse(payload);
}