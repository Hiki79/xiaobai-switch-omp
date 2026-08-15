import { describe, expect, it } from "vitest";
import { groupModelsByPrefix, modelFamilyPrefix } from "./modelPrefix";

describe("modelFamilyPrefix", () => {
  it("uses the first hyphen token", () => {
    expect(modelFamilyPrefix("gpt-4.1")).toBe("gpt");
    expect(modelFamilyPrefix("gemini-2.5-flash")).toBe("gemini");
    expect(modelFamilyPrefix("grok-4-0709")).toBe("grok");
    expect(modelFamilyPrefix("claude-sonnet-4")).toBe("claude");
  });

  it("strips vendor path and colon prefixes", () => {
    expect(modelFamilyPrefix("openai/gpt-4.1")).toBe("gpt");
    expect(modelFamilyPrefix("google/gemini-2.5-pro")).toBe("gemini");
    expect(modelFamilyPrefix("openai:gpt-4o")).toBe("gpt");
  });

  it("lowercases and handles ids without a hyphen", () => {
    expect(modelFamilyPrefix("GPT-4o")).toBe("gpt");
    expect(modelFamilyPrefix("o1")).toBe("o1");
    expect(modelFamilyPrefix("  grok-3-mini  ")).toBe("grok");
  });

  it("returns empty for blank input", () => {
    expect(modelFamilyPrefix("")).toBe("");
    expect(modelFamilyPrefix("   ")).toBe("");
  });
});

describe("groupModelsByPrefix", () => {
  it("clusters by prefix and keeps first-seen group order", () => {
    const groups = groupModelsByPrefix([
      { modelId: "gemini-2.5-flash" },
      { modelId: "gpt-4.1" },
      { modelId: "gemini-2.5-pro" },
      { modelId: "grok-4" },
      { modelId: "gpt-4o" },
    ]);

    expect(groups.map((g) => g.prefix)).toEqual(["gemini", "gpt", "grok"]);
    expect(groups[0]?.models.map((m) => m.modelId)).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ]);
    expect(groups[1]?.models.map((m) => m.modelId)).toEqual(["gpt-4.1", "gpt-4o"]);
    expect(groups[2]?.models.map((m) => m.modelId)).toEqual(["grok-4"]);
  });

  it("treats path-qualified ids as the same family", () => {
    const groups = groupModelsByPrefix([
      { modelId: "openai/gpt-4.1" },
      { modelId: "gpt-5" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.prefix).toBe("gpt");
  });
});
