import { Divider, Switch } from "antd";
import { useTranslation } from "react-i18next";
import type { CodexCapabilityFlags } from "@/lib/siteCapabilities";

const rowStyle: React.CSSProperties = { padding: "4px 0" };

interface Props {
  value: CodexCapabilityFlags;
  onChange: (next: CodexCapabilityFlags) => void;
}

export function CodexCapabilitySwitchList({ value, onChange }: Props) {
  const { t } = useTranslation();

  const row = (
    key: keyof CodexCapabilityFlags,
    titleKey: string,
    hintKey: string,
    divider: boolean,
  ) => (
    <div key={key}>
      {divider ? <Divider style={{ margin: "8px 0" }} /> : null}
      <div style={rowStyle} className="flex items-center justify-between gap-4">
        <div>
          <div>{t(titleKey)}</div>
          <div className="text-xs opacity-50">{t(hintKey)}</div>
        </div>
        <Switch checked={value[key]} onChange={(checked) => onChange({ ...value, [key]: checked })} />
      </div>
    </div>
  );

  return (
    <>
      {row("compact", "apply.remoteCompaction", "apply.remoteCompactionHint", false)}
      {row("vision", "apply.imageUnderstanding", "apply.imageUnderstandingHint", true)}
      {row("imagegen", "apply.imageGeneration", "apply.imageGenerationHint", true)}
      {row("search", "apply.webSearch", "apply.webSearchHint", true)}
    </>
  );
}
