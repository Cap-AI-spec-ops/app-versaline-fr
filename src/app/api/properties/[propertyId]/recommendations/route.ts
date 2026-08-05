import { NextRequest, NextResponse } from "next/server";

import { mapWorkspaceProperty, readFirstNumber, readFirstString } from "@/lib/properties/workspace-properties";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type ContactRole = "buyer" | "seller" | "tenant" | "landlord" | "investor" | "other";
type ContactStage = "new_lead" | "qualified" | "viewing" | "negotiating" | "closed_won" | "archived" | "closed_lost";

type CrmContact = {
  id: string;
  first_name: string;
  last_name: string;
  stage: ContactStage;
  budget: number | null;
  currency: string;
  address: string | null;
  contact_roles: ContactRole[] | null;
  client_type: ContactRole;
  buyer_target_locations: string[] | null;
  buyer_property_types: string[] | null;
  buyer_budget_max: number | null;
  buyer_bedrooms_min: number | null;
  buyer_surface_min_m2: number | null;
  tenant_target_locations: string[] | null;
  tenant_property_types: string[] | null;
  tenant_budget_max: number | null;
  tenant_bedrooms_min: number | null;
  tenant_surface_min_m2: number | null;
};

type Recommendation = {
  contactId: string;
  fullName: string;
  stage: ContactStage;
  roles: ContactRole[];
  score: number;
  reasons: string[];
  distanceKm: number | null;
  budget: number | null;
  currency: string;
};

const ELIGIBLE_STAGES: ContactStage[] = ["new_lead", "qualified", "viewing", "negotiating"];
const MAX_CONTACTS_TO_SCAN = 80;
const MAX_RECOMMENDATIONS = 20;

const LOCATION_DISTANCE_BANDS = [
  { maxKm: 3, score: 45, label: "Very close location fit" },
  { maxKm: 8, score: 36, label: "Strong location fit" },
  { maxKm: 15, score: 27, label: "Good location fit" },
  { maxKm: 30, score: 16, label: "Broad location fit" },
  { maxKm: 50, score: 8, label: "Extended location fit" },
] as const;

function normalizeRoleList(roles: ContactRole[] | null | undefined, fallbackRole: ContactRole): ContactRole[] {
  const source = Array.isArray(roles) && roles.length > 0 ? roles : [fallbackRole];
  return Array.from(new Set(source));
}

function normalizeText(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitLocationTerms(value: string | null | undefined) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return [] as string[];
  }

  return normalized
    .split(/[\s,;/|-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function hasLocationTokenOverlap(left: string, right: string) {
  const leftTokens = new Set(splitLocationTerms(left));

  if (leftTokens.size === 0) {
    return false;
  }

  const rightTokens = splitLocationTerms(right);
  return rightTokens.some((token) => leftTokens.has(token));
}

function normalizePropertyTypeToken(value: string | null | undefined) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return "";
  }

  if (normalized.includes("apartment") || normalized.includes("appartement")) {
    return "apartment";
  }

  if (normalized.includes("house") || normalized.includes("maison") || normalized.includes("villa") || normalized.includes("townhouse")) {
    return "house";
  }

  if (normalized.includes("land") || normalized.includes("terrain")) {
    return "land";
  }

  if (normalized.includes("commercial") || normalized.includes("bureau") || normalized.includes("office")) {
    return "commercial";
  }

  if (normalized.includes("parking") || normalized.includes("garage")) {
    return "parking";
  }

  return "other";
}

function getFullName(contact: CrmContact) {
  const full = `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim();
  return full || "Unnamed contact";
}

function toFiniteNumber(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function getDistanceKm(from: { lat: number; lon: number }, to: { lat: number; lon: number }) {
  const earthKm = 6371;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLon = ((to.lon - from.lon) * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthKm * c;
}

async function geocodeLocation(
  location: string,
  cache: Map<string, { lat: number; lon: number } | null>,
): Promise<{ lat: number; lon: number } | null> {
  const normalized = normalizeText(location);

  if (!normalized) {
    return null;
  }

  if (cache.has(normalized)) {
    return cache.get(normalized) ?? null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const query = encodeURIComponent(location);
    const geocoderUserAgent =
      process.env.NOMINATIM_USER_AGENT?.trim() ||
      "VersaPropertyMatcher/1.0 (+https://versa.local)";
    const geocoderReferer = process.env.NOMINATIM_REFERER?.trim() || "https://versa.local";

    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&addressdetails=0`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Language": "en",
          "User-Agent": geocoderUserAgent,
          Referer: geocoderReferer,
        },
        signal: controller.signal,
        cache: "no-store",
      },
    );

    clearTimeout(timeout);

    if (!response.ok) {
      cache.set(normalized, null);
      return null;
    }

    const payload = (await response.json()) as Array<{ lat?: string; lon?: string }>;
    const first = payload[0];

    if (!first?.lat || !first?.lon) {
      cache.set(normalized, null);
      return null;
    }

    const lat = Number(first.lat);
    const lon = Number(first.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      cache.set(normalized, null);
      return null;
    }

    const value = { lat, lon };
    cache.set(normalized, value);
    return value;
  } catch {
    cache.set(normalized, null);
    return null;
  }
}

