import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDeferredTabContent } from "./useDeferredTabContent";

async function flushMacrotasks() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
  });
}

describe("useDeferredTabContent", () => {
  it("shows a skeleton until the active tab is mounted and revealed", async () => {
    const { result } = renderHook(({ tab }) => useDeferredTabContent(tab), {
      initialProps: { tab: "claude_code" },
    });

    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.mounted.has("claude_code")).toBe(false);

    await flushMacrotasks();
    expect(result.current.mounted.has("claude_code")).toBe(true);

    await flushMacrotasks();
    expect(result.current.showSkeleton).toBe(false);
  });

  it("shows a skeleton again when switching to an unvisited tab", async () => {
    const { result, rerender } = renderHook(({ tab }) => useDeferredTabContent(tab), {
      initialProps: { tab: "claude_code" },
    });

    await flushMacrotasks();
    await flushMacrotasks();
    expect(result.current.showSkeleton).toBe(false);

    rerender({ tab: "codex" });
    expect(result.current.showSkeleton).toBe(true);
    expect(result.current.mounted.has("codex")).toBe(false);
    expect(result.current.mounted.has("claude_code")).toBe(true);

    await flushMacrotasks();
    expect(result.current.mounted.has("codex")).toBe(true);

    await flushMacrotasks();
    expect(result.current.showSkeleton).toBe(false);
  });

  it("does not remount a previously revealed tab", async () => {
    const { result, rerender } = renderHook(({ tab }) => useDeferredTabContent(tab), {
      initialProps: { tab: "claude_code" },
    });
    await flushMacrotasks();
    await flushMacrotasks();

    rerender({ tab: "codex" });
    await flushMacrotasks();
    await flushMacrotasks();

    rerender({ tab: "claude_code" });
    expect(result.current.showSkeleton).toBe(false);
    expect(result.current.mounted.has("claude_code")).toBe(true);
  });
});
