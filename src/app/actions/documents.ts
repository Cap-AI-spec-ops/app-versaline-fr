"use server";

import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { createElement, type ReactElement } from "react";
import { ZodError, type ZodIssue } from "zod";

import { generateWithCredits, InsufficientCreditsError } from "@/lib/ai/generate-with-credits";
import { generateSpecialClause } from "@/lib/documents/ai-clause-generator";
import { extractDocxPlaceholders } from "@/lib/documents/docx-renderer";
import { renderDocxTemplate } from "@/lib/documents/docx-renderer";
import { renderMandatVenteDocx } from "@/lib/documents/mandat-vente-docx";
import {
  AvenantPDF,
  BailLocationPDF,
  MandatRecherchePDF,
  MandatVentePDF,
} from "@/lib/documents/pdf-renderer";
import {
  type AvenantData,
  type BailLocationData,
  type MandatRechercheData,
  type MandatVenteData,
  parseDocumentData,
  supportedDocumentSchema,
  type DocumentType,
  type SupportedDocumentData,
  type TemplateSource,
} from "@/lib/documents/schemas";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type JsonMap = Record<string, unknown>;
type ExportFormat = "pdf" | "docx";

type WorkspaceBrandingRow = {
  agency_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
  carte_t_number: string | null;
  carte_t_cci: string | null;
  siret: string | null;
  rcp_policy_number: string | null;
  rcp_insurer: string | null;
  guarantor_name: string | null;
  guarantor_amount_eur: number | null;
};

type ContactRow = {
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
};

type CustomTemplateRow = {
  id: string;
  workspace_id: string;
  document_type: string;
};

export type GenerateDocumentDraftInput = {
  documentId?: string | null;
  workspaceId: string;
  documentType: DocumentType;
  templateSource: TemplateSource;
  title: string;
  formData: JsonMap;
  specialClauses?: string[];
  contactId?: string | null;
  propertyId?: string | null;
  customTemplateId?: string | null;
};

export type GenerateDocumentDraftResult =
  | {
      ok: true;
      documentId: string;
      mandateNumber: number | null;
      status: string;
    }
  | {
      ok: false;
      error: string;
      fieldErrors?: Record<string, string[]>;
      requiredCredits?: number;
      currentBalance?: number;
    };

