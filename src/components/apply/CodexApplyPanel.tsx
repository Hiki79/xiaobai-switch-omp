import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Select, Space, Divider, Skeleton } from "antd";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { useApplyStore, useSiteStore } from "@/stores";
import type { CodexCapabilitySource, CodexReasoningEffort } from "@/types/domain";
import {
  codexFlagsFromCapabilities,
  EMPTY_CODEX_FLAGS,
  summarizeCodexCapabilities,
  type CodexCapabilityFlags,
} from "@/lib/siteCapabilities";
import { ApplyFooter } from "./ApplyFooter";
import { ModelCatalogSection } from "./ModelCatalogSection";
import { ReasoningLevelFields } from "./ReasoningLevelFields";
import { SiteSelect } from "./SiteSelect";
import { TargetStatusCard, statusFor, toolFor } from "./TargetStatusCard";
import { useApplySiteSelection } from "./useApplySiteSelection";
import { useCatalogSelection } from "./useCatalogSelection";
import {
  buildModelOptions,
  CODEX_EFFORT_LIST,
  codexReasoningLevelsForModel,
  defaultReasoningLevel,
  hydrateCatalogSelection,
  hydrateCodexForm,
  parseLiveModelIds,
} from "./hydrateApplyForm";
import { showApplyException, showApplyOutcome } from "./showApplyOutcome";
import { CodexCapabilitySwitchList } from "./CodexCapabilitySwitchList";

const rowStyle: React.CSSProperties = { padding: "4px 0" };

