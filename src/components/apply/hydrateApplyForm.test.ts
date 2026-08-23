import { describe, expect, it } from "vitest";
import type { Site, SiteModel, TargetLiveStatus } from "@/types/domain";
import {
  buildModelOptions,
  claudeEffortLevelsForModel,
  codexReasoningLevelsForModel,
  defaultReasoningLevel,
  dshReasoningLevelsForModel,
  hydrateCatalogSelection,
  hydrateClaudeForm,
  hydrateCodexForm,
  hydrateDshForm,
  hydrateOmpForm,
  hydratePiForm,
  hydrateZcodeForm,
  ompReasoningLevelsForModel,
  piReasoningLevelsForModel,
  parseLiveModelIds,
  pickApplySiteId,
  selectableApplySites,
  zcodeReasoningLevelsForModel,
} from "./hydrateApplyForm";

function site(partial: Partial<Site> & Pick<Site, "id">): Site {
  return {
    name: partial.name ?? partial.id,
    baseUrl: "https://api.example.com",
    baseUrls: ["https://api.example.com"],
    keyPrefix: "sk-xx",
    hasKey: true,
    protocol: "openai_compatible",
    claudeAuthKeyStyle: "anthropic_auth_token",
    notes: null,
    enabled: true,
    sortOrder: 0,
    selectedModelId: null,
    lastModelFetchAt: null,
    lastModelFetchLatencyMs: null,
    lastModelFetchError: null,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function status(partial: Partial<TargetLiveStatus> = {}): TargetLiveStatus {
  return {
    kind: "claude_code",
    installed: true,
    version: "2.1.0",
    configPath: "/tmp/settings.json",
    status: "applied",
    appliedSiteId: "shuai",
    appliedSiteName: "shuai",
    appliedModelId: "codex-auto-review",
    providerId: null,
    orphan: false,
    liveSummary: {
      ANTHROPIC_MODEL: "codex-auto-review",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-live",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-live",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-live",
      ANTHROPIC_AUTH_TOKEN: "sk-live",
      CLAUDE_CODE_EFFORT_LEVEL: "high",
    },
    lastAppliedAt: 99,
    staleReason: null,
    ...partial,
  };
}

describe("selectableApplySites", () => {
  it("only treats enabled sites as selectable", () => {
    const enabled = site({ id: "on", enabled: true });
    const off = site({ id: "off", enabled: false });
    expect(selectableApplySites([enabled, off])).toEqual([enabled]);
    expect(selectableApplySites([off])).toEqual([]);
  });
});

describe("pickApplySiteId", () => {
  const sites = [{ id: "gptnb" }, { id: "shuai" }];

  it("prefers an explicit go-apply prefill", () => {
    expect(
      pickApplySiteId({
        sites,
        prefillSiteId: "gptnb",
        selectedSiteId: "shuai",
        appliedSiteId: "shuai",
      }),
    ).toBe("gptnb");
  });

  it("falls back to the currently applied site", () => {
    expect(
      pickApplySiteId({
        sites,
        selectedSiteId: "gptnb",
        appliedSiteId: "shuai",
      }),
    ).toBe("shuai");
  });

  it("then uses the globally selected site, then the first site", () => {
    expect(pickApplySiteId({ sites, selectedSiteId: "gptnb" })).toBe("gptnb");
    expect(pickApplySiteId({ sites })).toBe("gptnb");
    expect(pickApplySiteId({ sites: [] })).toBeNull();
  });
});

describe("hydrateClaudeForm", () => {
  it("uses live target config when the selected site is the applied site", () => {
    const defaults = hydrateClaudeForm(
      site({ id: "shuai", selectedModelId: "gpt-4.1", claudeAuthKeyStyle: "anthropic_api_key" }),
      status(),
    );
    expect(defaults.modelId).toBe("codex-auto-review");
    expect(defaults.opusModel).toBe("opus-live");
    expect(defaults.sonnetModel).toBe("sonnet-live");
    expect(defaults.haikuModel).toBe("haiku-live");
    expect(defaults.effort).toBe("high");
    expect(defaults.auth).toBe("anthropic_auth_token");
  });

  it("does not copy the site primary model into aliases when applying a different site", () => {
    const defaults = hydrateClaudeForm(
      site({ id: "gptnb", selectedModelId: "gpt-4.1", claudeAuthKeyStyle: "anthropic_api_key" }),
      status(),
    );
    expect(defaults.modelId).toBe("gpt-4.1");
    expect(defaults.opusModel).toBeUndefined();
    expect(defaults.sonnetModel).toBeUndefined();
    expect(defaults.haikuModel).toBeUndefined();
    expect(defaults.auth).toBe("anthropic_api_key");
    expect(defaults.effort).toBe("high");
  });

  it("leaves effort empty when nothing is written yet", () => {
    const defaults = hydrateClaudeForm(site({ id: "shuai", selectedModelId: "gpt-4.1" }), undefined);
    expect(defaults.modelId).toBe("gpt-4.1");
    expect(defaults.effort).toBeUndefined();
    expect(defaults.opusModel).toBeUndefined();
  });
});

describe("hydrateCodexForm", () => {
  const live: TargetLiveStatus = {
    ...status({
      kind: "codex",
      appliedModelId: "codex-auto-review",
      liveSummary: {
        model: "codex-auto-review",
        model_reasoning_effort: "xhigh",
        model_catalog_json: "/tmp/models.json",
      },
    }),
  };

  it("uses live model / catalog / reasoning for the applied site", () => {
    const defaults = hydrateCodexForm(site({ id: "shuai", selectedModelId: "gpt-4.1" }), live);
    expect(defaults.modelId).toBe("codex-auto-review");
    expect(defaults.writeAllModels).toBe(true);
    expect(defaults.reasoning).toBe("xhigh");
  });

  it("defaults platform capabilities off when nothing is written", () => {
    const defaults = hydrateCodexForm(site({ id: "shuai", selectedModelId: "gpt-4.1" }), undefined);
    expect(defaults.capabilitySource).toBe("site");
    expect(defaults.remoteCompaction).toBe(false);
    expect(defaults.imageUnderstanding).toBe(false);
    expect(defaults.imageGeneration).toBe(false);
    expect(defaults.webSearch).toBe(false);
  });

  it("defaults to follow-site when live has no capability_source", () => {
    const defaults = hydrateCodexForm(
      site({
        id: "shuai",
        selectedModelId: "gpt-4.1",
        capabilities: { "codex-search": true },
      }),
      status({
        kind: "codex",
        appliedSiteId: "shuai",
        liveSummary: { model: "gpt-5.4", web_search: "disabled" },
      }),
    );
    expect(defaults.capabilitySource).toBe("site");
    expect(defaults.webSearch).toBe(true);
  });

  it("follows current site presets when capability_source is site", () => {
    const defaults = hydrateCodexForm(
      site({
        id: "shuai",
        selectedModelId: "gpt-4.1",
        capabilities: { "codex-vision": true, "codex-compact": true },
      }),
      status({
        kind: "codex",
        appliedSiteId: "shuai",
        liveSummary: {
          capability_source: "site",
          remote_compaction: "off",
          web_search: "disabled",
        },
      }),
    );
    expect(defaults.capabilitySource).toBe("site");
    expect(defaults.remoteCompaction).toBe(true);
    expect(defaults.imageUnderstanding).toBe(true);
    expect(defaults.imageGeneration).toBe(false);
    expect(defaults.webSearch).toBe(false);
  });

  it("reads platform capabilities from live summary", () => {
    const defaults = hydrateCodexForm(
      site({ id: "shuai", selectedModelId: "gpt-4.1" }),
      status({
        kind: "codex",
        appliedSiteId: "shuai",
        liveSummary: {
          capability_source: "custom",
          remote_compaction: "on",
          tools_view_image: "true",
          features_image_generation: "true",
          web_search: "cached",
        },
      }),
    );
    expect(defaults.remoteCompaction).toBe(true);
    expect(defaults.imageUnderstanding).toBe(true);
    expect(defaults.imageGeneration).toBe(true);
    expect(defaults.webSearch).toBe(true);
  });

  it("treats disabled web_search and false image flags as off", () => {
    const defaults = hydrateCodexForm(
      site({ id: "shuai" }),
      status({
        kind: "codex",
        appliedSiteId: "shuai",
        liveSummary: {
          capability_source: "custom",
          remote_compaction: "off",
          tools_view_image: "false",
          features_image_generation: "false",
          web_search: "disabled",
        },
      }),
    );
    expect(defaults.remoteCompaction).toBe(false);
    expect(defaults.imageUnderstanding).toBe(false);
    expect(defaults.imageGeneration).toBe(false);
    expect(defaults.webSearch).toBe(false);
  });

  it("falls back to OpenAI provider name for remote compaction", () => {
    const defaults = hydrateCodexForm(
      site({ id: "shuai", name: "Relay One" }),
      status({
        kind: "codex",
        appliedSiteId: "shuai",
        liveSummary: { capability_source: "custom", provider_display_name: "OpenAI" },
      }),
    );
    expect(defaults.remoteCompaction).toBe(true);
  });

  it("treats a live config without web_search as search enabled", () => {
    const defaults = hydrateCodexForm(
      site({ id: "shuai" }),
      status({
        kind: "codex",
        appliedSiteId: "shuai",
        liveSummary: { capability_source: "custom", model: "gpt-5.4" },
      }),
    );
    expect(defaults.webSearch).toBe(true);
    expect(defaults.remoteCompaction).toBe(false);
    expect(defaults.imageUnderstanding).toBe(false);
    expect(defaults.imageGeneration).toBe(false);
  });

  it("uses the site primary model when switching to another site", () => {
    const defaults = hydrateCodexForm(site({ id: "gptnb", selectedModelId: "gpt-4.1" }), live);
    expect(defaults.modelId).toBe("gpt-4.1");
    expect(defaults.writeAllModels).toBe(true);
    expect(defaults.reasoning).toBe("xhigh");
  });

  it("does not force write-all or medium reasoning when nothing is written", () => {
    const defaults = hydrateCodexForm(site({ id: "shuai", selectedModelId: "gpt-4.1" }), undefined);
    expect(defaults.writeAllModels).toBe(false);
    expect(defaults.reasoning).toBeUndefined();
  });
});

describe("buildModelOptions", () => {
  it("prepends live model ids that are missing from the site catalog", () => {
    const opts = buildModelOptions(
      [{ id: "1", siteId: "s", modelId: "gpt-4.1", displayName: "GPT", ownedBy: null, raw: null }],
      ["codex-auto-review", "gpt-4.1"],
    );
    expect(opts[0]).toEqual({ value: "codex-auto-review", label: "codex-auto-review" });
    expect(opts).toHaveLength(2);
  });
});

describe("hydrateZcodeForm", () => {
  it("uses the selected model's live variants and default", () => {
    const defaults = hydrateZcodeForm(
      site({ id: "shuai", selectedModelId: "glm-5.3" }),
      status({
        kind: "zcode",
        appliedSiteId: "shuai",
        liveSummary: {
          model: "xiaobai-shuai/glm-5.3",
          reasoning_variants: "low,high,max",
          reasoning_default: "high",
        },
      }),
    );
    expect(defaults.modelId).toBe("glm-5.3");
    expect(defaults.reasoningLevels).toEqual(["low", "high", "max"]);
    expect(defaults.reasoningLevel).toBe("high");
  });

  it("reads a different model's configured variants before using heuristics", () => {
    const live = status({
      kind: "zcode",
      appliedSiteId: "shuai",
      liveSummary: {
        model: "xiaobai-shuai/glm-5.3",
        reasoning_variants: "low,high,max",
        reasoning_variants_by_model: JSON.stringify({
          "custom-model": { variants: ["fast", "deep"], defaultVariant: "deep" },
        }),
      },
    });
    expect(zcodeReasoningLevelsForModel("custom-model", undefined, live)).toEqual([
      "fast",
      "deep",
    ]);
  });

  it("uses model metadata and family defaults for new models", () => {
    const model: SiteModel = {
      id: "1",
      siteId: "shuai",
      modelId: "vendor-model",
      displayName: "Vendor",
      ownedBy: null,
      raw: { reasoning: { variants: ["quick", "thorough"] } },
    };
    expect(zcodeReasoningLevelsForModel("vendor-model", model)).toEqual(["quick", "thorough"]);
    expect(zcodeReasoningLevelsForModel("glm-5.3")).toEqual(["low", "max", "high"]);
  });

  it("marks write-all on when the provider holds several models", () => {
    const multi = hydrateZcodeForm(
      site({ id: "shuai", selectedModelId: "glm-5.3" }),
      status({
        kind: "zcode",
        appliedSiteId: "shuai",
        liveSummary: {
          model: "xiaobai-shuai/glm-5.3",
          models: "3",
          model_ids: "deepseek-chat,glm-5.3,gpt-4.1",
        },
      }),
    );
    expect(multi.writeAllModels).toBe(true);
    expect(multi.contextWindow).toBeUndefined();

    const single = hydrateZcodeForm(
      site({ id: "shuai", selectedModelId: "glm-5.3" }),
      status({
        kind: "zcode",
        appliedSiteId: "shuai",
        liveSummary: { model: "xiaobai-shuai/glm-5.3", models: "1" },
      }),
    );
    expect(single.writeAllModels).toBe(false);

    const fresh = hydrateZcodeForm(site({ id: "shuai", selectedModelId: "glm-5.3" }), undefined);
    expect(fresh.writeAllModels).toBe(false);
  });

  it("hydrates the manual context window from the live summary", () => {
    const defaults = hydrateZcodeForm(
      site({ id: "shuai", selectedModelId: "glm-5.3" }),
      status({
        kind: "zcode",
        appliedSiteId: "shuai",
        liveSummary: {
          model: "xiaobai-shuai/glm-5.3",
          model_context: "500000",
        },
      }),
    );
    expect(defaults.contextWindow).toBe(500_000);
  });

  it("falls back to the low/high/max ladder for unknown families", () => {
    expect(zcodeReasoningLevelsForModel("ox-alpha-free")).toEqual(["low", "high", "max"]);
  });

  it("rejects stale off variants for always-thinking ox-alpha models", () => {
    const model: SiteModel = {
      id: "ox",
      siteId: "shuai",
      modelId: "ox-alpha-free",
      displayName: "OX Alpha Free",
      ownedBy: null,
      raw: { reasoning: { variants: ["off", "high", "max"] } },
    };
    const live = status({
      kind: "zcode",
      appliedSiteId: "shuai",
      liveSummary: {
        model: "xiaobai-shuai/ox-alpha-free",
        reasoning_variants: "off,high,max",
        reasoning_default: "off",
      },
    });

    expect(zcodeReasoningLevelsForModel("ox-alpha-free", model, live)).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(hydrateZcodeForm(site({ id: "shuai", selectedModelId: "ox-alpha-free" }), live, [model]))
      .toMatchObject({ reasoningLevels: ["low", "high", "max"], reasoningLevel: "max" });
  });
});

describe("hydrateDshForm", () => {
  it("hydrates pi-ai reasoning efforts from the live provider", () => {
    const defaults = hydrateDshForm(
      site({ id: "shuai", selectedModelId: "deepseek-v4" }),
      status({
        kind: "dsh",
        appliedSiteId: "shuai",
        liveSummary: {
          model: "deepseek-v4",
          models: "2",
          model_ids: "deepseek-v4,glm-5.3",
          reasoning_efforts: "off,high,max",
          reasoning_effort: "high",
        },
      }),
    );
    expect(defaults).toMatchObject({
      modelId: "deepseek-v4",
      writeAllModels: true,
      reasoningLevels: ["off", "high", "max"],
      reasoningLevel: "high",
    });
  });

  it("removes off from stale ox-alpha dsh configuration", () => {
    expect(dshReasoningLevelsForModel("ox-alpha-free")).toEqual(["low", "high", "max"]);
    const defaults = hydrateDshForm(
      site({ id: "shuai", selectedModelId: "ox-alpha-free" }),
      status({
        kind: "dsh",
        appliedSiteId: "shuai",
        liveSummary: {
          model: "ox-alpha-free",
          reasoning_efforts: "off,high,max",
          reasoning_effort: "off",
        },
      }),
    );
    expect(defaults.reasoningLevels).toEqual(["low", "high", "max"]);
    expect(defaults.reasoningLevel).toBe("max");
  });
});

describe("hydratePiForm", () => {
  it("round-trips the Pi catalog and default thinking level", () => {
    const defaults = hydratePiForm(
      site({ id: "shuai", selectedModelId: "gpt-4.1" }),
      status({
        kind: "pi",
        appliedSiteId: "shuai",
        liveSummary: {
          default_provider: "xiaobai-shuai",
          default_model: "gpt-4.1",
          models: "2",
          model_ids: "gpt-4.1,claude-sonnet-4",
          reasoning_levels: "low,medium,high,xhigh",
          default_thinking_level: "high",
        },
      }),
    );
    expect(defaults).toMatchObject({
      modelId: "gpt-4.1",
      writeAllModels: true,
      reasoningLevels: ["low", "medium", "high", "xhigh"],
      reasoningLevel: "high",
    });
  });

  it("removes stale off from always-thinking Pi models", () => {
    expect(piReasoningLevelsForModel("ox-alpha-free")).toEqual(["low", "high", "max"]);
    const defaults = hydratePiForm(
      site({ id: "shuai", selectedModelId: "ox-alpha-free" }),
      status({
        kind: "pi",
        appliedSiteId: "shuai",
        liveSummary: {
          default_model: "ox-alpha-free",
          reasoning_levels: "off,high,max",
          default_thinking_level: "off",
        },
      }),
    );
    expect(defaults.reasoningLevels).toEqual(["low", "high", "max"]);
    expect(defaults.reasoningLevel).toBe("max");
  });

  it("uses the relay-safe low/high/max fallback for unknown Pi models", () => {
    expect(piReasoningLevelsForModel("mystery-model")).toEqual(["low", "high", "max"]);
  });
});

describe("catalog selection helpers", () => {
  const models: SiteModel[] = [
    { id: "1", siteId: "s", modelId: "glm-5.3", displayName: "GLM", ownedBy: null, raw: null },
    { id: "2", siteId: "s", modelId: "deepseek-chat", displayName: "deepseek-chat", ownedBy: null, raw: null },
    { id: "3", siteId: "s", modelId: "gpt-4.1", displayName: "gpt-4.1", ownedBy: null, raw: null },
  ];

  it("parses written model ids from the live summary", () => {
    expect(parseLiveModelIds({ model_ids: "glm-5.3, deepseek-chat" })).toEqual([
      "glm-5.3",
      "deepseek-chat",
    ]);
    expect(parseLiveModelIds({})).toEqual([]);
    expect(parseLiveModelIds(undefined)).toEqual([]);
  });

  it("intersects written ids with the site catalog and falls back to all", () => {
    expect(hydrateCatalogSelection(models, ["glm-5.3", "gpt-4.1", "gone-model"])).toEqual([
      "glm-5.3",
      "gpt-4.1",
    ]);
    expect(hydrateCatalogSelection(models, [])).toEqual([
      "glm-5.3",
      "deepseek-chat",
      "gpt-4.1",
    ]);
  });
});

describe("per-target reasoning levels", () => {
  it("codex keeps only codex-valid efforts per model family", () => {
    expect(codexReasoningLevelsForModel("glm-5.3")).toEqual(["low", "max", "high"]);
    expect(codexReasoningLevelsForModel("glm-5.2")).toEqual(["high", "max"]);
    expect(codexReasoningLevelsForModel("gpt-5.2")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(codexReasoningLevelsForModel("deepseek-v4")).toEqual(["high", "max"]);
  });

  it("codex falls back to the default family ladder for unknown models", () => {
    expect(codexReasoningLevelsForModel("mystery-model")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("claude keeps only claude-valid efforts per model family", () => {
    expect(claudeEffortLevelsForModel("deepseek-v4")).toEqual(["high", "max"]);
    expect(claudeEffortLevelsForModel("claude-opus-5")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(claudeEffortLevelsForModel("mystery-model")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("omp keeps only the omp effort ladder", () => {
    expect(ompReasoningLevelsForModel("glm-5.2")).toEqual(["high", "max"]);
    expect(ompReasoningLevelsForModel("mystery-model")).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("default level prefers the strongest supported effort", () => {
    expect(defaultReasoningLevel(["low", "max", "high"])).toBe("max");
    expect(defaultReasoningLevel(["low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(defaultReasoningLevel(["low", "medium", "high", "xhigh"], "low")).toBe("low");
    expect(defaultReasoningLevel(["minimal", "off"])).toBe("minimal");
  });
});

describe("hydrateOmpForm reasoning", () => {
  const ompSite = site({ id: "omp-site", selectedModelId: "glm-5.3" });

  it("reads reasoning level and bare model from the live summary", () => {
    const live = status({
      kind: "omp",
      appliedSiteId: "omp-site",
      liveSummary: {
        default_model: "xiaobai_omp-site/glm-5.3:max",
        model: "glm-5.3",
        reasoning_level: "max",
        reasoning_levels: "low,max,high",
      },
    });
    const defaults = hydrateOmpForm(ompSite, live);
    expect(defaults.modelId).toBe("glm-5.3");
    expect(defaults.reasoningLevels).toEqual(["low", "max", "high"]);
    expect(defaults.reasoningLevel).toBe("max");
  });

  it("infers levels for a fresh site and strips selector suffixes", () => {
    const live = status({
      kind: "omp",
      appliedSiteId: "other-site",
      liveSummary: {
        default_model: "xiaobai_other/glm-5.3:high",
      },
    });
    const defaults = hydrateOmpForm(ompSite, live);
    expect(defaults.modelId).toBe("glm-5.3");
    expect(defaults.reasoningLevels).toEqual(["low", "max", "high"]);
    expect(defaults.reasoningLevel).toBe("max");
  });
});
