"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  MARKET_LANGUAGE_OPTIONS,
  MARKET_LOCALE_OPTIONS,
  MARKET_PRESETS,
  MARKET_TIMEZONE_OPTIONS,
  getMarketPresetByCountry,
} from "@/lib/market/market-presets";
import { dispatchCreditsBalanceRefresh } from "@/lib/credits/client-refresh";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";
import WorkspacePropertyPicker from "@/components/workspace-property-picker";

type Tone = "professional" | "warm" | "premium" | "concise";
type TransactionType = "sale" | "rent";
type DescriptionLength = "short" | "medium" | "long";
type EnhancementStyle = "clean_premium" | "premium_plus" | "luxury_editorial";

type GeneratedListingDescription = {
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

type GenerationResponse = {
  ok?: boolean;
  result?: GeneratedListingDescription;
  error?: string;
  creditsUsed?: number;
  baseCreditsUsed?: number;
  enhancementCreditsUsed?: number;
  enhancementApplied?: boolean;
  enhancementWarning?: string | null;
  enhancedPreviewDataUrls?: Array<string | null>;
  newBalance?: number;
  requiredCredits?: number;
  currentBalance?: number;
};

type SendDraftEmailResponse = {
  ok?: boolean;
  error?: string;
};

type EnhanceOnlyResponse = {
  ok?: boolean;
  error?: string;
  creditsUsed?: number;
  newBalance?: number;
  enhancedPreviewDataUrls?: Array<string | null>;
  warning?: string | null;
};

const PROPERTY_TYPES = [
  "Apartment",
  "House",
  "Villa",
  "Studio",
  "Loft",
  "Duplex",
  "Townhouse",
  "Commercial space",
];
const INCLUDED_PHOTO_COUNT = 5;
const EXTRA_CREDIT_PER_PHOTO = 0.5;
const PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO = 0.1;

const SURFACE_UNITS = ["m²", "sq m", "ft²", "sq ft"];
const TRANSACTION_TYPES: Array<{ value: TransactionType; label: string }> = [
  { value: "sale", label: "For sale" },
  { value: "rent", label: "For rent" },
];
const TONES: Array<{ value: Tone; label: string }> = [
  { value: "professional", label: "Professional" },
  { value: "warm", label: "Warm" },
  { value: "premium", label: "Premium" },
  { value: "concise", label: "Concise" },
];
const DESCRIPTION_LENGTHS: Array<{ value: DescriptionLength; label: string }> = [
  { value: "short", label: "Short" },
  { value: "medium", label: "Medium" },
  { value: "long", label: "Long" },
];
const ENHANCEMENT_STYLES: Array<{ value: EnhancementStyle; label: string }> = [
  { value: "clean_premium", label: "Clean Premium" },
  { value: "premium_plus", label: "Premium Plus" },
  { value: "luxury_editorial", label: "Luxury Editorial" },
];

export default function PropertyDescriptionPanel() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const searchParams = useSearchParams();
  const { workspace, isLoading: isWorkspaceLoading, error: workspaceError, isSuperAdmin } = useCurrentWorkspace();

  const [propertyType, setPropertyType] = useState("Apartment");
  const [transactionType, setTransactionType] = useState<TransactionType>("sale");
  const [city, setCity] = useState("");
  const [neighborhood, setNeighborhood] = useState("");
  const [rooms, setRooms] = useState("");
  const [bathrooms, setBathrooms] = useState("");
  const [surfaceArea, setSurfaceArea] = useState("");
  const [surfaceUnit, setSurfaceUnit] = useState("m²");
  const [highlightsText, setHighlightsText] = useState("");
  const [notes, setNotes] = useState("");
  const [dpeEnergyClass, setDpeEnergyClass] = useState("");
  const [dpeClimateClass, setDpeClimateClass] = useState("");
  const [feePrice, setFeePrice] = useState("");
  const [secondaryLanguage, setSecondaryLanguage] = useState("");
  const [feeCharge, setFeeCharge] = useState("");
  const [coOwnershipLotNumber, setCoOwnershipLotNumber] = useState("");
  const [coOwnershipAnnualCharges, setCoOwnershipAnnualCharges] = useState("");
  const [tone, setTone] = useState<Tone>("professional");
  const [descriptionLength, setDescriptionLength] = useState<DescriptionLength>("medium");
  const [enhancePhotos, setEnhancePhotos] = useState(false);
  const [enhancementStyle, setEnhancementStyle] = useState<EnhancementStyle>("luxury_editorial");
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [enhancedPreviewUrls, setEnhancedPreviewUrls] = useState<Array<string | null>>([]);
  const [editableDraft, setEditableDraft] = useState<GeneratedListingDescription | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [emailMessage, setEmailMessage] = useState<string | null>(null);
  const [hasSentDraftEmail, setHasSentDraftEmail] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEnhancingOnly, setIsEnhancingOnly] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [isMarketOverrideOpen, setIsMarketOverrideOpen] = useState(false);
  const [marketCountryCode, setMarketCountryCode] = useState("FR");
  const [marketLocale, setMarketLocale] = useState("fr-FR");
  const [marketLanguage, setMarketLanguage] = useState("fr");
  const [marketTimezone, setMarketTimezone] = useState("Europe/Paris");
  const [selectedWorkspacePropertyId, setSelectedWorkspacePropertyId] = useState("");

  useEffect(() => {
    const queryPropertyId = searchParams.get("propertyId")?.trim() ?? "";

    if (!queryPropertyId) {
      return;
    }

    setSelectedWorkspacePropertyId((previous) => (previous ? previous : queryPropertyId));
  }, [searchParams]);

  const extraPhotoCount = Math.max(0, files.length - INCLUDED_PHOTO_COUNT);
  const extraPhotoCredits = extraPhotoCount * EXTRA_CREDIT_PER_PHOTO;
  const enhancementCredits = enhancePhotos ? files.length * PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO : 0;

  const getFileKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviewUrls(urls);
    setEnhancedPreviewUrls([]);

    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  const previewItems = useMemo(
    () =>
      previewUrls.flatMap((originalUrl, index) => {
        const enhancedUrl = enhancedPreviewUrls[index];
        const items: Array<{
          kind: "original" | "enhanced";
          url: string;
          fileIndex: number;
          label: string;
        }> = [
          {
            kind: "original",
            url: originalUrl,
            fileIndex: index,
            label: "Original",
          },
        ];

        if (enhancedUrl) {
          items.push({
            kind: "enhanced",
            url: enhancedUrl,
            fileIndex: index,
            label: "Enhanced",
          });
        }

        return items;
      }),
    [previewUrls, enhancedPreviewUrls],
  );

  useEffect(() => {
    if (!workspace) {
      return;
    }

    if (workspace.metric_system === "imperial") {
      setSurfaceUnit((previous) => (previous === "m²" || previous === "sq m" ? "sq ft" : previous));
    }

    setMarketCountryCode(workspace.default_country_code || "FR");
    setMarketLocale(workspace.default_locale || "fr-FR");
    setMarketLanguage(workspace.default_language || "fr");
    setMarketTimezone(workspace.default_timezone || "Europe/Paris");
  }, [workspace]);

  const applyWorkspaceProperty = (property: {
    transactionType: "sale" | "rent" | null;
    propertyType: string | null;
    city: string | null;
    neighborhood: string | null;
    rooms: number | null;
    bathrooms: number | null;
    loiCarrezSurfaceSqm: number | null;
    dpeEnergyRating: string | null;
    dpeClimateRating: string | null;
  }) => {
    if (property.transactionType === "sale" || property.transactionType === "rent") {
      setTransactionType(property.transactionType);
    }

    if (property.propertyType) {
      setPropertyType(property.propertyType);
    }

    if (property.city) {
      setCity(property.city);
    }

    if (property.neighborhood) {
      setNeighborhood(property.neighborhood);
    }

    if (property.rooms !== null) {
      setRooms(String(property.rooms));
    }

    if (property.bathrooms !== null) {
      setBathrooms(String(property.bathrooms));
    }

    if (property.loiCarrezSurfaceSqm !== null) {
      setSurfaceArea(String(property.loiCarrezSurfaceSqm));
    }

    if (property.dpeEnergyRating) {
      setDpeEnergyClass(property.dpeEnergyRating);
    }

    if (property.dpeClimateRating) {
      setDpeClimateClass(property.dpeClimateRating);
    }
  };

  const handleFilesChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFiles = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));

    if (nextFiles.length === 0) {
      return;
    }

    setFiles((previous) => {
      const merged = [...previous];
      const existing = new Set(previous.map((file) => getFileKey(file)));

      nextFiles.forEach((file) => {
        const key = getFileKey(file);

        if (!existing.has(key)) {
          merged.push(file);
          existing.add(key);
        }
      });

      return merged;
    });

    event.target.value = "";
  };

  const handleRemoveFile = (indexToRemove: number) => {
    setFiles((previous) => previous.filter((_, index) => index !== indexToRemove));
  };

  const handleClearFiles = () => {
    setFiles([]);
  };

  const updateEditableDraft = (updater: (previous: GeneratedListingDescription) => GeneratedListingDescription) => {
    setEditableDraft((previous) => {
      if (!previous) {
        return previous;
      }

      return updater(previous);
    });
    setHasSentDraftEmail(false);
    setEmailMessage(null);
  };

  const getEnhancedFilename = (fileIndex: number, dataUrl: string) => {
    const originalName = files[fileIndex]?.name || `photo-${fileIndex + 1}.jpg`;
    const dotIndex = originalName.lastIndexOf(".");
    const baseName = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
    const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/i);
    const mimeType = mimeMatch?.[1]?.toLowerCase() || "image/jpeg";
    const extension =
      mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : mimeType === "image/jpeg" ? "jpg" : "jpg";

    return `${baseName}-enhanced.${extension}`;
  };

  const downloadDataUrl = (dataUrl: string, filename: string) => {
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const handleDownloadEnhanced = (fileIndex: number) => {
    const dataUrl = enhancedPreviewUrls[fileIndex];

    if (!dataUrl) {
      return;
    }

    downloadDataUrl(dataUrl, getEnhancedFilename(fileIndex, dataUrl));
  };

  const handleDownloadAllEnhanced = () => {
    enhancedPreviewUrls.forEach((dataUrl, fileIndex) => {
      if (!dataUrl) {
        return;
      }

      downloadDataUrl(dataUrl, getEnhancedFilename(fileIndex, dataUrl));
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!supabase) {
      setMessage("Supabase is not configured.");
      return;
    }

    if (!workspace?.id) {
      setMessage("Workspace not found.");
      return;
    }

    if (transactionType !== "sale" && transactionType !== "rent") {
      setMessage("Listing type is required.");
      return;
    }

    if (!city.trim()) {
      setMessage("City is required.");
      return;
    }

    if (!rooms.trim()) {
      setMessage("Amount of rooms is required.");
      return;
    }

    if (!surfaceArea.trim()) {
      setMessage("Surface area is required.");
      return;
    }

    if (files.length === 0) {
      setMessage("Please upload at least one photo.");
      return;
    }

    setIsGenerating(true);
    setMessage(null);
    setEmailMessage(null);
    setHasSentDraftEmail(false);
    setEditableDraft(null);
    setEnhancedPreviewUrls([]);

    const formData = new FormData();
    formData.set("workspaceId", workspace.id);
    formData.set("propertyType", propertyType);
    formData.set("transactionType", transactionType);
    formData.set("city", city);
    formData.set("neighborhood", neighborhood);
    formData.set("rooms", rooms);
    formData.set("bathrooms", bathrooms);
    formData.set("surfaceArea", surfaceArea);
    formData.set("surfaceUnit", surfaceUnit);
    formData.set("tone", tone);
    formData.set("descriptionLength", descriptionLength);
    formData.set("notes", notes);
    formData.set("highlights", highlightsText);
    formData.set("dpeEnergyClass", dpeEnergyClass);
    formData.set("dpeClimateClass", dpeClimateClass);
    formData.set("feePrice", feePrice);
    formData.set("secondaryLanguage", secondaryLanguage);
    formData.set("feeCharge", feeCharge);
    formData.set("coOwnershipLotNumber", coOwnershipLotNumber);
    formData.set("coOwnershipAnnualCharges", coOwnershipAnnualCharges);

    if (isMarketOverrideOpen) {
      formData.set("marketCountryCode", marketCountryCode);
      formData.set("marketLocale", marketLocale);
      formData.set("marketLanguage", marketLanguage);
      formData.set("marketTimezone", marketTimezone);
    }

    formData.set("enhancePhotos", String(enhancePhotos));
    formData.set("enhancementStyle", enhancementStyle);

    files.forEach((file) => formData.append("images", file));

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 90000);

    try {
      const response = await fetch("/api/generate/listing-description", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      let payload: GenerationResponse | null = null;

      try {
        payload = (await response.json()) as GenerationResponse;
      } catch {
        payload = null;
      }

      if (!response.ok || !payload?.ok || !payload.result) {
        setMessage(
          payload?.error ||
            "Could not generate description. Try fewer or smaller photos. If the problem persists, please contact support.",
        );
        return;
      }

      setEditableDraft(payload.result);
      setEnhancedPreviewUrls(payload.enhancedPreviewDataUrls ?? []);

      if (workspace?.id && typeof payload.newBalance === "number") {
        dispatchCreditsBalanceRefresh({
          workspaceId: workspace.id,
          newBalance: payload.newBalance,
          source: "listing-description",
        });
      }

      const totalCreditsUsed = payload.creditsUsed ?? 1;
      const enhancementUsed = payload.enhancementCreditsUsed ?? 0;
      const baseUsed = payload.baseCreditsUsed ?? totalCreditsUsed - enhancementUsed;
      const warning = payload.enhancementWarning?.trim();

      setMessage(
        enhancementUsed > 0
          ? `Description generated. Credits used: ${totalCreditsUsed} (${baseUsed} base + ${enhancementUsed} photo enhancement). Review and edit the draft before sending by email.${warning ? ` ${warning}` : ""}`
          : `Description generated. Credits used: ${totalCreditsUsed}. Review and edit the draft before sending by email.${warning ? ` ${warning}` : ""}`,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setMessage("Generation timed out. Try fewer or smaller photos, then retry.");
        return;
      }

      setMessage(isSuperAdmin && error instanceof Error ? error.message : "Unexpected generation error.");
    } finally {
      window.clearTimeout(timeoutId);
      setIsGenerating(false);
    }
  };

  const handleEnhanceOnly = async () => {
    if (!supabase) {
      setMessage("Supabase is not configured.");
      return;
    }

    if (!workspace?.id) {
      setMessage("Workspace not found.");
      return;
    }

    if (files.length === 0) {
      setMessage("Please upload at least one photo.");
      return;
    }

    setIsEnhancingOnly(true);
    setMessage(null);
    setEnhancedPreviewUrls([]);

    const formData = new FormData();
    formData.set("workspaceId", workspace.id);
    formData.set("enhancementStyle", enhancementStyle);
    files.forEach((file) => formData.append("images", file));

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 90000);

    try {
      const response = await fetch("/api/generate/listing-description/enhance-only", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      let payload: EnhanceOnlyResponse | null = null;

      try {
        payload = (await response.json()) as EnhanceOnlyResponse;
      } catch {
        payload = null;
      }

      if (!response.ok || !payload?.ok) {
        setMessage(payload?.error || "Could not enhance photos. Try fewer or smaller photos.");
        return;
      }

      setEnhancedPreviewUrls(payload.enhancedPreviewDataUrls ?? []);

      if (workspace?.id && typeof payload.newBalance === "number") {
        dispatchCreditsBalanceRefresh({
          workspaceId: workspace.id,
          newBalance: payload.newBalance,
          source: "listing-description",
        });
      }

      setMessage(
        `Enhancement test complete. Credits used: ${payload.creditsUsed ?? 0}. You can now review original/enhanced preview pairs without generating a description.${payload.warning ? ` ${payload.warning}` : ""}`,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setMessage("Enhancement timed out. Try fewer or smaller photos, then retry.");
        return;
      }

      setMessage(isSuperAdmin && error instanceof Error ? error.message : "Unexpected enhancement error.");
    } finally {
      window.clearTimeout(timeoutId);
      setIsEnhancingOnly(false);
    }
  };

  const sendDraftByEmail = async (draft: GeneratedListingDescription) => {
    if (!workspace?.id) {
      setEmailMessage("Workspace not found.");
      return false;
    }

    setIsSendingEmail(true);
    setEmailMessage(null);

    const formData = new FormData();
    formData.set("workspaceId", workspace.id);
    formData.set("workspaceName", workspace.name);
    formData.set("draft", JSON.stringify(draft));
    files.forEach((file) => formData.append("images", file));

    const response = await fetch("/api/generate/listing-description/send-email", {
      method: "POST",
      body: formData,
    });

    const payload = (await response.json()) as SendDraftEmailResponse;

    setIsSendingEmail(false);

    if (!response.ok || !payload.ok) {
      setEmailMessage(isSuperAdmin && payload.error ? payload.error : "Could not send draft email.");
      return false;
    }

    setHasSentDraftEmail(true);
    setEmailMessage("Draft sent to your account email.");
    return true;
  };

  const handleSendDraftEmail = async () => {
    if (!editableDraft) {
      setEmailMessage("Generate a draft first.");
      return;
    }

    if (!editableDraft.title.trim() || !editableDraft.description.trim()) {
      setEmailMessage("Title and description are required before sending.");
      return;
    }

    const sanitizedDraft: GeneratedListingDescription = {
      ...editableDraft,
      title: editableDraft.title.trim(),
      description: editableDraft.description.trim(),
      bulletPoints: editableDraft.bulletPoints.map((point) => point.trim()).filter((point) => point.length > 0),
      secondaryTitle: editableDraft.secondaryTitle?.trim() || undefined,
      secondaryDescription: editableDraft.secondaryDescription?.trim() || undefined,
      secondaryBulletPoints:
        editableDraft.secondaryBulletPoints
          ?.map((point) => point.trim())
          .filter((point) => point.length > 0),
    };

    if (sanitizedDraft.bulletPoints.length === 0) {
      setEmailMessage("Add at least one bullet point before sending.");
      return;
    }

    setEditableDraft(sanitizedDraft);
    void sendDraftByEmail(sanitizedDraft);
  };

  const marketSummary = isWorkspaceLoading
    ? "Loading market context..."
    : workspace
      ? `${workspace.default_country_code} • ${workspace.default_locale} • ${workspace.default_language} • ${workspace.default_timezone}`
      : `Market context unavailable${isSuperAdmin && workspaceError ? ` (${workspaceError})` : ""}`;

  const activeMarketSummary = isMarketOverrideOpen
    ? `${marketCountryCode} • ${marketLocale} • ${marketLanguage} • ${marketTimezone}`
    : marketSummary;

  return (
    <section className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col gap-8">
      <div className="w-full max-w-none">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Properties</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[var(--foreground)]">Listing description</h1>
        <p className="mt-4 text-base leading-7 text-[var(--muted)]">
          Upload photos, add a few property facts, and generate a market-aware listing draft.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--muted)]">
          <p>Market context: {activeMarketSummary}</p>
          <button
            type="button"
            onClick={() => {
              setIsMarketOverrideOpen((previous) => {
                const nextOpen = !previous;

                if (!nextOpen && workspace) {
                  setMarketCountryCode(workspace.default_country_code || "FR");
                  setMarketLocale(workspace.default_locale || "fr-FR");
                  setMarketLanguage(workspace.default_language || "fr");
                  setMarketTimezone(workspace.default_timezone || "Europe/Paris");
                }

                return nextOpen;
              });
            }}
            className="inline-flex items-center rounded-full border border-[var(--border)] bg-white px-2.5 py-1 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            {isMarketOverrideOpen ? "Use workspace default" : "Change for this draft"}
          </button>
        </div>

        {isMarketOverrideOpen ? (
          <div className="mt-3 rounded-2xl border border-[var(--border)] bg-white/80 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">This generation only</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Country</span>
                <select
                  value={marketCountryCode}
                  onChange={(event) => {
                    const preset = getMarketPresetByCountry(event.target.value);
                    setMarketCountryCode(preset.countryCode);
                    setMarketLocale(preset.defaultLocale);
                    setMarketLanguage(preset.defaultLanguage);
                    setMarketTimezone(preset.defaultTimezone);
                  }}
                  className="settings-field w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs outline-none focus:border-[var(--accent)]"
                >
                  {MARKET_PRESETS.map((preset) => (
                    <option key={preset.countryCode} value={preset.countryCode}>{`${preset.countryCode} - ${preset.countryName}`}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Locale</span>
                <select
                  value={marketLocale}
                  onChange={(event) => setMarketLocale(event.target.value)}
                  className="settings-field w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs outline-none focus:border-[var(--accent)]"
                >
                  {MARKET_LOCALE_OPTIONS.map((option) => (
                    <option key={option.code} value={option.code}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Language</span>
                <select
                  value={marketLanguage}
                  onChange={(event) => setMarketLanguage(event.target.value)}
                  className="settings-field w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs outline-none focus:border-[var(--accent)]"
                >
                  {MARKET_LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.code} value={option.code}>{option.label}</option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">Timezone</span>
                <select
                  value={marketTimezone}
                  onChange={(event) => setMarketTimezone(event.target.value)}
                  className="settings-field w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs outline-none focus:border-[var(--accent)]"
                >
                  {MARKET_TIMEZONE_OPTIONS.map((option) => (
                    <option key={option.code} value={option.code}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ) : null}
      </div>

      <article className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">Workspace properties</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)]">Pick an existing property</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
          Select a workspace property to prefill this form. You can still adjust every field before generation.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[320px] flex-1">
            <WorkspacePropertyPicker
              workspaceId={workspace?.id}
              value={selectedWorkspacePropertyId}
              onChange={setSelectedWorkspacePropertyId}
              onPick={(property) => {
                if (property) {
                  applyWorkspaceProperty(property);
                }
              }}
              label="Property"
              helperText="Linked records come from the workspace properties table."
            />
          </div>

          {selectedWorkspacePropertyId ? (
            <button
              type="button"
              onClick={() => setSelectedWorkspacePropertyId("")}
              className="rounded-full border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Unlink
            </button>
          ) : null}
        </div>
      </article>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form onSubmit={handleSubmit} className="settings-card rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="property-type">Property type</label>
              <select id="property-type" value={propertyType} onChange={(event) => setPropertyType(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]">
                {PROPERTY_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="transaction-type">Listing type *</label>
              <select
                id="transaction-type"
                value={transactionType}
                onChange={(event) => setTransactionType(event.target.value as TransactionType)}
                className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
                required
              >
                {TRANSACTION_TYPES.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="tone">Tone</label>
              <select id="tone" value={tone} onChange={(event) => setTone(event.target.value as Tone)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]">
                {TONES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="city">City *</label>
              <input id="city" value={city} onChange={(event) => setCity(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="Paris" required />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="neighborhood">Neighborhood</label>
              <input id="neighborhood" value={neighborhood} onChange={(event) => setNeighborhood(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="Le Marais" />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="rooms">Rooms *</label>
              <input id="rooms" type="number" min="1" value={rooms} onChange={(event) => setRooms(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="3" required />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="bathrooms">Bathrooms</label>
              <input id="bathrooms" type="number" min="0" value={bathrooms} onChange={(event) => setBathrooms(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="1" />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="surface-area">Surface area *</label>
              <input id="surface-area" type="number" min="1" step="0.1" value={surfaceArea} onChange={(event) => setSurfaceArea(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="78" required />
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="surface-unit">Surface unit</label>
              <select id="surface-unit" value={surfaceUnit} onChange={(event) => setSurfaceUnit(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]">
                {SURFACE_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
              </select>
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="highlights">Highlights</label>
            <textarea id="highlights" value={highlightsText} onChange={(event) => setHighlightsText(event.target.value)} rows={4} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder={"Balcony\nSea view\nRenovated kitchen"} />
          </div>

          <div className="mt-4">
            <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="notes">Notes</label>
            <textarea id="notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="Anything the description should emphasize or avoid." />
          </div>

          <div className="mt-4 rounded-2xl border border-[var(--border)] bg-white/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[var(--foreground)]">Translate / Secondary language</p>
                <p className="text-xs text-[var(--muted)]">Generate one additional version in a language of your choice.</p>
              </div>
              <select
                value={secondaryLanguage}
                onChange={(event) => setSecondaryLanguage(event.target.value)}
                className="settings-field min-w-[180px] rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              >
                <option value="">No secondary language</option>
                {MARKET_LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.code} value={option.code}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-[var(--border)] bg-white/70 p-4">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-[var(--foreground)]">Compliance disclosures (optional)</p>
              <div className="group relative">
                <span
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border)] bg-white text-[11px] font-semibold text-[var(--muted)]"
                  aria-label="What this compliance section checks"
                >
                  i
                </span>
                <div className="pointer-events-none absolute left-1/2 top-7 z-20 w-80 -translate-x-1/2 rounded-xl border border-[var(--border)] bg-white p-3 text-xs leading-5 text-[var(--foreground)] opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
                  Legal Compliance Check: Ensures your text strictly adheres to local regulations (such as Loi Hoguet & ALUR) by verifying required energy ratings, pricing terms, and fee disclosures.
                </div>
              </div>
            </div>
            <p className="mt-1 text-xs text-[var(--muted)]">These details are appended to the generated description when provided, including any secondary language output.</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="dpe-energy-class">DPE class</label>
                <input id="dpe-energy-class" value={dpeEnergyClass} onChange={(event) => setDpeEnergyClass(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="D" />
              </div>
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="dpe-climate-class">GES class</label>
                <input id="dpe-climate-class" value={dpeClimateClass} onChange={(event) => setDpeClimateClass(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="B" />
              </div>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="fee-price">Price / fee disclosure</label>
                <input id="fee-price" value={feePrice} onChange={(event) => setFeePrice(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="350 000 €" />
              </div>
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="fee-charge">Fee responsibility</label>
                <select id="fee-charge" value={feeCharge} onChange={(event) => setFeeCharge(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]">
                  <option value="">Not specified</option>
                  <option value="seller">Seller</option>
                  <option value="buyer">Buyer</option>
                </select>
              </div>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="co-ownership-lot">Co-ownership lot number</label>
                <input id="co-ownership-lot" value={coOwnershipLotNumber} onChange={(event) => setCoOwnershipLotNumber(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="123" />
              </div>
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="co-ownership-charges">Annual charges</label>
                <input id="co-ownership-charges" value={coOwnershipAnnualCharges} onChange={(event) => setCoOwnershipAnnualCharges(event.target.value)} className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]" placeholder="1 200 €" />
              </div>
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-2 block text-xs font-medium text-[var(--muted)]" htmlFor="photos">Photos</label>
            <div className="flex flex-wrap items-center gap-3">
              <label
                htmlFor="photos"
                className="inline-flex cursor-pointer items-center rounded-full border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                Add a photo
              </label>
              <span className="text-xs text-[var(--muted)]">
                {files.length > 0 ? `${files.length} selected` : "No file selected"}
              </span>
            </div>
            <input id="photos" type="file" multiple accept="image/*" onChange={handleFilesChange} className="sr-only" />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
              <p>
                Upload listing photos here. Up to {INCLUDED_PHOTO_COUNT} photos are included. Extra photos cost {EXTRA_CREDIT_PER_PHOTO} credit each.
              </p>
              <p>
                Optional enhancement costs {PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO} credit per photo and keeps room elements unchanged.
              </p>
              {files.length > 0 ? (
                <button
                  type="button"
                  onClick={handleClearFiles}
                  className="rounded-full border border-[var(--border)] bg-white px-2.5 py-1 font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  Clear all ({files.length})
                </button>
              ) : null}
            </div>
            {extraPhotoCount > 0 ? (
              <p className="mt-2 text-xs font-semibold text-[var(--foreground)]">
                {extraPhotoCount} extra photo{extraPhotoCount > 1 ? "s" : ""} selected. Additional cost: {extraPhotoCredits.toFixed(1)} credits.
              </p>
            ) : null}
            {enhancePhotos && files.length > 0 ? (
              <p className="mt-2 text-xs font-semibold text-[var(--foreground)]">
                Enhancement enabled for {files.length} photo{files.length > 1 ? "s" : ""}. Additional cost: {enhancementCredits.toFixed(1)} credits.
              </p>
            ) : null}
          </div>

          {message ? <p className="mt-4 text-sm font-medium text-[var(--foreground)]">{message}</p> : null}

          <div className="mt-5 flex flex-wrap items-end gap-3">
            <label className="min-w-[170px]">
              <span className="mb-2 block text-xs font-medium text-[var(--muted)]">Description length</span>
              <select
                value={descriptionLength}
                onChange={(event) => setDescriptionLength(event.target.value as DescriptionLength)}
                className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              >
                {DESCRIPTION_LENGTHS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="inline-flex min-w-[220px] items-center gap-2 rounded-2xl border border-[var(--border)] bg-white px-3 py-3 text-sm text-[var(--foreground)]">
              <input
                type="checkbox"
                checked={enhancePhotos}
                onChange={(event) => setEnhancePhotos(event.target.checked)}
                className="h-4 w-4 rounded border-[var(--border)]"
              />
              <span>Enhance photos ({PHOTO_ENHANCEMENT_CREDIT_PER_PHOTO} credit/photo)</span>
            </label>

            <label className="min-w-[180px]">
              <span className="mb-2 block text-xs font-medium text-[var(--muted)]">Enhancement style</span>
              <select
                value={enhancementStyle}
                onChange={(event) => setEnhancementStyle(event.target.value as EnhancementStyle)}
                className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
              >
                {ENHANCEMENT_STYLES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={handleEnhanceOnly}
              disabled={isGenerating || isEnhancingOnly || isWorkspaceLoading}
              className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isEnhancingOnly ? "Enhancing..." : "Enhance photos only"}
            </button>

            <button type="submit" disabled={isGenerating || isEnhancingOnly || isWorkspaceLoading} className="rounded-2xl bg-[linear-gradient(135deg,var(--accent)_0%,var(--accent-strong)_100%)] px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-[rgba(59,130,246,0.24)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70">
              {isGenerating ? "Generating..." : "Generate description"}
            </button>
          </div>
        </form>

        <div className="space-y-4 rounded-[24px] border border-[var(--border)] bg-[var(--surface)] px-5 py-5 shadow-sm xl:sticky xl:top-6 xl:self-start">
          <div>
            <p className="text-sm font-semibold text-[var(--foreground)]">Photo previews (visual check)</p>
            <p className="mt-1 text-sm text-[var(--muted)]">After enhancement test or generation, each photo shows as original then enhanced when available.</p>
            {enhancedPreviewUrls.some((url) => !!url) ? (
              <button
                type="button"
                onClick={handleDownloadAllEnhanced}
                className="mt-2 inline-flex items-center rounded-full border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                Download all enhanced
              </button>
            ) : null}
          </div>
          {previewItems.length > 0 ? (
            <div className="grid grid-cols-2 gap-3">
              {previewItems.map((item, index) => (
                <div key={`${item.kind}-${item.fileIndex}-${index}`} className="relative">
                  <img src={item.url} alt={`${item.label} property preview ${item.fileIndex + 1}`} className="h-36 w-full rounded-2xl border border-[var(--border)] object-cover" />
                  <span className="absolute left-2 top-2 rounded-full border border-white/70 bg-black/65 px-2 py-1 text-[11px] font-semibold text-white">
                    {item.label}
                  </span>
                  {item.kind === "original" ? (
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(item.fileIndex)}
                      className="absolute right-2 top-2 rounded-full border border-white/70 bg-black/65 px-2 py-1 text-[11px] font-semibold text-white transition hover:bg-black/80"
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleDownloadEnhanced(item.fileIndex)}
                      className="absolute bottom-2 right-2 rounded-full border border-white/70 bg-black/65 px-2 py-1 text-[11px] font-semibold text-white transition hover:bg-black/80"
                    >
                      Download
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-[var(--border)] bg-white/70 px-4 py-8 text-sm text-[var(--muted)]">
              Upload property photos to see them here.
            </div>
          )}

          <div className="rounded-2xl border border-[var(--border)] bg-white/80 p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold text-[var(--foreground)]">Generated draft</p>
              <p className="text-[11px] text-[var(--muted)]">AI can make mistakes; verify important details</p>
            </div>
            {editableDraft ? (
              <div className="mt-3 space-y-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">Title</p>
                  <input
                    value={editableDraft.title}
                    onChange={(event) => updateEditableDraft((previous) => ({ ...previous, title: event.target.value }))}
                    className="settings-field mt-1 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-base font-semibold text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                    placeholder="Draft title"
                  />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">Description</p>
                  <textarea
                    value={editableDraft.description}
                    onChange={(event) => updateEditableDraft((previous) => ({ ...previous, description: event.target.value }))}
                    rows={9}
                    className="settings-field mt-1 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm leading-7 text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                    placeholder="Draft description"
                  />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">Bullet points</p>
                  <textarea
                    value={editableDraft.bulletPoints.join("\n")}
                    onChange={(event) =>
                      updateEditableDraft((previous) => ({
                        ...previous,
                        bulletPoints: event.target.value
                          .split("\n")
                          .map((bullet) => bullet.trim())
                          .filter((bullet) => bullet.length > 0),
                      }))
                    }
                    rows={7}
                    className="settings-field mt-2 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                    placeholder="One bullet point per line"
                  />
                </div>
                {editableDraft.secondaryTitle || editableDraft.secondaryDescription || editableDraft.secondaryBulletPoints?.length ? (
                  <div className="rounded-2xl border border-[var(--border)] bg-white/80 p-4">
                    <p className="text-xs uppercase tracking-[0.18em] text-[var(--muted)]">Secondary language</p>
                    <input
                      value={editableDraft.secondaryTitle ?? ""}
                      onChange={(event) =>
                        updateEditableDraft((previous) => ({
                          ...previous,
                          secondaryTitle: event.target.value,
                        }))
                      }
                      className="settings-field mt-2 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-base font-semibold text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                      placeholder="Secondary title"
                    />
                    <textarea
                      value={editableDraft.secondaryDescription ?? ""}
                      onChange={(event) =>
                        updateEditableDraft((previous) => ({
                          ...previous,
                          secondaryDescription: event.target.value,
                        }))
                      }
                      rows={7}
                      className="settings-field mt-2 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm leading-7 text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                      placeholder="Secondary description"
                    />
                    <textarea
                      value={editableDraft.secondaryBulletPoints?.join("\n") ?? ""}
                      onChange={(event) =>
                        updateEditableDraft((previous) => ({
                          ...previous,
                          secondaryBulletPoints: event.target.value
                            .split("\n")
                            .map((bullet) => bullet.trim())
                            .filter((bullet) => bullet.length > 0),
                        }))
                      }
                      rows={5}
                      className="settings-field mt-2 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                      placeholder="One secondary bullet point per line"
                    />
                  </div>
                ) : null}
                <p className="text-xs text-[var(--muted)]">
                  Market: {editableDraft.metadata.countryCode} / {editableDraft.metadata.locale} / {editableDraft.metadata.language} / {editableDraft.metadata.timezone}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleSendDraftEmail}
                    disabled={isSendingEmail}
                    className="rounded-full border border-[var(--border)] bg-white px-3 py-1.5 text-xs font-semibold text-[var(--foreground)] transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSendingEmail ? "Sending..." : hasSentDraftEmail ? "Resend draft by email" : "Send draft by email"}
                  </button>
                  {emailMessage ? <p className="text-xs text-[var(--muted)]">{emailMessage}</p> : null}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--muted)]">Your draft will appear here after generation.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
