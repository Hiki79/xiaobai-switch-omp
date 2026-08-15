import { useEffect, useState } from "react";
import { Avatar, theme } from "antd";
import { Loader2 } from "lucide-react";
import {
  getCachedSiteIcon,
  originFromBaseUrl,
  resolveSiteIcon,
  subscribeSiteIconCache,
} from "@/lib/siteIcon";

interface Props {
  siteId: string;
  name: string;
  baseUrl: string;
  size?: number;
  className?: string;
}

function letterFromName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  return trimmed.charAt(0).toUpperCase();
}

export function SiteAvatar({ siteId, name, baseUrl, size = 28, className }: Props) {
  const { token } = theme.useToken();
  const origin = originFromBaseUrl(baseUrl);
  const [iconUrl, setIconUrl] = useState<string | null>(() =>
    origin ? (getCachedSiteIcon(siteId, origin) ?? null) : null,
  );
  const [loading, setLoading] = useState(() => {
    if (!origin) return false;
    return getCachedSiteIcon(siteId, origin) === undefined;
  });
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    return subscribeSiteIconCache(() => {
      if (!origin) return;
      const cached = getCachedSiteIcon(siteId, origin);
      if (cached === undefined) {
        setIconUrl(null);
        setBroken(false);
        setLoading(true);
        return;
      }
      setIconUrl(cached);
      setBroken(false);
      setLoading(false);
    });
  }, [siteId, origin]);

  useEffect(() => {
    if (!origin) {
      setIconUrl(null);
      setLoading(false);
      setBroken(false);
      return;
    }
    const cached = getCachedSiteIcon(siteId, origin);
    if (cached !== undefined) {
      setIconUrl(cached);
      setLoading(false);
      setBroken(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setBroken(false);
    setIconUrl(null);
    void resolveSiteIcon(siteId, baseUrl).then((url) => {
      if (cancelled) return;
      setIconUrl(url);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [siteId, baseUrl, origin]);

  const letter = letterFromName(name);
  const host = origin ? new URL(origin).hostname : name;
  const src = !broken && iconUrl ? iconUrl : undefined;

  return (
    <span title={host} className={className} style={{ display: "inline-flex", flexShrink: 0 }}>
      {loading ? (
        <Avatar
          size={size}
          style={{
            backgroundColor: token.colorFillSecondary,
            color: token.colorTextTertiary,
          }}
          icon={<Loader2 size={Math.max(12, Math.round(size * 0.45))} className="animate-spin" />}
        />
      ) : src ? (
        <Avatar
          size={size}
          src={src}
          alt={host}
          style={{ backgroundColor: token.colorFillSecondary }}
          onError={() => {
            setBroken(true);
            return false;
          }}
        >
          {letter}
        </Avatar>
      ) : (
        <Avatar
          size={size}
          style={{
            backgroundColor: token.colorPrimaryBg,
            color: token.colorPrimary,
            fontWeight: 600,
          }}
        >
          {letter}
        </Avatar>
      )}
    </span>
  );
}
