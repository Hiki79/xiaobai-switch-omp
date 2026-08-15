import { describe, expect, it } from "vitest";
import type { Site, TargetLiveStatus } from "@/types/domain";
import {
  buildModelOptions,
  hydrateClaudeForm,
  hydrateCodexForm,
  pickApplySiteId,
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
