import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TargetKind, TargetRuntimeStatus } from "@/types/domain";
import { getLastLaunchRequest, resetBrowserMock, seedRuntimeStatuses } from "@/lib/browserMock";
import { useRuntimeStore } from "@/stores/runtimeStore";
import { TargetLaunchControl } from "./TargetLaunchControl";
import "@/i18n";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

function runtime(
  target: TargetKind,
  overrides?: Partial<TargetRuntimeStatus>,
): TargetRuntimeStatus {
  return {
    target,
    installed: true,
    running: false,
    pid: null,
    executablePath: `C:/tools/${target}`,
    error: null,
    ...overrides,
  };
}

function renderControl(props: Partial<Parameters<typeof TargetLaunchControl>[0]> & {
  target: TargetKind;
  runtimeStatus?: TargetRuntimeStatus;
}) {
  const onLaunch = props.onLaunch ?? vi.fn().mockResolvedValue(undefined);
  const onFocus = props.onFocus ?? vi.fn().mockResolvedValue(undefined);
  const view = render(
    <Wrapper>
      <TargetLaunchControl
        configured={props.configured ?? true}
        workingDirectory={props.workingDirectory}
        onWorkingDirectoryChange={props.onWorkingDirectoryChange}
        onLaunch={onLaunch}
        onFocus={onFocus}
        starting={props.starting}
        launchError={props.launchError}
        runtimeStatus={props.runtimeStatus}
        target={props.target}
      />
    </Wrapper>,
  );
  return { ...view, onLaunch, onFocus };
}

describe("TargetLaunchControl", () => {
  beforeEach(() => {
    resetBrowserMock();
  });

  it("shows 启动 when the target is installed but not running", () => {
    const { onLaunch } = renderControl({
      target: "claude_code",
      runtimeStatus: runtime("claude_code"),
    });
    const btn = screen.getByRole("button", { name: /启\s*动/ });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toMatch(/ant-btn-primary/);
    fireEvent.click(btn);
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("未运行")).toBeInTheDocument();
  });

  it("shows 再次打开终端 for a running TUI target", () => {
    const { onLaunch, onFocus } = renderControl({
      target: "claude_code",
      runtimeStatus: runtime("claude_code", { running: true, pid: 321 }),
    });
    fireEvent.click(screen.getByRole("button", { name: /再次打开终端/ }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onFocus).not.toHaveBeenCalled();
    expect(screen.getByText("运行中")).toBeInTheDocument();
  });

  it("shows 打开/聚焦 for the running GUI target and calls onFocus", () => {
    const { onLaunch, onFocus } = renderControl({
      target: "zcode",
      runtimeStatus: runtime("zcode", { running: true, pid: 77 }),
    });
    fireEvent.click(screen.getByRole("button", { name: /打开\/聚焦/ }));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("disables the button with 未检测到程序 when not installed", () => {
    const { onLaunch } = renderControl({
      target: "omp",
      runtimeStatus: runtime("omp", { installed: false }),
    });
    const btn = screen.getByRole("button", { name: /未检测到程序/ });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByText("未安装")).toBeInTheDocument();
  });

  it("blocks clicks while a launch is starting (no duplicate requests)", () => {
    const { onLaunch } = renderControl({
      target: "dsh",
      runtimeStatus: runtime("dsh"),
      starting: true,
    });
    const btn = screen.getByRole("button", { name: /启\s*动中/ });
    expect(btn.className).toMatch(/ant-btn-loading/);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getAllByText("启动中").length).toBeGreaterThan(0);
  });

  it("switches label and status when the target changes", () => {
    const view = renderControl({
      target: "codex",
      runtimeStatus: runtime("codex"),
    });
    expect(screen.getByText("未运行")).toBeInTheDocument();
    view.rerender(
      <Wrapper>
        <TargetLaunchControl
          configured
          target="zcode"
          runtimeStatus={runtime("zcode", { running: true })}
          onLaunch={vi.fn()}
          onFocus={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.getByText("运行中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /打开\/聚焦/ })).toBeInTheDocument();
    expect(screen.queryByText("未运行")).not.toBeInTheDocument();
  });

  it("passes the working directory when launching a TUI target", async () => {
    seedRuntimeStatuses([runtime("claude_code")]);
    renderControl({
      target: "claude_code",
      runtimeStatus: runtime("claude_code"),
      workingDirectory: "D:/my project",
      onLaunch: () => useRuntimeStore.getState().launchTarget("claude_code", "D:/my project"),
    });
    fireEvent.click(screen.getByRole("button", { name: /启\s*动/ }));
    await waitFor(() => {
      expect(getLastLaunchRequest()).toEqual({
        target: "claude_code",
        workingDirectory: "D:/my project",
      });
    });
  });

  it("shows the redacted error after a failed launch and allows retry", () => {
    renderControl({
      target: "codex",
      runtimeStatus: runtime("codex"),
      launchError: "failed to launch powershell.exe: <redacted>",
    });
    expect(screen.getByText(/<redacted>/)).toBeInTheDocument();
    expect(screen.getByText("启动失败")).toBeInTheDocument();
    // Retry stays available.
    expect(screen.getByRole("button", { name: /启\s*动/ })).toBeEnabled();
  });

  it("warns when the target has no applied config yet", () => {
    renderControl({
      target: "dsh",
      runtimeStatus: runtime("dsh"),
      configured: false,
    });
    expect(screen.getByText(/尚未应用配置/)).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /启\s*动/ });
    expect(btn.className).not.toMatch(/ant-btn-primary/);
  });

  it("only offers a working directory for TUI targets", () => {
    const { rerender } = renderControl({
      target: "claude_code",
      runtimeStatus: runtime("claude_code"),
    });
    expect(
      screen.getByPlaceholderText(/启动工作目录/),
    ).toBeInTheDocument();
    rerender(
      <Wrapper>
        <TargetLaunchControl
          configured
          target="zcode"
          runtimeStatus={runtime("zcode")}
          onLaunch={vi.fn()}
          onFocus={vi.fn()}
        />
      </Wrapper>,
    );
    expect(screen.queryByPlaceholderText(/启动工作目录/)).not.toBeInTheDocument();
  });
});