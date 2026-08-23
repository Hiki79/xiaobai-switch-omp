import { beforeEach, describe, expect, it } from "vitest";
import type {
  ApplyResult,
  FetchModelsResult,
  Site,
  TargetLiveStatus,
} from "@/types/domain";
import { handleBrowserCommand, resetBrowserMock } from "./browserMock";

describe("browser mock Pi apply", () => {
  beforeEach(() => resetBrowserMock());

  it("round-trips the selected catalog and Pi reasoning settings", async () => {
    const site = await handleBrowserCommand<Site>("create_site", {
      input: {
        name: "Relay",
        baseUrl: "https://relay.example.com",
        apiKey: "sk-test",
      },
    });
    const fetched = await handleBrowserCommand<FetchModelsResult>("fetch_site_models", {
      siteId: site.id,
    });
    expect(fetched.models).toHaveLength(2);

    const result = await handleBrowserCommand<ApplyResult>("apply_site", {
      siteId: site.id,
      targets: ["pi"],
      modelId: "gpt-4.1",
      piWriteAllModels: true,
      catalogModelIds: ["claude-sonnet-4"],
      piReasoningLevels: ["low", "high", "xhigh"],
      piReasoningLevel: "high",
    });
    expect(result.results).toEqual([
      expect.objectContaining({ target: "pi", ok: true, status: "applied" }),
    ]);

    const statuses = await handleBrowserCommand<TargetLiveStatus[]>("list_target_status");
    const pi = statuses.find((status) => status.kind === "pi");
    expect(pi).toMatchObject({
      appliedSiteId: site.id,
      appliedModelId: "gpt-4.1",
      liveSummary: {
        default_provider: `xiaobai-${site.id}`,
        default_model: "gpt-4.1",
        default_thinking_level: "high",
        reasoning_levels: "low,high,xhigh",
        models: "2",
      },
    });
    expect(pi?.liveSummary.model_ids?.split(",").sort()).toEqual([
      "claude-sonnet-4",
      "gpt-4.1",
    ]);
  });
});
