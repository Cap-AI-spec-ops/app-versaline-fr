export type WorkspacePropertySummary = {
  id: string;
  label: string;
  transactionType: "sale" | "rent" | null;
  askingPrice: number | null;
  monthlyRent: number | null;
  linkedSellerContactId: string | null;
  linkedTenantContactId: string | null;
  reference: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  neighborhood: string | null;
  postalCode: string | null;
  propertyType: string | null;
  cadastreReference: string | null;
  rooms: number | null;
  bathrooms: number | null;
  loiCarrezSurfaceSqm: number | null;
  dpeEnergyRating: string | null;
  dpeClimateRating: string | null;
  imagePaths: string[];
  coverImagePath: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

function readString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readFirstString(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const parsed = readString(row[key]);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function readFirstNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const parsed = readNumber(row[key]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

export function mapWorkspaceProperty(row: Record<string, unknown>): WorkspacePropertySummary {
  const imagePaths = readStringArray(row.image_paths);
  const rawTransactionType = readFirstString(row, ["transaction_type", "listing_type"]);
  const transactionType = rawTransactionType === "sale" || rawTransactionType === "rent" ? rawTransactionType : null;

  return {
    id: readFirstString(row, ["id"]) ?? "",
    label: readFirstString(row, ["reference", "title", "name", "address_line1", "address", "street_address"]) ?? "Unnamed property",
    transactionType,
    askingPrice: readFirstNumber(row, [
      "asking_price",
      "listing_price",
      "sale_price",
      "price",
    ]),
    monthlyRent: readFirstNumber(row, ["monthly_rent", "rent_price"]),
    linkedSellerContactId: readFirstString(row, ["seller_contact_id"]),
    linkedTenantContactId: readFirstString(row, ["tenant_contact_id"]),
    reference: readFirstString(row, ["reference", "title", "name"]),
    addressLine1: readFirstString(row, ["address_line1", "address", "street_address"]),
    addressLine2: readFirstString(row, ["address_line2"]),
    city: readFirstString(row, ["city", "town"]),
    neighborhood: readFirstString(row, ["neighborhood", "district", "area"]),
    postalCode: readFirstString(row, ["postal_code", "zip_code", "zipcode"]),
    propertyType: readFirstString(row, ["property_type", "type"]),
    cadastreReference: readFirstString(row, ["cadastre_reference", "cadastre", "parcel_reference"]),
    rooms: readFirstNumber(row, ["rooms", "room_count", "bedrooms"]),
    bathrooms: readFirstNumber(row, ["bathrooms", "bathroom_count"]),
    loiCarrezSurfaceSqm: readFirstNumber(row, ["loi_carrez_surface_sqm", "carrez_surface", "surface_area", "surface"]),
    dpeEnergyRating: readFirstString(row, ["dpe_energy_rating", "dpe_rating", "energy_rating"]),
    dpeClimateRating: readFirstString(row, ["dpe_climate_rating", "ges_rating", "climate_rating"]),
    imagePaths,
    coverImagePath: readFirstString(row, ["cover_image_path"]) ?? imagePaths[0] ?? null,
    createdAt: readFirstString(row, ["created_at"]),
    updatedAt: readFirstString(row, ["updated_at"]),
  };
}
