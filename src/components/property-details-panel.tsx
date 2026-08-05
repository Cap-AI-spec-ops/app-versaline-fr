"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

import WorkspaceContactPicker, { type WorkspaceContactOption } from "@/components/workspace-contact-picker";
import { mapWorkspaceProperty, type WorkspacePropertySummary } from "@/lib/properties/workspace-properties";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

type PropertyDetailsPanelProps = {
  propertyId: string;
};

type PropertyContactRecommendation = {
  contactId: string;
  fullName: string;
  stage: string;
  roles: string[];
  score: number;
  reasons: string[];
  distanceKm: number | null;
  budget: number | null;
  currency: string;
};

type RecommendationsResponse = {
  ok?: boolean;
  recommendations?: PropertyContactRecommendation[];
  error?: string;
};

type PropertyFormState = {
  transactionType: "sale" | "rent";
  askingPrice: string;
  monthlyRent: string;
  linkedSellerContactId: string;
  linkedTenantContactId: string;
  reference: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  neighborhood: string;
  propertyType: string;
  cadastreReference: string;
  rooms: string;
  bathrooms: string;
  loiCarrezSurfaceSqm: string;
  dpeEnergyRating: string;
  dpeClimateRating: string;
};

const PROPERTY_IMAGE_BUCKET = "property-images";
const DPE_OPTIONS = ["", "A", "B", "C", "D", "E", "F", "G", "N/A"];
const TRANSACTION_TYPE_OPTIONS: Array<{ value: "sale" | "rent"; label: string }> = [
  { value: "sale", label: "For sale" },
  { value: "rent", label: "For rent" },
];
const PROPERTY_TYPE_OPTIONS = [
  "Apartment",
  "House",
  "Villa",
  "Studio",
  "Loft",
  "Duplex",
  "Townhouse",
  "Commercial space",
  "Land",
];

const EMPTY_FORM: PropertyFormState = {
  transactionType: "sale",
  askingPrice: "",
  monthlyRent: "",
  linkedSellerContactId: "",
  linkedTenantContactId: "",
  reference: "",
  addressLine1: "",
  addressLine2: "",
  postalCode: "",
  city: "",
  neighborhood: "",
  propertyType: "",
  cadastreReference: "",
  rooms: "",
  bathrooms: "",
  loiCarrezSurfaceSqm: "",
  dpeEnergyRating: "",
  dpeClimateRating: "",
};

