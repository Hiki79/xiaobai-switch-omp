import { describe, expect, it } from "vitest";
import {
  appendCapabilitiesToSearchParams,
  capabilitiesEqual,
  capabilitiesFromCodexFlags,
  capabilitiesFromSearchParams,
  CODEX_COMPACT,
  CODEX_IMAGEGEN,
  CODEX_SEARCH,
  CODEX_VISION,
  codexFlagsFromCapabilities,
  isCapabilityQueryKey,
  mergeCodexCapabilities,
  parseCapabilityFlag,
  parseCapabilitySource,
} from "./siteCapabilities";

describe("parseCapabilityFlag", () => {
  it("accepts common truthy and falsy tokens", () => {
    expect(parseCapabilityFlag("1")).toBe(true);
    expect(parseCapabilityFlag("TRUE")).toBe(true);
    expect(parseCapabilityFlag("on")).toBe(true);
    expect(parseCapabilityFlag("yes")).toBe(true);
    expect(parseCapabilityFlag("0")).toBe(false);
    expect(parseCapabilityFlag("false")).toBe(false);
    expect(parseCapabilityFlag("OFF")).toBe(false);
    expect(parseCapabilityFlag("no")).toBe(false);
    expect(parseCapabilityFlag("maybe")).toBe(false);
    expect(parseCapabilityFlag(null)).toBe(false);
  });
});

describe("isCapabilityQueryKey", () => {
  it("accepts platform-prefixed kebab keys and rejects reserved fields", () => {
    expect(isCapabilityQueryKey("codex-compact")).toBe(true);
    expect(isCapabilityQueryKey("claude-vision")).toBe(true);
    expect(isCapabilityQueryKey("name")).toBe(false);
    expect(isCapabilityQueryKey("baseurls")).toBe(false);
    expect(isCapabilityQueryKey("apikey")).toBe(false);
    expect(isCapabilityQueryKey("Codex-Compact")).toBe(false);
    expect(isCapabilityQueryKey("compact")).toBe(false);
  });
});

describe("capabilitiesFromSearchParams", () => {
  it("treats a missing block as not present", () => {
    const parsed = capabilitiesFromSearchParams(
      new URLSearchParams("name=Relay&baseurls=https://a.example.com"),
    );
    expect(parsed.present).toBe(false);
    expect(parsed.capabilities).toEqual({});
  });

  it("fills known Codex keys when any capability param is present", () => {
    const parsed = capabilitiesFromSearchParams(
      new URLSearchParams("codex-compact=1&codex-vision=true"),
    );
    expect(parsed.present).toBe(true);
    expect(parsed.capabilities).toEqual({
      [CODEX_COMPACT]: true,
      [CODEX_VISION]: true,
      [CODEX_IMAGEGEN]: false,
      [CODEX_SEARCH]: false,
    });
  });

  it("keeps unknown future platform keys", () => {
    const parsed = capabilitiesFromSearchParams(new URLSearchParams("claude-foo=1"));
    expect(parsed.present).toBe(true);
    expect(parsed.capabilities["claude-foo"]).toBe(true);
    expect(parsed.capabilities[CODEX_SEARCH]).toBe(false);
  });
});

describe("appendCapabilitiesToSearchParams", () => {
  it("emits only truthy keys", () => {
    const params = new URLSearchParams();
    appendCapabilitiesToSearchParams(params, {
      [CODEX_COMPACT]: true,
      [CODEX_VISION]: false,
      [CODEX_SEARCH]: true,
    });
    expect(params.get("codex-compact")).toBe("1");
    expect(params.get("codex-search")).toBe("1");
    expect(params.get("codex-vision")).toBeNull();
  });
});

describe("mergeCodexCapabilities", () => {
  it("replaces known Codex keys and keeps unknown existing keys", () => {
    const merged = mergeCodexCapabilities(
      { [CODEX_SEARCH]: true, "claude-foo": true },
      { [CODEX_COMPACT]: true },
    );
    expect(merged).toEqual({
      "claude-foo": true,
      [CODEX_COMPACT]: true,
      [CODEX_VISION]: false,
      [CODEX_IMAGEGEN]: false,
      [CODEX_SEARCH]: false,
    });
  });
});

describe("codex flag mapping", () => {
  it("round-trips flags through the kebab map", () => {
    const flags = { compact: true, vision: true, imagegen: false, search: true };
    expect(codexFlagsFromCapabilities(capabilitiesFromCodexFlags(flags))).toEqual(flags);
  });
});

describe("capabilitiesEqual", () => {
  it("treats missing keys as false", () => {
    expect(capabilitiesEqual({ [CODEX_COMPACT]: true }, { [CODEX_COMPACT]: true, [CODEX_SEARCH]: false })).toBe(
      true,
    );
    expect(capabilitiesEqual({ [CODEX_COMPACT]: true }, { [CODEX_VISION]: true })).toBe(false);
  });
});

describe("parseCapabilitySource", () => {
  it("defaults to follow-site unless custom is explicit", () => {
    expect(parseCapabilitySource("site")).toBe("site");
    expect(parseCapabilitySource("SITE")).toBe("site");
    expect(parseCapabilitySource("custom")).toBe("custom");
    expect(parseCapabilitySource(undefined)).toBe("site");
  });
});
