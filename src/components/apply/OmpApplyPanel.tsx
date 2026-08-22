import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Select, Space, Skeleton } from "antd";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { useApplyStore, useSiteStore } from "@/stores";
import { ApplyFooter } from "./ApplyFooter";
import { ModelCatalogSection } from "./ModelCatalogSection";
import { ReasoningLevelFields } from "./ReasoningLevelFields";
import { SiteSelect } from "./SiteSelect";
import { TargetStatusCard, statusFor, toolFor } from "./TargetStatusCard";
import { useApplySiteSelection } from "./useApplySiteSelection";
import { useCatalogSelection } from "./useCatalogSelection";
import {
  buildModelOptions,
  defaultReasoningLevel,
  hydrateCatalogSelection,
  hydrateOmpForm,
  OMP_EFFORTS,
  ompReasoningLevelsForModel,
  parseLiveModelIds,
} from "./hydrateApplyForm";
import { showApplyException, showApplyOutcome } from "./showApplyOutcome";

const rowStyle: React.CSSProperties = { padding: "4px 0" };

export const OmpApplyPanel = memo(function OmpApplyPanel() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const modelsBySite = useSiteStore((s) => s.modelsBySite);
  const modelsLoadingBySite = useSiteStore((s) => s.modelsLoadingBySite);
  const listModels = useSiteStore((s) => s.listModels);
  const updateSite = useSiteStore((s) => s.updateSite);

  const statuses = useApplyStore((s) => s.statuses);
  const tools = useApplyStore((s) => s.tools);
  const applying = useApplyStore((s) => s.applying);
  const loadStatus = useApplyStore((s) => s.loadStatus);
  const apply = useApplyStore((s) => s.apply);
  const revert = useApplyStore((s) => s.revert);
  const restoreOfficial = useApplyStore((s) => s.restoreOfficial);
  const cleanupOrphan = useApplyStore((s) => s.cleanupOrphan);
  const statusLoading = useApplyStore((s) => s.loading);

  const status = statusFor(statuses, "omp");
  const { siteId, site, sites, selectSite, hasAnySite, hasEnabledSite } = useApplySiteSelection(
    status?.appliedSiteId,
  );

  const models = siteId ? (modelsBySite[siteId] ?? []) : [];
  const modelsLoading = siteId ? Boolean(modelsLoadingBySite[siteId]) : false;

  const [modelId, setModelId] = useState<string | undefined>();
  const [writeAllModels, setWriteAllModels] = useState(false);
  const [reasoningLevels, setReasoningLevels] = useState<string[]>([]);
  const [reasoningLevel, setReasoningLevel] = useState<string | undefined>();
  const { catalogIds, setCatalogIds } = useCatalogSelection(models);

  useEffect(() => {
    if (!siteId) return;
    void listModels(siteId).catch(() => null);
  }, [siteId, listModels]);

  const lastHydrate = useRef<{ siteId: string; stamp: number | null; modelCount: number } | null>(null);
  useEffect(() => {
    if (!site) {
      lastHydrate.current = null;
      setModelId(undefined);
      setWriteAllModels(false);
      setReasoningLevels([]);
      setReasoningLevel(undefined);
      setCatalogIds(null);
      return;
    }
    const stamp = status?.lastAppliedAt ?? null;
    const prev = lastHydrate.current;
    if (prev && prev.siteId === site.id && prev.stamp === stamp && prev.modelCount === models.length) return;
    const defaults = hydrateOmpForm(site, status);
    setModelId(defaults.modelId);
    setWriteAllModels(defaults.writeAllModels);
    setReasoningLevels(defaults.reasoningLevels);
    setReasoningLevel(defaults.reasoningLevel);
    const liveIds = defaults.writeAllModels ? parseLiveModelIds(status?.liveSummary) : [];
    setCatalogIds(
      liveIds.length > 0 && models.length > 0 ? hydrateCatalogSelection(models, liveIds) : null,
    );
    lastHydrate.current = { siteId: site.id, stamp, modelCount: models.length };
  }, [site, status, models, setCatalogIds]);

  const modelOptions = useMemo(
    () => buildModelOptions(models, [modelId]),
    [models, modelId],
  );

  const handleModelChange = (nextModelId: string) => {
    setModelId(nextModelId);
    const levels = ompReasoningLevelsForModel(nextModelId);
    setReasoningLevels(levels);
    setReasoningLevel((current) => defaultReasoningLevel(levels, current));
  };

  const handleApply = async () => {
    if (!site) {
      message.warning(t("apply.noSite"));
      return;
    }
    if (!modelId) {
      message.warning(t("sites.selectModel"));
      return;
    }
    try {
      if (site.selectedModelId !== modelId) {
        await updateSite(site.id, { selectedModelId: modelId });
      }
      const result = await apply({
        siteId: site.id,
        targets: ["omp"],
        modelId,
        ompWriteAllModels: writeAllModels,
        catalogModelIds: writeAllModels ? catalogIds : null,
        ompReasoningLevels: reasoningLevels,
        ompReasoningLevel: reasoningLevel ?? null,
      });
      showApplyOutcome(
        modal,
        t,
        result.results.find((r) => r.target === "omp"),
      );
    } catch (e) {
      showApplyException(modal, t, e);
    }
  };

  const tool = toolFor(tools, "omp");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-6 pb-4">
        <SettingsGroup title={t("apply.status")}>
          {statusLoading && !status ? (
            <Skeleton active paragraph={{ rows: 3 }} title={{ width: "40%" }} />
          ) : (
            <TargetStatusCard
              status={status}
              tool={tool}
              onRefresh={() => loadStatus({ force: true })}
              onRevert={() => revert("omp")}
              onCleanupOrphan={() => cleanupOrphan("omp")}
            />
          )}
        </SettingsGroup>

        <SettingsGroup title={t("apply.groupSite")}>
          {!hasAnySite ? (
            <Alert type="info" title={t("apply.noSite")} showIcon />
          ) : (
            <Space orientation="vertical" className="w-full" size="middle">
              {!hasEnabledSite && (
                <Alert type="info" title={t("apply.noEnabledSite")} showIcon />
              )}
              <div style={rowStyle}>
                <div className="mb-1 text-sm opacity-70">{t("apply.selectSite")}</div>
                <SiteSelect
                  sites={sites}
                  value={siteId ?? undefined}
                  placeholder={t("apply.selectSite")}
                  onChange={selectSite}
                />
              </div>
              <div style={rowStyle}>
                <div className="mb-1 text-sm opacity-70">{t("apply.defaultModel")}</div>
                {modelsLoading && models.length === 0 ? (
                  <Skeleton.Input active block style={{ height: 32 }} />
                ) : (
                  <Select
                    className="w-full"
                    value={modelId}
                    placeholder={t("sites.selectModel")}
                    options={modelOptions}
                    onChange={handleModelChange}
                    showSearch
                    optionFilterProp="label"
                    disabled={!site}
                    loading={modelsLoading}
                    notFoundContent={t("sites.noModels")}
                  />
                )}
                <div className="mt-1 text-xs opacity-50">{t("apply.ompModelHint")}</div>
              </div>
            </Space>
          )}
        </SettingsGroup>

        {site && (
          <>
          <SettingsGroup title={t("apply.groupOmpModels")}>
            <ModelCatalogSection
              title={t("apply.ompWriteAllModels")}
              hint={t("apply.ompWriteAllModelsHint")}
              models={models}
              loading={modelsLoading}
              writeAll={writeAllModels}
              onWriteAllChange={setWriteAllModels}
              selectedIds={catalogIds}
              onSelectedIdsChange={setCatalogIds}
              defaultModelId={modelId}
            />
          </SettingsGroup>

          <SettingsGroup title={t("apply.groupOmpReasoning")}>
            <ReasoningLevelFields
              levels={reasoningLevels}
              onLevelsChange={setReasoningLevels}
              defaultLevel={reasoningLevel}
              onDefaultLevelChange={setReasoningLevel}
              allowed={OMP_EFFORTS}
              defaultLabel={t("apply.ompReasoningLevel")}
              defaultHint={t("apply.ompReasoningHint")}
              variantsHint={t("apply.ompReasoningVariantsHint")}
            />
          </SettingsGroup>
          </>
        )}
      </div>

      <ApplyFooter
        target="omp"
        loading={applying}
        disabled={!modelId}
        onApply={() => void handleApply()}
        onRestoreOfficial={() => restoreOfficial("omp")}
      />
    </div>
  );
});
