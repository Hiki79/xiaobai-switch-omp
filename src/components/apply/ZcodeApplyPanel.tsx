import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Select, Skeleton, Space } from "antd";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { useApplyStore, useSiteStore } from "@/stores";
import { ApplyFooter } from "./ApplyFooter";
import { SiteSelect } from "./SiteSelect";
import { TargetStatusCard, statusFor, toolFor } from "./TargetStatusCard";
import { useApplySiteSelection } from "./useApplySiteSelection";
import {
  buildModelOptions,
  hydrateZcodeForm,
  zcodeReasoningLevelsForModel,
} from "./hydrateApplyForm";
import { showApplyException, showApplyOutcome } from "./showApplyOutcome";

const rowStyle: React.CSSProperties = { padding: "4px 0" };

function defaultLevel(levels: string[], current?: string): string | undefined {
  if (current && levels.includes(current)) return current;
  return levels.find((level) => level.toLowerCase() === "max") ?? levels[0];
}

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

  const [modelId, setModelId] = useState<string | undefined>();
  const [reasoningLevels, setReasoningLevels] = useState<string[]>([]);
  const [reasoningLevel, setReasoningLevel] = useState<string | undefined>();

  const models = siteId ? (modelsBySite[siteId] ?? []) : [];
  const modelsLoading = siteId ? Boolean(modelsLoadingBySite[siteId]) : false;

  useEffect(() => {
    if (!siteId) return;
    void listModels(siteId).catch(() => null);
  }, [siteId, listModels]);

  const lastHydrate = useRef<{ siteId: string; stamp: number | null; modelCount: number } | null>(null);
  useEffect(() => {
    if (!site) {
      lastHydrate.current = null;
      setModelId(undefined);
      setReasoningLevels([]);
      setReasoningLevel(undefined);
      return;
    }
    const stamp = status?.lastAppliedAt ?? null;
    const prev = lastHydrate.current;
    if (prev && prev.siteId === site.id && prev.stamp === stamp && prev.modelCount === models.length) return;
    const defaults = hydrateZcodeForm(site, status, models);
    setModelId(defaults.modelId);
    setReasoningLevels(defaults.reasoningLevels);
    setReasoningLevel(defaults.reasoningLevel);
    lastHydrate.current = { siteId: site.id, stamp, modelCount: models.length };
  }, [site, status, models]);

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
    setReasoningLevel(defaultLevel(levels));
  };

  const handleLevelListChange = (values: string[]) => {
    const next = values.map((value) => value.trim()).filter(Boolean);
    setReasoningLevels(next);
    setReasoningLevel((current) => defaultLevel(next, current));
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
          <SettingsGroup title={t("apply.groupZcodeReasoning")}>
            <div style={rowStyle}>
              <div className="mb-1 text-sm opacity-70">{t("apply.zcodeReasoningLevel")}</div>
              <Select
                className="w-full"
                value={reasoningLevel}
                options={reasoningLevels.map((level) => ({ value: level, label: level }))}
                onChange={setReasoningLevel}
                disabled={reasoningLevels.length === 0}
                placeholder={t("apply.zcodeReasoningLevel")}
              />
              <div className="mt-1 text-xs opacity-50">{t("apply.zcodeReasoningHint")}</div>
            </div>
            <div className="mt-4" style={rowStyle}>
              <div className="mb-1 text-sm opacity-70">{t("apply.zcodeReasoningVariants")}</div>
              <Select
                mode="tags"
                className="w-full"
                value={reasoningLevels}
                onChange={(values) => handleLevelListChange(values as string[])}
                tokenSeparators={[",", " "]}
                placeholder={t("apply.zcodeReasoningVariantsPlaceholder")}
              />
              <div className="mt-1 text-xs opacity-50">{t("apply.zcodeReasoningVariantsHint")}</div>
            </div>
          </SettingsGroup>
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