export const CodexApplyPanel = memo(function CodexApplyPanel() {
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

  const status = statusFor(statuses, "codex");
  const { siteId, site, sites, selectSite, hasAnySite, hasEnabledSite } = useApplySiteSelection(
    status?.appliedSiteId,
  );

  const models = siteId ? (modelsBySite[siteId] ?? []) : [];
  const modelsLoading = siteId ? Boolean(modelsLoadingBySite[siteId]) : false;

  const [modelId, setModelId] = useState<string | undefined>();
  const [writeAllModels, setWriteAllModels] = useState(false);
  const [reasoning, setReasoning] = useState<CodexReasoningEffort | undefined>();
  const [reasoningLevels, setReasoningLevels] = useState<CodexReasoningEffort[]>([]);
  const [capabilitySource, setCapabilitySource] = useState<CodexCapabilitySource>("site");
  const [codexFlags, setCodexFlags] = useState<CodexCapabilityFlags>(EMPTY_CODEX_FLAGS);
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
      setCapabilitySource("site");
      setCodexFlags(EMPTY_CODEX_FLAGS);
      setCatalogIds(null);
      return;
    }
    const stamp = status?.lastAppliedAt ?? null;
    const prev = lastHydrate.current;
    if (prev && prev.siteId === site.id && prev.stamp === stamp && prev.modelCount === models.length) return;
    const defaults = hydrateCodexForm(site, status);
    setModelId(defaults.modelId);
    setWriteAllModels(defaults.writeAllModels);
    const levels = codexReasoningLevelsForModel(defaults.modelId);
    setReasoningLevels(levels);
    setReasoning(defaultReasoningLevel(levels, defaults.reasoning));
    setCapabilitySource(defaults.capabilitySource);
    setCodexFlags({
      compact: defaults.remoteCompaction,
      vision: defaults.imageUnderstanding,
      imagegen: defaults.imageGeneration,
      search: defaults.webSearch,
    });
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
    const levels = codexReasoningLevelsForModel(nextModelId);
    setReasoningLevels(levels);
    setReasoning((current) => defaultReasoningLevel(levels, current));
  };

  const effortLabel = (value: string): string => {
    switch (value as CodexReasoningEffort) {
      case "minimal":
        return t("apply.effortMinimal");
      case "low":
        return t("apply.effortLow");
      case "medium":
        return t("apply.effortMedium");
      case "high":
        return t("apply.effortHigh");
      case "xhigh":
        return t("apply.effortXhigh");
      case "max":
        return t("apply.effortMax");
      default:
        return value;
    }
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
        targets: ["codex"],
        modelId,
        codexWriteAllModels: writeAllModels,
        catalogModelIds: writeAllModels ? catalogIds : null,
        codexReasoningEffort: reasoning ?? null,
        codexReasoningLevels: reasoningLevels,
        codexCapabilitySource: capabilitySource,
        codexRemoteCompaction: capabilitySource === "custom" ? codexFlags.compact : undefined,
        codexImageUnderstanding: capabilitySource === "custom" ? codexFlags.vision : undefined,
        codexImageGeneration: capabilitySource === "custom" ? codexFlags.imagegen : undefined,
        codexWebSearch: capabilitySource === "custom" ? codexFlags.search : undefined,
      });
      showApplyOutcome(
        modal,
        t,
        result.results.find((r) => r.target === "codex"),
      );
    } catch (e) {
      showApplyException(modal, t, e);
    }
  };

  const tool = toolFor(tools, "codex");

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
              onRevert={() => revert("codex")}
              onCleanupOrphan={() => cleanupOrphan("codex")}
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
                <div className="mt-1 text-xs opacity-50">{t("apply.codexModelHint")}</div>
              </div>
            </Space>
          )}
        </SettingsGroup>

        {site && (
          <>
            <SettingsGroup title={t("apply.groupCodexModels")}>
              <ModelCatalogSection
                title={t("apply.writeAllModels")}
                hint={t("apply.writeAllModelsHint")}
                models={models}
                loading={modelsLoading}
                writeAll={writeAllModels}
                onWriteAllChange={setWriteAllModels}
                selectedIds={catalogIds}
                onSelectedIdsChange={setCatalogIds}
                defaultModelId={modelId}
              />
            </SettingsGroup>

            <SettingsGroup title={t("apply.groupReasoning")}>
              <ReasoningLevelFields
                levels={reasoningLevels}
                onLevelsChange={(levels) => setReasoningLevels(levels as CodexReasoningEffort[])}
                defaultLevel={reasoning}
                onDefaultLevelChange={(level) => setReasoning(level as CodexReasoningEffort | undefined)}
                allowed={CODEX_EFFORT_LIST}
                levelLabel={effortLabel}
                defaultLabel={t("apply.reasoningEffort")}
                defaultHint={t("apply.reasoningHint")}
                variantsHint={t("apply.codexReasoningVariantsHint")}
              />
            </SettingsGroup>

            <SettingsGroup title={t("apply.groupCodexCapabilities")}>
              <div style={rowStyle}>
                <div className="mb-1 text-sm opacity-70">{t("apply.capabilitySource")}</div>
                <Select
                  className="w-full"
                  value={capabilitySource}
                  onChange={(value) => {
                    const next = value as CodexCapabilitySource;
                    setCapabilitySource(next);
                    if (next === "custom") {
                      setCodexFlags(codexFlagsFromCapabilities(site.capabilities));
                    }
                  }}
                  options={[
                    { value: "site", label: t("apply.capabilityFollowSite") },
                    { value: "custom", label: t("apply.capabilityCustom") },
                  ]}
                />
                <div className="mt-1 text-xs opacity-50">
                  {capabilitySource === "site"
                    ? t("apply.capabilityFollowHint")
                    : t("apply.capabilityCustomHint")}
                </div>
              </div>
              {capabilitySource === "site" ? (
                <div className="mt-3 text-xs opacity-50">
                  {summarizeCodexCapabilities(codexFlagsFromCapabilities(site.capabilities))
                    .map(({ key, on }) => {
                      const title =
                        key === "codex-compact"
                          ? t("apply.remoteCompaction")
                          : key === "codex-vision"
                            ? t("apply.imageUnderstanding")
                            : key === "codex-imagegen"
                              ? t("apply.imageGeneration")
                              : t("apply.webSearch");
                      return `${title}${on ? t("apply.capabilityOn") : t("apply.capabilityOff")}`;
                    })
                    .join(" · ")}
                </div>
              ) : (
                <>
                  <Divider style={{ margin: "12px 0 8px" }} />
                  <CodexCapabilitySwitchList value={codexFlags} onChange={setCodexFlags} />
                </>
              )}
            </SettingsGroup>
          </>
        )}
      </div>

      <ApplyFooter
        target="codex"
        loading={applying}
        disabled={!modelId}
        onApply={() => void handleApply()}
        onRestoreOfficial={() => restoreOfficial("codex")}
      />
    </div>
  );
});
