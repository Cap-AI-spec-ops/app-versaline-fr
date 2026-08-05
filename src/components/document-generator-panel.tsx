"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useState } from "react";

import {
  exportDocumentDirectAction,
  finalizeDocumentExportAction,
  generateDocumentDraftAction,
  generateDocumentSpecialClauseAction,
  loadDocumentGeneratorBootstrapAction,
  uploadCustomDocxTemplateAction,
  type DocumentGeneratorBootstrapResult,
} from "@/app/actions/documents";
import DateTimePickerInput from "@/components/ui/date-time-picker-input";
import { dispatchCreditsBalanceRefresh } from "@/lib/credits/client-refresh";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

const ACTIVE_DOCUMENT_TYPE = "mandat_vente" as const;

const TEMPLATE_OPTIONS = [
  {
    value: "versaline_standard",
    label: "Versaline Standard Template",
    detail: "Use the built-in FR legal contract copy for PDF or DOCX export.",
  },
  {
    value: "agency_custom",
    label: "Our Agency Custom Template",
    detail: "Use your uploaded DOCX template for DOCX export, with PDF still available.",
  },
] as const;

const MANDATE_TYPE_OPTIONS = [
  { value: "simple", label: "Simple" },
  { value: "exclusif", label: "Exclusif" },
  { value: "semi_exclusif", label: "Semi-Exclusif" },
] as const;

const FEE_PAYER_OPTIONS = [
  { value: "charge_vendeur", label: "Charge vendeur" },
  { value: "charge_acquereur", label: "Charge acquéreur" },
  { value: "partage", label: "Partage" },
] as const;

const DPE_OPTIONS = ["A", "B", "C", "D", "E", "F", "G", "N/A"] as const;

type BootstrapSuccess = Extract<
  DocumentGeneratorBootstrapResult,
  { contacts: unknown[]; properties: unknown[]; templates: unknown[]; brandingReady: boolean }
>;
type TemplateSource = (typeof TEMPLATE_OPTIONS)[number]["value"];
type ExportFormat = "pdf" | "docx";

type MandatVenteFormState = {
  title: string;
  mandateType: "simple" | "exclusif" | "semi_exclusif";
  sellerName: string;
  sellerEmail: string;
  sellerPhone: string;
  sellerAddress: string;
  propertyReference: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  cadastreReference: string;
  propertyType: string;
  loiCarrezSurfaceSqm: string;
  habitableSurfaceSqm: string;
  dpeEnergyRating: (typeof DPE_OPTIONS)[number];
  dpeClimateRating: (typeof DPE_OPTIONS)[number];
  listingPriceEur: string;
  netSellerPriceEur: string;
  agencyFeesEur: string;
  agencyFeesVatRate: string;
  feePayer: "charge_vendeur" | "charge_acquereur" | "partage";
  marketingCommitmentsText: string;
  signatureDate: string;
  effectiveDate: string;
  expirationDate: string;
  tacitRenewalAllowed: boolean;
  consumerInformationDelivered: boolean;
  coolingOffPeriodDays: string;
};

function createInitialFormState(): MandatVenteFormState {
  const today = new Date();
  const signatureDate = today.toISOString().slice(0, 10);
  const expirationDate = new Date(today.getFullYear() + 1, today.getMonth(), today.getDate())
    .toISOString()
    .slice(0, 10);

  return {
    title: "Mandat de vente",
    mandateType: "simple",
    sellerName: "",
    sellerEmail: "",
    sellerPhone: "",
    sellerAddress: "",
    propertyReference: "",
    addressLine1: "",
    addressLine2: "",
    postalCode: "",
    city: "",
    cadastreReference: "",
    propertyType: "Appartement",
    loiCarrezSurfaceSqm: "",
    habitableSurfaceSqm: "",
    dpeEnergyRating: "N/A",
    dpeClimateRating: "N/A",
    listingPriceEur: "",
    netSellerPriceEur: "",
    agencyFeesEur: "",
    agencyFeesVatRate: "20",
    feePayer: "charge_vendeur",
    marketingCommitmentsText: "Publication sur les portails immobiliers\nOrganisation des visites\nCompte-rendu régulier au mandant",
    signatureDate,
    effectiveDate: signatureDate,
    expirationDate,
    tacitRenewalAllowed: true,
    consumerInformationDelivered: true,
    coolingOffPeriodDays: "14",
  };
}

