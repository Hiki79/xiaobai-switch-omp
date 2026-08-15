import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBrowserMock } from "@/lib/browserMock";
import { useSiteStore, useUIStore } from "@/stores";
import { SitesPage } from "./SitesPage";
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
  await useSiteStore.getState().fetchModels(site.id);
  useUIStore.getState().setSelectedSiteId(site.id);
  return site;
}

describe("SitesPage", () => {
  beforeEach(() => {
    resetBrowserMock();
    useSiteStore.setState({
      sites: [],
      modelsBySite: {},
      modelsLoadingBySite: {},
      loading: false,
      hydrated: false,
      fetchingModels: false,
      error: null,
    });
    useUIStore.setState({ selectedSiteId: null, activePage: "sites", pendingSiteForm: null });
  });

  afterEach(() => {
    resetBrowserMock();
  });

  it("renders detail without a card, current-model copy, small add, and apply beside the site name", async () => {
    await act(async () => {
      await seedSite();
    });

    render(
      <Wrapper>
        <SitesPage />
      </Wrapper>,
    );

    const tag = await waitFor(() => {
      const el = document.querySelector('.ant-tag[title="gpt-4.1"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });

    expect(document.querySelector(".ant-card")).toBeNull();
    expect(screen.queryByText("列表没有？手动输入")).toBeNull();
    expect(screen.getByText("（当前模型：gpt-4.1）")).toBeInTheDocument();

    const search = screen.getByPlaceholderText("搜索模型…");
    expect(search.closest(".ant-input-search")).not.toHaveClass("ant-input-search-small");
    expect(search.closest(".ant-input-affix-wrapper")).not.toHaveClass(
      "ant-input-affix-wrapper-sm",
    );

    expect(tag.querySelector(".ant-tag-close-icon")).toBeTruthy();

    const addBtn = screen.getByRole("button", { name: "手动添加" });
    expect(addBtn.className).toMatch(/ant-btn-sm/);
    expect(addBtn.compareDocumentPosition(screen.getByText("主模型")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    const applyBtn = screen.getByRole("button", { name: /去 Claude Code 应用|去 Codex 应用/ });
    expect(applyBtn.className).toMatch(/ant-btn-sm/);
    const detailName = document.querySelector(".text-base.font-medium");
    expect(detailName?.textContent).toBe("Relay One");
    expect(applyBtn.compareDocumentPosition(detailName as Node) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it("opens a modal to add a model manually", async () => {
    await act(async () => {
      await seedSite();
    });

    render(
      <Wrapper>
        <SitesPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "手动添加" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "手动添加" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("手动添加模型")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByPlaceholderText("输入 model id"), {
      target: { value: "gpt-5.6-terra" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /保\s*存/ }));

    await waitFor(() => {
      expect(document.querySelector('.ant-tag[title="gpt-5.6-terra"]')).toBeTruthy();
    });
    expect(useSiteStore.getState().sites[0]?.selectedModelId).toBe("gpt-5.6-terra");
  });

  it("offers edit and delete on site list context menu", async () => {
    await act(async () => {
      await seedSite();
    });

    render(
      <Wrapper>
        <SitesPage />
      </Wrapper>,
    );

    const item = await screen.findByRole("button", { name: /Relay One/ });
    fireEvent.contextMenu(item);

    expect(await screen.findByRole("menuitem", { name: "编辑站点" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "删除站点" })).toBeInTheDocument();
  });

  it("centers an empty-model hint with a fetch button", async () => {
    await act(async () => {
      const site = await useSiteStore.getState().createSite({
        name: "Empty One",
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
      });
      useUIStore.getState().setSelectedSiteId(site.id);
    });

    render(
      <Wrapper>
        <SitesPage />
      </Wrapper>,
    );

    const hint = await screen.findByText("暂无模型，请先拉取或手动添加");
    expect(hint.parentElement).toHaveClass("justify-center");

    const fetchInEmpty = hint.parentElement?.querySelector("button");
    expect(fetchInEmpty).toBeTruthy();
    expect(fetchInEmpty).toHaveTextContent("拉取模型");
    expect(fetchInEmpty?.className).toMatch(/ant-btn-sm/);
    expect(document.querySelector("[data-model-list]")).toBeTruthy();

    fireEvent.click(fetchInEmpty as HTMLButtonElement);
    await waitFor(() => {
      expect(document.querySelector(".ant-tag")).toBeTruthy();
    });
    const toasts = await screen.findAllByText("同步模型成功，本次同步 2 个模型");
    expect(toasts).toHaveLength(1);
    expect(screen.queryByText("成功")).toBeNull();
  });

  it("shows edit and delete from the site row more menu", async () => {
    await act(async () => {
      await seedSite();
    });

    render(
      <Wrapper>
        <SitesPage />
      </Wrapper>,
    );

    const more = await screen.findByRole("button", { name: "更多操作" });
    fireEvent.click(more);

    expect(await screen.findByRole("menuitem", { name: "编辑站点" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "删除站点" })).toBeInTheDocument();
  });

  it("clears all models from the header button", async () => {
    await act(async () => {
      await seedSite();
    });

    render(
      <Wrapper>
        <SitesPage />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(document.querySelector('.ant-tag[title="gpt-4.1"]')).toBeTruthy();
    });

    const addBtn = screen.getByRole("button", { name: "手动添加" });
    const clearBtn = screen.getByRole("button", { name: /清\s*空/ });
    expect(clearBtn.className).toMatch(/ant-btn-sm/);
    expect(addBtn.compareDocumentPosition(clearBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(clearBtn);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /确\s*认/ }));

    await waitFor(() => {
      expect(document.querySelector(".ant-tag")).toBeNull();
    });
    expect(await screen.findByText("清空模型成功")).toBeInTheDocument();
    expect(screen.queryByText("成功")).toBeNull();
    expect(useSiteStore.getState().modelsBySite[useUIStore.getState().selectedSiteId ?? ""]).toEqual(
      [],
    );
  });

  it("opens the route dropdown and can switch the active base url", async () => {
    await act(async () => {
      const created = await useSiteStore.getState().createSite({
        name: "Relay One",
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
      });
      await useSiteStore.getState().updateSite(created.id, {
        baseUrls: ["https://api.example.com", "https://api2.example.com"],
      });
      useUIStore.getState().setSelectedSiteId(created.id);
    });

    render(
      <Wrapper>
        <SitesPage />
      </Wrapper>,
    );

    const trigger = await screen.findByRole("button", { name: "切换线路" });
    fireEvent.click(trigger);

    expect(await screen.findByText("https://api2.example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /测\s*速/ })).toBeInTheDocument();

    fireEvent.click(screen.getByText("https://api2.example.com"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText("切换线路？").length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: /取\s*消/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "跳过应用" })).toBeInTheDocument();
    expect(useSiteStore.getState().sites[0]?.baseUrl).toBe("https://api.example.com");

    fireEvent.click(within(dialog).getByRole("button", { name: /确\s*认/ }));
    await waitFor(() => {
      expect(useSiteStore.getState().sites[0]?.baseUrl).toBe("https://api2.example.com");
    });
  });

  it("can switch a route without applying to target CLIs", async () => {
    await act(async () => {
      const created = await useSiteStore.getState().createSite({
        name: "Relay One",
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
      });
      await useSiteStore.getState().updateSite(created.id, {
        baseUrls: ["https://api.example.com", "https://api2.example.com"],
      });
      useUIStore.getState().setSelectedSiteId(created.id);
    });

    render(
      <Wrapper>
        <SitesPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "切换线路" }));
    fireEvent.click(await screen.findByText("https://api2.example.com"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "跳过应用" }));
    await waitFor(() => {
      expect(useSiteStore.getState().sites[0]?.baseUrl).toBe("https://api2.example.com");
    });
  });

  it("does not switch the route when the confirm dialog is cancelled", async () => {
    await act(async () => {
      const created = await useSiteStore.getState().createSite({
        name: "Relay One",
        baseUrl: "https://api.example.com",
        apiKey: "sk-test",
      });
      await useSiteStore.getState().updateSite(created.id, {
        baseUrls: ["https://api.example.com", "https://api2.example.com"],
      });
      useUIStore.getState().setSelectedSiteId(created.id);
    });

    render(
      <Wrapper>
        <SitesPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "切换线路" }));
    fireEvent.click(await screen.findByText("https://api2.example.com"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /取\s*消/ }));
    expect(useSiteStore.getState().sites[0]?.baseUrl).toBe("https://api.example.com");
  });

  it("removes a model when the tag close icon is clicked", async () => {
    await act(async () => {
      await seedSite();
    });

    render(
      <Wrapper>
        <SitesPage />
      </Wrapper>,
    );

    const tag = await waitFor(() => {
      const el = document.querySelector('.ant-tag[title="gpt-4.1"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });

    const close = tag.querySelector(".ant-tag-close-icon");
    expect(close).toBeTruthy();
    fireEvent.click(close as Element);

    await waitFor(() => {
      expect(document.querySelector('.ant-tag[title="gpt-4.1"]')).toBeNull();
    });
    expect(
      useSiteStore.getState().modelsBySite[useUIStore.getState().selectedSiteId ?? ""]?.some(
        (m) => m.modelId === "gpt-4.1",
      ),
    ).toBe(false);
  });
});