export async function generateDocumentDraftAction(
  input: GenerateDocumentDraftInput,
): Promise<GenerateDocumentDraftResult> {
  try {
    const supabase = await getSupabaseServerClient();

    if (!supabase) {
      return { ok: false, error: "Supabase server client is not available." };
    }

    const [branding, contact, property, customTemplate] = await Promise.all([
      loadWorkspaceBranding(supabase, input.workspaceId),
      input.contactId ? loadContact(supabase, input.workspaceId, input.contactId) : Promise.resolve(null),
      input.propertyId ? loadProperty(supabase, input.workspaceId, input.propertyId) : Promise.resolve(null),
      input.customTemplateId
        ? loadCustomTemplate(supabase, input.workspaceId, input.customTemplateId)
        : Promise.resolve(null),
    ]);

    if (input.templateSource === "agency_custom" && input.customTemplateId && !customTemplate) {
      return { ok: false, error: "The selected custom template was not found in this workspace." };
    }

    const payload = buildDocumentPayload({
      input,
      branding,
      contact,
      property,
    });
    const parsedData = parseDocumentData(input.documentType, payload) as SupportedDocumentData;
    let mandateNumber: number | null = null;

    if (input.documentId) {
      const { data: existingDraft, error: existingDraftError } = await supabase
        .from("workspace_documents")
        .select("id, mandate_number")
        .eq("workspace_id", input.workspaceId)
        .eq("id", input.documentId)
        .maybeSingle<{ id: string; mandate_number: number | null }>();

      if (existingDraftError) {
        throw new Error(existingDraftError.message);
      }

      if (!existingDraft) {
        return { ok: false, error: "The selected draft no longer exists." };
      }

      mandateNumber = existingDraft.mandate_number;
    }

    if (!input.documentId && shouldAssignMandateNumber(input.documentType)) {
      try {
        mandateNumber = await getNextMandateNumber(supabase, input.workspaceId);
      } catch (error) {
        if (!isStackDepthError(error)) {
          throw error;
        }

        mandateNumber = null;
      }
    }

    const documentPayload = {
      workspace_id: input.workspaceId,
      contact_id: input.contactId ?? null,
      property_id: input.propertyId ?? null,
      template_source: input.templateSource,
      custom_template_id: input.customTemplateId ?? null,
      type: input.documentType,
      mandate_number: mandateNumber,
      title: input.title.trim(),
      country_code: parsedData.countryCode,
      jurisdiction: parsedData.jurisdiction,
      parent_document_id: parsedData.type === "avenant" ? parsedData.referenceDocumentId ?? null : null,
      form_data: parsedData,
      special_clauses: parsedData.specialClauses,
      file_url: null,
      status: "draft",
    };

    const draftMutation = input.documentId
      ? supabase
          .from("workspace_documents")
          .update(documentPayload)
          .eq("workspace_id", input.workspaceId)
          .eq("id", input.documentId)
          .select("id, mandate_number, status")
          .single<{ id: string; mandate_number: number | null; status: string }>()
      : supabase
          .from("workspace_documents")
          .insert(documentPayload)
          .select("id, mandate_number, status")
          .single<{ id: string; mandate_number: number | null; status: string }>();

    const { data, error } = await draftMutation;

    if (error || !data) {
      throw new Error(error?.message ?? "Could not save the document draft.");
    }

    return {
      ok: true,
      documentId: data.id,
      mandateNumber: data.mandate_number,
      status: data.status,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        ok: false,
        error: "Some required fields are missing or invalid.",
        fieldErrors: normalizeZodIssues(error.issues),
      };
    }

    if (error instanceof InsufficientCreditsError) {
      return {
        ok: false,
        error: error.message,
        requiredCredits: error.requiredCredits,
        currentBalance: error.currentBalance,
      };
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : "Document draft generation failed.",
    };
  }
}

export async function loadDocumentGeneratorBootstrapAction(workspaceId: string) {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return { ok: false, error: "Supabase server client is not available." };
  }

  const [branding, contactsResult, propertiesResult, templatesResult] = await Promise.all([
    loadWorkspaceBranding(supabase, workspaceId),
    supabase
      .from("crm_contacts")
      .select("id, first_name, last_name, email, phone, address")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .limit(50),
    supabase
      .from("properties")
      .select("*")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false }),
    supabase
      .from("workspace_custom_templates")
      .select("id, document_type, name, detected_placeholders, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false }),
  ]);

  if (contactsResult.error) {
    return { ok: false, error: contactsResult.error.message };
  }

  if (templatesResult.error) {
    return { ok: false, error: templatesResult.error.message };
  }

  const propertiesAccessError = propertiesResult.error?.message?.trim() ?? null;

  return {
    ok: true,
    brandingReady: isBrandingConfigured(branding),
    branding,
    propertiesAccessError: propertiesAccessError
      ? `Property autosuggest is unavailable right now (${propertiesAccessError}). You can continue with manual property fields for now.`
      : null,
    contacts: (contactsResult.data ?? []).map((contact) => ({
      id: contact.id,
      label: `${contact.first_name} ${contact.last_name}`.trim() || contact.email || "Unnamed contact",
      email: contact.email,
      phone: contact.phone,
      address: contact.address,
    })),
    properties: ((propertiesAccessError ? [] : propertiesResult.data) ?? []).map((property) => ({
      id: property.id,
      label:
        readFirstString(property, ["reference", "title", "name", "address_line1", "address", "street_address"]) ??
        "Unnamed property",
      city: readFirstString(property, ["city", "town"]),
      postalCode: readFirstString(property, ["postal_code", "zip_code", "zipcode"]),
      propertyType: readFirstString(property, ["property_type", "type"]),
      cadastreReference: readFirstString(property, ["cadastre_reference", "cadastre", "parcel_reference"]),
      loiCarrezSurfaceSqm: readFirstNumber(property, ["loi_carrez_surface_sqm", "carrez_surface", "surface_area", "surface"]),
      dpeEnergyRating: readFirstString(property, ["dpe_energy_rating", "dpe_rating", "energy_rating"]),
      dpeClimateRating: readFirstString(property, ["dpe_climate_rating", "ges_rating", "climate_rating"]),
    })),
    templates: templatesResult.data ?? [],
  };
}

