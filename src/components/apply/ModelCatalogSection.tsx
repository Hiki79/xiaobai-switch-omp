import { memo, useMemo, useState } from "react";
import { Button, Checkbox, Divider, Input, Skeleton, Space, Switch, Tag } from "antd";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SiteModel } from "@/types/domain";

const rowStyle: React.CSSProperties = { padding: "4px 0" };
const LIST_MAX_HEIGHT = 240;

interface ModelCatalogSectionProps {
  /** Switch 标题，如 apply.ompWriteAllModels */
  title: string;
  /** Switch 副标题，如 apply.ompWriteAllModelsHint */
  hint: string;
  models: SiteModel[];
  loading: boolean;
  writeAll: boolean;
  onWriteAllChange: (value: boolean) => void;
  /** 勾选待写入的模型 id（默认模型始终写入，无需包含在内）。 */
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  /** 当前默认模型 id，列表中会打标且不可取消。 */
  defaultModelId?: string;
}

/** Shared "write site models" picker: switch + searchable checkbox list. */
export const ModelCatalogSection = memo(function ModelCatalogSection({
  title,
  hint,
  models,
  loading,
  writeAll,
  onWriteAllChange,
  selectedIds,
  onSelectedIdsChange,
  defaultModelId,
}: ModelCatalogSectionProps) {
  const { t } = useTranslation();
  const [keyword, setKeyword] = useState("");

  const normalizedKeyword = keyword.trim().toLowerCase();
  const visibleModels = useMemo(() => {
    if (!normalizedKeyword) return models;
    return models.filter(
      (model) =>
        model.modelId.toLowerCase().includes(normalizedKeyword) ||
        (model.displayName ?? "").toLowerCase().includes(normalizedKeyword),
    );
  }, [models, normalizedKeyword]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectableModels = visibleModels.filter((model) => model.modelId !== defaultModelId);

  const toggle = (id: string, checked: boolean) => {
    if (id === defaultModelId) return;
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedIdsChange(models.filter((model) => next.has(model.modelId)).map((m) => m.modelId));
  };

  const setAllVisible = (checked: boolean) => {
    const next = new Set(selected);
    for (const model of selectableModels) {
      if (checked) next.add(model.modelId);
      else next.delete(model.modelId);
    }
    onSelectedIdsChange(models.filter((model) => next.has(model.modelId)).map((m) => m.modelId));
  };

  return (
    <>
      <div style={rowStyle} className="flex items-center justify-between gap-4">
        <div>
          <div>{title}</div>
          <div className="text-xs opacity-50">{hint}</div>
        </div>
        <Switch checked={writeAll} onChange={onWriteAllChange} />
      </div>
      {writeAll && (
        <>
          <Divider style={{ margin: "8px 0" }} />
          {loading && models.length === 0 ? (
            <Skeleton active paragraph={{ rows: 2 }} title={false} />
          ) : models.length === 0 ? (
            <div className="text-xs opacity-60">{t("apply.modelEmpty")}</div>
          ) : (
            <Space orientation="vertical" size="small" className="w-full">
              <Input
                allowClear
                size="small"
                prefix={<Search size={14} className="opacity-50" />}
                placeholder={t("apply.modelSearchPlaceholder")}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
              <div className="flex items-center justify-between">
                <span className="text-xs opacity-60">
                  {t("apply.modelSelectedCount", { selected: selectedIds.length, total: models.length })}
                </span>
                <Space size="small">
                  <Button type="link" size="small" className="px-1 py-0" onClick={() => setAllVisible(true)}>
                    {t("apply.modelSelectAll")}
                  </Button>
                  <Button type="link" size="small" className="px-1 py-0" onClick={() => setAllVisible(false)}>
                    {t("apply.modelClear")}
                  </Button>
                </Space>
              </div>
              <div
                className="flex flex-col gap-1 overflow-y-auto pr-1"
                style={{ maxHeight: LIST_MAX_HEIGHT }}
              >
                {visibleModels.length === 0 && (
                  <div className="text-xs opacity-60">{t("apply.modelSearchEmpty")}</div>
                )}
                {visibleModels.map((model) => {
                  const isDefault = model.modelId === defaultModelId;
                  return (
                    <label
                      key={model.modelId}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm"
                    >
                      <Checkbox
                        checked={isDefault || selected.has(model.modelId)}
                        disabled={isDefault}
                        onChange={(e) => toggle(model.modelId, e.target.checked)}
                      />
                      <span className="min-w-0 truncate">
                        {model.displayName && model.displayName !== model.modelId
                          ? `${model.displayName} (${model.modelId})`
                          : model.modelId}
                      </span>
                      {isDefault && <Tag className="m-0">{t("apply.defaultModelTag")}</Tag>}
                    </label>
                  );
                })}
              </div>
            </Space>
          )}
        </>
      )}
    </>
  );
});