export default function DocumentGeneratorPanel() {
  const { workspace, isLoading: isWorkspaceLoading, error: workspaceError, currentRole } = useCurrentWorkspace();

  const [bootstrap, setBootstrap] = useState<BootstrapSuccess | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [templateSource, setTemplateSource] = useState<TemplateSource>("versaline_standard");
  const [selectedContactId, setSelectedContactId] = useState("");
  const [selectedPropertyId, setSelectedPropertyId] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [propertySearch, setPropertySearch] = useState("");
  const [form, setForm] = useState<MandatVenteFormState>(createInitialFormState);
  const [specialClauses, setSpecialClauses] = useState<string[]>([]);
  const [clausePrompt, setClausePrompt] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<string | null>(null);
  const [mandateNumber, setMandateNumber] = useState<number | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [exportMimeType, setExportMimeType] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isGeneratingClause, setIsGeneratingClause] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploadingTemplate, setIsUploadingTemplate] = useState(false);

  const deferredContactSearch = useDeferredValue(contactSearch);
  const deferredPropertySearch = useDeferredValue(propertySearch);

  useEffect(() => {
    if (!workspace?.id) {
      return;
    }

    void refreshBootstrap(workspace.id);
  }, [workspace?.id]);

  const filteredContacts = bootstrap?.contacts.filter((contact) => {
    const query = deferredContactSearch.trim().toLowerCase();

    if (!query) {
      return true;
    }

    return `${contact.label} ${contact.email ?? ""} ${contact.phone ?? ""}`.toLowerCase().includes(query);
  }) ?? [];

  const filteredProperties = bootstrap?.properties.filter((property) => {
    const query = deferredPropertySearch.trim().toLowerCase();

    if (!query) {
      return true;
    }

    return `${property.label} ${property.city ?? ""} ${property.postalCode ?? ""}`.toLowerCase().includes(query);
  }) ?? [];

  useEffect(() => {
    if (!bootstrap || !selectedContactId) {
      return;
    }

    const selectedContact = bootstrap.contacts.find((contact) => contact.id === selectedContactId);

    if (!selectedContact) {
      return;
    }

    setForm((current) => ({
      ...current,
      sellerName: selectedContact.label,
      sellerEmail: selectedContact.email ?? "",
      sellerPhone: selectedContact.phone ?? "",
      sellerAddress: selectedContact.address ?? current.sellerAddress,
    }));
  }, [bootstrap, selectedContactId]);

  useEffect(() => {
    if (!bootstrap || !selectedPropertyId) {
      return;
    }

    const selectedProperty = bootstrap.properties.find((property) => property.id === selectedPropertyId);

    if (!selectedProperty) {
      return;
    }

    setForm((current) => ({
      ...current,
      propertyReference: selectedProperty.label,
      addressLine1: selectedProperty.label,
      postalCode: selectedProperty.postalCode ?? current.postalCode,
      city: selectedProperty.city ?? current.city,
      propertyType: selectedProperty.propertyType ?? current.propertyType,
      cadastreReference: selectedProperty.cadastreReference ?? current.cadastreReference,
      loiCarrezSurfaceSqm:
        selectedProperty.loiCarrezSurfaceSqm !== null && selectedProperty.loiCarrezSurfaceSqm !== undefined
          ? String(selectedProperty.loiCarrezSurfaceSqm)
          : current.loiCarrezSurfaceSqm,
      dpeEnergyRating: normalizeDpeValue(selectedProperty.dpeEnergyRating, current.dpeEnergyRating),
      dpeClimateRating: normalizeDpeValue(selectedProperty.dpeClimateRating, current.dpeClimateRating),
    }));
  }, [bootstrap, selectedPropertyId]);

  async function refreshBootstrap(workspaceId: string) {
    setIsBootstrapping(true);
    setBootstrapError(null);

    const result = await loadDocumentGeneratorBootstrapAction(workspaceId);

    setIsBootstrapping(false);

    if (!("contacts" in result) || !("properties" in result) || !("templates" in result) || !("brandingReady" in result)) {
      setBootstrap(null);
      setBootstrapError(("error" in result && typeof result.error === "string" ? result.error : null) ?? "Could not load document generator data.");
      return;
    }

    const successResult = result as BootstrapSuccess;

    setBootstrap(successResult);
    setBootstrapError(null);

    if (!selectedTemplateId && successResult.templates.length > 0) {
      setSelectedTemplateId(successResult.templates[0]?.id ?? "");
    }
  }

  function updateForm<K extends keyof MandatVenteFormState>(key: K, value: MandatVenteFormState[K]) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function handleSaveDraft() {
    if (!workspace?.id) {
      setMessage("Workspace not found.");
      return null;
    }

    if (!bootstrap?.brandingReady) {
      setMessage("Complete branding setup before saving or exporting a document.");
      return null;
    }

    setIsSavingDraft(true);
    setMessage(null);
    setFieldErrors({});
    setDownloadUrl(null);

    const result = await generateDocumentDraftAction({
      documentId: draftId,
      workspaceId: workspace.id,
      documentType: ACTIVE_DOCUMENT_TYPE,
      templateSource,
      title: form.title,
      formData: buildMandatVenteFormData(form, specialClauses, bootstrap?.branding ?? null),
      specialClauses,
      contactId: selectedContactId || null,
      propertyId: selectedPropertyId || null,
      customTemplateId: templateSource === "agency_custom" ? selectedTemplateId || null : null,
    });

    setIsSavingDraft(false);

    if (!result.ok) {
      setMessage(result.error ?? "Could not save draft.");
      setFieldErrors(result.fieldErrors ?? {});
      return null;
    }

    setDraftId(result.documentId);
    setDraftStatus(result.status);
    setMandateNumber(result.mandateNumber);
    setFieldErrors({});
    setMessage(`Draft saved${result.mandateNumber ? ` with mandate number ${result.mandateNumber}` : ""}.`);
    return result.documentId;
  }

  async function handleGenerateClause() {
    if (!workspace?.id) {
      setMessage("Workspace not found.");
      return;
    }

    if (!clausePrompt.trim()) {
      setMessage("Describe the special clause you want to generate.");
      return;
    }

    setIsGeneratingClause(true);
    setMessage(null);

    const result = await generateDocumentSpecialClauseAction({
      workspaceId: workspace.id,
      userPrompt: clausePrompt,
      documentType: ACTIVE_DOCUMENT_TYPE,
    });

    setIsGeneratingClause(false);

    if (!result.ok) {
      setMessage(result.error ?? "Could not generate special clause.");
      return;
    }

    if (!result.clause) {
      setMessage("Generated clause was empty. Please try again.");
      return;
    }

    setSpecialClauses((current) => [...current, result.clause]);
    setClausePrompt("");
    dispatchCreditsBalanceRefresh({
      workspaceId: workspace.id,
      newBalance: result.newBalance,
      source: "document-special-clause",
    });
    setMessage(`Special clause generated. Credits used: ${result.creditsUsed}.`);
  }

  async function handleExport(format: ExportFormat) {
    if (!workspace?.id) {
      setMessage("Workspace not found.");
      return;
    }

    if (!bootstrap?.brandingReady) {
      setMessage("Complete branding setup before saving or exporting a document.");
      return;
    }

    if (format === "docx" && templateSource === "agency_custom" && !selectedTemplateId) {
      setMessage("Select or upload a custom DOCX template before export.");
      return;
    }

    setIsExporting(true);
    setExportingFormat(format);
    setMessage(null);

    if (templateSource === "versaline_standard") {
      const directResult = await exportDocumentDirectAction({
        documentType: ACTIVE_DOCUMENT_TYPE,
        templateSource,
        outputFormat: format,
        title: form.title,
        formData: buildMandatVenteFormData(form, specialClauses, bootstrap?.branding ?? null),
        specialClauses,
      });

      setIsExporting(false);
      setExportingFormat(null);

      if (!directResult.ok) {
        setMessage(directResult.error ?? "Could not export document.");
        setFieldErrors(directResult.fieldErrors ?? {});
        return;
      }

      setFieldErrors({});
      setExportMimeType(directResult.mimeType);
      setDownloadUrl(null);
      triggerBase64DocumentDownload(directResult.base64, directResult.fileName, directResult.mimeType);
      setMessage(`Document exported in ${format.toUpperCase()} format.`);
      return;
    }

    let nextDraftId = draftId;

    if (!nextDraftId) {
      nextDraftId = await handleSaveDraft();
    }

    if (!nextDraftId) {
      setMessage((current) => current ?? "The draft could not be saved. Please review required fields and try again.");
      setIsExporting(false);
      setExportingFormat(null);
      return;
    }

    const result = await finalizeDocumentExportAction({
      workspaceId: workspace.id,
      documentId: nextDraftId,
      outputFormat: format,
    });

    setIsExporting(false);
    setExportingFormat(null);

    if (!result.ok) {
      setMessage(result.error ?? "Could not export document.");
      return;
    }

    if (!result.downloadUrl || !result.mimeType) {
      setMessage("Export completed without a valid download payload.");
      return;
    }

    setDownloadUrl(result.downloadUrl);
    setExportMimeType(result.mimeType);
    setDraftStatus("finalized");
    triggerDocumentDownload(result.downloadUrl, result.mimeType);
    dispatchCreditsBalanceRefresh({
      workspaceId: workspace.id,
      newBalance: result.newBalance,
      source: "document-export",
    });
    setMessage(`Document exported in ${format.toUpperCase()} format.`);
  }

  async function handleTemplateUpload() {
    if (!workspace?.id) {
      setMessage("Workspace not found.");
      return;
    }

    if (!uploadName.trim() || !uploadFile) {
      setMessage("Provide a template name and a DOCX file.");
      return;
    }

    setIsUploadingTemplate(true);
    setMessage(null);

    const result = await uploadCustomDocxTemplateAction({
      workspaceId: workspace.id,
      documentType: ACTIVE_DOCUMENT_TYPE,
      name: uploadName,
      file: uploadFile,
    });

    setIsUploadingTemplate(false);

    if (!result.ok) {
      setMessage(result.error ?? "Could not upload template.");
      return;
    }

    if (!result.template) {
      setMessage("Template upload response was incomplete.");
      return;
    }

    setUploadName("");
    setUploadFile(null);
    setSelectedTemplateId(result.template.id);
    await refreshBootstrap(workspace.id);
    setMessage(`Template uploaded with ${Array.isArray(result.template.detected_placeholders) ? result.template.detected_placeholders.length : 0} placeholder(s) detected.`);
  }

  if (workspaceError) {
    return <p className="text-sm text-red-600">{workspaceError}</p>;
  }

  return (
      <section className="flex min-h-full flex-col gap-6">
        <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                France Tier 1 generator
              </p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">
                Document generator
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--muted)]">
                The first live flow is focused on <strong>Mandat de vente</strong>, while the page
                structure already supports the other document families, dual-template strategy, and
                AI clause drafting.
              </p>
            </div>

            <div className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-3 text-sm text-[var(--foreground)]">
              <p className="font-semibold">Workspace</p>
              <p className="mt-1">{workspace?.name ?? (isWorkspaceLoading ? "Loading..." : "Unavailable")}</p>
              {mandateNumber ? <p className="mt-2 text-xs text-[var(--muted)]">Current mandate number: {mandateNumber}</p> : null}
            </div>
          </div>
        </article>

        {message ? (
          <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            {message}
          </div>
        ) : null}

        {bootstrapError ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {bootstrapError}
          </div>
        ) : null}

        {bootstrap?.propertiesAccessError ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {bootstrap.propertiesAccessError}
          </div>
        ) : null}

        {!bootstrap?.brandingReady ? (
          <article className="rounded-[28px] border border-amber-200 bg-amber-50 px-6 py-6 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">
              Setup required
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-amber-950">
              Complete agency branding and legal identity first
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-7 text-amber-900">
              This generator is blocked until the workspace has the legal minimum configured:
              agency name, Carte T details, SIRET, and RCP insurer.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/settings#workspace-branding"
                className="inline-flex items-center rounded-xl bg-amber-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-950"
              >
                Open settings
              </Link>
              {workspace?.id ? (
                <button
                  type="button"
                  onClick={() => void refreshBootstrap(workspace.id)}
                  disabled={isBootstrapping}
                  className="inline-flex items-center rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-900 transition hover:bg-amber-100 disabled:opacity-60"
                >
                  {isBootstrapping ? "Checking..." : "Re-check setup"}
                </button>
              ) : null}
            </div>
          </article>
        ) : null}

        <div className={`grid gap-6 xl:grid-cols-[1.5fr_minmax(320px,0.95fr)] ${!bootstrap?.brandingReady ? "opacity-60" : ""}`}>
          <div className="flex flex-col gap-6">
            <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                Step 1
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
                Template
              </h2>

              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {TEMPLATE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setTemplateSource(option.value)}
                    disabled={!bootstrap?.brandingReady}
                    className={`rounded-2xl border px-4 py-4 text-left transition ${
                      templateSource === option.value
                        ? "border-sky-500 bg-sky-50 dark:border-sky-500/70 dark:bg-sky-900/35"
                        : "border-[var(--border)] bg-white/70 hover:bg-white dark:bg-slate-900/45 dark:hover:bg-slate-900/65"
                    } disabled:cursor-not-allowed disabled:opacity-60`}
                  >
                    <p className={`text-sm font-semibold ${templateSource === option.value ? "text-sky-950 dark:text-sky-100" : "text-[var(--foreground)]"}`}>
                      {option.label}
                    </p>
                    <p className={`mt-2 text-sm leading-6 ${templateSource === option.value ? "text-sky-900 dark:text-sky-200" : "text-[var(--muted)]"}`}>
                      {option.detail}
                    </p>
                  </button>
                ))}
              </div>

            </article>

            <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                Step 2
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
                CRM contact and property
              </h2>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-4">
                  <label className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
                    Contact search
                  </label>
                  <input
                    value={contactSearch}
                    onChange={(event) => setContactSearch(event.target.value)}
                    disabled={!bootstrap?.brandingReady}
                    placeholder="Search seller, phone, email..."
                    className="mt-2 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400"
                  />
                  <select
                    value={selectedContactId}
                    onChange={(event) => setSelectedContactId(event.target.value)}
                    disabled={!bootstrap?.brandingReady}
                    className="mt-3 h-40 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    size={5}
                  >
                    <option value="">No linked contact</option>
                    {filteredContacts.map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-4">
                  <label className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
                    Property search
                  </label>
                  <input
                    value={propertySearch}
                    onChange={(event) => setPropertySearch(event.target.value)}
                    disabled={!bootstrap?.brandingReady}
                    placeholder="Search reference, city, postal code..."
                    className="mt-2 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400"
                  />
                  <select
                    value={selectedPropertyId}
                    onChange={(event) => setSelectedPropertyId(event.target.value)}
                    disabled={!bootstrap?.brandingReady}
                    className="mt-3 h-40 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                    size={5}
                  >
                    <option value="">No linked property</option>
                    {filteredProperties.map((property) => (
                      <option key={property.id} value={property.id}>
                        {property.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </article>

            {templateSource === "agency_custom" ? (
              <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                      Step 3A
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
                      Agency DOCX template
                    </h2>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">
                    {bootstrap?.templates.length ?? 0} template(s)
                  </span>
                </div>

                <div className="mt-5 grid gap-4 lg:grid-cols-[1.1fr_minmax(0,1fr)]">
                  <div className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-4">
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
                      Available templates
                    </label>
                    <select
                      value={selectedTemplateId}
                      onChange={(event) => setSelectedTemplateId(event.target.value)}
                      disabled={!bootstrap?.brandingReady}
                      className="mt-3 h-40 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none"
                      size={5}
                    >
                      <option value="">Select a template</option>
                      {bootstrap?.templates
                        .filter((template) => template.document_type === ACTIVE_DOCUMENT_TYPE)
                        .map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name}
                          </option>
                        ))}
                    </select>
                  </div>

                  <div className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-4">
                    <label className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
                      Upload a new DOCX template
                    </label>
                    <input
                      value={uploadName}
                      onChange={(event) => setUploadName(event.target.value)}
                      disabled={!bootstrap?.brandingReady || currentRole === "agent"}
                      placeholder="Template name"
                      className="mt-3 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400"
                    />
                    <input
                      type="file"
                      accept=".docx"
                      disabled={!bootstrap?.brandingReady || currentRole === "agent"}
                      onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
                      className="mt-3 block w-full text-sm text-[var(--foreground)]"
                    />
                    <button
                      type="button"
                      onClick={() => void handleTemplateUpload()}
                      disabled={!bootstrap?.brandingReady || currentRole === "agent" || isUploadingTemplate}
                      className="mt-4 inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-950 disabled:opacity-60"
                    >
                      {isUploadingTemplate ? "Uploading..." : "Upload template"}
                    </button>
                    {currentRole === "agent" ? (
                      <p className="mt-3 text-xs text-[var(--muted)]">
                        Only workspace managers can upload legal templates.
                      </p>
                    ) : null}
                  </div>
                </div>
              </article>
            ) : null}

            <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                Step 3
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
                Mandat de vente details
              </h2>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <Field label="Document title">
                  <input value={form.title} onChange={(event) => updateForm("title", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Mandate type">
                  <select value={form.mandateType} onChange={(event) => updateForm("mandateType", event.target.value as MandatVenteFormState["mandateType"])} disabled={!bootstrap?.brandingReady} className={inputClassName}>
                    {MANDATE_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Seller full name">
                  <input value={form.sellerName} onChange={(event) => updateForm("sellerName", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Seller email">
                  <input value={form.sellerEmail} onChange={(event) => updateForm("sellerEmail", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Seller phone">
                  <input value={form.sellerPhone} onChange={(event) => updateForm("sellerPhone", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Property reference">
                  <input value={form.propertyReference} onChange={(event) => updateForm("propertyReference", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
              </div>

              <div className="mt-4">
                <Field label="Seller address">
                  <textarea value={form.sellerAddress} onChange={(event) => updateForm("sellerAddress", event.target.value)} disabled={!bootstrap?.brandingReady} rows={3} className={textareaClassName} />
                </Field>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <Field label="Address line 1">
                  <input value={form.addressLine1} onChange={(event) => updateForm("addressLine1", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Address line 2">
                  <input value={form.addressLine2} onChange={(event) => updateForm("addressLine2", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Postal code">
                  <input value={form.postalCode} onChange={(event) => updateForm("postalCode", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="City">
                  <input value={form.city} onChange={(event) => updateForm("city", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Cadastre reference">
                  <input value={form.cadastreReference} onChange={(event) => updateForm("cadastreReference", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Property type">
                  <input value={form.propertyType} onChange={(event) => updateForm("propertyType", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Loi Carrez surface (m²)">
                  <input value={form.loiCarrezSurfaceSqm} onChange={(event) => updateForm("loiCarrezSurfaceSqm", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="DPE energy rating">
                  <select value={form.dpeEnergyRating} onChange={(event) => updateForm("dpeEnergyRating", event.target.value as MandatVenteFormState["dpeEnergyRating"])} disabled={!bootstrap?.brandingReady} className={inputClassName}>
                    {DPE_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </Field>
                <Field label="DPE climate rating">
                  <select value={form.dpeClimateRating} onChange={(event) => updateForm("dpeClimateRating", event.target.value as MandatVenteFormState["dpeClimateRating"])} disabled={!bootstrap?.brandingReady} className={inputClassName}>
                    {DPE_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Field label="Listing price (EUR)">
                  <input value={form.listingPriceEur} onChange={(event) => updateForm("listingPriceEur", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Net seller price (EUR)">
                  <input value={form.netSellerPriceEur} onChange={(event) => updateForm("netSellerPriceEur", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="Agency fees (EUR)">
                  <input value={form.agencyFeesEur} onChange={(event) => updateForm("agencyFeesEur", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
                <Field label="VAT rate (%)">
                  <input value={form.agencyFeesVatRate} onChange={(event) => updateForm("agencyFeesVatRate", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field label="Fee payer">
                  <select value={form.feePayer} onChange={(event) => updateForm("feePayer", event.target.value as MandatVenteFormState["feePayer"])} disabled={!bootstrap?.brandingReady} className={inputClassName}>
                    {FEE_PAYER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Cooling-off period (days)">
                  <input value={form.coolingOffPeriodDays} onChange={(event) => updateForm("coolingOffPeriodDays", event.target.value)} disabled={!bootstrap?.brandingReady} className={inputClassName} />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <Field label="Signature date">
                  <DateTimePickerInput
                    mode="date"
                    value={form.signatureDate}
                    onChange={(nextValue) => updateForm("signatureDate", nextValue)}
                    disabled={!bootstrap?.brandingReady}
                    className={inputClassName}
                  />
                </Field>
                <Field label="Effective date">
                  <DateTimePickerInput
                    mode="date"
                    value={form.effectiveDate}
                    onChange={(nextValue) => updateForm("effectiveDate", nextValue)}
                    disabled={!bootstrap?.brandingReady}
                    className={inputClassName}
                  />
                </Field>
                <Field label="Expiration date">
                  <DateTimePickerInput
                    mode="date"
                    value={form.expirationDate}
                    onChange={(nextValue) => updateForm("expirationDate", nextValue)}
                    disabled={!bootstrap?.brandingReady}
                    className={inputClassName}
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <label className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-3 text-sm text-[var(--foreground)] dark:bg-slate-900/55">
                  <input type="checkbox" checked={form.tacitRenewalAllowed} onChange={(event) => updateForm("tacitRenewalAllowed", event.target.checked)} disabled={!bootstrap?.brandingReady} />
                  Tacit renewal allowed
                </label>
                <label className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-3 text-sm text-[var(--foreground)] dark:bg-slate-900/55">
                  <input type="checkbox" checked={form.consumerInformationDelivered} onChange={(event) => updateForm("consumerInformationDelivered", event.target.checked)} disabled={!bootstrap?.brandingReady} />
                  14-day cooling-off information delivered
                </label>
              </div>

              <div className="mt-4">
                <Field label="Marketing commitments (one per line)">
                  <textarea value={form.marketingCommitmentsText} onChange={(event) => updateForm("marketingCommitmentsText", event.target.value)} disabled={!bootstrap?.brandingReady} rows={4} className={textareaClassName} />
                </Field>
              </div>
            </article>
          </div>

          <div className="flex flex-col gap-6">
            <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                Step 4
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
                AI clause assistant
              </h2>
              <textarea
                value={clausePrompt}
                onChange={(event) => setClausePrompt(event.target.value)}
                disabled={!bootstrap?.brandingReady}
                rows={4}
                placeholder="Example: seller leaves kitchen equipment for free."
                className={`${textareaClassName} mt-4`}
              />
              <button
                type="button"
                onClick={() => void handleGenerateClause()}
                disabled={!bootstrap?.brandingReady || isGeneratingClause}
                className="mt-4 inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-950 disabled:opacity-60"
              >
                {isGeneratingClause ? "Drafting..." : "Draft special clause"}
              </button>

              <div className="mt-5 space-y-3">
                {specialClauses.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-[var(--border)] bg-white/60 px-4 py-4 text-sm text-[var(--muted)]">
                    No special clauses yet.
                  </p>
                ) : (
                  specialClauses.map((clause, index) => (
                    <div key={`${index}-${clause.slice(0, 24)}`} className="rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-4">
                      <p className="text-sm leading-6 text-[var(--foreground)]">{clause}</p>
                      <button
                        type="button"
                        onClick={() => setSpecialClauses((current) => current.filter((_, clauseIndex) => clauseIndex !== index))}
                        className="mt-3 text-xs font-semibold uppercase tracking-[0.14em] text-red-600"
                      >
                        Remove clause
                      </button>
                    </div>
                  ))
                )}
              </div>
            </article>

            <article className="rounded-[28px] border border-[var(--border)] bg-[var(--surface-strong)] px-6 py-6 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                Live preview
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
                Draft summary
              </h2>

              <div className="mt-5 space-y-4 rounded-2xl border border-[var(--border)] bg-white/70 px-4 py-4 text-sm leading-6 text-[var(--foreground)]">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Document</p>
                  <p className="mt-1 font-semibold">{form.title || "Mandat de vente"}</p>
                  <p className="text-[var(--muted)]">{templateSource === "versaline_standard" ? "Standard legal template" : "Agency custom template"}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Seller</p>
                  <p className="mt-1">{form.sellerName || "No seller selected"}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Property</p>
                  <p className="mt-1">{form.addressLine1 || "No property selected"}</p>
                  <p className="text-[var(--muted)]">{[form.postalCode, form.city].filter(Boolean).join(" ") || "Manual override pending"}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Financials</p>
                  <p className="mt-1">Listing {formatCurrencyPreview(form.listingPriceEur)} · Net seller {formatCurrencyPreview(form.netSellerPriceEur)}</p>
                  <p className="text-[var(--muted)]">Fees {formatCurrencyPreview(form.agencyFeesEur)} · {form.feePayer.replaceAll("_", " ")}</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Special clauses</p>
                  <p className="mt-1">{specialClauses.length > 0 ? `${specialClauses.length} clause(s) ready` : "None"}</p>
                </div>
                {draftId ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Draft state</p>
                    <p className="mt-1 break-all">{draftId}</p>
                    <p className="text-[var(--muted)]">Status: {draftStatus ?? "draft"}</p>
                  </div>
                ) : null}
              </div>

              {Object.keys(fieldErrors).length > 0 ? (
                <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700">
                  {Object.entries(fieldErrors).map(([key, errors]) => (
                    <p key={key}><strong>{formatFieldErrorLabel(key)}</strong>: {errors.join(", ")}</p>
                  ))}
                </div>
              ) : null}

              {message ? (
                <div className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
                  {message}
                </div>
              ) : null}

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void handleSaveDraft()}
                  disabled={isSavingDraft || isExporting}
                  className="inline-flex items-center rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-slate-50 disabled:opacity-60"
                >
                  {isSavingDraft ? "Saving..." : draftId ? "Update draft" : "Save draft"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport("pdf")}
                  disabled={isExporting || isSavingDraft}
                  className="inline-flex items-center rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:opacity-60"
                >
                  {isExporting && exportingFormat === "pdf" ? "Exporting PDF..." : "Generate & export PDF"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleExport("docx")}
                  disabled={isExporting || isSavingDraft || (templateSource === "agency_custom" && !selectedTemplateId)}
                  className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-950 disabled:opacity-60"
                >
                  {isExporting && exportingFormat === "docx" ? "Exporting DOCX..." : "Generate & export DOCX"}
                </button>
              </div>

              {downloadUrl ? (
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex items-center rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-800"
                >
                  Download exported {exportMimeType === "application/pdf" ? "PDF" : "DOCX"}
                </a>
              ) : null}
            </article>
          </div>
        </div>
      </section>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
        {props.label}
      </span>
      <div className="mt-2">{props.children}</div>
    </label>
  );
}

function buildMandatVenteFormData(
  form: MandatVenteFormState,
  specialClauses: string[],
  branding: BootstrapSuccess["branding"] | null,
) {
  return {
    title: form.title,
    workspaceBranding: {
      agencyName: branding?.agency_name ?? "",
      logoUrl: branding?.logo_url ?? null,
      primaryColor: branding?.primary_color ?? "#0F172A",
      accentColor: branding?.accent_color ?? "#3B82F6",
      carteTNumber: branding?.carte_t_number ?? "",
      carteTCci: branding?.carte_t_cci ?? "",
      siret: branding?.siret ?? "",
      rcpPolicyNumber: branding?.rcp_policy_number ?? null,
      rcpInsurer: branding?.rcp_insurer ?? "",
      guarantorName: branding?.guarantor_name ?? null,
      guarantorAmountEur: branding?.guarantor_amount_eur ?? null,
    },
    mandateType: form.mandateType,
    principalSeller: {
      fullName: form.sellerName,
      email: form.sellerEmail || null,
      phone: form.sellerPhone || null,
      address: form.sellerAddress || null,
      companyName: null,
    },
    coSellers: [],
    property: {
      reference: form.propertyReference || null,
      addressLine1: form.addressLine1,
      addressLine2: form.addressLine2 || null,
      postalCode: form.postalCode,
      city: form.city,
      cadastreReference: form.cadastreReference || null,
      propertyType: form.propertyType || null,
      loiCarrezSurfaceSqm: parseNumber(form.loiCarrezSurfaceSqm),
      habitableSurfaceSqm: parseOptionalNumber(form.habitableSurfaceSqm),
      dpeEnergyRating: form.dpeEnergyRating,
      dpeClimateRating: form.dpeClimateRating,
      furnishedInventoryIncluded: false,
    },
    economics: {
      listingPriceEur: parseNumber(form.listingPriceEur),
      netSellerPriceEur: parseNumber(form.netSellerPriceEur),
      agencyFeesEur: parseNumber(form.agencyFeesEur),
      agencyFeesVatRate: parseOptionalNumber(form.agencyFeesVatRate),
      feePayer: form.feePayer,
    },
    marketingCommitments: form.marketingCommitmentsText
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
    coolingOff: {
      consumerInformationDelivered: form.consumerInformationDelivered,
      coolingOffPeriodDays: parseNumber(form.coolingOffPeriodDays),
    },
    mandateTiming: {
      signatureDate: form.signatureDate,
      effectiveDate: form.effectiveDate,
      expirationDate: form.expirationDate,
      tacitRenewalAllowed: form.tacitRenewalAllowed,
    },
    specialClauses,
  };
}

function parseNumber(value: string) {
  const normalized = Number.parseFloat(value.replace(",", "."));
  return Number.isFinite(normalized) ? normalized : 0;
}

function parseOptionalNumber(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const normalized = Number.parseFloat(trimmed.replace(",", "."));
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeDpeValue(value: string | null | undefined, fallback: (typeof DPE_OPTIONS)[number]) {
  return value && DPE_OPTIONS.includes(value as (typeof DPE_OPTIONS)[number])
    ? (value as (typeof DPE_OPTIONS)[number])
    : fallback;
}

function formatCurrencyPreview(value: string) {
  if (!value.trim()) {
    return "Not set";
  }

  const amount = Number.parseFloat(value.replace(",", "."));

  if (!Number.isFinite(amount)) {
    return value;
  }

  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(amount);
}

function triggerDocumentDownload(url: string, _mimeType: string) {
  if (typeof window === "undefined") {
    return;
  }

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  window.location.assign(url);
}

function triggerBase64DocumentDownload(base64: string, fileName: string, mimeType: string) {
  if (typeof window === "undefined") {
    return;
  }

  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const blob = new Blob([bytes], { type: mimeType });
  const downloadUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(downloadUrl);
}

function formatFieldErrorLabel(key: string) {
  const keyLabelMap: Record<string, string> = {
    form: "Form",
    title: "Document title",
    mandateType: "Mandate type",
    "principalSeller.fullName": "Seller full name",
    "principalSeller.email": "Seller email",
    "principalSeller.phone": "Seller phone",
    "principalSeller.address": "Seller address",
    "property.addressLine1": "Address line 1",
    "property.addressLine2": "Address line 2",
    "property.postalCode": "Postal code",
    "property.city": "City",
    "property.cadastreReference": "Cadastre reference",
    "property.propertyType": "Property type",
    "property.loiCarrezSurfaceSqm": "Loi Carrez surface (m2)",
    "property.dpeEnergyRating": "DPE energy rating",
    "property.dpeClimateRating": "DPE climate rating",
    "economics.listingPriceEur": "Listing price (EUR)",
    "economics.netSellerPriceEur": "Net seller price (EUR)",
    "economics.agencyFeesEur": "Agency fees (EUR)",
    "economics.agencyFeesVatRate": "VAT rate (%)",
    "economics.feePayer": "Fee payer",
    "coolingOff.coolingOffPeriodDays": "Cooling-off period (days)",
    "coolingOff.consumerInformationDelivered": "Cooling-off information delivered",
    "mandateTiming.signatureDate": "Signature date",
    "mandateTiming.effectiveDate": "Effective date",
    "mandateTiming.expirationDate": "Expiration date",
    "mandateTiming.tacitRenewalAllowed": "Tacit renewal allowed",
    marketingCommitments: "Marketing commitments",
    specialClauses: "Special clauses",
    "workspaceBranding.agencyName": "Agency name",
    "workspaceBranding.carteTNumber": "Carte T number",
    "workspaceBranding.carteTCci": "Carte T CCI",
    "workspaceBranding.siret": "SIRET",
    "workspaceBranding.rcpInsurer": "RCP insurer",
  };

  const mapped = keyLabelMap[key];

  if (mapped) {
    return mapped;
  }

  return key
    .replaceAll(".", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

const inputClassName =
  "w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-sky-400";

const textareaClassName =
  "w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm leading-6 text-[var(--foreground)] outline-none transition focus:border-sky-400";