export type DocumentGeneratorBootstrapResult = Awaited<
  ReturnType<typeof loadDocumentGeneratorBootstrapAction>
>;

export async function generateDocumentSpecialClauseAction(input: {
  workspaceId: string;
  userPrompt: string;
  documentType: DocumentType;
}) {
  try {
    const { result, creditsUsed, newBalance } = await generateWithCredits({
      workspaceId: input.workspaceId,
      actionType: "document_special_clause",
      idempotencyKey: crypto.randomUUID(),
      generationFn: async () => {
        const clause = await generateSpecialClause(input.userPrompt, {
          workspaceId: input.workspaceId,
          countryCode: "FR",
          documentType: input.documentType,
        });

        return clause;
      },
    });

    return {
      ok: true,
      clause: result,
      creditsUsed,
      newBalance,
    };
  } catch (error) {
    if (error instanceof InsufficientCreditsError) {
      return {
        ok: false,
        error: error.message,
        requiredCredits: error.requiredCredits,
        currentBalance: error.currentBalance,
      };
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : "Special clause generation failed.",
    };
  }
}

export async function exportDocumentDirectAction(input: {
  documentType: DocumentType;
  templateSource: TemplateSource;
  outputFormat: ExportFormat;
  title: string;
  formData: JsonMap;
  specialClauses?: string[];
}) {
  try {
    const supabase = await getSupabaseServerClient();

    if (!supabase) {
      return { ok: false, error: "Supabase server client is not available." };
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return { ok: false, error: "Unauthorized." };
    }

    const payload = {
      ...input.formData,
      type: input.documentType,
      title: input.title.trim(),
      templateSource: input.templateSource,
      countryCode: readString(input.formData.countryCode) ?? "FR",
      jurisdiction: readString(input.formData.jurisdiction) ?? "france",
      specialClauses: input.specialClauses ?? [],
    };

    const parsedData = parseDocumentData(input.documentType, payload) as SupportedDocumentData;
    const rendered = await renderDocumentBuffer({
      outputFormat: input.outputFormat,
      templateSource: input.templateSource,
      documentType: input.documentType,
      parsedData,
    });
    const normalizedTitle = normalizeFileName(input.title || input.documentType);

    return {
      ok: true,
      fileName: `${normalizedTitle}.${rendered.extension}`,
      mimeType: rendered.mimeType,
      base64: rendered.buffer.toString("base64"),
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        ok: false,
        error: "Some required fields are missing or invalid.",
        fieldErrors: normalizeZodIssues(error.issues),
      };
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : "Direct document export failed.",
    };
  }
}

