"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import WorkspaceContactPicker from "@/components/workspace-contact-picker";
import { mapWorkspaceProperty, type WorkspacePropertySummary } from "@/lib/properties/workspace-properties";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";

type PropertyToolId = "listing-description" | "valuation" | "inventory";

const PROPERTY_TOOLS: Array<{
  id: PropertyToolId;
  title: string;
  description: string;
  badge: string;
  href: string;
}> = [
  {
    id: "listing-description",
    title: "Listing description",
    description: "Generate a market-aware description from photos and a few property facts.",
    badge: "Ready",
    href: "/properties/listing-description",
  },
  {
    id: "valuation",
    title: "Valuation helper",
    description: "Compare pricing signals and prepare a draft range for the listing.",
    badge: "Beta",
    href: "/properties/valuation",
  },
  {
    id: "inventory",
    title: "Property inventory",
    description: "Track rooms, photo sets, and listing assets in one place.",
    badge: "Beta",
    href: "/properties/inventory",
  },
];

const DPE_OPTIONS = ["", "A", "B", "C", "D", "E", "F", "G", "N/A"];
const PROPERTY_IMAGE_BUCKET = "property-images";
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

function formatUpdatedAt(value: string | null) {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }

  return parsed.toLocaleDateString();
}

function normalizeFileName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