function buildPropertyLocationString(propertyRow: Record<string, unknown>) {
  return [
    readFirstString(propertyRow, ["address_line1", "address", "street_address"]),
    readFirstString(propertyRow, ["postal_code", "zip_code", "zipcode"]),
    readFirstString(propertyRow, ["city", "town"]),
    readFirstString(propertyRow, ["neighborhood", "district", "area"]),
  ]
    .filter(Boolean)
    .join(", ");
}

function getContactLocationCandidate(contact: CrmContact, transactionType: "sale" | "rent" | null) {
  if (transactionType === "sale") {
    return contact.buyer_target_locations?.[0] ?? contact.address;
  }

  if (transactionType === "rent") {
    return contact.tenant_target_locations?.[0] ?? contact.address;
  }

  return contact.address;
}

function scoreContact(options: {
  contact: CrmContact;
  roles: ContactRole[];
  transactionType: "sale" | "rent" | null;
  propertyType: string;
  propertyRooms: number | null;
  propertySurface: number | null;
  propertyPrice: number | null;
  propertyLocationText: string;
  distanceKm: number | null;
}): Recommendation | null {
  const {
    contact,
    roles,
    transactionType,
    propertyType,
    propertyRooms,
    propertySurface,
    propertyPrice,
    propertyLocationText,
    distanceKm,
  } = options;

  if (!ELIGIBLE_STAGES.includes(contact.stage)) {
    return null;
  }

  const isSale = transactionType === "sale";
  const isRent = transactionType === "rent";

  const canMatchSale = isSale && (roles.includes("buyer") || roles.includes("investor"));
  const canMatchRent = isRent && roles.includes("tenant");

  if (!canMatchSale && !canMatchRent) {
    return null;
  }

  let score = 0;
  const reasons: string[] = [];

  score += 25;
  reasons.push(canMatchSale ? "Buyer/investor profile" : "Tenant profile");

  if (contact.stage === "qualified") {
    score += 8;
    reasons.push("Qualified lead");
  } else if (contact.stage === "viewing") {
    score += 6;
    reasons.push("Already in visits");
  } else if (contact.stage === "negotiating") {
    score += 4;
    reasons.push("In negotiation");
  } else {
    score += 2;
    reasons.push("New lead");
  }

  if (distanceKm !== null) {
    const band = LOCATION_DISTANCE_BANDS.find((item) => distanceKm <= item.maxKm);

    if (band) {
      score += band.score;
      reasons.push(band.label);
    }
  } else {
    const candidateLocation = getContactLocationCandidate(contact, transactionType);
    if (candidateLocation && hasLocationTokenOverlap(propertyLocationText, candidateLocation)) {
      score += 14;
      reasons.push("Location keyword overlap");
    }
  }

  const normalizedPropertyType = normalizePropertyTypeToken(propertyType);

  if (isSale) {
    const preferredTypes = (contact.buyer_property_types ?? []).map((type) => normalizePropertyTypeToken(type));

    if (preferredTypes.length > 0 && preferredTypes.includes(normalizedPropertyType)) {
      score += 14;
      reasons.push("Property type preference match");
    }

    const minRooms = toFiniteNumber(contact.buyer_bedrooms_min);

    if (minRooms !== null && propertyRooms !== null) {
      if (propertyRooms >= minRooms) {
        score += 10;
        reasons.push("Rooms requirement met");
      } else if (propertyRooms >= Math.max(1, minRooms - 1)) {
        score += 4;
        reasons.push("Rooms near requirement");
      } else {
        score -= 8;
      }
    }

    const minSurface = toFiniteNumber(contact.buyer_surface_min_m2);

    if (minSurface !== null && propertySurface !== null) {
      if (propertySurface >= minSurface * 0.88) {
        score += 12;
        reasons.push("Surface requirement met");
      } else if (propertySurface >= minSurface * 0.75) {
        score += 5;
        reasons.push("Surface near requirement");
      } else {
        score -= 8;
      }
    }

    const budget = toFiniteNumber(contact.buyer_budget_max) ?? toFiniteNumber(contact.budget);

    if (budget !== null && propertyPrice !== null) {
      if (propertyPrice <= budget * 1.05) {
        score += 16;
        reasons.push("Within budget");
      } else if (propertyPrice <= budget * 1.15) {
        score += 7;
        reasons.push("Slightly above budget");
      } else {
        score -= 10;
      }
    }
  }

  if (isRent) {
    const preferredTypes = (contact.tenant_property_types ?? []).map((type) => normalizePropertyTypeToken(type));

    if (preferredTypes.length > 0 && preferredTypes.includes(normalizedPropertyType)) {
      score += 14;
      reasons.push("Property type preference match");
    }

    const minRooms = toFiniteNumber(contact.tenant_bedrooms_min);

    if (minRooms !== null && propertyRooms !== null) {
      if (propertyRooms >= minRooms) {
        score += 10;
        reasons.push("Rooms requirement met");
      } else if (propertyRooms >= Math.max(1, minRooms - 1)) {
        score += 4;
        reasons.push("Rooms near requirement");
      } else {
        score -= 8;
      }
    }

    const minSurface = toFiniteNumber(contact.tenant_surface_min_m2);

    if (minSurface !== null && propertySurface !== null) {
      if (propertySurface >= minSurface * 0.88) {
        score += 12;
        reasons.push("Surface requirement met");
      } else if (propertySurface >= minSurface * 0.75) {
        score += 5;
        reasons.push("Surface near requirement");
      } else {
        score -= 8;
      }
    }

    const budget = toFiniteNumber(contact.tenant_budget_max) ?? toFiniteNumber(contact.budget);

    if (budget !== null && propertyPrice !== null) {
      if (propertyPrice <= budget * 1.05) {
        score += 16;
        reasons.push("Within budget");
      } else if (propertyPrice <= budget * 1.15) {
        score += 7;
        reasons.push("Slightly above budget");
      } else {
        score -= 10;
      }
    }
  }

  const cleanedScore = Math.max(0, Math.round(score));

  return {
    contactId: contact.id,
    fullName: getFullName(contact),
    stage: contact.stage,
    roles,
    score: cleanedScore,
    reasons,
    distanceKm: distanceKm !== null ? Math.round(distanceKm * 10) / 10 : null,
    budget: toFiniteNumber(contact.budget),
    currency: contact.currency || "EUR",
  };
}