function toOptionalNumber(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStorageObjectPath(path: string) {
  const trimmed = path.trim();

  if (!trimmed) {
    return "";
  }

  const bucketPrefix = `${PROPERTY_IMAGE_BUCKET}/`;
  return trimmed.startsWith(bucketPrefix) ? trimmed.slice(bucketPrefix.length) : trimmed;
}

function formatStageLabel(value: string) {
  if (!value) {
    return "Unknown";
  }

  if (value === "closed_won") {
    return "Active";
  }

  return value.replace(/_/g, " ");
}

function formatRoleLabel(value: string) {
  return value.replace(/_/g, " ");
}

function formatDistance(value: number | null) {
  if (value === null) {
    return "Distance unavailable";
  }

  if (value < 1) {
    return `< 1 km`;
  }

  return `${value.toFixed(1)} km`;
}

function formatMoney(value: number | null, currency: string) {
  if (value === null) {
    return "No budget";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function displayValue(value: string | number | null | undefined) {
  if (value === null || value === undefined) {
    return "-";
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : "-";
  }

  return String(value);
}

function normalizeFileName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function createFormFromProperty(property: WorkspacePropertySummary): PropertyFormState {
  return {
    transactionType: property.transactionType ?? "sale",
    askingPrice: property.askingPrice !== null ? String(property.askingPrice) : "",
    monthlyRent: property.monthlyRent !== null ? String(property.monthlyRent) : "",
    linkedSellerContactId: property.linkedSellerContactId ?? "",
    linkedTenantContactId: property.linkedTenantContactId ?? "",
    reference: property.reference ?? "",
    addressLine1: property.addressLine1 ?? "",
    addressLine2: property.addressLine2 ?? "",
    postalCode: property.postalCode ?? "",
    city: property.city ?? "",
    neighborhood: property.neighborhood ?? "",
    propertyType: property.propertyType ?? "",
    cadastreReference: property.cadastreReference ?? "",
    rooms: property.rooms !== null ? String(property.rooms) : "",
    bathrooms: property.bathrooms !== null ? String(property.bathrooms) : "",
    loiCarrezSurfaceSqm:
      property.loiCarrezSurfaceSqm !== null ? String(property.loiCarrezSurfaceSqm) : "",
    dpeEnergyRating: property.dpeEnergyRating ?? "",
    dpeClimateRating: property.dpeClimateRating ?? "",
  };
}

export default function PropertyDetailsPanel({ propertyId }: PropertyDetailsPanelProps) {
  const { workspace, isLoading: isWorkspaceLoading, error: workspaceError } = useCurrentWorkspace();
  const [property, setProperty] = useState<WorkspacePropertySummary | null>(null);
  const [form, setForm] = useState<PropertyFormState>(EMPTY_FORM);
  const [coverUrl, setCoverUrl] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isLoadingProperty, setIsLoadingProperty] = useState(true);
  const [isLoadingRecommendations, setIsLoadingRecommendations] = useState(true);
  const [recommendations, setRecommendations] = useState<PropertyContactRecommendation[]>([]);
  const [recommendationsError, setRecommendationsError] = useState<string | null>(null);
  const [propertyError, setPropertyError] = useState<string | null>(null);
  const [editFiles, setEditFiles] = useState<File[]>([]);
  const [editUploadCoverIndex, setEditUploadCoverIndex] = useState(0);
  const [editExistingCoverPath, setEditExistingCoverPath] = useState<string | null>(null);
  const [editExistingImagePreviews, setEditExistingImagePreviews] = useState<Array<{ path: string; url: string }>>([]);
  const [linkedSellerContact, setLinkedSellerContact] = useState<WorkspaceContactOption | null>(null);
  const [linkedTenantContact, setLinkedTenantContact] = useState<WorkspaceContactOption | null>(null);

  const editPreviewUrls = useMemo(
    () => editFiles.map((file) => URL.createObjectURL(file)),
    [editFiles],
  );

  useEffect(() => {
    return () => {
      editPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [editPreviewUrls]);

  useEffect(() => {
    if (editFiles.length === 0) {
      setEditUploadCoverIndex(0);
      return;
    }

    if (editUploadCoverIndex > editFiles.length - 1) {
      setEditUploadCoverIndex(0);
    }
  }, [editFiles, editUploadCoverIndex]);

  useEffect(() => {
    async function loadLinkedContacts(workspaceId: string, contactIds: string[]) {
      const supabase = getSupabaseBrowserClient();

      if (!supabase || contactIds.length === 0) {
        if (!property?.linkedSellerContactId) {
          setLinkedSellerContact(null);
        }

        if (!property?.linkedTenantContactId) {
          setLinkedTenantContact(null);
        }
        return;
      }

      const { data, error } = await supabase
        .from("crm_contacts")
        .select("id, first_name, last_name, email, client_type, contact_roles")
        .eq("workspace_id", workspaceId)
        .in("id", contactIds);

      if (error) {
        return;
      }

      const options = ((data ?? []) as Array<{
        id: string;
        first_name: string;
        last_name: string;
        email: string | null;
        client_type: string;
        contact_roles: string[] | null;
      }>).map((contact) => ({
        id: contact.id,
        label: `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || contact.email || "Unnamed contact",
        email: contact.email,
        clientType: contact.client_type,
        contactRoles: Array.isArray(contact.contact_roles) && contact.contact_roles.length > 0 ? contact.contact_roles : [contact.client_type],
      }));

      setLinkedSellerContact(options.find((contact) => contact.id === property?.linkedSellerContactId) ?? null);
      setLinkedTenantContact(options.find((contact) => contact.id === property?.linkedTenantContactId) ?? null);
    }

    if (!workspace?.id || !property) {
      return;
    }

    const ids = [property.linkedSellerContactId, property.linkedTenantContactId].filter(
      (value): value is string => Boolean(value),
    );

    void loadLinkedContacts(workspace.id, ids);
  }, [property, workspace?.id]);

  const propertyLocation = useMemo(() => {
    if (!property) {
      return "-";
    }

    return [property.addressLine1, property.postalCode, property.city].filter(Boolean).join(", ") || "-";
  }, [property]);

  const highConfidenceRecommendations = useMemo(
    () => recommendations.filter((item) => item.score > 70),
    [recommendations],
  );

  const otherRecommendations = useMemo(
    () => recommendations.filter((item) => item.score > 40 && item.score <= 70).slice(0, 3),
    [recommendations],
  );

  async function createSignedImageUrl(path: string) {
    const normalizedPath = normalizeStorageObjectPath(path);

    if (!normalizedPath) {
      return "";
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      return "";
    }

    const { data, error: signedError } = await supabase.storage
      .from(PROPERTY_IMAGE_BUCKET)
      .createSignedUrl(normalizedPath, 60 * 60);

    if (signedError || !data?.signedUrl) {
      return "";
    }

    return data.signedUrl;
  }

  async function loadEditExistingImagePreviews(paths: string[]) {
    const previews = await Promise.all(
      paths.map(async (path) => {
        const url = await createSignedImageUrl(path);
        return { path, url };
      }),
    );

    setEditExistingImagePreviews(previews.filter((preview) => Boolean(preview.url)));
  }

  async function refreshCoverUrl(nextProperty: WorkspacePropertySummary) {
    if (!nextProperty.coverImagePath) {
      setCoverUrl("");
      return;
    }

    const normalizedPath = normalizeStorageObjectPath(nextProperty.coverImagePath);

    if (!normalizedPath) {
      setCoverUrl("");
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setCoverUrl("");
      return;
    }

    const { data: signedData, error: signedError } = await supabase.storage
      .from(PROPERTY_IMAGE_BUCKET)
      .createSignedUrl(normalizedPath, 60 * 60);

    if (!signedError && signedData?.signedUrl) {
      setCoverUrl(signedData.signedUrl);
      return;
    }

    setCoverUrl("");
  }

  async function uploadPropertyImages(workspaceId: string, files: File[]) {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      throw new Error("Supabase is not configured.");
    }

    const uploadedPaths: string[] = [];

    for (const file of files) {
      const normalizedName = normalizeFileName(file.name || `property-${Date.now()}.jpg`);
      const storagePath = `${workspaceId}/${crypto.randomUUID()}-${normalizedName}`;
      const { data, error: uploadError } = await supabase.storage
        .from(PROPERTY_IMAGE_BUCKET)
        .upload(storagePath, file, {
          contentType: file.type || "image/jpeg",
          upsert: false,
        });

      if (uploadError) {
        throw new Error(uploadError.message);
      }

      const path =
        (data as { path?: string; fullPath?: string } | null)?.path ??
        (data as { path?: string; fullPath?: string } | null)?.fullPath ??
        storagePath;

      uploadedPaths.push(normalizeStorageObjectPath(path));
    }

    return uploadedPaths;
  }

  async function removeImages(paths: string[]) {
    const normalizedPaths = paths
      .map((path) => normalizeStorageObjectPath(path))
      .filter((path) => path.length > 0);

    if (normalizedPaths.length === 0) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      return;
    }

    await supabase.storage.from(PROPERTY_IMAGE_BUCKET).remove(normalizedPaths);
  }

  async function fetchRecommendations() {
    setIsLoadingRecommendations(true);
    setRecommendationsError(null);

    const response = await fetch(`/api/properties/${propertyId}/recommendations`, {
      method: "GET",
    });

    let payload: RecommendationsResponse | null = null;

    try {
      payload = (await response.json()) as RecommendationsResponse;
    } catch {
      payload = null;
    }

    if (!response.ok || !payload?.ok) {
      setRecommendations([]);
      setRecommendationsError(payload?.error ?? "Could not load recommendations.");
      setIsLoadingRecommendations(false);
      return;
    }

    setRecommendations(payload.recommendations ?? []);
    setIsLoadingRecommendations(false);
  }

  async function startEditProperty() {
    if (!property) {
      return;
    }

    setForm(createFormFromProperty(property));
    setEditFiles([]);
    setEditUploadCoverIndex(0);
    setEditExistingCoverPath(
      property.coverImagePath
        ? normalizeStorageObjectPath(property.coverImagePath)
        : property.imagePaths[0]
          ? normalizeStorageObjectPath(property.imagePaths[0])
          : null,
    );
    await loadEditExistingImagePreviews(property.imagePaths.map((path) => normalizeStorageObjectPath(path)));
    setFormError(null);
    setMessage(null);
    setIsEditing(true);
  }

  function cancelEditProperty() {
    if (property) {
      setForm(createFormFromProperty(property));
    }

    setEditFiles([]);
    setEditUploadCoverIndex(0);
    setEditExistingCoverPath(null);
    setEditExistingImagePreviews([]);
    setIsEditing(false);
    setFormError(null);
  }

  async function handleSaveEditProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!workspace?.id || !property) {
      return;
    }

    if (!form.addressLine1.trim()) {
      setFormError("Address is required.");
      return;
    }

    if (!form.city.trim()) {
      setFormError("City is required.");
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setFormError("Supabase is not configured.");
      return;
    }

    setIsSaving(true);
    setFormError(null);
    setMessage(null);

    try {
      const replacementImagePaths =
        editFiles.length > 0 ? await uploadPropertyImages(workspace.id, editFiles) : property.imagePaths;
      const resolvedCoverPath =
        editFiles.length > 0
          ? replacementImagePaths[editUploadCoverIndex] ?? replacementImagePaths[0] ?? null
          : (editExistingCoverPath ? normalizeStorageObjectPath(editExistingCoverPath) : null) ?? replacementImagePaths[0] ?? null;
      const updateTitle = form.reference.trim() || form.addressLine1.trim();

      const payload = {
        transaction_type: form.transactionType,
        listing_type: form.transactionType,
        asking_price: form.transactionType === "sale" ? toOptionalNumber(form.askingPrice) : null,
        monthly_rent: form.transactionType === "rent" ? toOptionalNumber(form.monthlyRent) : null,
        seller_contact_id: form.transactionType === "sale" ? form.linkedSellerContactId || null : null,
        tenant_contact_id: form.transactionType === "rent" ? form.linkedTenantContactId || null : null,
        title: updateTitle,
        name: updateTitle,
        reference: form.reference.trim() || null,
        address_line1: form.addressLine1.trim(),
        address_line2: form.addressLine2.trim() || null,
        postal_code: form.postalCode.trim() || null,
        city: form.city.trim(),
        neighborhood: form.neighborhood.trim() || null,
        property_type: form.propertyType.trim() || null,
        cadastre_reference: form.cadastreReference.trim() || null,
        rooms: toOptionalNumber(form.rooms),
        bathrooms: toOptionalNumber(form.bathrooms),
        loi_carrez_surface_sqm: toOptionalNumber(form.loiCarrezSurfaceSqm),
        dpe_energy_rating: form.dpeEnergyRating.trim() || null,
        dpe_climate_rating: form.dpeClimateRating.trim() || null,
        image_paths: replacementImagePaths,
        cover_image_path: resolvedCoverPath,
      };

      const { data, error: updateError } = await supabase
        .from("properties")
        .update(payload)
        .eq("workspace_id", workspace.id)
        .eq("id", property.id)
        .select("*")
        .single();

      if (updateError) {
        throw new Error(updateError.message);
      }

      const updated = mapWorkspaceProperty((data ?? {}) as Record<string, unknown>);
      setProperty(updated);
      setForm(createFormFromProperty(updated));
      await refreshCoverUrl(updated);

      if (editFiles.length > 0) {
        const oldPaths = property.imagePaths.filter((path) => !replacementImagePaths.includes(path));
        void removeImages(oldPaths);
      }

      setEditFiles([]);
      setEditUploadCoverIndex(0);
      setEditExistingCoverPath(null);
      setEditExistingImagePreviews([]);
      setIsEditing(false);
      setMessage("Property updated.");
      void fetchRecommendations();
    } catch (updateError) {
      setFormError(
        updateError instanceof Error
          ? `Could not update property: ${updateError.message}`
          : "Could not update property.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  useEffect(() => {
    async function loadProperty(workspaceId: string) {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        setPropertyError("Supabase is not configured.");
        setIsLoadingProperty(false);
        return;
      }

      setIsLoadingProperty(true);
      setPropertyError(null);

      const { data, error: fetchError } = await supabase
        .from("properties")
        .select("*")
        .eq("workspace_id", workspaceId)
        .eq("id", propertyId)
        .maybeSingle();

      if (fetchError) {
        setProperty(null);
        setPropertyError(`Could not load property: ${fetchError.message}`);
        setIsLoadingProperty(false);
        return;
      }

      if (!data) {
        setProperty(null);
        setPropertyError("Property not found in this workspace.");
        setIsLoadingProperty(false);
        return;
      }

      const mapped = mapWorkspaceProperty(data as Record<string, unknown>);
      setProperty(mapped);
      setForm(createFormFromProperty(mapped));
      await refreshCoverUrl(mapped);

      setIsLoadingProperty(false);
    }

    if (!workspace?.id) {
      return;
    }

    void loadProperty(workspace.id);
  }, [workspace?.id, propertyId]);

  useEffect(() => {
    if (!workspace?.id) {
      return;
    }

    void fetchRecommendations();
  }, [workspace?.id, propertyId]);

  if (workspaceError) {
    return <p className="text-sm text-red-600">{workspaceError}</p>;
  }

  if (isWorkspaceLoading || isLoadingProperty) {
    return <p className="text-sm text-[var(--muted)]">Loading property...</p>;
  }

  if (!property) {
    return <p className="text-sm text-red-600">{propertyError ?? "Property not found."}</p>;
  }

  return (
    <section className="flex min-h-full flex-col gap-6">
      <article className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">Property workspace</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--foreground)]">
              {property.label}
            </h1>
          </div>
          {!isEditing ? (
            <button
              type="button"
              onClick={() => void startEditProperty()}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Edit property
            </button>
          ) : null}
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">{propertyLocation}</p>

        {isEditing ? (
          <form onSubmit={handleSaveEditProperty} className="mt-4 grid gap-4 sm:grid-cols-2">
            <PropertyFormFields
              workspaceId={workspace?.id}
              form={form}
              onChange={setForm}
              onSellerPick={setLinkedSellerContact}
              onTenantPick={setLinkedTenantContact}
            />

            <div className="sm:col-span-2">
              {editExistingImagePreviews.length > 0 ? (
                <div className="mb-4">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
                    Current photos (pick cover)
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {editExistingImagePreviews.map((image) => {
                      const isActive = editFiles.length === 0 && editExistingCoverPath === image.path;

                      return (
                        <button
                          key={image.path}
                          type="button"
                          onClick={() => setEditExistingCoverPath(image.path)}
                          className={`overflow-hidden rounded-xl border ${isActive ? "border-[var(--accent)]" : "border-[var(--border)]"} bg-[var(--surface)] text-left`}
                        >
                          <img
                            src={image.url}
                            alt="Property image"
                            className="h-24 w-full object-cover"
                          />
                          <span className="block px-2 py-1 text-[11px] font-semibold text-[var(--foreground)]">
                            {isActive ? "Cover photo" : "Set as cover"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <label className="text-sm text-[var(--muted)]">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Replace photos</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => {
                    setEditFiles(Array.from(event.target.files ?? []));
                    setEditUploadCoverIndex(0);
                  }}
                  className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)]"
                />
              </label>
              {editPreviewUrls.length > 0 ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  {editPreviewUrls.map((url, index) => (
                    <button
                      key={url}
                      type="button"
                      onClick={() => setEditUploadCoverIndex(index)}
                      className={`overflow-hidden rounded-xl border ${editUploadCoverIndex === index ? "border-[var(--accent)]" : "border-[var(--border)]"} bg-[var(--surface)] text-left`}
                    >
                      <img
                        src={url}
                        alt={`New property photo ${index + 1}`}
                        className="h-24 w-full object-cover"
                      />
                      <span className="block px-2 py-1 text-[11px] font-semibold text-[var(--foreground)]">
                        {editUploadCoverIndex === index ? "Cover photo" : "Set as cover"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {formError ? <p className="sm:col-span-2 text-sm font-medium text-red-600">{formError}</p> : null}
            {message ? <p className="sm:col-span-2 text-sm font-medium text-emerald-700">{message}</p> : null}

            <div className="sm:col-span-2 flex items-center gap-2">
              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:opacity-60"
              >
                {isSaving ? "Saving..." : "Save changes"}
              </button>
              <button
                type="button"
                onClick={cancelEditProperty}
                className="inline-flex items-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-4 grid gap-3 text-sm text-[var(--foreground)] sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Listing</p>
              <p className="mt-1 font-semibold">
                {property.transactionType === "rent" ? "For rent" : property.transactionType === "sale" ? "For sale" : "-"}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Reference</p>
              <p className="mt-1 font-semibold">{displayValue(property.reference)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Type</p>
              <p className="mt-1 font-semibold">{displayValue(property.propertyType)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                {property.transactionType === "rent" ? "Monthly rent" : "Asking price"}
              </p>
              <p className="mt-1 font-semibold">
                {property.transactionType === "rent"
                  ? property.monthlyRent !== null
                    ? formatMoney(property.monthlyRent, "EUR")
                    : "-"
                  : property.askingPrice !== null
                    ? formatMoney(property.askingPrice, "EUR")
                    : "-"}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 sm:col-span-2 lg:col-span-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Address line 1</p>
              <p className="mt-1 font-semibold">{displayValue(property.addressLine1)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 sm:col-span-2 lg:col-span-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Address line 2</p>
              <p className="mt-1 font-semibold">{displayValue(property.addressLine2)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Postal code</p>
              <p className="mt-1 font-semibold">{displayValue(property.postalCode)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">City</p>
              <p className="mt-1 font-semibold">{displayValue(property.city)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Neighborhood</p>
              <p className="mt-1 font-semibold">{displayValue(property.neighborhood)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Cadastre reference</p>
              <p className="mt-1 font-semibold">{displayValue(property.cadastreReference)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 sm:col-span-2 lg:col-span-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                {property.transactionType === "rent" ? "Linked tenant" : "Linked seller"}
              </p>
              {property.transactionType === "rent" ? (
                property.linkedTenantContactId ? (
                  <Link
                    href={`/contacts?contactId=${property.linkedTenantContactId}&details=1`}
                    className="mt-1 inline-flex font-semibold text-[var(--foreground)] underline-offset-2 hover:text-[var(--accent)] hover:underline"
                  >
                    {linkedTenantContact?.label ?? "Open linked tenant"}
                  </Link>
                ) : (
                  <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-[var(--foreground)]">Not linked yet</p>
                    <button
                      type="button"
                      onClick={() => void startEditProperty()}
                      className="rounded-lg border border-[var(--border)] bg-[var(--surface-strong)] px-2.5 py-1 text-[11px] font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    >
                      Link tenant
                    </button>
                  </div>
                )
              ) : property.linkedSellerContactId ? (
                <Link
                  href={`/contacts?contactId=${property.linkedSellerContactId}&details=1`}
                  className="mt-1 inline-flex font-semibold text-[var(--foreground)] underline-offset-2 hover:text-[var(--accent)] hover:underline"
                >
                  {linkedSellerContact?.label ?? "Open linked seller"}
                </Link>
              ) : (
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--foreground)]">Not linked yet</p>
                  <button
                    type="button"
                    onClick={() => void startEditProperty()}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-strong)] px-2.5 py-1 text-[11px] font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    Link seller
                  </button>
                </div>
              )}
              {!((property.transactionType === "rent" ? property.linkedTenantContactId : property.linkedSellerContactId)) ? (
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {property.transactionType === "rent"
                    ? "Open edit mode to attach the tenant CRM contact to this property."
                    : "Open edit mode to attach the seller CRM contact to this property."}
                </p>
              ) : null}
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Rooms</p>
              <p className="mt-1 font-semibold">{displayValue(property.rooms)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Bathrooms</p>
              <p className="mt-1 font-semibold">{displayValue(property.bathrooms)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">Surface</p>
              <p className="mt-1 font-semibold">
                {property.loiCarrezSurfaceSqm !== null && property.loiCarrezSurfaceSqm !== undefined
                  ? `${property.loiCarrezSurfaceSqm} m2`
                  : "-"}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">DPE energy rating</p>
              <p className="mt-1 font-semibold">{displayValue(property.dpeEnergyRating)}</p>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <p className="text-xs uppercase tracking-[0.12em] text-[var(--muted)]">DPE climate rating</p>
              <p className="mt-1 font-semibold">{displayValue(property.dpeClimateRating)}</p>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={`/properties/listing-description?propertyId=${propertyId}`}
            className="rounded-xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-3 py-2 text-xs font-semibold text-white shadow-md shadow-[rgba(59,130,246,0.22)] transition hover:brightness-105"
          >
            Run listing description tool
          </Link>
          <Link
            href={`/properties/valuation?propertyId=${propertyId}`}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Run valuation tool
          </Link>
          <Link
            href={`/properties/inventory?propertyId=${propertyId}`}
            className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Run inventory tool
          </Link>
        </div>
      </article>

      {coverUrl ? (
        <article className="rounded-[24px] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
          <img src={coverUrl} alt={property.label} className="h-72 w-full rounded-2xl object-cover" />
        </article>
      ) : null}

      <article className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">CRM suggestions</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Potential matches</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">
              High-confidence leads only (score above 70).
            </p>
          </div>
        </div>

        {propertyError ? <p className="mt-4 text-sm font-medium text-red-600">{propertyError}</p> : null}
        {recommendationsError ? <p className="mt-4 text-sm font-medium text-red-600">{recommendationsError}</p> : null}

        {isLoadingRecommendations ? (
          <p className="mt-4 text-sm text-[var(--muted)]">Loading recommendations...</p>
        ) : highConfidenceRecommendations.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--muted)]">No high-confidence matches above score 70 yet.</p>
        ) : (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {highConfidenceRecommendations.map((item) => (
              <Link
                key={item.contactId}
                href={`/contacts?contactId=${item.contactId}&details=1`}
                className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4 transition hover:border-[var(--accent)] hover:bg-[var(--surface-strong)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--foreground)]">{item.fullName}</p>
                  <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                    Score {item.score}
                  </span>
                </div>
                <p className="mt-1 text-xs uppercase tracking-[0.12em] text-[var(--muted)]">
                  {item.roles.map((role) => formatRoleLabel(role)).join(" / ")}
                </p>
                <p className="mt-1 text-xs text-[var(--muted)]">Stage: {formatStageLabel(item.stage)}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">Distance: {formatDistance(item.distanceKm)}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">Budget: {formatMoney(item.budget, item.currency)}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {item.reasons.slice(0, 4).map((reason) => (
                    <span
                      key={`${item.contactId}-${reason}`}
                      className="rounded-full border border-[var(--border)] bg-[var(--surface-strong)] px-2 py-0.5 text-[10px] font-medium text-[var(--foreground)]"
                    >
                      {reason}
                    </span>
                  ))}
                </div>
              </Link>
            ))}
          </div>
        )}

        {!isLoadingRecommendations && otherRecommendations.length > 0 ? (
          <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Other matches</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Score above 40, best 3 results.</p>
            <div className="mt-2 space-y-2">
              {otherRecommendations.map((item) => (
                <Link
                  key={`other-${item.contactId}`}
                  href={`/contacts?contactId=${item.contactId}&details=1`}
                  className="flex items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 transition hover:border-[var(--accent)] hover:bg-[var(--surface)]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[var(--foreground)]">{item.fullName}</p>
                    <p className="text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
                      {item.roles.map((role) => formatRoleLabel(role)).join(" / ")}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                    {item.score}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </article>
    </section>
  );
}

type PropertyFormFieldsProps = {
  workspaceId: string | null | undefined;
  form: PropertyFormState;
  onChange: React.Dispatch<React.SetStateAction<PropertyFormState>>;
  onSellerPick?: (contact: WorkspaceContactOption | null) => void;
  onTenantPick?: (contact: WorkspaceContactOption | null) => void;
};

function PropertyFormFields({ workspaceId, form, onChange, onSellerPick, onTenantPick }: PropertyFormFieldsProps) {
  return (
    <>
      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Listing type</span>
        <select
          value={form.transactionType}
          onChange={(event) =>
            onChange((previous) => ({
              ...previous,
              transactionType: event.target.value as "sale" | "rent",
              askingPrice: event.target.value === "sale" ? previous.askingPrice : "",
              monthlyRent: event.target.value === "rent" ? previous.monthlyRent : "",
                linkedSellerContactId: event.target.value === "sale" ? previous.linkedSellerContactId : "",
                linkedTenantContactId: event.target.value === "rent" ? previous.linkedTenantContactId : "",
            }))
          }
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        >
          {TRANSACTION_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Reference</span>
        <input
          value={form.reference}
          onChange={(event) => onChange((previous) => ({ ...previous, reference: event.target.value }))}
          placeholder="APT-18-MARAIS"
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        />
      </label>

      {form.transactionType === "sale" ? (
        <label className="text-sm text-[var(--muted)]">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Asking price</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.askingPrice}
            onChange={(event) => onChange((previous) => ({ ...previous, askingPrice: event.target.value }))}
            placeholder="450000"
            className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
          />
        </label>
      ) : (
        <label className="text-sm text-[var(--muted)]">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Monthly rent</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.monthlyRent}
            onChange={(event) => onChange((previous) => ({ ...previous, monthlyRent: event.target.value }))}
            placeholder="1800"
            className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
          />
        </label>
      )}

      {form.transactionType === "sale" ? (
        <div className="sm:col-span-2">
          <WorkspaceContactPicker
            workspaceId={workspaceId}
            value={form.linkedSellerContactId}
            onChange={(nextId) => onChange((previous) => ({ ...previous, linkedSellerContactId: nextId }))}
            onPick={onSellerPick}
            label="Linked seller"
            helperText="Link this property to the CRM seller contact responsible for the sale."
            emptyOptionLabel="No linked seller"
            roleFilter="seller"
          />
        </div>
      ) : (
        <div className="sm:col-span-2">
          <WorkspaceContactPicker
            workspaceId={workspaceId}
            value={form.linkedTenantContactId}
            onChange={(nextId) => onChange((previous) => ({ ...previous, linkedTenantContactId: nextId }))}
            onPick={onTenantPick}
            label="Linked tenant"
            helperText="Link this rental property to the CRM tenant contact."
            emptyOptionLabel="No linked tenant"
            roleFilter="tenant"
          />
        </div>
      )}

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Property type</span>
        <select
          value={form.propertyType}
          onChange={(event) => onChange((previous) => ({ ...previous, propertyType: event.target.value }))}
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        >
          <option value="">Select property type</option>
          {PROPERTY_TYPE_OPTIONS.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </label>

      <label className="sm:col-span-2 text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Address line 1 *</span>
        <input
          value={form.addressLine1}
          onChange={(event) => onChange((previous) => ({ ...previous, addressLine1: event.target.value }))}
          placeholder="12 Rue des Archives"
          required
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        />
      </label>

      <label className="sm:col-span-2 text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Address line 2</span>
        <input
          value={form.addressLine2}
          onChange={(event) => onChange((previous) => ({ ...previous, addressLine2: event.target.value }))}
          placeholder="Building B, 3rd floor"
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        />
      </label>

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Postal code</span>
        <input
          value={form.postalCode}
          onChange={(event) => onChange((previous) => ({ ...previous, postalCode: event.target.value }))}
          placeholder="75003"
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        />
      </label>

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">City *</span>
        <input
          value={form.city}
          onChange={(event) => onChange((previous) => ({ ...previous, city: event.target.value }))}
          placeholder="Paris"
          required
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        />
      </label>

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Neighborhood</span>
        <input
          value={form.neighborhood}
          onChange={(event) => onChange((previous) => ({ ...previous, neighborhood: event.target.value }))}
          placeholder="Le Marais"
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        />
      </label>

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Cadastre reference</span>
        <input
          value={form.cadastreReference}
          onChange={(event) => onChange((previous) => ({ ...previous, cadastreReference: event.target.value }))}
          placeholder="AB-245"
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        />
      </label>

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Rooms</span>
        <input
          type="number"
          min="0"
          step="1"
          value={form.rooms}
          onChange={(event) => onChange((previous) => ({ ...previous, rooms: event.target.value }))}
          placeholder="3"
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        />
      </label>

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Bathrooms</span>
        <input
          type="number"
          min="0"
          step="1"
          value={form.bathrooms}
          onChange={(event) => onChange((previous) => ({ ...previous, bathrooms: event.target.value }))}
          placeholder="1"
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        />
      </label>

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Carrez surface (m2)</span>
        <input
          type="number"
          min="0"
          step="0.1"
          value={form.loiCarrezSurfaceSqm}
          onChange={(event) => onChange((previous) => ({ ...previous, loiCarrezSurfaceSqm: event.target.value }))}
          placeholder="78"
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        />
      </label>

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">DPE energy rating</span>
        <select
          value={form.dpeEnergyRating}
          onChange={(event) => onChange((previous) => ({ ...previous, dpeEnergyRating: event.target.value }))}
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        >
          {DPE_OPTIONS.map((option) => (
            <option key={option} value={option}>{option || "Not set"}</option>
          ))}
        </select>
      </label>

      <label className="text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">DPE climate rating</span>
        <select
          value={form.dpeClimateRating}
          onChange={(event) => onChange((previous) => ({ ...previous, dpeClimateRating: event.target.value }))}
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--accent)]"
        >
          {DPE_OPTIONS.map((option) => (
            <option key={option} value={option}>{option || "Not set"}</option>
          ))}
        </select>
      </label>
    </>
  );
}
