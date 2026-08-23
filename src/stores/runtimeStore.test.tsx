import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TargetKind, TargetRuntimeStatus } from "@/types/domain";
import {
  handleBrowserCommand,
  getLastLaunchRequest,
  resetBrowserMock,
  seedRuntimeStatuses,
} from "@/lib/browserMock";
import { useSettingsStore } from "./settingsStore";
import {
  ALL_RUNTIME_TARGETS,
  RUNTIME_POLL_INTERVAL_MS,
  runtimeStatusKind,
  useRuntimeStore,
} from "./runtimeStore";

vi.mock("@/lib/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invoke")>();
  return {
    ...actual,
    invoke: vi.fn(
      async <T,>(cmd: string, args?: Record<string, unknown>) =>
        handleBrowserCommand<T>(cmd, args),
    ),
  };
});

const { invoke } = await import("@/lib/invoke");

function runtime(
  target: TargetKind,
  overrides?: Partial<TargetRuntimeStatus>,
): TargetRuntimeStatus {
  return {
    target,
    installed: true,
    running: false,
    pid: null,
    executablePath: `C:/tools/${target}.cmd`,
    error: null,
    ...overrides,
  };
}

function resetStore() {
  useRuntimeStore.setState({
    statuses: {
      claude_code: undefined,
      codex: undefined,
      omp: undefined,
      zcode: undefined,
      dsh: undefined,
      pi: undefined,
    },
    statusKind: {
      claude_code: undefined,
      codex: undefined,
      omp: undefined,
      zcode: undefined,
      dsh: undefined,
      pi: undefined,
    },
    launchErrors: {
      claude_code: null,
      codex: null,
      omp: null,
      zcode: null,
      dsh: null,
      pi: null,
    },
    starting: {
      claude_code: false,
      codex: false,
      omp: false,
      zcode: false,
      dsh: false,
      pi: false,
    },
    loading: false,
    hydrated: false,
    pollTimer: null,
  });
}

describe("runtimeStatusKind", () => {
  it("maps raw status to the aggregate kind", () => {
    const installed = runtime("codex");
    expect(runtimeStatusKind(installed)).toBe("not_running");
    expect(runtimeStatusKind(runtime("codex", { running: true }))).toBe("running");
    expect(runtimeStatusKind(runtime("omp", { installed: false }))).toBe("not_installed");
    expect(runtimeStatusKind(installed, { starting: true })).toBe("starting");
    expect(runtimeStatusKind(installed, { launchError: "boom" })).toBe("launch_failed");
    // A running target clears the failure state even if an error lingers.
    expect(
      runtimeStatusKind(runtime("codex", { running: true }), { launchError: "boom" }),
    ).toBe("running");
    expect(runtimeStatusKind(undefined)).toBe("not_installed");
  });
});

