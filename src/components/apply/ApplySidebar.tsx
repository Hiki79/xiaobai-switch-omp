import { Menu, theme } from "antd";
import ClaudeCode from "@lobehub/icons/es/ClaudeCode";
import Codex from "@lobehub/icons/es/Codex";
import { useTranslation } from "react-i18next";
import { useUIStore, type ApplyTargetTab } from "@/stores/uiStore";

const TAB_KEYS: ApplyTargetTab[] = ["claude_code", "codex"];

const MENU_ICONS: Record<ApplyTargetTab, React.ReactNode> = {
  claude_code: <ClaudeCode size={16} />,
  codex: <Codex size={16} />,
};

export function ApplySidebar() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const applyTab = useUIStore((s) => s.applyTab);
  const setApplyTab = useUIStore((s) => s.setApplyTab);

  const items = TAB_KEYS.map((key) => ({
    key,
    icon: MENU_ICONS[key],
    label: key === "claude_code" ? t("apply.targetClaude") : t("apply.targetCodex"),
  }));

  return (
    <div className="flex h-full flex-col" style={{ backgroundColor: token.colorBgContainer, overflowY: "auto" }}>
      <div
        className="shrink-0"
        style={{
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          paddingLeft: 20,
          paddingRight: 16,
          paddingTop: 14,
          paddingBottom: 14,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: token.colorText }}>{t("apply.title")}</div>
        <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 2 }}>
          {t("apply.sidebarHint")}
        </div>
      </div>
      <div className="flex-1 pt-1" style={{ overflowY: "auto" }}>
        <Menu
          mode="inline"
          selectedKeys={[applyTab]}
          items={items}
          style={{ borderInlineEnd: "none" }}
          styles={{ item: { height: 44, lineHeight: "44px" } }}
          onClick={({ key }) => setApplyTab(key as ApplyTargetTab)}
        />
      </div>
    </div>
  );
}
