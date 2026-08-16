import { useEffect, useMemo, useRef, useState } from "react";
import { useSiteStore, useUIStore } from "@/stores";
import { pickApplySiteId, selectableApplySites } from "./hydrateApplyForm";

export function useApplySiteSelection(appliedSiteId: string | null | undefined) {
  const sites = useSiteStore((s) => s.sites);
  const selectable = useMemo(() => selectableApplySites(sites), [sites]);
  const selectedSiteId = useUIStore((s) => s.selectedSiteId);
  const setSelectedSiteId = useUIStore((s) => s.setSelectedSiteId);
  const applyPrefillSiteId = useUIStore((s) => s.applyPrefillSiteId);
  const setApplyPrefillSiteId = useUIStore((s) => s.setApplyPrefillSiteId);

  const [siteId, setSiteId] = useState<string | null>(() =>
    pickApplySiteId({
      sites: selectableApplySites(useSiteStore.getState().sites),
      prefillSiteId: useUIStore.getState().applyPrefillSiteId,
      selectedSiteId: useUIStore.getState().selectedSiteId,
      appliedSiteId,
    }),
  );
  const userPicked = useRef(Boolean(useUIStore.getState().applyPrefillSiteId));

  useEffect(() => {
    if (applyPrefillSiteId) {
      if (selectable.some((s) => s.id === applyPrefillSiteId)) {
        setSiteId(applyPrefillSiteId);
        userPicked.current = true;
      }
      setApplyPrefillSiteId(null);
      return;
    }
    setSiteId((current) => {
      const currentValid = Boolean(current && selectable.some((s) => s.id === current));
      if (!currentValid) {
        userPicked.current = false;
        return pickApplySiteId({
          sites: selectable,
          selectedSiteId,
          appliedSiteId,
        });
      }
      if (userPicked.current) return current;
      return (
        pickApplySiteId({
          sites: selectable,
          selectedSiteId,
          appliedSiteId,
        }) ?? current
      );
    });
  }, [selectable, appliedSiteId, applyPrefillSiteId, selectedSiteId, setApplyPrefillSiteId]);

  const selectSite = (id: string) => {
    if (!selectable.some((s) => s.id === id)) return;
    userPicked.current = true;
    setSiteId(id);
    setSelectedSiteId(id);
  };

  const site = useMemo(
    () => selectable.find((s) => s.id === siteId) ?? null,
    [selectable, siteId],
  );

  return {
    siteId,
    site,
    sites,
    selectSite,
    hasAnySite: sites.length > 0,
    hasEnabledSite: selectable.length > 0,
  };
}
