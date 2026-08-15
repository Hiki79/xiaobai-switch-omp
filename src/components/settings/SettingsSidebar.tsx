import { Menu, theme } from "antd";
import { ArrowLeft, Database, FolderOpen, Globe, Info, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore, type SettingsSection } from "@/stores/uiStore";

const MENU_ICONS: Record<SettingsSection, React.ReactNode> = {
  general: <Settings size={16} />,
  network: <Globe size={16} />,
  paths: <FolderOpen size={16} />,
  backup: <Database size={16} />,
  about: <Info size={16} />,
};

const SECTION_KEYS: SettingsSection[] = ["general", "network", "paths", "backup", "about"];

export function SettingsSidebar() {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const settingsTab = useUIStore((s) => s.settingsTab);
  const setSettingsTab = useUIStore((s) => s.setSettingsTab);
  const setPage = useUIStore((s) => s.setPage);

  const items = SECTION_KEYS.map((key) => ({
    key,
    icon: MENU_ICONS[key],
    label: t(`settings.${key}`),
  }));

  return (
    <div className="flex h-full flex-col" style={{ backgroundColor: token.colorBgContainer, overflowY: "auto" }}>
      <div
        className="flex shrink-0 cursor-pointer items-center gap-2"
        style={{
          color: token.colorTextSecondary,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          paddingLeft: 26,
          paddingRight: 16,
          paddingTop: 12,
          paddingBottom: 12,
        }}
        onClick={() => setPage("sites")}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = token.colorText;
          e.currentTarget.style.backgroundColor = token.colorFillSecondary;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = token.colorTextSecondary;
          e.currentTarget.style.backgroundColor = "transparent";
        }}
      >
        <ArrowLeft size={16} />
        <span style={{ fontSize: 14 }}>{t("common.back")}</span>
        <span
          style={{
            fontSize: 11,
            color: token.colorTextQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 4,
            padding: "1px 6px",
            marginLeft: 4,
            lineHeight: "16px",
          }}
        >
          Esc
        </span>
      </div>
      <div className="flex-1 pt-1" style={{ overflowY: "auto" }}>
        <Menu
          mode="inline"
          selectedKeys={[settingsTab]}
          items={items}
          style={{ borderInlineEnd: "none" }}
          styles={{ item: { height: 44, lineHeight: "44px" } }}
          onClick={({ key }) => setSettingsTab(key as SettingsSection)}
        />
      </div>
    </div>
  );
}
