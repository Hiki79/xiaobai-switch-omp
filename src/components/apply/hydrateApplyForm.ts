import type {
  ClaudeAuthKeyStyle,
  ClaudeEffortLevel,
  CodexCapabilitySource,
  CodexReasoningEffort,
  LiveSummary,
  Site,
  SiteModel,
  TargetLiveStatus,
} from "@/types/domain";
import {
  type CodexCapabilityFlags,
  EMPTY_CODEX_FLAGS,
  codexFlagsFromCapabilities,
} from "@/lib/siteCapabilities";

const CLAUDE_EFFORTS = new Set<ClaudeEffortLevel>(["low", "medium", "high", "max"]);

/** Efforts Codex accepts on model_reasoning_effort and catalog levels. */
export const CODEX_EFFORT_LIST = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const CODEX_EFFORTS = new Set<CodexReasoningEffort>(CODEX_EFFORT_LIST);

/** Effort ladder omp understands on `:level` suffixes and thinking.levels. */
export const OMP_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const DEFAULT_FAMILY_LEVELS = ["low", "medium", "high", "max"];

export function selectableApplySites<T extends { enabled: boolean }>(sites: T[]): T[] {
  return sites.filter((s) => s.enabled);
}

export interface PickApplySiteIdInput {
  sites: Pick<Site, "id">[];
  prefillSiteId?: string | null;
  selectedSiteId?: string | null;
  appliedSiteId?: string | null;
}

export function pickApplySiteId({
  sites,
  prefillSiteId,
  selectedSiteId,
  appliedSiteId,
}: PickApplySiteIdInput): string | null {
  const ids = new Set(sites.map((s) => s.id));
  if (prefillSiteId && ids.has(prefillSiteId)) return prefillSiteId;
  if (appliedSiteId && ids.has(appliedSiteId)) return appliedSiteId;
  if (selectedSiteId && ids.has(selectedSiteId)) return selectedSiteId;
  return sites[0]?.id ?? null;
}