export async function finalizeDocumentExportAction(input: {
  workspaceId: string;
  documentId: string;
  outputFormat: ExportFormat;
}) {
  try {
    const supabase = await getSupabaseServerClient();

    if (!supabase) {
      return { ok: false, error: "Supabase server client is not available." };
    }

    const { data: documentRow, error: documentError } = await supabase
      .from("workspace_documents")
      .select("id, workspace_id, type, title, template_source, custom_template_id, form_data, special_clauses")
      .eq("workspace_id", input.workspaceId)
      .eq("id", input.documentId)
      .single<{
        id: string;
        workspace_id: string;
        type: DocumentType;
        title: string;
        template_source: TemplateSource;
        custom_template_id: string | null;
        form_data: unknown;
        special_clauses: string[] | null;
      }>();

    if (documentError || !documentRow) {
      return { ok: false, error: documentError?.message ?? "Document draft not found." };
    }

    const parsedData = supportedDocumentSchema.parse({
      ...(documentRow.form_data as Record<string, unknown>),
      specialClauses: documentRow.special_clauses ?? [],
    });

    const rendered = await renderFinalDocument({
      supabase,
      workspaceId: input.workspaceId,
      documentId: documentRow.id,
      outputFormat: input.outputFormat,
      templateSource: documentRow.template_source,
      customTemplateId: documentRow.custom_template_id,
      documentType: documentRow.type,
      title: documentRow.title,
      parsedData,
    });

    const { error: updateError } = await supabase
      .from("workspace_documents")
      .update({
        file_url: rendered.filePath,
        status: "finalized",
      })
      .eq("workspace_id", input.workspaceId)
      .eq("id", input.documentId);

    if (updateError) {
      throw new Error(updateError.message);
    }

    const { data: balanceRow, error: balanceError } = await supabase
      .from("workspaces")
      .select("credit_balance")
      .eq("id", input.workspaceId)
      .maybeSingle<{ credit_balance: number | null }>();

    if (balanceError) {
      throw new Error(balanceError.message);
    }

    return {
      ok: true,
      filePath: rendered.filePath,
      downloadUrl: rendered.downloadUrl,
      mimeType: rendered.mimeType,
      creditsUsed: 0,
      newBalance: balanceRow?.credit_balance ?? 0,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        ok: false,
        error: "Stored document data is invalid.",
      };
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : "Document export failed.",
    };
  }
}

export type UploadCustomDocxTemplateInput = {
  workspaceId: string;
  documentType: DocumentType;
  name: string;
  file: File;
};

export async function uploadCustomDocxTemplateAction(input: UploadCustomDocxTemplateInput) {
  const supabase = await getSupabaseServerClient();

  if (!supabase) {
    return { ok: false, error: "Supabase server client is not available." };
  }

  if (!input.file.name.toLowerCase().endsWith(".docx")) {
    return { ok: false, error: "Only .docx templates are supported." };
  }

  const buffer = Buffer.from(await input.file.arrayBuffer());
  const detectedPlaceholders = extractDocxPlaceholders(buffer);
  const safeFileName = normalizeFileName(input.file.name);
  const storagePath = `${input.workspaceId}/${crypto.randomUUID()}-${safeFileName}`;

  const { data: uploadData, error: uploadError } = await supabase.storage
    .from("agency-templates")
    .upload(storagePath, buffer, {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      upsert: false,
    });

  if (uploadError) {
    return { ok: false, error: uploadError.message };
  }

  const { data, error } = await supabase
    .from("workspace_custom_templates")
    .insert({
      workspace_id: input.workspaceId,
      document_type: input.documentType,
      country_code: "FR",
      name: input.name.trim(),
      docx_file_url: uploadData.fullPath,
      detected_placeholders: detectedPlaceholders,
    })
    .select("id, name, docx_file_url, detected_placeholders")
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? "Could not save the custom template." };
  }

  return {
    ok: true,
    template: data,
  };
}

async function loadWorkspaceBranding(
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>,
  workspaceId: string,
) {
  const { data, error } = await supabase
    .from("workspace_branding")
    .select(
      "agency_name, logo_url, primary_color, accent_color, carte_t_number, carte_t_cci, siret, rcp_policy_number, rcp_insurer, guarantor_name, guarantor_amount_eur",
    )
    .eq("workspace_id", workspaceId)
    .maybeSingle<WorkspaceBrandingRow>();

  if (error) {
    throw new Error(`Could not load workspace branding: ${error.message}`);
  }

  return data;
}

