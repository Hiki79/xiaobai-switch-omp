import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Select, Skeleton, Space } from "antd";
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
  dshReasoningLevelsForModel,
  hydrateCatalogSelection,
  hydrateDshForm,
  parseLiveModelIds,
} from "./hydrateApplyForm";
import { showApplyException, showApplyOutcome } from "./showApplyOutcome";

const rowStyle: React.CSSProperties = { padding: "4px 0" };

export const DshApplyPanel = memo(function DshApplyPanel() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const modelsBySite = useSiteStore((state) => state.modelsBySite);
  const modelsLoadingBySite = useSiteStore((state) => state.modelsLoadingBySite);
  const listModels = useSiteStore((state) => state.listModels);
  const updateSite = useSiteStore((state) => state.updateSite);

  const statuses = useApplyStore((state) => state.statuses);
  const tools = useApplyStore((state) => state.tools);
  const applying = useApplyStore((state) => state.applying);
  const loadStatus = useApplyStore((state) => state.loadStatus);
  const apply = useApplyStore((state) => state.apply);
  const revert = useApplyStore((state) => state.revert);
  const restoreOfficial = useApplyStore((state) => state.restoreOfficial);
  const cleanupOrphan = useApplyStore((state) => state.cleanupOrphan);
  const statusLoading = useApplyStore((state) => state.loading);

  const status = statusFor(statuses, "dsh");
  const { siteId, site, sites, selectSite, hasAnySite, hasEnabledSite } =
    useApplySiteSelection(status?.appliedSiteId);
  const models = siteId ? (modelsBySite[siteId] ?? []) : [];
  const modelsLoading = siteId ? Boolean(modelsLoadingBySite[siteId]) : false;

  const [modelId, setModelId] = useState<string>();
  const [writeAllModels, setWriteAllModels] = useState(false);
  const [reasoningLevels, setReasoningLevels] = useState<string[]>([]);
  const [reasoningLevel, setReasoningLevel] = useState<string>();
  const { catalogIds, setCatalogIds } = useCatalogSelection(models);

  useEffect(() => {
    if (siteId) void listModels(siteId).catch(() => null);
  }, [siteId, listModels]);

  const lastHydrate = useRef<{ siteId: string; stamp: number | null; modelCount: number } | null>(
    null,
  );
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
    const previous = lastHydrate.current;
    if (
      previous &&
      previous.siteId === site.id &&
      previous.stamp === stamp &&
      previous.modelCount === models.length
    ) {
      return;
    }
    const defaults = hydrateDshForm(site, status);
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

  const modelOptions = useMemo(() => buildModelOptions(models, [modelId]), [models, modelId]);

  const handleModelChange = (nextModelId: string) => {
    setModelId(nextModelId);
    const levels = dshReasoningLevelsForModel(nextModelId);
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
        targets: ["dsh"],
        modelId,
        dshWriteAllModels: writeAllModels,
        catalogModelIds: writeAllModels ? catalogIds : null,
        dshReasoningLevels: reasoningLevels,
        dshReasoningLevel: reasoningLevel ?? null,
      });
      showApplyOutcome(
        modal,
        t,
        result.results.find((item) => item.target === "dsh"),
      );
    } catch (error) {
      showApplyException(modal, t, error);
    }
  };

  const tool = toolFor(tools, "dsh");
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
              onRevert={() => revert("dsh")}
              onCleanupOrphan={() => cleanupOrphan("dsh")}
            />
          )}
        </SettingsGroup>

        <SettingsGroup title={t("apply.groupSite")}>
          {!hasAnySite ? (
            <Alert type="info" title={t("apply.noSite")} showIcon />
          ) : (
            <Space orientation="vertical" className="w-full" size="middle">
              {!hasEnabledSite && <Alert type="info" title={t("apply.noEnabledSite")} showIcon />}
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
                <div className="mt-1 text-xs opacity-50">{t("apply.dshModelHint")}</div>
              </div>
            </Space>
          )}
        </SettingsGroup>

        {site && (
          <>
            <SettingsGroup title={t("apply.groupDshModels")}>
              <ModelCatalogSection
                title={t("apply.dshWriteAllModels")}
                hint={t("apply.dshWriteAllModelsHint")}
                models={models}
                loading={modelsLoading}
                writeAll={writeAllModels}
                onWriteAllChange={setWriteAllModels}
                selectedIds={catalogIds}
                onSelectedIdsChange={setCatalogIds}
                defaultModelId={modelId}
              />
            </SettingsGroup>

            <SettingsGroup title={t("apply.groupDshReasoning")}>
              <ReasoningLevelFields
                levels={reasoningLevels}
                onLevelsChange={setReasoningLevels}
                defaultLevel={reasoningLevel}
                onDefaultLevelChange={setReasoningLevel}
                allowed={dshReasoningLevelsForModel(modelId ?? "")}
                defaultLabel={t("apply.dshReasoningLevel")}
                defaultHint={t("apply.dshReasoningHint")}
                variantsHint={t("apply.dshReasoningVariantsHint")}
              />
            </SettingsGroup>
          </>
        )}
      </div>

      <ApplyFooter
        target="dsh"
        loading={applying}
        disabled={!modelId}
        onApply={() => void handleApply()}
        onRestoreOfficial={() => restoreOfficial("dsh")}
      />
    </div>
  );
});