function normalizeStorageObjectPath(path: string) {
  const trimmed = path.trim();

  if (!trimmed) {
    return "";
  }

  const bucketPrefix = `${PROPERTY_IMAGE_BUCKET}/`;
  return trimmed.startsWith(bucketPrefix) ? trimmed.slice(bucketPrefix.length) : trimmed;
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

export default function PropertiesHub() {
  const { workspace, isLoading: isWorkspaceLoading, error: workspaceError } = useCurrentWorkspace();
  const [rows, setRows] = useState<WorkspacePropertySummary[]>([]);
  const [coverUrlByPropertyId, setCoverUrlByPropertyId] = useState<Record<string, string>>({});
  const [form, setForm] = useState<PropertyFormState>(EMPTY_FORM);
  const [formFiles, setFormFiles] = useState<File[]>([]);
  const [formCoverIndex, setFormCoverIndex] = useState(0);
  const [editFiles, setEditFiles] = useState<File[]>([]);
  const [editUploadCoverIndex, setEditUploadCoverIndex] = useState(0);
  const [editExistingCoverPath, setEditExistingCoverPath] = useState<string | null>(null);
  const [editExistingImagePreviews, setEditExistingImagePreviews] = useState<Array<{ path: string; url: string }>>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeletingId, setIsDeletingId] = useState<string | null>(null);
  const [editingPropertyId, setEditingPropertyId] = useState<string | null>(null);
  const [editingForm, setEditingForm] = useState<PropertyFormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  useEffect(() => {
    if (!workspace?.id) {
      return;
    }

    void loadProperties(workspace.id);
  }, [workspace?.id]);

  const createPreviewUrls = useMemo(
    () => formFiles.map((file) => URL.createObjectURL(file)),
    [formFiles],
  );

  const editPreviewUrls = useMemo(
    () => editFiles.map((file) => URL.createObjectURL(file)),
    [editFiles],
  );

  useEffect(() => {
    return () => {
      createPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [createPreviewUrls]);

  useEffect(() => {
    return () => {
      editPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [editPreviewUrls]);

  useEffect(() => {
    if (formFiles.length === 0) {
      setFormCoverIndex(0);
      return;
    }

    if (formCoverIndex > formFiles.length - 1) {
      setFormCoverIndex(0);
    }
  }, [formFiles, formCoverIndex]);

  useEffect(() => {
    if (editFiles.length === 0) {
      setEditUploadCoverIndex(0);
      return;
    }

    if (editUploadCoverIndex > editFiles.length - 1) {
      setEditUploadCoverIndex(0);
    }
  }, [editFiles, editUploadCoverIndex]);

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    if (!query) {
      return rows;
    }

    return rows.filter((row) => {
      const haystack = [
        row.label,
        row.reference ?? "",
        row.addressLine1 ?? "",
        row.city ?? "",
        row.postalCode ?? "",
        row.propertyType ?? "",
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [rows, searchQuery]);

  async function refreshCoverImageUrls(nextRows: WorkspacePropertySummary[]) {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setCoverUrlByPropertyId({});
      return;
    }

    const entries = await Promise.all(
      nextRows.map(async (row) => {
        if (!row.coverImagePath) {
          return [row.id, ""] as const;
        }

        const normalizedPath = normalizeStorageObjectPath(row.coverImagePath);

        if (!normalizedPath) {
          return [row.id, ""] as const;
        }

        const { data, error: signedError } = await supabase.storage
          .from(PROPERTY_IMAGE_BUCKET)
          .createSignedUrl(normalizedPath, 60 * 60);

        if (signedError || !data?.signedUrl) {
          return [row.id, ""] as const;
        }

        return [row.id, data.signedUrl] as const;
      }),
    );

    setCoverUrlByPropertyId(Object.fromEntries(entries));
  }

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

  async function loadProperties(workspaceId: string) {
    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from("properties")
      .select("*")
      .eq("workspace_id", workspaceId);

    if (fetchError) {
      setRows([]);
      setError(`Could not load workspace properties: ${fetchError.message}`);
      setIsLoading(false);
      return;
    }

    const mapped = ((data ?? []) as Record<string, unknown>[])
      .map((row) => mapWorkspaceProperty(row))
      .filter((row) => Boolean(row.id))
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt ?? left.createdAt ?? 0).getTime();
        const rightTime = new Date(right.updatedAt ?? right.createdAt ?? 0).getTime();
        return rightTime - leftTime;
      });

    setRows(mapped);
    await refreshCoverImageUrls(mapped);
    setIsLoading(false);
  }

  async function handleCreateProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!workspace?.id) {
      setError("Workspace not found.");
      return;
    }

    if (!form.addressLine1.trim()) {
      setError("Address is required.");
      return;
    }

    if (!form.city.trim()) {
      setError("City is required.");
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    try {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        throw new Error("Could not resolve the authenticated user for property creation.");
      }

      const uploadedPaths = formFiles.length > 0 ? await uploadPropertyImages(workspace.id, formFiles) : [];
      const createTitle = form.reference.trim() || form.addressLine1.trim();

      const payload = {
        workspace_id: workspace.id,
        created_by: user.id,
        transaction_type: form.transactionType,
        listing_type: form.transactionType,
        asking_price: form.transactionType === "sale" ? toOptionalNumber(form.askingPrice) : null,
        monthly_rent: form.transactionType === "rent" ? toOptionalNumber(form.monthlyRent) : null,
        seller_contact_id: form.transactionType === "sale" ? form.linkedSellerContactId || null : null,
        tenant_contact_id: form.transactionType === "rent" ? form.linkedTenantContactId || null : null,
        title: createTitle,
        name: createTitle,
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
        image_paths: uploadedPaths,
        cover_image_path: uploadedPaths[formCoverIndex] ?? uploadedPaths[0] ?? null,
      };

      const { data, error: insertError } = await supabase
        .from("properties")
        .insert(payload)
        .select("*")
        .single();

      if (insertError) {
        throw new Error(insertError.message);
      }

      const created = mapWorkspaceProperty((data ?? {}) as Record<string, unknown>);

      if (created.id) {
        const nextRows = [created, ...rows];
        setRows(nextRows);
        await refreshCoverImageUrls(nextRows);
      }

      setForm(EMPTY_FORM);
      setFormFiles([]);
      setFormCoverIndex(0);
      setIsCreateModalOpen(false);
      setMessage("Property added to this workspace.");
    } catch (createError) {
      setError(
        createError instanceof Error
          ? `Could not add property: ${createError.message}`
          : "Could not add property.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function startEditProperty(property: WorkspacePropertySummary) {
    setEditingPropertyId(property.id);
    setEditingForm(createFormFromProperty(property));
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
    setError(null);
    setMessage(null);
  }

  function cancelEditProperty() {
    setEditingPropertyId(null);
    setEditingForm(EMPTY_FORM);
    setEditFiles([]);
    setEditUploadCoverIndex(0);
    setEditExistingCoverPath(null);
    setEditExistingImagePreviews([]);
  }

  async function handleSaveEditProperty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!workspace?.id || !editingPropertyId) {
      return;
    }

    if (!editingForm.addressLine1.trim()) {
      setError("Address is required.");
      return;
    }

    if (!editingForm.city.trim()) {
      setError("City is required.");
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    const current = rows.find((row) => row.id === editingPropertyId);

    if (!current) {
      setError("Property not found.");
      return;
    }

    setIsSaving(true);
    setError(null);
    setMessage(null);

    try {
      const replacementImagePaths =
        editFiles.length > 0 ? await uploadPropertyImages(workspace.id, editFiles) : current.imagePaths;
      const resolvedCoverPath =
        editFiles.length > 0
          ? replacementImagePaths[editUploadCoverIndex] ?? replacementImagePaths[0] ?? null
          : (editExistingCoverPath ? normalizeStorageObjectPath(editExistingCoverPath) : null) ?? replacementImagePaths[0] ?? null;
      const updateTitle = editingForm.reference.trim() || editingForm.addressLine1.trim();

      const payload = {
        transaction_type: editingForm.transactionType,
        listing_type: editingForm.transactionType,
        asking_price: editingForm.transactionType === "sale" ? toOptionalNumber(editingForm.askingPrice) : null,
        monthly_rent: editingForm.transactionType === "rent" ? toOptionalNumber(editingForm.monthlyRent) : null,
        seller_contact_id: editingForm.transactionType === "sale" ? editingForm.linkedSellerContactId || null : null,
        tenant_contact_id: editingForm.transactionType === "rent" ? editingForm.linkedTenantContactId || null : null,
        title: updateTitle,
        name: updateTitle,
        reference: editingForm.reference.trim() || null,
        address_line1: editingForm.addressLine1.trim(),
        address_line2: editingForm.addressLine2.trim() || null,
        postal_code: editingForm.postalCode.trim() || null,
        city: editingForm.city.trim(),
        neighborhood: editingForm.neighborhood.trim() || null,
        property_type: editingForm.propertyType.trim() || null,
        cadastre_reference: editingForm.cadastreReference.trim() || null,
        rooms: toOptionalNumber(editingForm.rooms),
        bathrooms: toOptionalNumber(editingForm.bathrooms),
        loi_carrez_surface_sqm: toOptionalNumber(editingForm.loiCarrezSurfaceSqm),
        dpe_energy_rating: editingForm.dpeEnergyRating.trim() || null,
        dpe_climate_rating: editingForm.dpeClimateRating.trim() || null,
        image_paths: replacementImagePaths,
        cover_image_path: resolvedCoverPath,
      };

      const { data, error: updateError } = await supabase
        .from("properties")
        .update(payload)
        .eq("workspace_id", workspace.id)
        .eq("id", editingPropertyId)
        .select("*")
        .single();

      if (updateError) {
        throw new Error(updateError.message);
      }

      const updated = mapWorkspaceProperty((data ?? {}) as Record<string, unknown>);
      const nextRows = rows.map((row) => (row.id === updated.id ? updated : row));
      setRows(nextRows);
      await refreshCoverImageUrls(nextRows);

      if (editFiles.length > 0) {
        const oldPaths = current.imagePaths.filter(
          (path) => !replacementImagePaths.includes(path),
        );
        void removeImages(oldPaths);
      }

      cancelEditProperty();
      setMessage("Property updated.");
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? `Could not update property: ${updateError.message}`
          : "Could not update property.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDeleteProperty(property: WorkspacePropertySummary) {
    if (!workspace?.id) {
      return;
    }

    const confirmed = window.confirm(
      `Delete ${property.label} permanently from this workspace?`,
    );

    if (!confirmed) {
      return;
    }

    const supabase = getSupabaseBrowserClient();

    if (!supabase) {
      setError("Supabase is not configured.");
      return;
    }

    setIsDeletingId(property.id);
    setError(null);
    setMessage(null);

    const { error: deleteError } = await supabase
      .from("properties")
      .delete()
      .eq("workspace_id", workspace.id)
      .eq("id", property.id);

    if (deleteError) {
      setError(`Could not delete property: ${deleteError.message}`);
      setIsDeletingId(null);
      return;
    }

    const nextRows = rows.filter((row) => row.id !== property.id);
    setRows(nextRows);
    await refreshCoverImageUrls(nextRows);
    void removeImages(property.imagePaths);

    if (editingPropertyId === property.id) {
      cancelEditProperty();
    }

    setMessage("Property deleted.");
    setIsDeletingId(null);
  }

  if (workspaceError) {
    return <p className="text-sm text-red-600">{workspaceError}</p>;
  }

  if (isWorkspaceLoading || isLoading) {
    return <p className="text-sm text-[var(--muted)]">Loading properties...</p>;
  }

  return (
    <section className="flex min-h-full flex-col gap-8">
      <div className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Properties</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">Property tools</h1>
        <p className="mt-4 text-base leading-7 text-[var(--muted)]">
          Manage workspace properties once and reuse them in document generation and property tools.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {PROPERTY_TOOLS.map((tool) => (
          <article
            key={tool.id}
            className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-left shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold text-[var(--foreground)]">{tool.title}</p>
                <p className="mt-1.5 text-xs leading-5 text-[var(--muted)]">{tool.description}</p>
              </div>
              <span className="rounded-full border border-[var(--border)] bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                {tool.badge}
              </span>
            </div>
            <div className="mt-3">
              <Link
                href={tool.href}
                className="rounded-xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-3 py-1.5 text-xs font-semibold text-white shadow-md shadow-[rgba(59,130,246,0.22)] transition hover:brightness-105"
              >
                Open tool
              </Link>
            </div>
          </article>
        ))}
      </div>

      {error ? <p className="text-sm font-medium text-red-600">{error}</p> : null}
      {message ? <p className="text-sm font-medium text-emerald-700">{message}</p> : null}

      <article className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Workspace inventory</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
              All properties in {workspace?.name ?? "this workspace"}
            </h2>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Any teammate with workspace access can reuse these records in document generation and property tools.
            </p>
          </div>
        </div>

        <div className="mt-4 flex w-full items-end justify-between gap-3">
          <label className="w-full max-w-sm text-sm text-[var(--muted)]">
            <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em]">Search properties</span>
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Address, city, reference, type"
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] outline-none transition focus:border-[var(--accent)]"
            />
          </label>

          <button
            type="button"
            onClick={() => setIsCreateModalOpen(true)}
            className="inline-flex shrink-0 items-center rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Add property
          </button>
        </div>

        <div className="mt-4 overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--background)]">
          <table className="min-w-full divide-y divide-[var(--border)] text-sm">
            <thead className="bg-[var(--surface-strong)]">
              <tr className="text-left text-xs font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
                <th className="px-4 py-3">Photo</th>
                <th className="px-4 py-3">Property</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Listing</th>
                <th className="px-4 py-3">Surface</th>
                <th className="px-4 py-3">DPE / GES</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] bg-[var(--background)] text-[var(--foreground)]">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-sm text-[var(--muted)]">
                    No properties found in this workspace yet.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => (
                  <tr key={row.id} className="align-top">
                    <td className="px-4 py-3">
                      {coverUrlByPropertyId[row.id] ? (
                        <img
                          src={coverUrlByPropertyId[row.id]}
                          alt={`Property ${row.label}`}
                          className="h-16 w-24 rounded-xl border border-[var(--border)] object-cover"
                        />
                      ) : (
                        <div className="flex h-16 w-24 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] text-xs text-[var(--muted)]">
                          No photo
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/properties/${row.id}`}
                        className="font-semibold text-[var(--foreground)] underline-offset-2 hover:text-[var(--accent)] hover:underline"
                      >
                        {row.label}
                      </Link>
                      {row.reference ? <p className="mt-1 text-xs text-[var(--muted)]">Ref: {row.reference}</p> : null}
                      <p className="mt-1 text-xs text-[var(--muted)]">{row.imagePaths.length} image(s)</p>
                    </td>
                    <td className="px-4 py-3 text-[var(--foreground)]">
                      <p>{row.addressLine1 ?? "-"}</p>
                      <p className="text-xs text-[var(--muted)]">
                        {[row.postalCode, row.city].filter(Boolean).join(" ") || "-"}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-[var(--foreground)]">{row.propertyType ?? "-"}</td>
                    <td className="px-4 py-3 text-[var(--foreground)]">
                      {row.transactionType === "rent" ? "For rent" : row.transactionType === "sale" ? "For sale" : "-"}
                    </td>
                    <td className="px-4 py-3 text-[var(--foreground)]">
                      {row.loiCarrezSurfaceSqm !== null ? `${row.loiCarrezSurfaceSqm} m2` : "-"}
                    </td>
                    <td className="px-4 py-3 text-[var(--foreground)]">
                      {row.dpeEnergyRating ?? "-"} / {row.dpeClimateRating ?? "-"}
                    </td>
                    <td className="px-4 py-3 text-[var(--foreground)]">{formatUpdatedAt(row.updatedAt ?? row.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        <Link
                          href={`/properties/${row.id}`}
                          className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        >
                          Open
                        </Link>
                        <button
                          type="button"
                          onClick={() => void handleDeleteProperty(row)}
                          disabled={isDeletingId === row.id}
                          className="rounded-xl border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-60"
                        >
                          {isDeletingId === row.id ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </article>

      {editingPropertyId ? (
        <article className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Edit property</p>
              <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Update property details</h2>
            </div>
            <button
              type="button"
              onClick={cancelEditProperty}
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Cancel
            </button>
          </div>

          <form onSubmit={handleSaveEditProperty} className="mt-4 grid gap-4 sm:grid-cols-2">
            <PropertyFormFields workspaceId={workspace?.id} form={editingForm} onChange={setEditingForm} />

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
                          className={`overflow-hidden rounded-xl border ${isActive ? "border-[var(--accent)]" : "border-[var(--border)]"} bg-white text-left`}
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
                      className={`overflow-hidden rounded-xl border ${editUploadCoverIndex === index ? "border-[var(--accent)]" : "border-[var(--border)]"} bg-white text-left`}
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

            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:opacity-60"
              >
                {isSaving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </form>
        </article>
      ) : null}

      {isCreateModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="max-h-[92vh] w-full max-w-5xl overflow-y-auto rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">Add property</p>
                <h2 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Create a reusable property record</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateModalOpen(false)}
                className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleCreateProperty} className="mt-4 grid gap-4 sm:grid-cols-2">
              <PropertyFormFields workspaceId={workspace?.id} form={form} onChange={setForm} />

              <div className="sm:col-span-2">
                <label className="text-sm text-[var(--muted)]">
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">Property photos</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(event) => {
                      setFormFiles(Array.from(event.target.files ?? []));
                      setFormCoverIndex(0);
                    }}
                    className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)]"
                  />
                </label>
                {createPreviewUrls.length > 0 ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {createPreviewUrls.map((url, index) => (
                      <button
                        key={url}
                        type="button"
                        onClick={() => setFormCoverIndex(index)}
                        className={`overflow-hidden rounded-xl border ${formCoverIndex === index ? "border-[var(--accent)]" : "border-[var(--border)]"} bg-white text-left`}
                      >
                        <img
                          src={url}
                          alt={`Selected property photo ${index + 1}`}
                          className="h-24 w-full object-cover"
                        />
                        <span className="block px-2 py-1 text-[11px] font-semibold text-[var(--foreground)]">
                          {formCoverIndex === index ? "Cover photo" : "Set as cover"}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="sm:col-span-2 flex items-center gap-2">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="inline-flex items-center rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:opacity-60"
                >
                  {isSaving ? "Adding..." : "Add property"}
                </button>
                <button
                  type="button"
                  onClick={() => setIsCreateModalOpen(false)}
                  className="inline-flex items-center rounded-2xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

    </section>
  );
}

type PropertyFormFieldsProps = {
  workspaceId: string | null | undefined;
  form: PropertyFormState;
  onChange: React.Dispatch<React.SetStateAction<PropertyFormState>>;
};

function PropertyFormFields({ workspaceId, form, onChange }: PropertyFormFieldsProps) {
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