export async function GET(
  _request: NextRequest,
  context: {
    params: Promise<{ propertyId: string }>;
  },
) {
  const { propertyId } = await context.params;

  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Supabase client unavailable" }, { status: 500 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { data: profileData, error: profileError } = await supabase.rpc("get_current_profile");

  if (profileError || !profileData) {
    return NextResponse.json({ ok: false, error: "Could not load current profile" }, { status: 403 });
  }

  const profile = profileData as { workspace_id?: string | null };

  if (!profile.workspace_id) {
    return NextResponse.json({ ok: false, error: "No workspace on current profile" }, { status: 400 });
  }

  const workspaceId = profile.workspace_id;

  const [{ data: propertyRow, error: propertyError }, { data: contactsRows, error: contactsError }] = await Promise.all([
    supabase
      .from("properties")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("id", propertyId)
      .maybeSingle<Record<string, unknown>>(),
    supabase
      .from("crm_contacts")
      .select("id, first_name, last_name, stage, budget, currency, address, contact_roles, client_type, buyer_target_locations, buyer_property_types, buyer_budget_max, buyer_bedrooms_min, buyer_surface_min_m2, tenant_target_locations, tenant_property_types, tenant_budget_max, tenant_bedrooms_min, tenant_surface_min_m2")
      .eq("workspace_id", workspaceId)
      .in("stage", ELIGIBLE_STAGES)
      .order("updated_at", { ascending: false })
      .limit(MAX_CONTACTS_TO_SCAN),
  ]);

  if (propertyError) {
    return NextResponse.json({ ok: false, error: propertyError.message }, { status: 400 });
  }

  if (!propertyRow) {
    return NextResponse.json({ ok: false, error: "Property not found" }, { status: 404 });
  }

  if (contactsError) {
    return NextResponse.json({ ok: false, error: contactsError.message }, { status: 400 });
  }

  const property = mapWorkspaceProperty(propertyRow);
  const propertyLocationText = buildPropertyLocationString(propertyRow);
  const budgetComparablePropertyPrice =
    property.transactionType === "rent" ? property.monthlyRent : property.askingPrice;
  const propertyCoordsCache = new Map<string, { lat: number; lon: number } | null>();
  const contactCoordsCache = new Map<string, { lat: number; lon: number } | null>();
  const propertyCoords = await geocodeLocation(propertyLocationText, propertyCoordsCache);

  const recommendations: Recommendation[] = [];

  for (const row of (contactsRows ?? []) as CrmContact[]) {
    const roles = normalizeRoleList(row.contact_roles, row.client_type);
    const contactLocationText = getContactLocationCandidate(row, property.transactionType);

    let distanceKm: number | null = null;

    if (propertyCoords && contactLocationText) {
      const contactCoords = await geocodeLocation(contactLocationText, contactCoordsCache);

      if (contactCoords) {
        distanceKm = getDistanceKm(propertyCoords, contactCoords);
      }
    }

    const scored = scoreContact({
      contact: row,
      roles,
      transactionType: property.transactionType,
      propertyType: property.propertyType ?? "",
      propertyRooms: property.rooms,
      propertySurface: property.loiCarrezSurfaceSqm,
      propertyPrice: budgetComparablePropertyPrice,
      propertyLocationText,
      distanceKm,
    });

    if (scored && scored.score > 0) {
      recommendations.push(scored);
    }
  }

  recommendations.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    const leftDistance = left.distanceKm ?? Number.POSITIVE_INFINITY;
    const rightDistance = right.distanceKm ?? Number.POSITIVE_INFINITY;

    return leftDistance - rightDistance;
  });

  return NextResponse.json({
    ok: true,
    recommendations: recommendations.slice(0, MAX_RECOMMENDATIONS),
  });
}
