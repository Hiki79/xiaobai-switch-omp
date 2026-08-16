import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { theme } from "antd";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ModelTagProps {
  title: string;
  selected?: boolean;
  picked?: boolean;
  closable?: boolean;
  onClick?: () => void;
  onClose?: (e: MouseEvent) => void;
  children: ReactNode;
}

export function ModelTag({
  title,
  selected = false,
  picked = false,
  closable = false,
  onClick,
  onClose,
  children,
}: ModelTagProps) {
  const { t } = useTranslation();

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <span
      tabIndex={0}
      data-model-tag
      data-selected={selected ? "true" : "false"}
      data-picked={picked ? "true" : "false"}
      title={title}
      className="model-tag"
      onClick={onClick}
      onKeyDown={handleKeyDown}
    >
      {children}
      {closable && (
        <button
          type="button"
          className="model-tag-close"
          data-model-tag-close
          tabIndex={-1}
          aria-label={t("sites.deleteModel")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClose?.(e);
          }}
        >
          <X size={10} strokeWidth={2.25} />
        </button>
      )}
    </span>
  );
}

interface ModelCountBadgeProps {
  children: ReactNode;
}

export function ModelCountBadge({ children }: ModelCountBadgeProps) {
  const { token } = theme.useToken();
  return (
    <span
      data-model-count
      className="model-count-badge"
      style={{
        fontSize: token.fontSizeSM - 2,
        lineHeight: `${token.fontSizeSM + 2}px`,
        paddingInline: token.paddingXXS,
      }}
    >
      {children}
    </span>
  );
}
