import { useMemo, useState } from "react";
import { App, Button, Dropdown, Spin, theme } from "antd";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Site } from "@/types/domain";
import { useSettingsStore, useSiteStore } from "@/stores";
import { isAppError } from "@/lib/invoke";
import { siteBaseUrls } from "@/lib/urlNormalize";
import {
  colorForLatency,
  formatLatency,
  getCachedProbe,
  probeUrls,
  urlsNeedingProbe,
  type ProbeColor,
  type ProbeEntry,
} from "@/lib/routeProbe";

interface Props {
  site: Site;
}

const TOKEN_COLOR: Record<ProbeColor, "colorSuccess" | "colorWarning" | "colorError"> = {
  green: "colorSuccess",
  yellow: "colorWarning",
  red: "colorError",
};

export function SiteRouteSwitcher({ site }: Props) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { message, modal } = App.useApp();
  const switchRoute = useSiteStore((s) => s.switchRoute);
  const ttl = useSettingsStore((s) => s.settings.routeProbeTtlMinutes);
  const urls = useMemo(() => siteBaseUrls(site), [site]);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [probing, setProbing] = useState(false);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [tick, setTick] = useState(0);

  const runProbe = async (targets: string[], force: boolean) => {
    const list = force ? targets : urlsNeedingProbe(targets, ttl);
    if (list.length === 0) {
      setTick((n) => n + 1);
      return;
    }
    setProbing(true);
    setPending(new Set(list));
    try {
      await probeUrls(list);
      setTick((n) => n + 1);
    } catch (e) {
      message.error(isAppError(e) ? e.message : String(e));
    } finally {
      setPending(new Set());
      setProbing(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void runProbe(urls, false);
  };

  const applySwitch = async (url: string, apply: boolean) => {
    try {
      const result = await switchRoute(site.id, url, { apply });
      const failed = result.results.filter((r) => !r.ok);
      if (!apply) {
        message.success(t("sites.routeSwitchSkipped"));
      } else if (failed.length > 0) {
        message.warning(t("sites.routeSwitchPartial"));
      } else if (result.results.length > 0) {
        message.success(t("sites.routeSwitchSuccess"));
      } else {
        message.success(t("sites.routeSwitchSiteOnly"));
      }
    } catch (e) {
      message.error(isAppError(e) ? e.message : String(e));
    }
  };

  const handleSelect = (url: string) => {
    if (url === site.baseUrl) {
      setOpen(false);
      return;
    }
    setOpen(false);
    const dlg = modal.confirm({
      centered: true,
      title: t("sites.routeSwitchTitle"),
      content: t("sites.routeSwitchHint"),
      footer: (
        <div className="flex justify-end gap-2">
          <Button onClick={() => dlg.destroy()}>{t("common.cancel")}</Button>
          <Button
            onClick={() => {
              dlg.destroy();
              void applySwitch(url, false);
            }}
          >
            {t("sites.routeSwitchSkip")}
          </Button>
          <Button
            type="primary"
            onClick={() => {
              dlg.destroy();
              void applySwitch(url, true);
            }}
          >
            {t("common.confirm")}
          </Button>
        </div>
      ),
    });
  };

  const colorOf = (entry: ProbeEntry | undefined): string | undefined => {
    if (!entry) return undefined;
    return token[TOKEN_COLOR[colorForLatency(entry.ok, entry.latencyMs)]];
  };

  const latencyLabel = (url: string, entry: ProbeEntry | undefined) => {
    if (pending.has(url)) return null;
    if (!entry) return null;
    if (!entry.ok) {
      return entry.latencyMs >= 8000 ? t("sites.probeTimeout") : t("sites.probeFailed");
    }
    return formatLatency(entry.latencyMs);
  };

  const panel = (
    <div
      className="min-w-[240px] overflow-hidden rounded-lg py-1"
      style={{
        background: token.colorBgElevated,
        boxShadow: token.boxShadowSecondary,
        border: `1px solid ${token.colorBorderSecondary}`,
        maxWidth: 360,
        ["--route-option-hover" as string]: token.colorFillTertiary,
        ["--route-option-active" as string]: token.colorPrimaryBg,
        ["--route-option-active-hover" as string]: token.colorPrimaryBgHover,
      }}
    >
      {urls.map((url) => {
        const entry = getCachedProbe(url);
        void tick;
        const active = url === site.baseUrl;
        const label = latencyLabel(url, entry);
        return (
          <button
            key={url}
            type="button"
            className="route-option flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs"
            data-active={active ? "true" : "false"}
            style={{ color: token.colorText }}
            onClick={() => handleSelect(url)}
          >
            <span className="inline-flex w-3.5 shrink-0" style={{ color: token.colorPrimary }}>
              {active ? <Check size={12} /> : null}
            </span>
            <span className="min-w-0 flex-1 break-all">{url}</span>
            <span className="shrink-0 tabular-nums" style={{ color: colorOf(entry) }}>
              {pending.has(url) ? <Spin size="small" /> : label}
            </span>
          </button>
        );
      })}
      <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}` }} className="mt-1 pt-1">
        <Button
          type="text"
          size="small"
          block
          className="cursor-pointer"
          loading={probing}
          icon={<RefreshCw size={12} />}
          onClick={(e) => {
            e.stopPropagation();
            void runProbe(urls, true);
          }}
        >
          {t("sites.probeRoutes")}
        </Button>
      </div>
    </div>
  );

  return (
    <Dropdown
      open={open}
      onOpenChange={handleOpenChange}
      trigger={["click"]}
      popupRender={() => panel}
      destroyOnHidden
    >
      <button
        type="button"
        className="inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 text-left"
        aria-label={t("sites.switchRoute")}
        style={{ color: token.colorText }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <span
          className="min-w-0 break-all"
          style={{
            borderBottom: `1px dashed ${hover || open ? token.colorPrimary : token.colorTextSecondary}`,
            paddingBottom: 1,
          }}
        >
          {site.baseUrl}
        </span>
        <ChevronDown size={14} className="shrink-0" style={{ color: token.colorTextTertiary }} />
      </button>
    </Dropdown>
  );
}
