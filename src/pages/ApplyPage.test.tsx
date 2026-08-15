import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBrowserMock } from "@/lib/browserMock";
import { useApplyStore, useSiteStore, useUIStore } from "@/stores";
import { ApplyPage } from "./ApplyPage";
import "@/i18n";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

async function seedSite() {
  const site = await useSiteStore.getState().createSite({
    name: "Relay One",
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
  });
  useUIStore.getState().setSelectedSiteId(site.id);
  return site;
}

function resetStores() {
  resetBrowserMock();
  useSiteStore.setState({
    sites: [],
    modelsBySite: {},
    modelsLoadingBySite: {},
    loading: false,
    hydrated: true,
    fetchingModels: false,
    error: null,
  });
  useUIStore.setState({
    selectedSiteId: null,
    applyPrefillSiteId: null,
    activePage: "apply",
    applyTab: "claude_code",
  });
  useApplyStore.setState({
    statuses: [],
    tools: [],
    records: [],
    backups: [],
    applying: false,
    loading: false,
    statusHydrated: true,
    lastResult: null,
  });
}

describe("ApplyPage target switch", () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    resetStores();
  });

  it("shows a skeleton immediately when switching to an unvisited target", async () => {
    await seedSite();
    render(
      <Wrapper>
        <ApplyPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("鉴权字段")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Codex" }));

    expect(document.querySelector("[aria-busy='true']")).toBeTruthy();
    expect(screen.queryByText("将站点全部模型写入 Codex")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("将站点全部模型写入 Codex")).toBeInTheDocument();
    });
  });

  it("keeps a visited target mounted so switching back is instant", async () => {
    await seedSite();
    render(
      <Wrapper>
        <ApplyPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByText("鉴权字段")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Codex" }));
    });
    await waitFor(() => {
      expect(screen.getByText("将站点全部模型写入 Codex")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("menuitem", { name: "Claude Code" }));
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
    expect(screen.getByText("鉴权字段")).toBeInTheDocument();
  });
});
