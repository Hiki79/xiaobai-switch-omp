import { act, renderHook, waitFor } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApplyStore, useUIStore } from "@/stores";
import type { ApplyTargetResult } from "@/types/domain";
import { useTrayEvents } from "./useTrayEvents";
import "@/i18n";

const listeners = new Map<string, (payload: unknown) => void>();

vi.mock("@/lib/invoke", async () => {
  const actual = await vi.importActual<typeof import("@/lib/invoke")>("@/lib/invoke");
  return {
    ...actual,
    isTauri: () => true,
    invoke: vi.fn(async () => undefined),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (e: { payload: unknown }) => void) => {
    listeners.set(event, (payload) => cb({ payload }));
    return () => {
      listeners.delete(event);
    };
  }),
}));

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

describe("useTrayEvents", () => {
  beforeEach(() => {
    listeners.clear();
    useUIStore.setState({ activePage: "sites" });
    useApplyStore.setState({
      loadStatus: vi.fn(async () => undefined),
    });
  });

  afterEach(() => {
    listeners.clear();
    vi.clearAllMocks();
  });

  it("navigates to settings from the tray", async () => {
    renderHook(() => useTrayEvents(), { wrapper: Wrapper });
    await waitFor(() => {
      expect(listeners.has("tray-navigate")).toBe(true);
    });
    act(() => {
      listeners.get("tray-navigate")?.("settings");
    });
    expect(useUIStore.getState().activePage).toBe("settings");
  });

  it("reloads apply status after a tray apply", async () => {
    const loadStatus = vi.fn(async () => undefined);
    useApplyStore.setState({ loadStatus });
    renderHook(() => useTrayEvents(), { wrapper: Wrapper });
    await waitFor(() => {
      expect(listeners.has("tray-applied")).toBe(true);
    });
    const results: ApplyTargetResult[] = [
      {
        target: "claude_code",
        ok: true,
        status: "applied",
        backupPaths: [],
        message: "ok",
      },
    ];
    act(() => {
      listeners.get("tray-applied")?.(results);
    });
    await waitFor(() => {
      expect(loadStatus).toHaveBeenCalledWith({ force: true });
    });
  });
});
