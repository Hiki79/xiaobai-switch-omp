import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBrowserMock } from "@/lib/browserMock";
import {
  GITHUB_ISSUES_URL,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_URL,
} from "@/lib/constants";
import { useSettingsStore, useUIStore } from "@/stores";
import { SettingsPage } from "./SettingsPage";
import "@/i18n";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as {
  version: string;
};

describe("SettingsPage network", () => {
  beforeEach(() => {
    resetBrowserMock();
    useUIStore.setState({ settingsTab: "network" });
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, proxyMode: "system" },
      loaded: false,
      loading: false,
    });
  });

  afterEach(() => {
    resetBrowserMock();
    useUIStore.setState({ settingsTab: "general" });
  });

  it("shows proxy modes and custom fields only when custom is selected", async () => {
    render(
      <Wrapper>
        <SettingsPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("代理模式")).toBeInTheDocument();
    });
    expect(screen.getByText("系统代理")).toBeInTheDocument();
    expect(screen.queryByText("主机 / IP")).toBeNull();

    fireEvent.mouseDown(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByTitle("自定义"));

    await waitFor(() => {
      expect(screen.getByText("主机 / IP")).toBeInTheDocument();
      expect(screen.getByText("端口")).toBeInTheDocument();
    });
    expect(useSettingsStore.getState().settings.proxyMode).toBe("custom");
    expect(screen.getByText("测速结果有效期")).toBeInTheDocument();
    expect(screen.queryByText("设置已保存")).toBeNull();
  });
});

describe("SettingsPage about", () => {
  beforeEach(() => {
    resetBrowserMock();
    useUIStore.setState({ settingsTab: "about" });
    useSettingsStore.setState({
      settings: useSettingsStore.getState().settings,
      loaded: false,
      loading: false,
    });
  });

  afterEach(() => {
    resetBrowserMock();
    useUIStore.setState({ settingsTab: "general" });
  });

  it("shows the actual package version instead of a hardcoded placeholder", async () => {
    render(
      <Wrapper>
        <SettingsPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(useSettingsStore.getState().loaded).toBe(true);
      expect(screen.getByText(pkg.version)).toBeInTheDocument();
      expect(screen.getByText("~/.xiaobai-switch")).toBeInTheDocument();
    });
  });

  it("shows the app logo and GitHub link entries", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <Wrapper>
        <SettingsPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "XiaoBaiSwitch" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /GitHub 仓库/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /问题反馈/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /版本发布/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /GitHub 仓库/ }));
    expect(open).toHaveBeenCalledWith(GITHUB_REPO_URL, "_blank", "noopener,noreferrer");

    fireEvent.click(screen.getByRole("button", { name: /问题反馈/ }));
    expect(open).toHaveBeenCalledWith(GITHUB_ISSUES_URL, "_blank", "noopener,noreferrer");

    fireEvent.click(screen.getByRole("button", { name: /版本发布/ }));
    expect(open).toHaveBeenCalledWith(GITHUB_RELEASES_URL, "_blank", "noopener,noreferrer");

    open.mockRestore();
  });
});
