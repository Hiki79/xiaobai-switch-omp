import { Button, Dropdown, theme } from "antd";
import type { MenuProps } from "antd";
import { Ellipsis, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Site } from "@/types/domain";
import { SiteAvatar } from "@/components/sites/SiteAvatar";

interface Props {
  site: Site;
  active: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function SiteListItem({ site, active, onSelect, onEdit, onDelete }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  const menu: MenuProps = {
    items: [
      {
        key: "edit",
        icon: <Pencil size={14} />,
        label: t("sites.edit"),
      },
      {
        key: "delete",
        icon: <Trash2 size={14} />,
        label: t("sites.delete"),
        danger: true,
      },
    ],
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      onSelect();
      if (key === "edit") onEdit();
      else if (key === "delete") onDelete();
    },
  };

  return (
    <Dropdown
      trigger={["contextMenu"]}
      destroyOnHidden
      menu={menu}
      onOpenChange={(open) => {
        if (open) onSelect();
      }}
    >
      <div
        className="site-list-item group flex w-full cursor-pointer items-center rounded-lg pr-0.5 transition-colors"
        data-active={active ? "true" : "false"}
        style={{
          background: active ? token.colorPrimaryBg : undefined,
          color: token.colorText,
          ["--site-item-bg" as string]: token.colorFillQuaternary,
          ["--site-item-hover" as string]: token.colorFillTertiary,
        }}
      >
        <button
          type="button"
          onClick={onSelect}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left"
        >
          <SiteAvatar siteId={site.id} name={site.name} baseUrl={site.baseUrl} size={28} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{site.name}</div>
            <div className="truncate text-xs opacity-50">{site.baseUrl}</div>
          </div>
        </button>
        <Dropdown trigger={["click"]} destroyOnHidden menu={menu} placement="bottomRight">
          <Button
            type="text"
            size="small"
            className="site-more-btn mr-0.5 shrink-0"
            icon={<Ellipsis size={16} />}
            aria-label={t("sites.moreActions")}
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
          />
        </Dropdown>
      </div>
    </Dropdown>
  );
}
