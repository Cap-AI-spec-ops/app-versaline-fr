"use client";

import { useEffect, useState } from "react";

import { mapWorkspaceProperty, type WorkspacePropertySummary } from "@/lib/properties/workspace-properties";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type WorkspacePropertyPickerProps = {
  workspaceId: string | null | undefined;
  value: string;
  onChange: (nextId: string) => void;
  onPick?: (property: WorkspacePropertySummary | null) => void;
  label?: string;
  helperText?: string;
  emptyOptionLabel?: string;
};

export default function WorkspacePropertyPicker({
  workspaceId,
  value,
  onChange,
  onPick,
  label = "Workspace property",
  helperText = "Select a property saved in this workspace.",
  emptyOptionLabel = "No linked property",
}: WorkspacePropertyPickerProps) {
  const [properties, setProperties] = useState<WorkspacePropertySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!onPick) {
      return;
    }

    if (!value) {
      onPick(null);
      return;
    }

    const selected = properties.find((property) => property.id === value) ?? null;
    onPick(selected);
  }, [onPick, properties, value]);

  useEffect(() => {
    async function load(workspaceScope: string) {
      const supabase = getSupabaseBrowserClient();

      if (!supabase) {
        setProperties([]);
        setError("Supabase is not configured.");
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from("properties")
        .select("*")
        .eq("workspace_id", workspaceScope);

      if (fetchError) {
        setProperties([]);
        setError(fetchError.message);
        setIsLoading(false);
        return;
      }

      const mapped = ((data ?? []) as Record<string, unknown>[])
        .map((row) => mapWorkspaceProperty(row))
        .filter((row) => Boolean(row.id));

      setProperties(mapped);
      setIsLoading(false);
    }

    if (!workspaceId) {
      setProperties([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    void load(workspaceId);
  }, [workspaceId]);

  return (
    <div>
      <label className="block text-sm text-[var(--muted)]">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-[0.14em]">{label}</span>
        <select
          value={value}
          onChange={(event) => {
            const nextId = event.target.value;
            onChange(nextId);

            if (!onPick) {
              return;
            }

            const selected = properties.find((property) => property.id === nextId) ?? null;
            onPick(selected);
          }}
          className="settings-field w-full rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm outline-none focus:border-[var(--accent)]"
          disabled={isLoading}
        >
          <option value="">{isLoading ? "Loading properties..." : emptyOptionLabel}</option>
          {properties.map((property) => (
            <option key={property.id} value={property.id}>
              {property.label}
              {property.city ? ` - ${property.city}` : ""}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs text-[var(--muted)]">{helperText}</p>
      {error ? <p className="mt-2 text-xs font-medium text-amber-700">Could not load properties ({error}).</p> : null}
    </div>
  );
}
