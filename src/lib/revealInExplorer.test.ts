import { beforeEach, describe, expect, it, vi } from "vitest";
import { parentPath, revealInExplorer } from "./revealInExplorer";

vi.mock("@/lib/invoke", async () => {
  const actual = await vi.importActual<typeof import("@/lib/invoke")>("@/lib/invoke");
  return {
    ...actual,
    isTauri: () => false,
    invoke: vi.fn().mockResolvedValue(undefined),
  };
});

import { invoke } from "@/lib/invoke";

describe("parentPath", () => {
  it("strips the last file segment on posix and windows paths", () => {
    expect(parentPath("/Users/lmini/.claude/settings.json")).toBe("/Users/lmini/.claude");
    expect(parentPath("C:\\Users\\lmini\\.claude\\settings.json")).toBe("C:\\Users\\lmini\\.claude");
  });

  it("returns the original path when there is no parent", () => {
    expect(parentPath("settings.json")).toBe("settings.json");
  });
});

describe("revealInExplorer", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("opens the parent folder via open_path when not running under Tauri", async () => {
    await revealInExplorer("/Users/lmini/.claude/settings.json");
    expect(invoke).toHaveBeenCalledWith("open_path", { path: "/Users/lmini/.claude" });
  });
});
