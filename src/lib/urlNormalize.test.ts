import { describe, expect, it } from "vitest";
import { keyPrefix, normalizeBaseUrl, normalizeBaseUrls, siteBaseUrls } from "./urlNormalize";

describe("normalizeBaseUrl", () => {
  it("adds /v1 for bare host", () => {
    const r = normalizeBaseUrl("https://api.example.com");
    expect(r.modelsUrl).toBe("https://api.example.com/v1/models");
    expect(r.claudeBaseUrl).toBe("https://api.example.com");
    expect(r.codexBaseUrl).toBe("https://api.example.com/v1");
  });

  it("handles trailing slash", () => {
    const r = normalizeBaseUrl("https://api.example.com/");
    expect(r.modelsUrl).toBe("https://api.example.com/v1/models");
  });

  it("handles base ending with /v1", () => {
    const r = normalizeBaseUrl("https://api.example.com/v1");
    expect(r.modelsUrl).toBe("https://api.example.com/v1/models");
    expect(r.claudeBaseUrl).toBe("https://api.example.com/v1");
    expect(r.codexBaseUrl).toBe("https://api.example.com/v1");
  });

  it("strips /v1/messages", () => {
    const r = normalizeBaseUrl("https://relay.example.com/v1/messages");
    expect(r.claudeBaseUrl).toBe("https://relay.example.com/v1");
    expect(r.codexBaseUrl).toBe("https://relay.example.com/v1");
    expect(r.modelsUrl).toBe("https://relay.example.com/v1/models");
  });

  it("keeps /anthropic path", () => {
    const r = normalizeBaseUrl("https://relay.example.com/anthropic");
    expect(r.claudeBaseUrl).toBe("https://relay.example.com/anthropic");
    expect(r.codexBaseUrl).toBe("https://relay.example.com/anthropic/v1");
    expect(r.modelsUrl).toBe("https://relay.example.com/anthropic/v1/models");
  });
});

describe("normalizeBaseUrls", () => {
  it("trims, dedupes, and requires http(s)", () => {
    expect(
      normalizeBaseUrls(["  https://a.example.com  ", "https://a.example.com", "https://b.example.com", ""]),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
    expect(() => normalizeBaseUrls([""])).toThrow("empty_url");
    expect(() => normalizeBaseUrls(["ftp://x"])).toThrow("invalid_url_scheme");
  });

  it("falls back to site.baseUrl", () => {
    expect(siteBaseUrls({ baseUrl: "https://a.example.com" })).toEqual(["https://a.example.com"]);
    expect(
      siteBaseUrls({
        baseUrl: "https://a.example.com",
        baseUrls: ["https://b.example.com", "https://a.example.com"],
      }),
    ).toEqual(["https://b.example.com", "https://a.example.com"]);
  });
});

describe("keyPrefix", () => {
  it("masks long keys", () => {
    expect(keyPrefix("sk-abcdefghijklmnop")).toBe("sk-a…mnop");
  });
});
