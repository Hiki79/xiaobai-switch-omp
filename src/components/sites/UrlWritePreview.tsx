import { Popover, theme } from "antd";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { normalizeBaseUrl } from "@/lib/urlNormalize";

export function UrlWritePreviewIcon({ baseUrl }: { baseUrl: string }) {
  const { t } = useTranslation();
  const { token } = theme.useToken();

  let preview: ReturnType<typeof normalizeBaseUrl> | null = null;
  try {
    if (baseUrl.trim()) preview = normalizeBaseUrl(baseUrl);
  } catch {
    preview = null;
  }

  const rows = preview
    ? [
        { label: t("sites.modelsUrl"), value: preview.modelsUrl },
        { label: t("sites.claudeUrl"), value: preview.claudeBaseUrl },
        { label: t("sites.codexUrl"), value: preview.codexBaseUrl },
      ]
    : [];

  const content = (
    <div style={{ maxWidth: 360 }}>
      <div className="mb-2 text-xs font-medium" style={{ color: token.colorTextSecondary }}>
        {t("sites.urlPreview")}
      </div>
      {preview ? (
        <div className="space-y-1.5 text-xs">
          {rows.map((r) => (
            <div key={r.label}>
              <div style={{ color: token.colorTextSecondary }}>{r.label}</div>
              <code className="break-all" style={{ color: token.colorText, fontSize: 11 }}>
                {r.value}
              </code>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs" style={{ color: token.colorTextSecondary }}>
          {t("sites.urlPreviewEmpty")}
        </div>
      )}
    </div>
  );

  return (
    <Popover content={content} trigger="hover" placement="topLeft" mouseEnterDelay={0.15}>
      <span
        role="img"
        aria-label={t("sites.urlPreview")}
        className="inline-flex cursor-help items-center"
        style={{
          color: preview ? token.colorPrimary : token.colorTextQuaternary,
          verticalAlign: "middle",
        }}
        onClick={(e) => e.preventDefault()}
      >
        <Info size={14} />
      </span>
    </Popover>
  );
}
