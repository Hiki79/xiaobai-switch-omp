import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateChecker } from "./useUpdateChecker";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  confirm: vi.fn(),
  info: vi.fn(),
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
  isTauri: vi.fn(() => true),
  invoke: vi.fn(async () => undefined),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mocks.check,
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
        },
      }),
    },
  };
});

async function checkForUpdate(update: { version: string; body?: string | null } | null) {
  mocks.check.mockResolvedValue(update);
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
    mocks.isTauri.mockReturnValue(true);
  });

  it("toasts when already on the latest version", async () => {
    const { found } = await checkForUpdate(null);
    expect(found).toBe(false);
    expect(mocks.messageSuccess).toHaveBeenCalledWith("settings.noUpdate");
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("stays silent when no update is found during an auto-check", async () => {
    mocks.check.mockResolvedValue(null);
    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      expect(await result.current.checkForUpdate({ silent: true })).toBe(false);
    });
    expect(mocks.messageSuccess).not.toHaveBeenCalled();
    expect(mocks.messageError).not.toHaveBeenCalled();
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

  it("does not toast a failed silent check", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.check.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      expect(await result.current.checkForUpdate({ silent: true })).toBe(false);
    });
    expect(mocks.messageError).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
