import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, InputNumber, Select, Skeleton, Space } from "antd";
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
  hydrateCatalogSelection,
  hydrateZcodeForm,
  parseLiveModelIds,
  zcodeReasoningLevelsForModel,
} from "./hydrateApplyForm";
import { showApplyException, showApplyOutcome } from "./showApplyOutcome";

const rowStyle: React.CSSProperties = { padding: "4px 0" };

export const ZcodeApplyPanel = memo(function ZcodeApplyPanel() {
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

  const status = statusFor(statuses, "zcode");
  const { siteId, site, sites, selectSite, hasAnySite, hasEnabledSite } = useApplySiteSelection(
    status?.appliedSiteId,
  );

  const models = siteId ? (modelsBySite[siteId] ?? []) : [];
  const modelsLoading = siteId ? Boolean(modelsLoadingBySite[siteId]) : false;

  const [modelId, setModelId] = useState<string | undefined>();
  const [writeAllModels, setWriteAllModels] = useState(false);
  const [contextWindow, setContextWindow] = useState<number | undefined>();
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
      setContextWindow(undefined);
      setReasoningLevels([]);
      setReasoningLevel(undefined);
      setCatalogIds(null);
      return;
    }
    const stamp = status?.lastAppliedAt ?? null;
    const prev = lastHydrate.current;
    if (prev && prev.siteId === site.id && prev.stamp === stamp && prev.modelCount === models.length) return;
    const defaults = hydrateZcodeForm(site, status, models);
    setModelId(defaults.modelId);
    setWriteAllModels(defaults.writeAllModels);
    setContextWindow(defaults.contextWindow);
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
    const levels = zcodeReasoningLevelsForModel(
      nextModelId,
      models.find((model) => model.modelId === nextModelId),
      status,
    );
    setReasoningLevels(levels);
    const fallback = levels.find((level) => level.toLowerCase() === "max") ?? levels[0];
    setReasoningLevel((current) => (current && levels.includes(current) ? current : fallback));
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
        targets: ["zcode"],
        modelId,
        zcodeWriteAllModels: writeAllModels,
        catalogModelIds: writeAllModels ? catalogIds : null,
        zcodeContextWindow: contextWindow ?? null,
        zcodeReasoningLevels: reasoningLevels,
        zcodeReasoningLevel: reasoningLevel ?? null,
      });
      showApplyOutcome(
        modal,
        t,
        result.results.find((r) => r.target === "zcode"),
      );
    } catch (e) {
      showApplyException(modal, t, e);
    }
  };

  const tool = toolFor(tools, "zcode");

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
              onRevert={() => revert("zcode")}
              onCleanupOrphan={() => cleanupOrphan("zcode")}
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
                <div className="mt-1 text-xs opacity-50">{t("apply.zcodeModelHint")}</div>
              </div>
            </Space>
          )}
        </SettingsGroup>

        {site && (
          <>
            <SettingsGroup title={t("apply.groupZcodeModels")}>
              <ModelCatalogSection
                title={t("apply.zcodeWriteAllModels")}
                hint={t("apply.zcodeWriteAllModelsHint")}
                models={models}
                loading={modelsLoading}
                writeAll={writeAllModels}
                onWriteAllChange={setWriteAllModels}
                selectedIds={catalogIds}
                onSelectedIdsChange={setCatalogIds}
                defaultModelId={modelId}
              />
              <div className="mt-3" style={rowStyle}>
                <div className="mb-1 text-sm opacity-70">{t("apply.zcodeContextWindow")}</div>
                <InputNumber
                  className="w-full"
                  min={1000}
                  step={1000}
                  value={contextWindow}
                  onChange={(value) =>
                    setContextWindow(typeof value === "number" && value > 0 ? value : undefined)
                  }
                  placeholder={t("apply.zcodeContextWindowPlaceholder")}
                  addonAfter="tokens"
                />
                <div className="mt-1 text-xs opacity-50">{t("apply.zcodeContextWindowHint")}</div>
              </div>
            </SettingsGroup>

            <SettingsGroup title={t("apply.groupZcodeReasoning")}>
              <ReasoningLevelFields
                levels={reasoningLevels}
                onLevelsChange={setReasoningLevels}
                defaultLevel={reasoningLevel}
                onDefaultLevelChange={setReasoningLevel}
                defaultLabel={t("apply.zcodeReasoningLevel")}
                defaultHint={t("apply.zcodeReasoningHint")}
                variantsHint={t("apply.zcodeReasoningVariantsHint")}
              />
            </SettingsGroup>
          </>
        )}
      </div>

      <ApplyFooter
        target="zcode"
        loading={applying}
        disabled={!modelId}
        onApply={() => void handleApply()}
        onRestoreOfficial={() => restoreOfficial("zcode")}
      />
    </div>
  );
});