async function loadContact(
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>,
  workspaceId: string,
  contactId: string,
) {
  const { data, error } = await supabase
    .from("crm_contacts")
    .select("first_name, last_name, email, phone, address")
    .eq("workspace_id", workspaceId)
    .eq("id", contactId)
    .maybeSingle<ContactRow>();

  if (error) {
    throw new Error(`Could not load CRM contact: ${error.message}`);
  }

  return data;
}

async function loadProperty(
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>,
  workspaceId: string,
  propertyId: string,
) {
  const { data, error } = await supabase
    .from("properties")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", propertyId)
    .maybeSingle<Record<string, unknown>>();

  if (error) {
    return null;
  }

  return data;
}

async function loadCustomTemplate(
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>,
  workspaceId: string,
  customTemplateId: string,
) {
  const { data, error } = await supabase
    .from("workspace_custom_templates")
    .select("id, workspace_id, document_type")
    .eq("workspace_id", workspaceId)
    .eq("id", customTemplateId)
    .maybeSingle<CustomTemplateRow>();

  if (error) {
    throw new Error(`Could not load the custom template: ${error.message}`);
  }

  return data;
}

async function getNextMandateNumber(
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>,
  workspaceId: string,
) {
  const { data, error } = await supabase.rpc("get_next_mandate_number", {
    p_workspace_id: workspaceId,
  });

  if (error || typeof data !== "number") {
    throw new Error(error?.message ?? "Could not allocate the next mandate number.");
  }

  return data;
}

function buildDocumentPayload(options: {
  input: GenerateDocumentDraftInput;
  branding: WorkspaceBrandingRow | null;
  contact: ContactRow | null;
  property: Record<string, unknown> | null;
}) {
  const branding = {
    agencyName: options.input.formData.workspaceBranding && typeof options.input.formData.workspaceBranding === "object"
      ? pickObjectValue(options.input.formData.workspaceBranding as JsonMap, "agencyName") ?? options.branding?.agency_name ?? ""
      : options.branding?.agency_name ?? "",
    logoUrl: options.branding?.logo_url ?? null,
    primaryColor: "#000000",
    accentColor: options.branding?.accent_color ?? "#3B82F6",
    carteTNumber: options.branding?.carte_t_number ?? "",
    carteTCci: options.branding?.carte_t_cci ?? "",
    siret: options.branding?.siret ?? "",
    rcpPolicyNumber: options.branding?.rcp_policy_number ?? "",
    rcpInsurer: options.branding?.rcp_insurer ?? "",
    guarantorName: options.branding?.guarantor_name ?? "",
    guarantorAmountEur: options.branding?.guarantor_amount_eur ?? null,
  };

  const contactName = options.contact
    ? `${options.contact.first_name} ${options.contact.last_name}`.trim()
    : null;
  const contactObject = options.contact
    ? {
        fullName: contactName || "",
        email: options.contact.email,
        phone: options.contact.phone,
        address: options.contact.address,
      }
    : undefined;

  const propertyObject = options.property
    ? {
        reference: readString(options.property.reference),
        addressLine1: readString(options.property.address_line1) ?? readString(options.property.address) ?? "",
        addressLine2: readString(options.property.address_line2),
        postalCode: readString(options.property.postal_code) ?? "",
        city: readString(options.property.city) ?? "",
        cadastreReference: readString(options.property.cadastre_reference) ?? "",
        propertyType: readString(options.property.property_type),
        loiCarrezSurfaceSqm: readNumber(options.property.loi_carrez_surface_sqm) ?? 0,
        habitableSurfaceSqm: readNumber(options.property.habitable_surface_sqm),
        dpeEnergyRating: readString(options.property.dpe_energy_rating) ?? "N/A",
        dpeClimateRating: readString(options.property.dpe_climate_rating) ?? "N/A",
        furnishedInventoryIncluded: readBoolean(options.property.furnished_inventory_included) ?? false,
      }
    : undefined;

  const partyPayloadByType: Partial<JsonMap> =
    options.input.documentType === "mandat_vente"
      ? {
          principalSeller: readObject(options.input.formData.principalSeller) ?? contactObject,
        }
      : options.input.documentType === "mandat_recherche"
        ? {
            buyer: readObject(options.input.formData.buyer) ?? contactObject,
          }
        : options.input.documentType === "bail_location"
          ? {
              landlord: readObject(options.input.formData.landlord) ?? contactObject,
              tenant: readObject(options.input.formData.tenant) ?? contactObject,
            }
          : {
              principalParty: readObject(options.input.formData.principalParty) ?? contactObject,
            };

  return {
    ...options.input.formData,
    type: options.input.documentType,
    title: options.input.title.trim(),
    templateSource: options.input.templateSource,
    countryCode: readString(options.input.formData.countryCode) ?? "FR",
    jurisdiction: readString(options.input.formData.jurisdiction) ?? "france",
    specialClauses: options.input.specialClauses ?? [],
    workspaceBranding: {
      ...(branding as JsonMap),
      ...readObject(options.input.formData.workspaceBranding),
    },
    ...partyPayloadByType,
    property: {
      ...(propertyObject as JsonMap),
      ...readObject(options.input.formData.property),
    },
  };
}

