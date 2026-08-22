import { create } from "zustand";
import { invoke, isAppError } from "@/lib/invoke";
import type { TargetKind, TargetRuntimeStatus } from "@/types/domain";
import { useSettingsStore } from "./settingsStore";

/** Aggregate run-state shown in the launch control. */
export type RuntimeStatusKind =
  | "not_installed"
  | "not_running"
  | "starting"
  | "running"
  | "launch_failed";

export const RUNTIME_POLL_INTERVAL_MS = 4000;

export const ALL_RUNTIME_TARGETS: TargetKind[] = ["claude_code", "codex", "omp", "zcode", "dsh"];

const EMPTY_STATUS: Record<TargetKind, TargetRuntimeStatus | undefined> = {
  claude_code: undefined,
  codex: undefined,
  omp: undefined,
  zcode: undefined,
  dsh: undefined,
};

const EMPTY_KIND: Record<TargetKind, RuntimeStatusKind | undefined> = {
  claude_code: undefined,
  codex: undefined,
  omp: undefined,
  zcode: undefined,
  dsh: undefined,
};

const EMPTY_ERRORS: Record<TargetKind, string | null> = {
  claude_code: null,
  codex: null,
  omp: null,
  zcode: null,
  dsh: null,
};

const EMPTY_STARTING: Record<TargetKind, boolean> = {
  claude_code: false,
  codex: false,
  omp: false,
  zcode: false,
  dsh: false,
};

/** Derive the aggregate status kind shown in the launch control. A failed
 * launch keeps its failure state until the target actually runs. */
export function runtimeStatusKind(
  status: TargetRuntimeStatus | undefined,
  opts?: { starting?: boolean; launchError?: string | null },
): RuntimeStatusKind | undefined {
  if (opts?.starting) return "starting";
  if (!status) return "not_installed";
  if (opts?.launchError && !status.running) return "launch_failed";
  if (!status.installed) return "not_installed";
  if (status.running) return "running";
  return "not_running";
}

// Visibility listener is global (one poller at a time); it lives outside the
// store so start/stop can pair up cleanly under test.
let visibilityHandler: (() => void) | null = null;

interface RuntimeState {
  statuses: Record<TargetKind, TargetRuntimeStatus | undefined>;
  statusKind: Record<TargetKind, RuntimeStatusKind | undefined>;
  /** Redacted launch error per target; survives refresh until it runs. */
  launchErrors: Record<TargetKind, string | null>;
  /** True while a launch is in flight — guards against duplicate clicks. */
  starting: Record<TargetKind, boolean>;
  loading: boolean;
  hydrated: boolean;
  pollTimer: number | null;
  loadRuntimeStatuses: (opts?: { force?: boolean; background?: boolean }) => Promise<void>;
  launchTarget: (target: TargetKind, workingDirectory?: string | null) => Promise<void>;
  focusTarget: (target: TargetKind) => Promise<void>;
  setWorkingDirectory: (target: TargetKind, dir: string) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => {
  const tick = () => {
    // Skipped while hidden; the visibility listener refreshes on return.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    void get().loadRuntimeStatuses({ background: true }).catch(() => undefined);
  };

  return {
    statuses: EMPTY_STATUS,
    statusKind: EMPTY_KIND,
    launchErrors: EMPTY_ERRORS,
    starting: EMPTY_STARTING,
    loading: false,
    hydrated: false,
    pollTimer: null,
    loadRuntimeStatuses: async (opts) => {
      const background = opts?.background === true;
      if (!background) set({ loading: true });
      try {
        const list = await invoke<TargetRuntimeStatus[]>("list_target_runtime_statuses", {
          force: opts?.force === true,
        });
        const statuses = { ...EMPTY_STATUS };
        for (const row of list) statuses[row.target] = row;
        set((prev) => ({
          statuses,
          statusKind: Object.fromEntries(
            ALL_RUNTIME_TARGETS.map((t) => [
              t,
              runtimeStatusKind(statuses[t], {
                starting: prev.starting[t],
                launchError: prev.launchErrors[t],
              }),
            ]),
          ) as Record<TargetKind, RuntimeStatusKind>,
          hydrated: true,
        }));
      } finally {
        if (!background) set({ loading: false });
      }
    },
    launchTarget: async (target, workingDirectory) => {
      if (get().starting[target]) return;
      set((prev) => ({
        starting: { ...prev.starting, [target]: true },
        launchErrors: { ...prev.launchErrors, [target]: null },
        statusKind: { ...prev.statusKind, [target]: "starting" },
      }));
      try {
        const status = await invoke<TargetRuntimeStatus>("launch_target", {
          req: { target, workingDirectory: workingDirectory ?? null },
        });
        set((prev) => ({
          statuses: { ...prev.statuses, [target]: status },
          statusKind: {
            ...prev.statusKind,
            [target]: runtimeStatusKind(status, { launchError: prev.launchErrors[target] }),
          },
        }));
      } catch (e) {
        set((prev) => {
          const message = isAppError(e)
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e);
          return {
            launchErrors: { ...prev.launchErrors, [target]: message },
            statusKind: { ...prev.statusKind, [target]: "launch_failed" },
          };
        });
        throw e;
      } finally {
        set((prev) => ({ starting: { ...prev.starting, [target]: false } }));
      }
    },
    focusTarget: async (target) => {
      const status = await invoke<TargetRuntimeStatus>("focus_target", { target });
      set((prev) => ({
        statuses: { ...prev.statuses, [target]: status },
        statusKind: {
          ...prev.statusKind,
          [target]: runtimeStatusKind(status, { launchError: prev.launchErrors[target] }),
        },
      }));
    },
    setWorkingDirectory: async (target, dir) => {
      const current = useSettingsStore.getState().settings;
      const next = { ...(current.launchWorkingDirectories ?? {}) };
      const trimmed = dir.trim();
      if (trimmed) next[target] = trimmed;
      else delete next[target];
      await useSettingsStore.getState().saveSettings({ launchWorkingDirectories: next });
    },
    startPolling: () => {
      if (get().pollTimer != null) return;
      if (!get().hydrated) {
        void get().loadRuntimeStatuses().catch(() => undefined);
      }
      const onVisibility = () => {
        if (document.visibilityState === "visible") {
          void get().loadRuntimeStatuses({ background: true }).catch(() => undefined);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      visibilityHandler = onVisibility;
      const timer = window.setInterval(tick, RUNTIME_POLL_INTERVAL_MS);
      set({ pollTimer: timer });
    },
    stopPolling: () => {
      const timer = get().pollTimer;
      if (timer != null) {
        window.clearInterval(timer);
        set({ pollTimer: null });
      }
      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
        visibilityHandler = null;
      }
    },
  };
});