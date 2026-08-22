import { useMemo, useState } from "react";
import type { SiteModel } from "@/types/domain";

/** Catalog picker state shared by the write-all model sections.
 * `null` means "every site model" (the default); an explicit list is what the
 * user (or a previous apply) narrowed it down to. Stale ids that no longer
 * exist in the site catalog are dropped from the effective value. */
export function useCatalogSelection(models: SiteModel[]) {
  const [explicitIds, setExplicitIds] = useState<string[] | null>(null);
  const catalogIds = useMemo(() => {
    const all = models.map((m) => m.modelId);
    if (!explicitIds) return all;
    const known = new Set(all);
    return explicitIds.filter((id) => known.has(id));
  }, [explicitIds, models]);
  return { catalogIds, setCatalogIds: setExplicitIds };
}
