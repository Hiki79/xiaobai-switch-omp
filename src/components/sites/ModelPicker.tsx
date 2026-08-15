import { useEffect, useMemo, useState } from "react";
import { App, Button, Input, Tag, theme } from "antd";
import { Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Site, SiteModel } from "@/types/domain";
import { useSiteStore } from "@/stores";
import { isAppError } from "@/lib/invoke";

interface Props {
  site: Site;
  models: SiteModel[];
  /** Hide the fetch button when parent already places it in the header. */
  showFetchButton?: boolean;
  onAddManual?: () => void;
  onFetch?: () => void | Promise<void>;
}

export function ModelPicker({
  site,
  models: modelsProp,
  showFetchButton = false,
  onAddManual,
  onFetch,
}: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message, modal } = App.useApp();
  const fetchModels = useSiteStore((s) => s.fetchModels);
  const setSelectedModel = useSiteStore((s) => s.setSelectedModel);
  const deleteModel = useSiteStore((s) => s.deleteModel);
  const clearModels = useSiteStore((s) => s.clearModels);
  const fetching = useSiteStore((s) => s.fetchingModels);
  const [query, setQuery] = useState("");
  const [clearing, setClearing] = useState(false);
  const modelsFromStore = useSiteStore((s) => s.modelsBySite[site.id]);
  const models = modelsFromStore ?? modelsProp;

  // Default primary model to the first fetched model.
  useEffect(() => {
    if (site.selectedModelId || models.length === 0) return;
    void setSelectedModel(site.id, models[0].modelId);
  }, [site.id, site.selectedModelId, models, setSelectedModel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => {
      const name = (m.displayName || m.modelId).toLowerCase();
      return name.includes(q) || m.modelId.toLowerCase().includes(q);
    });
  }, [models, query]);

  const handleFetch = async () => {
    if (onFetch) {
      await onFetch();
      return;
    }
    try {
      const result = await fetchModels(site.id);
      if (!site.selectedModelId && result.models[0]) {
        await setSelectedModel(site.id, result.models[0].modelId);
      }
    } catch (e) {
      message.error(isAppError(e) ? e.message : String(e));
    }
  };

  const handleDelete = async (modelId: string) => {
    try {
      await deleteModel(site.id, modelId);
    } catch (e) {
      message.error(isAppError(e) ? e.message : String(e));
    }
  };

  const handleClear = () => {
    modal.confirm({
      title: t("sites.clearModelsConfirm"),
      content: t("sites.clearModelsHint"),
      centered: true,
      okText: t("common.confirm"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        setClearing(true);
        try {
          await clearModels(site.id);
          message.success(t("sites.clearModelsSuccess"));
        } catch (e) {
          message.error(isAppError(e) ? e.message : String(e));
          throw e;
        } finally {
          setClearing(false);
        }
      },
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium" style={{ color: token.colorText }}>
          {t("sites.selectModel")}
        </span>
        {site.selectedModelId && (
          <span className="text-xs font-normal" style={{ color: token.colorTextSecondary }}>
            {t("sites.currentModel", { model: site.selectedModelId })}
          </span>
        )}
        {onAddManual && (
          <Button size="small" icon={<Plus size={12} />} onClick={onAddManual}>
            {t("sites.manualModel")}
          </Button>
        )}
        <Button
          size="small"
          danger
          disabled={models.length === 0}
          loading={clearing}
          onClick={handleClear}
        >
          {t("sites.clearModels")}
        </Button>
        {showFetchButton && (
          <Button size="small" loading={fetching} onClick={() => void handleFetch()}>
            {fetching ? t("sites.fetching") : t("sites.fetchModels")}
          </Button>
        )}
      </div>

      {site.lastModelFetchLatencyMs != null && (
        <div className="shrink-0 text-xs" style={{ color: token.colorTextSecondary }}>
          {t("sites.latency", { ms: site.lastModelFetchLatencyMs })}
          {models.length > 0 ? ` · ${t("sites.modelCount", { count: models.length })}` : ""}
        </div>
      )}

      {site.lastModelFetchError && (
        <div className="shrink-0 text-xs text-red-500">
          {t("sites.lastError", { error: site.lastModelFetchError })}
        </div>
      )}

      <div className="shrink-0">
        <Input.Search
          allowClear
          placeholder={t("sites.modelSearch")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div
        data-model-list
        className="scroll-y min-h-0 flex-1"
        style={{ minHeight: 160 }}
      >
        {filtered.length === 0 ? (
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-3 px-4 py-6 text-center">
            <span className="text-sm" style={{ color: token.colorTextSecondary }}>
              {models.length === 0 ? t("sites.noModels") : t("sites.noModelsMatch")}
            </span>
            {models.length === 0 && (
              <Button
                type="primary"
                size="small"
                icon={<RefreshCw size={14} />}
                loading={fetching}
                onClick={() => void handleFetch()}
              >
                {fetching ? t("sites.fetching") : t("sites.fetchModels")}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap content-start gap-2">
            {filtered.map((m) => {
              const selected = site.selectedModelId === m.modelId;
              const label = m.displayName || m.modelId;
              return (
                <Tag
                  key={m.id || m.modelId}
                  closable
                  color={selected ? "processing" : undefined}
                  style={{
                    cursor: "pointer",
                    marginInlineEnd: 0,
                    fontSize: 14,
                    lineHeight: "22px",
                    paddingInline: 11,
                    paddingBlock: 5,
                    borderColor: selected ? token.colorPrimary : undefined,
                    userSelect: "none",
                  }}
                  onClick={() => void setSelectedModel(site.id, m.modelId)}
                  onClose={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleDelete(m.modelId);
                  }}
                  title={m.modelId}
                >
                  {label}
                </Tag>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
