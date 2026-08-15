import { beforeEach, describe, expect, it } from "vitest";
import { resetBrowserMock } from "@/lib/browserMock";
import { useSiteStore } from "./siteStore";

describe("siteStore fetchModels", () => {
  beforeEach(() => {
    resetBrowserMock();
    useSiteStore.setState({
      sites: [],
      modelsBySite: {},
      modelsLoadingBySite: {},
      loading: false,
      hydrated: false,
      fetchingModels: false,
      error: null,
    });
  });

  it("keeps a manually added model after refreshing the catalog", async () => {
    const site = await useSiteStore.getState().createSite({
      name: "Relay",
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
    });

    await useSiteStore.getState().setSelectedModel(site.id, "gpt-5.6-terra");
    await useSiteStore.getState().listModels(site.id, { force: true });
    expect(
      useSiteStore.getState().modelsBySite[site.id]?.some((m) => m.modelId === "gpt-5.6-terra"),
    ).toBe(true);

    await useSiteStore.getState().fetchModels(site.id);

    const ids = (useSiteStore.getState().modelsBySite[site.id] ?? []).map((m) => m.modelId);
    expect(ids).toContain("gpt-4.1");
    expect(ids).toContain("gpt-5.6-terra");
  });

  it("deletes a model and does not bring it back on the next fetch", async () => {
    const site = await useSiteStore.getState().createSite({
      name: "Relay",
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
    });
    await useSiteStore.getState().fetchModels(site.id);
    await useSiteStore.getState().deleteModel(site.id, "gpt-4.1");

    expect(
      useSiteStore.getState().modelsBySite[site.id]?.some((m) => m.modelId === "gpt-4.1"),
    ).toBe(false);

    await useSiteStore.getState().fetchModels(site.id);
    expect(
      useSiteStore.getState().modelsBySite[site.id]?.some((m) => m.modelId === "gpt-4.1"),
    ).toBe(false);
    expect(
      useSiteStore.getState().modelsBySite[site.id]?.some((m) => m.modelId === "claude-sonnet-4"),
    ).toBe(true);
  });

  it("imports a deep-link site and reuses the same protocol + URL set", async () => {
    const created = await useSiteStore.getState().importSiteFromDeepLink({
      name: "Relay",
      baseUrls: ["https://b.example.com", "https://a.example.com"],
      apiKey: "sk-test",
      protocol: "openai_compatible",
    });
    expect(created.created).toBe(true);
    expect(created.site.baseUrl).toBe("https://b.example.com");

    const reused = await useSiteStore.getState().importSiteFromDeepLink({
      name: "Relay",
      baseUrls: ["https://a.example.com", "https://b.example.com"],
      apiKey: "sk-test",
      protocol: "openai_compatible",
    });
    expect(reused.created).toBe(false);
    expect(reused.reused).toBe(true);
    expect(reused.site.id).toBe(created.site.id);
    expect(reused.site.baseUrl).toBe("https://b.example.com");
    expect(useSiteStore.getState().sites).toHaveLength(1);

    const updated = await useSiteStore.getState().importSiteFromDeepLink({
      name: "Relay 2",
      baseUrls: ["https://a.example.com", "https://b.example.com"],
      apiKey: "sk-other",
      protocol: "openai_compatible",
    });
    expect(updated.updatedKey).toBe(true);
    expect(updated.site.id).toBe(created.site.id);
    expect(updated.site.name).toBe("Relay 2");
  });

  it("switchRoute moves the selected url to the front", async () => {
    const site = await useSiteStore.getState().createSite({
      name: "Relay",
      baseUrl: "https://a.example.com",
      apiKey: "sk-test",
    });
    await useSiteStore.getState().updateSite(site.id, {
      baseUrls: ["https://a.example.com", "https://b.example.com"],
    });
    const result = await useSiteStore.getState().switchRoute(site.id, "https://b.example.com");
    expect(result.site.baseUrl).toBe("https://b.example.com");
    expect(result.site.baseUrls[0]).toBe("https://b.example.com");
    expect(useSiteStore.getState().sites[0]?.baseUrl).toBe("https://b.example.com");
  });

  it("switchRoute can skip applying target urls", async () => {
    const site = await useSiteStore.getState().createSite({
      name: "Relay",
      baseUrl: "https://a.example.com",
      apiKey: "sk-test",
    });
    await useSiteStore.getState().updateSite(site.id, {
      baseUrls: ["https://a.example.com", "https://b.example.com"],
    });
    const result = await useSiteStore.getState().switchRoute(site.id, "https://b.example.com", {
      apply: false,
    });
    expect(result.site.baseUrl).toBe("https://b.example.com");
    expect(result.results).toEqual([]);
  });

  it("clears the catalog without blocking the next fetch", async () => {
    const site = await useSiteStore.getState().createSite({
      name: "Relay",
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
    });
    await useSiteStore.getState().fetchModels(site.id);
    await useSiteStore.getState().clearModels(site.id);

    expect(useSiteStore.getState().modelsBySite[site.id]).toEqual([]);
    expect(useSiteStore.getState().sites[0]?.selectedModelId).toBeNull();

    await useSiteStore.getState().fetchModels(site.id);
    expect(
      useSiteStore.getState().modelsBySite[site.id]?.some((m) => m.modelId === "gpt-4.1"),
    ).toBe(true);
  });
});
