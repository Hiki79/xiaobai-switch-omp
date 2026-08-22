import { memo, useMemo } from "react";
import { Select } from "antd";
import { useTranslation } from "react-i18next";

const rowStyle: React.CSSProperties = { padding: "4px 0" };

interface ReasoningLevelFieldsProps {
  /** 可用等级列表（已选值）。 */
  levels: string[];
  onLevelsChange: (levels: string[]) => void;
  defaultLevel: string | undefined;
  onDefaultLevelChange: (level: string | undefined) => void;
  /** 提供时限定为目标 CLI 接受的取值（multiple 选择）；缺省为自由字符串（ZCode tags）。 */
  allowed?: readonly string[];
  /** 等级显示名（如 Codex 的 Extra High）。 */
  levelLabel?: (value: string) => string;
  /** 「默认思考等级」标题。 */
  defaultLabel: string;
  /** 「默认思考等级」说明。 */
  defaultHint: string;
  /** 「可用等级」说明。 */
  variantsHint: string;
}

function pickDefaultLevel(levels: string[], current?: string): string | undefined {
  if (current && levels.includes(current)) return current;
  return levels.find((level) => level.toLowerCase() === "max") ?? levels[0];
}

/** Shared thinking-level picker in the ZCode style: 默认思考等级 + 可用等级 tags. */
export const ReasoningLevelFields = memo(function ReasoningLevelFields({
  levels,
  onLevelsChange,
  defaultLevel,
  onDefaultLevelChange,
  allowed,
  levelLabel,
  defaultLabel,
  defaultHint,
  variantsHint,
}: ReasoningLevelFieldsProps) {
  const { t } = useTranslation();

  const defaultOptions = useMemo(
    () =>
      levels.map((level) => ({
        value: level,
        label: levelLabel ? levelLabel(level) : level,
      })),
    [levels, levelLabel],
  );

  const handleLevelsChange = (values: string[]) => {
    let next: string[];
    if (allowed) {
      const allowSet = new Set(allowed);
      next = values.filter((value) => allowSet.has(value));
    } else {
      next = values.map((value) => value.trim()).filter(Boolean);
    }
    onLevelsChange(next);
    const nextDefault = pickDefaultLevel(next, defaultLevel);
    if (nextDefault !== defaultLevel) onDefaultLevelChange(nextDefault);
  };

  const allowedOptions = useMemo(
    () =>
      allowed
        ? allowed.map((level) => ({ value: level, label: levelLabel ? levelLabel(level) : level }))
        : undefined,
    [allowed, levelLabel],
  );

  return (
    <div style={rowStyle}>
      <div className="mb-1 text-sm opacity-70">{defaultLabel}</div>
      <Select
        className="w-full"
        value={defaultLevel}
        options={defaultOptions}
        onChange={(value) => onDefaultLevelChange(value)}
        disabled={levels.length === 0}
        placeholder={defaultLabel}
      />
      <div className="mt-1 text-xs opacity-50">{defaultHint}</div>
      <div className="mt-4" style={rowStyle}>
        <div className="mb-1 text-sm opacity-70">{t("apply.reasoningVariants")}</div>
        <Select
          className="w-full"
          mode={allowed ? "multiple" : "tags"}
          value={levels}
          onChange={(values) => handleLevelsChange(values as string[])}
          options={allowedOptions}
          tokenSeparators={allowed ? undefined : [",", " "]}
          placeholder={
            allowed ? t("apply.reasoningVariantsSelectPlaceholder") : t("apply.reasoningVariantsPlaceholder")
          }
        />
        <div className="mt-1 text-xs opacity-50">{variantsHint}</div>
      </div>
    </div>
  );
});
