import { useEffect, useMemo, useRef, useState } from "react";
import { useSiteStore, useUIStore } from "@/stores";
import { pickApplySiteId } from "./hydrateApplyForm";

export function useApplySiteSelection(appliedSiteId: string | null | undefined) {
  const sites = useSiteStore((s) => s.sites);
  const selectedSiteId = useUIStore((s) => s.selectedSiteId);
  const setSelectedSiteId = useUIStore((s) => s.setSelectedSiteId);
  const applyPrefillSiteId = useUIStore((s) => s.applyPrefillSiteId);
  const setApplyPrefillSiteId = useUIStore((s) => s.setApplyPrefillSiteId);

  const [siteId, setSiteId] = useState<string | null>(() =>
    pickApplySiteId({
      sites: useSiteStore.getState().sites,
      prefillSiteId: useUIStore.getState().applyPrefillSiteId,
      selectedSiteId: useUIStore.getState().selectedSiteId,
      appliedSiteId,
    }),
  );
  const userPicked = useRef(Boolean(useUIStore.getState().applyPrefillSiteId));

  useEffect(() => {
    if (applyPrefillSiteId) {
      if (sites.some((s) => s.id === applyPrefillSiteId)) {
        setSiteId(applyPrefillSiteId);
        userPicked.current = true;
      }
      setApplyPrefillSiteId(null);
      return;
    }
    if (userPicked.current || sites.length === 0) return;
    const next = pickApplySiteId({
      sites,
      selectedSiteId,
      appliedSiteId,
    });
    if (next) setSiteId(next);
  }, [sites, appliedSiteId, applyPrefillSiteId, selectedSiteId, setApplyPrefillSiteId]);

  const selectSite = (id: string) => {
    userPicked.current = true;
    setSiteId(id);
    setSelectedSiteId(id);
  };

  const site = useMemo(() => sites.find((s) => s.id === siteId) ?? null, [sites, siteId]);

  return { siteId, site, sites, selectSite };
}
