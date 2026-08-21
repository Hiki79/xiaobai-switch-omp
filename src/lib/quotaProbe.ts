import { invoke } from "@/lib/invoke";
import type { Site, SiteQuota } from "@/types/domain";

export const QUOTA_TTL_MS = 5 * 60 * 1000;

export async function probeSiteQuota(siteId: string): Promise<SiteQuota> {
  return invoke<SiteQuota>("probe_site_quota", { siteId });
}

export function quotaCacheKey(site: Pick<Site, "id" | "baseUrl" | "keyPrefix">): string {
  return `${site.id}:${site.baseUrl}:${site.keyPrefix}`;
}

export function isQuotaCacheFresh(quota: SiteQuota, now = Date.now()): boolean {
  return now - quota.fetchedAt < QUOTA_TTL_MS;
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function normalizeQuotaUnit(unit: string | null | undefined): string {
  const raw = (unit ?? "USD").trim().toUpperCase();
  if (raw === "RMB" || raw === "CNY" || raw === "¥" || raw === "元") return "CNY";
  if (raw === "$" || raw === "USD") return "USD";
  return raw || "USD";
}

export function formatQuotaAmount(amount: number, unit?: string | null): string {
  const normalized = normalizeQuotaUnit(unit);
  if (normalized === "CNY") {
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: "CNY",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  }
  if (normalized === "USD") return formatUsd(amount);
  return `${new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)} ${normalized}`;
}

export function shouldShowExpiry(
  expiresAt: number | null,
  nowSec = Date.now() / 1000,
): boolean {
  if (expiresAt == null || !Number.isFinite(expiresAt) || expiresAt <= nowSec) {
    return false;
  }
  return new Date(expiresAt * 1000).getUTCFullYear() < 2099;
}

export function formatExpiryDate(expiresAt: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(expiresAt * 1000));
}

export function quotaRemainingPercent(quota: SiteQuota): number | null {
  if (quota.unlimited || quota.totalUsd == null || quota.totalUsd <= 0) return null;
  const remaining =
    quota.remainingUsd ??
    (quota.usedUsd != null ? quota.totalUsd - quota.usedUsd : null);
  if (remaining == null) return null;
  return Math.max(0, Math.min(100, (remaining / quota.totalUsd) * 100));
}

export type QuotaTone = "ok" | "warn" | "danger";

export function quotaTone(quota: SiteQuota): QuotaTone {
  const remaining = quota.remainingUsd;
  if (remaining == null) return "ok";
  if (remaining <= 0) return "danger";
  if (remaining < 1) return "warn";
  if (quota.totalUsd != null && quota.totalUsd > 0 && remaining / quota.totalUsd < 0.1) {
    return "warn";
  }
  return "ok";
}

export function emptyUnsupportedQuota(): SiteQuota {
  return {
    status: "unsupported",
    remainingUsd: null,
    usedUsd: null,
    totalUsd: null,
    unlimited: false,
    unit: null,
    expiresAt: null,
    source: null,
    endpoint: null,
    fetchedAt: Date.now(),
    latencyMs: 0,
    error: null,
  };
}
