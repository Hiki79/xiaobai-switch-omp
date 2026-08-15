export interface UrlWritePreview {
  modelsUrl: string;
  claudeBaseUrl: string;
  codexBaseUrl: string;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** Normalize base URL and derive models / Claude / Codex write values. */
export function normalizeBaseUrl(input: string): UrlWritePreview {
  let raw = input.trim();
  if (!raw) {
    throw new Error("empty_url");
  }
  if (/\s/.test(raw)) {
    throw new Error("invalid_url_whitespace");
  }

  // Drop fragment
  const hashIdx = raw.indexOf("#");
  if (hashIdx >= 0) raw = raw.slice(0, hashIdx);

  // MVP: strip query with warning caller can surface
  const qIdx = raw.indexOf("?");
  if (qIdx >= 0) raw = raw.slice(0, qIdx);

  let base = stripTrailingSlash(raw);

  // Strip /v1/messages or /messages
  if (/\/v1\/messages$/i.test(base)) {
    base = base.replace(/\/v1\/messages$/i, "/v1");
  } else if (/\/messages$/i.test(base)) {
    base = base.replace(/\/messages$/i, "");
  }
  base = stripTrailingSlash(base);

  const endsWithV1 = /\/v1$/i.test(base);

  const modelsUrl = endsWithV1 ? `${base}/models` : `${base}/v1/models`;
  const claudeBaseUrl = base;
  const codexBaseUrl = endsWithV1 ? base : `${base}/v1`;

  return { modelsUrl, claudeBaseUrl, codexBaseUrl };
}

/** Trim, drop empties, require http(s), dedupe preserving order. */
export function normalizeBaseUrls(urls: string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    const t = raw.trim();
    if (!t) continue;
    if (/\s/.test(t)) throw new Error("invalid_url_whitespace");
    if (!/^https?:\/\//i.test(t)) throw new Error("invalid_url_scheme");
    if (!out.includes(t)) out.push(t);
  }
  if (out.length === 0) throw new Error("empty_url");
  return out;
}

export function siteBaseUrls(site: { baseUrl: string; baseUrls?: string[] }): string[] {
  if (site.baseUrls && site.baseUrls.length > 0) return site.baseUrls;
  return site.baseUrl ? [site.baseUrl] : [];
}

export function keyPrefix(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 8) return `${apiKey.slice(0, 2)}…`;
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}