export function liveStr(summary: LiveSummary | undefined, ...keys: string[]): string | undefined {
  if (!summary) return undefined;
  for (const key of keys) {
    const value = summary[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function parseClaudeEffort(raw: string | undefined): ClaudeEffortLevel | undefined {
  if (!raw) return undefined;
  return CLAUDE_EFFORTS.has(raw as ClaudeEffortLevel) ? (raw as ClaudeEffortLevel) : undefined;
}

export function parseCodexReasoning(raw: string | undefined): CodexReasoningEffort | undefined {
  if (!raw) return undefined;
  return CODEX_EFFORTS.has(raw as CodexReasoningEffort)
    ? (raw as CodexReasoningEffort)
    : undefined;
}

export function inferClaudeAuth(summary: LiveSummary | undefined): ClaudeAuthKeyStyle | undefined {
  if (!summary) return undefined;
  if (liveStr(summary, "ANTHROPIC_AUTH_TOKEN")) return "anthropic_auth_token";
  if (liveStr(summary, "ANTHROPIC_API_KEY")) return "anthropic_api_key";
  return undefined;
}

export interface ClaudeFormDefaults {
  modelId: string | undefined;
  opusModel: string | undefined;
  sonnetModel: string | undefined;
  haikuModel: string | undefined;
  effort: ClaudeEffortLevel | undefined;
  auth: ClaudeAuthKeyStyle;
}

export interface CodexFormDefaults {
  modelId: string | undefined;
  writeAllModels: boolean;
  reasoning: CodexReasoningEffort | undefined;
  capabilitySource: CodexCapabilitySource;
  remoteCompaction: boolean;
  imageUnderstanding: boolean;
  imageGeneration: boolean;
  webSearch: boolean;
}

function appliedOnSite(site: Site | null, status: TargetLiveStatus | undefined): boolean {
  return Boolean(site && status?.appliedSiteId && status.appliedSiteId === site.id);
}

export function hydrateClaudeForm(
  site: Site | null,
  status: TargetLiveStatus | undefined,
): ClaudeFormDefaults {
  const live = status?.liveSummary;
  const onSite = appliedOnSite(site, status);
  const liveModel = liveStr(live, "ANTHROPIC_MODEL", "model") ?? status?.appliedModelId ?? undefined;
  const fallbackAuth = site?.claudeAuthKeyStyle ?? "anthropic_auth_token";

  if (onSite) {
    return {
      modelId: liveModel ?? site?.selectedModelId ?? undefined,
      opusModel: liveStr(live, "ANTHROPIC_DEFAULT_OPUS_MODEL"),
      sonnetModel: liveStr(live, "ANTHROPIC_DEFAULT_SONNET_MODEL"),
      haikuModel: liveStr(live, "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
      effort: parseClaudeEffort(liveStr(live, "CLAUDE_CODE_EFFORT_LEVEL", "effortLevel")),
      auth: inferClaudeAuth(live) ?? fallbackAuth,
    };
  }

  return {
    modelId: site?.selectedModelId ?? undefined,
    opusModel: undefined,
    sonnetModel: undefined,
    haikuModel: undefined,
    effort: parseClaudeEffort(liveStr(live, "CLAUDE_CODE_EFFORT_LEVEL", "effortLevel")),
    auth: site?.claudeAuthKeyStyle ?? fallbackAuth,
  };
}

function liveTruthy(summary: LiveSummary | undefined, ...keys: string[]): boolean {
  const raw = liveStr(summary, ...keys);
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

function hydrateRemoteCompaction(live: LiveSummary | undefined): boolean {
  if (liveTruthy(live, "remote_compaction")) return true;
  return liveStr(live, "provider_display_name") === "OpenAI";
}

function hydrateWebSearch(live: LiveSummary | undefined): boolean {
  const raw = liveStr(live, "web_search");
  if (raw) return raw.trim().toLowerCase() !== "disabled";
  if (liveStr(live, "model", "model_provider")) return true;
  return false;
}

function flagsToDefaults(flags: CodexCapabilityFlags) {
  return {
    remoteCompaction: flags.compact,
    imageUnderstanding: flags.vision,
    imageGeneration: flags.imagegen,
    webSearch: flags.search,
  };
}

function liveCapabilityFlags(live: LiveSummary | undefined): CodexCapabilityFlags {
  return {
    compact: hydrateRemoteCompaction(live),
    vision: liveTruthy(live, "tools_view_image", "view_image"),
    imagegen: liveTruthy(live, "features_image_generation", "image_generation"),
    search: hydrateWebSearch(live),
  };
}

export function hydrateCodexForm(
  site: Site | null,
  status: TargetLiveStatus | undefined,
): CodexFormDefaults {
  const live = status?.liveSummary;
  const onSite = appliedOnSite(site, status);
  const liveModel = liveStr(live, "model") ?? status?.appliedModelId ?? undefined;
  const siteFlags = site ? codexFlagsFromCapabilities(site.capabilities) : EMPTY_CODEX_FLAGS;
  const explicitSource = liveStr(live, "capability_source");
  const useCustomLive = onSite && explicitSource === "custom";
  const capabilitySource: CodexCapabilitySource = useCustomLive ? "custom" : "site";
  const flags = useCustomLive ? liveCapabilityFlags(live) : siteFlags;

  return {
    modelId: onSite ? (liveModel ?? site?.selectedModelId ?? undefined) : (site?.selectedModelId ?? undefined),
    writeAllModels: Boolean(liveStr(live, "model_catalog_json")),
    reasoning: parseCodexReasoning(liveStr(live, "model_reasoning_effort")),
    capabilitySource,
    ...flagsToDefaults(flags),
  };
}

export interface OmpFormDefaults {
  modelId: string | undefined;
  writeAllModels: boolean;
  reasoningLevels: string[];
  reasoningLevel: string | undefined;
}

export interface ZcodeFormDefaults {
  modelId: string | undefined;
  writeAllModels: boolean;
  reasoningLevels: string[];
  reasoningLevel: string | undefined;
  /** Manual context-window override written into ZCode model limits. */
  contextWindow: number | undefined;
}

/** Model ids a target currently has written (`model_ids` live summary key). */
export function parseLiveModelIds(live: LiveSummary | undefined): string[] {
  const raw = liveStr(live, "model_ids");
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Checked catalog models for the picker: what the target already has written,
 * falling back to every site model when nothing was written yet. */
export function hydrateCatalogSelection(
  models: SiteModel[],
  liveModelIds: string[],
): string[] {
  if (liveModelIds.length > 0) {
    const written = new Set(liveModelIds);
    return models.filter((model) => written.has(model.modelId)).map((m) => m.modelId);
  }
  return models.map((m) => m.modelId);
}

/** Model-family reasoning ladders shared by every target; each target keeps
 * only the levels its CLI actually accepts. */
const ZCODE_MODEL_LEVELS: Array<{ matches: RegExp; levels: string[] }> = [
  { matches: /glm[-_ ]?5\.3/i, levels: ["low", "max", "high"] },
  { matches: /glm[-_ ]?5\.2/i, levels: ["nothink", "high", "max"] },
  { matches: /(?:gpt|o1|o3)/i, levels: ["low", "medium", "high", "xhigh"] },
  { matches: /(?:claude|opus|sonnet)/i, levels: ["low", "medium", "high", "xhigh"] },
  { matches: /kimi/i, levels: ["low", "high", "max"] },
  { matches: /deepseek/i, levels: ["off", "high", "max"] },
  { matches: /gemini/i, levels: ["minimal", "low", "medium", "high"] },
];

function uniqueNonEmpty(values: unknown[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value || value.length > 64 || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function rawReasoningLevels(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const found: unknown[] = [];
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 3) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        [
          "variants",
          "levels",
          "reasoningLevels",
          "reasoning_levels",
          "supportedReasoningLevels",
          "supported_reasoning_levels",
        ].includes(key)
      ) {
        if (Array.isArray(child)) found.push(...child);
        else if (typeof child === "string") found.push(...child.split(","));
      }
      visit(child, depth + 1);
    }
  };
  visit(raw, 0);
  return uniqueNonEmpty(found);
}

export function zcodeReasoningLevelsForModel(
  modelId: string | undefined,
  model?: SiteModel,
  status?: TargetLiveStatus,
): string[] {
  const liveModel = liveStr(status?.liveSummary, "model")?.split("/").pop();
  const byModelRaw = liveStr(status?.liveSummary, "reasoning_variants_by_model");
  if (modelId && byModelRaw) {
    try {
      const byModel = JSON.parse(byModelRaw) as Record<string, unknown>;
      const configured = rawReasoningLevels(byModel[modelId]);
      if (configured.length > 0) return configured;
    } catch {
      // Ignore a malformed summary and fall back to the model catalog/heuristics.
    }
  }
  const live = liveStr(status?.liveSummary, "reasoning_variants");
  if (!modelId || !liveModel || modelId === liveModel) {
    const liveLevels = live ? uniqueNonEmpty(live.split(",")) : [];
    if (liveLevels.length > 0) return liveLevels;
  }

  const rawLevels = rawReasoningLevels(model?.raw);
  if (rawLevels.length > 0) return rawLevels;

  const family = ZCODE_MODEL_LEVELS.find((entry) => entry.matches.test(modelId ?? ""));
  // Keep in sync with the Rust fallback in zcode.rs::default_levels_for_model.
  return family?.levels ?? ["low", "high", "max"];
}

function familyLevelsForModel(modelId: string | undefined): string[] {
  const family = ZCODE_MODEL_LEVELS.find((entry) => entry.matches.test(modelId ?? ""));
  return family?.levels ?? DEFAULT_FAMILY_LEVELS;
}

function intersectLevels<T extends string>(modelId: string | undefined, allowed: readonly T[]): T[] {
  const levels = familyLevelsForModel(modelId).filter((v): v is T =>
    (allowed as readonly string[]).includes(v),
  );
  return levels.length > 0 ? levels : [...allowed];
}

/** Codex model_reasoning_effort options for the selected model. */
export function codexReasoningLevelsForModel(modelId: string | undefined): CodexReasoningEffort[] {
  return intersectLevels(modelId, [...CODEX_EFFORTS]);
}

/** Claude Code effort options for the selected model. */
export function claudeEffortLevelsForModel(modelId: string | undefined): ClaudeEffortLevel[] {
  return intersectLevels(modelId, [...CLAUDE_EFFORTS]);
}

/** omp thinking.levels options for the selected model. */
export function ompReasoningLevelsForModel(modelId: string | undefined): string[] {
  return intersectLevels(modelId, OMP_EFFORTS);
}

const PREFERRED_DEFAULT_LEVELS = ["max", "xhigh", "high", "medium", "low", "minimal", "off"];

/** Sensible default level: strongest the model family supports. */
export function defaultReasoningLevel<T extends string>(
  levels: T[],
  current?: string,
): T | undefined {
  const asStrings = levels as string[];
  if (current) {
    const match = asStrings.find((level) => level === current);
    if (match !== undefined) return match as T;
  }
  const preferred = PREFERRED_DEFAULT_LEVELS.find((level) => asStrings.includes(level));
  return preferred !== undefined ? (preferred as T) : levels[0];
}

function preferredZcodeLevel(levels: string[], preferred?: string): string | undefined {
  if (preferred && levels.includes(preferred)) return preferred;
  return levels.find((value) => value.toLowerCase() === "max") ?? levels[0];
}

export function hydrateZcodeForm(
  site: Site | null,
  status: TargetLiveStatus | undefined,
  models: SiteModel[] = [],
): ZcodeFormDefaults {
  const live = status?.liveSummary;
  const onSite = appliedOnSite(site, status);
  const selector = liveStr(live, "model");
  const liveModel = selector?.includes("/")
    ? selector.slice(selector.indexOf("/") + 1)
    : selector;
  const modelId = onSite
    ? (liveModel ?? status?.appliedModelId ?? site?.selectedModelId ?? undefined)
    : (site?.selectedModelId ?? undefined);
  const writtenModelIds = parseLiveModelIds(live);
  const count = Number(liveStr(live, "models") ?? "1");
  const levels = zcodeReasoningLevelsForModel(
    modelId,
    models.find((model) => model.modelId === modelId),
    status,
  );
  return {
    modelId,
    writeAllModels:
      onSite &&
      ((Number.isFinite(count) && count > 1) || writtenModelIds.length > 1),
    reasoningLevels: levels,
    reasoningLevel: preferredZcodeLevel(
      levels,
      onSite ? liveStr(live, "reasoning_default") : undefined,
    ),
    contextWindow: onSite
      ? Number(liveStr(live, "model_context") ?? "") || undefined
      : undefined,
  };
}

export function hydrateOmpForm(
  site: Site | null,
  status: TargetLiveStatus | undefined,
): OmpFormDefaults {
  const live = status?.liveSummary;
  const onSite = appliedOnSite(site, status);
  // omp stores the default as a "<provider>/<model>[:level]" selector; the
  // adapter also surfaces the bare model id separately.
  const selector = liveStr(live, "default_model");
  const liveModel =
    liveStr(live, "model") ??
    (selector?.includes("/")
      ? selector.slice(selector.indexOf("/") + 1)
      : selector)?.split(":")[0];
  const count = Number(liveStr(live, "models") ?? "1");
  const modelId = onSite
    ? (liveModel ?? site?.selectedModelId ?? undefined)
    : (site?.selectedModelId ?? undefined);
  const liveLevels = (liveStr(live, "reasoning_levels") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => (OMP_EFFORTS as readonly string[]).includes(value));
  const reasoningLevels =
    onSite && liveLevels.length > 0 ? liveLevels : ompReasoningLevelsForModel(modelId);
  return {
    modelId,
    writeAllModels: onSite && Number.isFinite(count) && count > 1,
    reasoningLevels,
    reasoningLevel: defaultReasoningLevel(
      reasoningLevels,
      onSite ? liveStr(live, "reasoning_level") : undefined,
    ),
  };
}

export function buildModelOptions(
  models: SiteModel[],
  extraIds: Array<string | undefined>,
): { value: string; label: string }[] {
  const opts = models.map((m) => ({
    value: m.modelId,
    label: m.displayName && m.displayName !== m.modelId ? `${m.displayName} (${m.modelId})` : m.modelId,
  }));
  const seen = new Set(opts.map((o) => o.value));
  for (const id of extraIds) {
    if (!id || seen.has(id)) continue;
    opts.unshift({ value: id, label: id });
    seen.add(id);
  }
  return opts;
}
