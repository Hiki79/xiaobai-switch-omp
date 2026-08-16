import type {
  ClaudeAuthKeyStyle,
  ClaudeEffortLevel,
  CodexReasoningEffort,
  LiveSummary,
  Site,
  SiteModel,
  TargetLiveStatus,
} from "@/types/domain";

const CLAUDE_EFFORTS = new Set<ClaudeEffortLevel>(["low", "medium", "high", "max"]);
const CODEX_EFFORTS = new Set<CodexReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

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

export function hydrateCodexForm(
  site: Site | null,
  status: TargetLiveStatus | undefined,
): CodexFormDefaults {
  const live = status?.liveSummary;
  const onSite = appliedOnSite(site, status);
  const liveModel = liveStr(live, "model") ?? status?.appliedModelId ?? undefined;

  return {
    modelId: onSite ? (liveModel ?? site?.selectedModelId ?? undefined) : (site?.selectedModelId ?? undefined),
    writeAllModels: Boolean(liveStr(live, "model_catalog_json")),
    reasoning: parseCodexReasoning(liveStr(live, "model_reasoning_effort")),
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
