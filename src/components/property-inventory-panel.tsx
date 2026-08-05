"use client";

import { useState } from "react";
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

import type { WorkspacePropertySummary } from "@/lib/properties/workspace-properties";
import { useCurrentWorkspace } from "@/lib/workspace/use-current-workspace";
import WorkspacePropertyPicker from "@/components/workspace-property-picker";

export default function PropertyInventoryPanel() {
  const searchParams = useSearchParams();
  const { workspace, isLoading: isWorkspaceLoading, error: workspaceError } = useCurrentWorkspace();
  const [selectedPropertyId, setSelectedPropertyId] = useState("");
  const [selectedProperty, setSelectedProperty] = useState<WorkspacePropertySummary | null>(null);

  useEffect(() => {
    const queryPropertyId = searchParams.get("propertyId")?.trim() ?? "";

    if (!queryPropertyId) {
      return;
    }

    setSelectedPropertyId((previous) => (previous ? previous : queryPropertyId));
  }, [searchParams]);

  if (workspaceError) {
    return <p className="text-sm text-red-600">{workspaceError}</p>;
  }

  if (isWorkspaceLoading) {
    return <p className="text-sm text-[var(--muted)]">Loading inventory workspace...</p>;
  }

  return (
    <section className="flex min-h-full flex-col gap-6">
      <article className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">Property inventory</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--foreground)]">Inventory workspace</h1>
        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
          This beta page is connected to the shared workspace property list and ready for room/photo inventory workflows.
        </p>
      </article>

      <article className="rounded-[24px] border border-[var(--border)] bg-[var(--surface-strong)] px-5 py-5 shadow-sm">
        <WorkspacePropertyPicker
          workspaceId={workspace?.id}
          value={selectedPropertyId}
          onChange={setSelectedPropertyId}
          onPick={setSelectedProperty}
          label="Property inventory target"
          helperText="Select which workspace property inventory updates should apply to."
        />

        {selectedProperty ? (
          <div className="mt-4 rounded-2xl border border-[var(--border)] bg-white px-4 py-4 text-sm text-[var(--foreground)]">
            <p className="font-semibold">Selected property</p>
            <p className="mt-2">{selectedProperty.label}</p>
            <p className="text-xs text-[var(--muted)]">
              {[selectedProperty.postalCode, selectedProperty.city].filter(Boolean).join(" ") || "No location details"}
            </p>
          </div>
        ) : null}
      </article>
    </section>
  );
}
