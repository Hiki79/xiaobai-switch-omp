import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetUpdateCheckerForTests, useUpdateChecker } from "./useUpdateChecker";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  info: vi.fn(),
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
  messageInfo: vi.fn(),
  hideLoading: vi.fn(),
  messageLoading: vi.fn(),
  isTauri: vi.fn(() => true),
  invoke: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  Update: class Update {
    version: string;
    body?: string | null;
    constructor(metadata: { version: string; body?: string | null }) {
      this.version = metadata.version;
      this.body = metadata.body;
    }
    close = async () => undefined;
    downloadAndInstall = async () => undefined;
  },
}));

vi.mock("@/lib/invoke", () => ({
  isTauri: () => mocks.isTauri(),
  invoke: mocks.invoke,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("antd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("antd")>();
  return {
    ...actual,
    App: {
      ...actual.App,
      useApp: () => ({
        modal: {
          confirm: mocks.confirm,
          info: mocks.info,
        },
        message: {
          success: mocks.messageSuccess,
          error: mocks.messageError,
          info: mocks.messageInfo,
          loading: mocks.messageLoading,
        },
      }),
    },
  };
});

function updateMetadata(update: { version: string; body?: string | null } | null) {
  if (!update) return null;
  return {
    rid: 1,
    currentVersion: "0.0.1",
    version: update.version,
    body: update.body ?? null,
    rawJson: {},
  };
}

async function checkForUpdate(update: { version: string; body?: string | null } | null) {
  mocks.invoke.mockResolvedValue(updateMetadata(update));
  const { result } = renderHook(() => useUpdateChecker());

  let found = false;
  await act(async () => {
    found = await result.current.checkForUpdate();
  });

  return {
    found,
    confirm: mocks.confirm.mock.calls[mocks.confirm.mock.calls.length - 1]?.[0],
  };
}

describe("useUpdateChecker", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    resetUpdateCheckerForTests();
    mocks.isTauri.mockReturnValue(true);
    mocks.messageLoading.mockReturnValue(mocks.hideLoading);
  });

  it("toasts when already on the latest version", async () => {
    const { found } = await checkForUpdate(null);
    expect(found).toBe(false);
    expect(mocks.messageLoading).toHaveBeenCalledWith("settings.checkingUpdate", 0);
    expect(mocks.hideLoading).toHaveBeenCalled();
    expect(mocks.messageSuccess).toHaveBeenCalledWith("settings.noUpdate");
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("stays silent when no update is found during an auto-check", async () => {
    mocks.invoke.mockResolvedValue(null);
    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      expect(await result.current.checkForUpdate({ silent: true })).toBe(false);
    });
    expect(mocks.messageLoading).not.toHaveBeenCalled();
    expect(mocks.messageSuccess).not.toHaveBeenCalled();
    expect(mocks.messageError).not.toHaveBeenCalled();
  });

  it("explains when a manual check runs outside the desktop app", async () => {
    mocks.isTauri.mockReturnValue(false);
    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      expect(await result.current.checkForUpdate()).toBe(false);
    });
    expect(mocks.messageInfo).toHaveBeenCalledWith("settings.checkUpdateDesktopOnly");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("waits on an in-flight silent check and still reports the result", async () => {
    let resolveCheck: ((value: null) => void) | undefined;
    mocks.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const { result } = renderHook(() => useUpdateChecker());

    let silentDone = false;
    let manualDone = false;
    let silentFound = true;
    let manualFound = true;

    act(() => {
      void result.current.checkForUpdate({ silent: true }).then((found) => {
        silentFound = found;
        silentDone = true;
      });
    });
    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });

    act(() => {
      void result.current.checkForUpdate().then((found) => {
        manualFound = found;
        manualDone = true;
      });
    });

    expect(mocks.messageLoading).toHaveBeenCalledWith("settings.checkingUpdate", 0);
    expect(silentDone).toBe(false);
    expect(manualDone).toBe(false);

    await act(async () => {
      resolveCheck?.(null);
    });

    await waitFor(() => {
      expect(silentDone).toBe(true);
      expect(manualDone).toBe(true);
    });
    expect(silentFound).toBe(false);
    expect(manualFound).toBe(false);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.messageSuccess).toHaveBeenCalledWith("settings.noUpdate");
    expect(mocks.hideLoading).toHaveBeenCalled();
  });

  it("renders update.body as release notes", async () => {
    const body = "## Changes\n\n- Fix apply";
    const { found, confirm } = await checkForUpdate({ version: "1.2.3", body });

    expect(found).toBe(true);
    render(confirm.content);

    expect(screen.getByText("settings.newVersion: 1.2.3")).toBeInTheDocument();
    expect(screen.getByTestId("update-release-notes")).toHaveTextContent(body, {
      normalizeWhitespace: false,
    });
  });

  it("does not render a release notes region when update.body is absent", async () => {
    const { confirm } = await checkForUpdate({ version: "1.2.4", body: null });

    render(confirm.content);

    expect(screen.getByText("settings.newVersion: 1.2.4")).toBeInTheDocument();
    expect(screen.queryByTestId("update-release-notes")).not.toBeInTheDocument();
  });

  it("checks updates through the host so network proxy settings apply", async () => {
    mocks.invoke.mockResolvedValue(null);
    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      expect(await result.current.checkForUpdate()).toBe(false);
    });
    expect(mocks.invoke).toHaveBeenCalledWith("check_app_update");
  });

  it("does not toast a failed silent check", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.invoke.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      expect(await result.current.checkForUpdate({ silent: true })).toBe(false);
    });
    expect(mocks.messageError).not.toHaveBeenCalled();
    expect(mocks.messageLoading).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