function shouldAssignMandateNumber(documentType: DocumentType) {
  return documentType === "mandat_vente" || documentType === "mandat_recherche" || documentType === "avenant";
}

function normalizeFileName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function readObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonMap)
    : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function pickObjectValue(value: JsonMap, key: string) {
  const fieldValue = value[key];
  return typeof fieldValue === "string" && fieldValue.trim().length > 0 ? fieldValue.trim() : null;
}

function normalizeFieldErrors(fieldErrors: Record<string, string[] | undefined>) {
  return Object.fromEntries(
    Object.entries(fieldErrors).filter((entry): entry is [string, string[]] => Array.isArray(entry[1])),
  );
}

function normalizeZodIssues(issues: ZodIssue[]) {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "form";

    if (!Array.isArray(fieldErrors[key])) {
      fieldErrors[key] = [];
    }

    fieldErrors[key].push(issue.message);
  }

  return fieldErrors;
}

function readFirstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readString(record[key]);

    if (value) {
      return value;
    }
  }

  return null;
}

function readFirstNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readNumber(record[key]);

    if (value !== null) {
      return value;
    }
  }

  return null;
}

function isBrandingConfigured(branding: WorkspaceBrandingRow | null) {
  if (!branding) {
    return false;
  }

  return Boolean(
    readString(branding.agency_name) &&
      readString(branding.carte_t_number) &&
      readString(branding.carte_t_cci) &&
      readString(branding.siret) &&
      readString(branding.rcp_insurer),
  );
}