describe("runtimeStore", () => {
  beforeEach(() => {
    resetBrowserMock();
    resetStore();
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        launchWorkingDirectories: {},
      },
      loaded: true,
      loading: false,
    });
    vi.mocked(invoke).mockClear();
  });

  afterEach(() => {
    useRuntimeStore.getState().stopPolling();
    cleanup();
  });

  it("loads statuses for all six targets", async () => {
    seedRuntimeStatuses([
      runtime("claude_code", { running: true, pid: 11 }),
      runtime("codex"),
      runtime("omp", { installed: false }),
      runtime("zcode", { running: true, pid: 12 }),
      runtime("dsh"),
      runtime("pi"),
    ]);
    await act(async () => {
      await useRuntimeStore.getState().loadRuntimeStatuses();
    });
    const state = useRuntimeStore.getState();
    expect(ALL_RUNTIME_TARGETS.map((t) => state.statuses[t]?.target)).toEqual(
      ALL_RUNTIME_TARGETS,
    );
    expect(state.statusKind.claude_code).toBe("running");
    expect(state.statusKind.codex).toBe("not_running");
    expect(state.statusKind.omp).toBe("not_installed");
    expect(state.statusKind.zcode).toBe("running");
    expect(state.statusKind.dsh).toBe("not_running");
    expect(state.statusKind.pi).toBe("not_running");
  });

  it("blocks duplicate launch requests while one is in flight", async () => {
    seedRuntimeStatuses([runtime("claude_code")]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "launch_target") {
        await gate;
      }
      return handleBrowserCommand(cmd, args);
    });
    const first = useRuntimeStore.getState().launchTarget("claude_code", "D:/proj");
    const second = useRuntimeStore.getState().launchTarget("claude_code", "D:/proj");
    await Promise.resolve();
    release();
    await Promise.allSettled([first, second]);
    const launches = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "launch_target");
    expect(launches).toHaveLength(1);
  });

  it("keeps launch_failed with the redacted error until the target runs", async () => {
    seedRuntimeStatuses([runtime("codex", { installed: false })]);
    await expect(
      useRuntimeStore.getState().launchTarget("codex"),
    ).rejects.toMatchObject({ code: "not_installed" });
    let state = useRuntimeStore.getState();
    expect(state.statusKind.codex).toBe("launch_failed");
    expect(state.launchErrors.codex).toBeTruthy();

    // Still failing on the next poll → failure state survives.
    await act(async () => {
      await useRuntimeStore.getState().loadRuntimeStatuses({ background: true });
    });
    state = useRuntimeStore.getState();
    expect(state.statusKind.codex).toBe("launch_failed");

    seedRuntimeStatuses([runtime("codex", { running: true, pid: 9 })]);
    await act(async () => {
      await useRuntimeStore.getState().loadRuntimeStatuses({ background: true });
    });
    expect(useRuntimeStore.getState().statusKind.codex).toBe("running");
  });

  it("passes the working directory through launch_target", async () => {
    seedRuntimeStatuses([runtime("omp")]);
    await useRuntimeStore.getState().launchTarget("omp", "D:/my project");
    expect(getLastLaunchRequest()).toEqual({
      target: "omp",
      workingDirectory: "D:/my project",
    });
  });

  it("persists the chosen working directory into settings", async () => {
    await useRuntimeStore.getState().setWorkingDirectory("dsh", "D:/repo");
    const saves = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "save_settings");
    expect(saves).toHaveLength(1);
    expect(useSettingsStore.getState().settings.launchWorkingDirectories.dsh).toBe("D:/repo");
  });

  it("stops polling after the page unmounts", async () => {
    vi.useFakeTimers();
    try {
      seedRuntimeStatuses([runtime("claude_code")]);
      // Mirrors the ApplyPage effect: start polling on mount, stop on unmount.
      function PollingPage() {
        const startPolling = useRuntimeStore((s) => s.startPolling);
        const stopPolling = useRuntimeStore((s) => s.stopPolling);
        useEffect(() => {
          startPolling();
          return () => stopPolling();
        }, [startPolling, stopPolling]);
        return null;
      }
      const { unmount } = render(<PollingPage />);
      expect(useRuntimeStore.getState().pollTimer).not.toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(RUNTIME_POLL_INTERVAL_MS * 3);
      });
      const polled = vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "list_target_runtime_statuses").length;
      expect(polled).toBeGreaterThanOrEqual(3);

      unmount();
      expect(useRuntimeStore.getState().pollTimer).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(RUNTIME_POLL_INTERVAL_MS * 3);
      });
      const after = vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "list_target_runtime_statuses").length;
      expect(after).toBe(polled);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("browserMock runtime contract", () => {
  beforeEach(() => {
    resetBrowserMock();
  });

  it("answers all four runtime commands with the Rust shapes", async () => {
    const list = await handleBrowserCommand<TargetRuntimeStatus[]>(
      "list_target_runtime_statuses",
      {},
    );
    expect(list.map((s) => s.target)).toEqual(ALL_RUNTIME_TARGETS);
    for (const row of list) {
      expect(typeof row.installed).toBe("boolean");
      expect(typeof row.running).toBe("boolean");
      expect("pid" in row && "executablePath" in row && "error" in row).toBe(true);
    }

    const one = await handleBrowserCommand<TargetRuntimeStatus>(
      "get_target_runtime_status",
      { target: "zcode" },
    );
    expect(one.target).toBe("zcode");

    seedRuntimeStatuses([runtime("claude_code")]);
    const launched = await handleBrowserCommand<TargetRuntimeStatus>("launch_target", {
      req: { target: "claude_code", workingDirectory: "D:/w" },
    });
    expect(launched.running).toBe(true);

    const focused = await handleBrowserCommand<TargetRuntimeStatus>("focus_target", {
      target: "claude_code",
    });
    expect(focused.target).toBe("claude_code");

    await expect(
      handleBrowserCommand("focus_target", { target: "dsh" }),
    ).rejects.toMatchObject({ code: "not_running" });
  });
});