import { Button, Progress, Skeleton, Tooltip, theme } from "antd";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SiteQuota } from "@/types/domain";
import {
  formatExpiryDate,
  formatQuotaAmount,
  quotaRemainingPercent,
  quotaTone,
  shouldShowExpiry,
} from "@/lib/quotaProbe";

interface Props {
  quota: SiteQuota | null;
  loading: boolean;
  refreshing?: boolean;
  onRefresh: () => void;
}

export function SiteQuotaRow({ quota, loading, refreshing, onRefresh }: Props) {
  const { t, i18n } = useTranslation();
  const { token } = theme.useToken();

  if (loading && quota?.status !== "available") {
    return (
      <div className="flex gap-2" data-testid="site-quota-loading">
        <span className="w-28 shrink-0 opacity-50">{t("sites.quota")}</span>
        <Skeleton.Input active size="small" style={{ width: 180, minWidth: 180, height: 18 }} />
      </div>
    );
  }

  if (quota?.status !== "available") return null;

  const tone = quotaTone(quota);
  const percent = quotaRemainingPercent(quota);
  const stroke =
    tone === "danger"
      ? token.colorError
      : tone === "warn"
        ? token.colorWarning
        : token.colorPrimary;

  const money = (n: number) => formatQuotaAmount(n, quota.unit);
  const primary = quota.unlimited
    ? t("sites.quotaUnlimited")
    : quota.remainingUsd != null
      ? t("sites.quotaRemaining", { amount: money(quota.remainingUsd) })
      : quota.usedUsd != null
        ? t("sites.quotaUsed", { amount: money(quota.usedUsd) })
        : quota.totalUsd != null
          ? money(quota.totalUsd)
          : t("sites.quotaUnlimited");

  let secondary: string | null = null;
  if (!quota.unlimited && quota.usedUsd != null && quota.totalUsd != null) {
    secondary = t("sites.quotaUsedOfTotal", {
      used: money(quota.usedUsd),
      total: money(quota.totalUsd),
    });
  } else if (quota.unlimited && quota.usedUsd != null) {
    secondary = t("sites.quotaUsed", { amount: money(quota.usedUsd) });
  }

  const showExpiry = shouldShowExpiry(quota.expiresAt);
  const mins = Math.max(0, Math.round((Date.now() - quota.fetchedAt) / 60_000));
  const updated =
    mins < 1
      ? t("sites.quotaUpdatedJustNow")
      : t("sites.quotaUpdated", { time: t("sites.quotaMinutesAgo", { count: mins }) });

  return (
    <div className="flex gap-2" data-testid="site-quota-row">
      <span className="w-28 shrink-0 opacity-50">{t("sites.quota")}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate">{primary}</span>
          {secondary && (
            <>
              <span className="opacity-40">·</span>
              <span className="min-w-0 truncate opacity-70">{secondary}</span>
            </>
          )}
          <Tooltip title={t("sites.quotaRefresh")}>
            <Button
              type="text"
              size="small"
              loading={Boolean(refreshing)}
              icon={<RefreshCw size={14} />}
              onClick={onRefresh}
              aria-label={t("sites.quotaRefresh")}
            />
          </Tooltip>
        </div>
        {percent != null && (
          <Progress
            percent={percent}
            showInfo={false}
            size="small"
            strokeColor={stroke}
            style={{ marginBottom: 0, marginTop: 4 }}
          />
        )}
        <div className="mt-0.5 text-xs opacity-50">
          {showExpiry && quota.expiresAt != null && (
            <span>
              {t("sites.quotaExpires", {
                date: formatExpiryDate(quota.expiresAt, i18n.language),
              })}
            </span>
          )}
          {showExpiry && <span> · </span>}
          <span>{updated}</span>
        </div>
      </div>
    </div>
  );
}