async function renderFinalDocument(options: {
  supabase: NonNullable<Awaited<ReturnType<typeof getSupabaseServerClient>>>;
  workspaceId: string;
  documentId: string;
  outputFormat: ExportFormat;
  templateSource: TemplateSource;
  customTemplateId: string | null;
  documentType: DocumentType;
  title: string;
  parsedData: SupportedDocumentData;
}) {
  const rendered = await renderDocumentBuffer({
    outputFormat: options.outputFormat,
    templateSource: options.templateSource,
    documentType: options.documentType,
    parsedData: options.parsedData,
    loadAgencyTemplate: async () => {
      if (!options.customTemplateId) {
        throw new Error("A custom template is required for DOCX export.");
      }

      const { data: templateRow, error: templateError } = await options.supabase
        .from("workspace_custom_templates")
        .select("docx_file_url")
        .eq("workspace_id", options.workspaceId)
        .eq("id", options.customTemplateId)
        .single<{ docx_file_url: string }>();

      if (templateError || !templateRow) {
        throw new Error(templateError?.message ?? "Custom template not found.");
      }

      const { data: templateObject, error: templateDownloadError } = await options.supabase.storage
        .from("agency-templates")
        .download(templateRow.docx_file_url);

      if (templateDownloadError || !templateObject) {
        throw new Error(templateDownloadError?.message ?? "Could not download the agency template.");
      }

      return Buffer.from(await templateObject.arrayBuffer());
    },
  });

  const normalizedTitle = normalizeFileName(options.title || `${options.documentType}-${options.documentId}`);
  const filePath = `${options.workspaceId}/${options.documentId}/${normalizedTitle}.${rendered.extension}`;
  const { error: uploadError } = await options.supabase.storage
    .from("workspace-documents")
    .upload(filePath, rendered.buffer, {
      contentType: rendered.mimeType,
      upsert: true,
    });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

  const { data: signedUrlData, error: signedUrlError } = await options.supabase.storage
    .from("workspace-documents")
    .createSignedUrl(filePath, 60 * 10, {
      download: `${normalizedTitle}.${rendered.extension}`,
    });

  if (signedUrlError || !signedUrlData?.signedUrl) {
    throw new Error(signedUrlError?.message ?? "Could not create a document download URL.");
  }

  return {
    filePath,
    downloadUrl: signedUrlData.signedUrl,
    mimeType: rendered.mimeType,
  };
}

async function renderDocumentBuffer(options: {
  outputFormat: ExportFormat;
  templateSource: TemplateSource;
  documentType: DocumentType;
  parsedData: SupportedDocumentData;
  loadAgencyTemplate?: () => Promise<Buffer>;
}) {
  let buffer: Buffer;
  let extension: "pdf" | "docx";
  let mimeType: string;

  if (options.outputFormat === "pdf") {
    buffer = await renderToBuffer(buildPdfComponent(options.documentType, options.parsedData));
    extension = "pdf";
    mimeType = "application/pdf";
  } else if (options.templateSource === "agency_custom") {
    if (!options.loadAgencyTemplate) {
      throw new Error("A custom template loader is required for DOCX export.");
    }

    const templateBuffer = await options.loadAgencyTemplate();
    buffer = renderDocxTemplate(templateBuffer, flattenTemplateData(options.parsedData));
    extension = "docx";
    mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  } else if (options.documentType === "mandat_vente") {
    buffer = await renderMandatVenteDocx(options.parsedData as MandatVenteData);
    extension = "docx";
    mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  } else {
    throw new Error("DOCX export without a custom template is currently only available for Mandat de vente.");
  }

  return {
    buffer,
    extension,
    mimeType,
  };
}

function flattenTemplateData(value: unknown, prefix = "", output: Record<string, unknown> = {}) {
  if (Array.isArray(value)) {
    output[prefix] = value.map((item) => (typeof item === "object" ? JSON.stringify(item) : item)).join(", ");
    return output;
  }

  if (value && typeof value === "object") {
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      flattenTemplateData(nestedValue, nextPrefix, output);
      if (!prefix) {
        output[key] = nestedValue;
      }
    }
    return output;
  }

  if (prefix) {
    output[prefix] = value ?? "";
  }

  return output;
}

function buildPdfComponent(documentType: DocumentType, parsedData: SupportedDocumentData) {
  if (documentType === "mandat_vente") {
    return createElement(MandatVentePDF, { data: parsedData as MandatVenteData }) as ReactElement<DocumentProps>;
  }

  if (documentType === "mandat_recherche") {
    return createElement(MandatRecherchePDF, { data: parsedData as MandatRechercheData }) as ReactElement<DocumentProps>;
  }

  if (documentType === "bail_location") {
    return createElement(BailLocationPDF, { data: parsedData as BailLocationData }) as ReactElement<DocumentProps>;
  }

  return createElement(AvenantPDF, { data: parsedData as AvenantData }) as ReactElement<DocumentProps>;
}

function isStackDepthError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("stack depth limit exceeded") || message.includes("infinite recursion");
}