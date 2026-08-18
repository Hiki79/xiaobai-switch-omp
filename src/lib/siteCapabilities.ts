export const CODEX_COMPACT = "codex-compact";
export const CODEX_VISION = "codex-vision";
export const CODEX_IMAGEGEN = "codex-imagegen";
export const CODEX_SEARCH = "codex-search";

export const CODEX_CAPABILITY_KEYS = [
  CODEX_COMPACT,
  CODEX_VISION,
  CODEX_IMAGEGEN,
  CODEX_SEARCH,
] as const;

export type CodexCapabilityKey = (typeof CODEX_CAPABILITY_KEYS)[number];
export type SiteCapabilities = Record<string, boolean>;
export type CodexCapabilitySource = "site" | "custom";

export interface CodexCapabilityFlags {
  compact: boolean;
  vision: boolean;
  imagegen: boolean;
  search: boolean;
}

export const EMPTY_CODEX_FLAGS: CodexCapabilityFlags = {
  compact: false,
  vision: false,
  imagegen: false,
  search: false,
};

const RESERVED_QUERY_KEYS = new Set([
  "name",
  "baseurl",
  "baseurls",
  "apikey",
  "protocol",
  "type",
  "notes",
]);

const MAX_CAPABILITY_KEYS = 32;
const CAPABILITY_KEY_RE = /^[a-z][a-z0-9]{0,15}-[a-z0-9-]{1,48}$/;

const TRUE_TOKENS = new Set(["1", "true", "on", "yes"]);
const FALSE_TOKENS = new Set(["0", "false", "off", "no"]);

export function parseCapabilityFlag(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_TOKENS.has(normalized)) return true;
  if (FALSE_TOKENS.has(normalized)) return false;
  return false;
}

export function isCapabilityQueryKey(key: string): boolean {
  if (RESERVED_QUERY_KEYS.has(key.toLowerCase())) return false;
  return CAPABILITY_KEY_RE.test(key);
}

export function isCodexCapabilityKey(key: string): key is CodexCapabilityKey {
  return (CODEX_CAPABILITY_KEYS as readonly string[]).includes(key);
}

export function emptyCapabilities(): SiteCapabilities {
  return {};
}

export function capabilityOn(caps: SiteCapabilities | undefined, key: string): boolean {
  return Boolean(caps?.[key]);
}

export function anyCodexCapabilityOn(caps: SiteCapabilities | undefined): boolean {
  return CODEX_CAPABILITY_KEYS.some((key) => capabilityOn(caps, key));
}

export function codexFlagsFromCapabilities(
  caps: SiteCapabilities | undefined,
): CodexCapabilityFlags {
  return {
    compact: capabilityOn(caps, CODEX_COMPACT),
    vision: capabilityOn(caps, CODEX_VISION),
    imagegen: capabilityOn(caps, CODEX_IMAGEGEN),
    search: capabilityOn(caps, CODEX_SEARCH),
  };
}

export function capabilitiesFromCodexFlags(flags: CodexCapabilityFlags): SiteCapabilities {
  return {
    [CODEX_COMPACT]: flags.compact,
    [CODEX_VISION]: flags.vision,
    [CODEX_IMAGEGEN]: flags.imagegen,
    [CODEX_SEARCH]: flags.search,
  };
}

/** Keep unknown keys; replace the four known Codex keys from incoming (missing = false). */
export function mergeCodexCapabilities(
  existing: SiteCapabilities | undefined,
  incoming: SiteCapabilities,
): SiteCapabilities {
  const next: SiteCapabilities = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (!isCodexCapabilityKey(key)) next[key] = Boolean(value);
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (!isCodexCapabilityKey(key)) next[key] = Boolean(value);
  }
  for (const key of CODEX_CAPABILITY_KEYS) {
    next[key] = Boolean(incoming[key]);
  }
  return next;
}

export function capabilitiesEqual(
  a: SiteCapabilities | undefined,
  b: SiteCapabilities | undefined,
): boolean {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of keys) {
    if (Boolean(a?.[key]) !== Boolean(b?.[key])) return false;
  }
  return true;
}

export function parseCapabilitySource(raw: string | null | undefined): CodexCapabilitySource {
  return raw?.trim().toLowerCase() === "custom" ? "custom" : "site";
}

export interface ParsedCapabilityParams {
  capabilities: SiteCapabilities;
  present: boolean;
}

export function capabilitiesFromSearchParams(params: URLSearchParams): ParsedCapabilityParams {
  const incoming: SiteCapabilities = {};
  let present = false;
  let accepted = 0;
  for (const [key, value] of params.entries()) {
    if (!isCapabilityQueryKey(key)) continue;
    present = true;
    if (accepted >= MAX_CAPABILITY_KEYS) continue;
    incoming[key] = parseCapabilityFlag(value);
    accepted += 1;
  }
  if (!present) return { capabilities: {}, present: false };
  return { capabilities: mergeCodexCapabilities({}, incoming), present: true };
}

export function appendCapabilitiesToSearchParams(
  params: URLSearchParams,
  capabilities: SiteCapabilities | undefined,
): void {
  if (!capabilities) return;
  const keys = Object.keys(capabilities).sort();
  for (const key of keys) {
    if (!isCapabilityQueryKey(key)) continue;
    if (!capabilities[key]) continue;
    params.set(key, "1");
  }
}

export function summarizeCodexCapabilities(flags: CodexCapabilityFlags): Array<{
  key: CodexCapabilityKey;
  on: boolean;
}> {
  return [
    { key: CODEX_COMPACT, on: flags.compact },
    { key: CODEX_VISION, on: flags.vision },
    { key: CODEX_IMAGEGEN, on: flags.imagegen },
    { key: CODEX_SEARCH, on: flags.search },
  ];
}
