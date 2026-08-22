import { fireEvent, render, screen, within } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SiteModel } from "@/types/domain";
import { ModelCatalogSection } from "./ModelCatalogSection";
import "@/i18n";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

const models: SiteModel[] = [
  { id: "1", siteId: "s", modelId: "glm-5.3", displayName: "GLM 5.3", ownedBy: null, raw: null },
  { id: "2", siteId: "s", modelId: "deepseek-chat", displayName: "deepseek-chat", ownedBy: null, raw: null },
  { id: "3", siteId: "s", modelId: "gpt-4.1", displayName: "gpt-4.1", ownedBy: null, raw: null },
];

function renderSection(overrides: Partial<Parameters<typeof ModelCatalogSection>[0]> = {}) {
  const onSelectedIdsChange = vi.fn();
  const onWriteAllChange = vi.fn();
  const props = {
    title: "write all",
    hint: "hint text",
    models,
    loading: false,
    writeAll: true,
    onWriteAllChange,
    selectedIds: models.map((m) => m.modelId),
    onSelectedIdsChange,
    defaultModelId: "glm-5.3",
    ...overrides,
  };
  const utils = render(
    <Wrapper>
      <ModelCatalogSection {...props} />
    </Wrapper>,
  );
  return { ...utils, props };
}

describe("ModelCatalogSection", () => {
  it("hides the picker until the switch is on", () => {
    renderSection({ writeAll: false });
    expect(screen.queryByPlaceholderText(/搜索|Search/i)).toBeNull();
  });

  it("filters the checkbox list by keyword without touching the selection", () => {
    const { props } = renderSection();
    const input = screen.getByPlaceholderText(/搜索|Search/i);
    fireEvent.change(input, { target: { value: "deepseek" } });
    expect(screen.getByText("deepseek-chat")).toBeInTheDocument();
    expect(screen.queryByText("gpt-4.1")).toBeNull();
    expect(props.onSelectedIdsChange).not.toHaveBeenCalled();
  });

  it("keeps the default model checked and disabled", () => {
    renderSection({ selectedIds: ["gpt-4.1"], defaultModelId: "glm-5.3" });
    const glmLabel = screen.getByText("GLM 5.3 (glm-5.3)").closest("label")!;
    const checkbox = within(glmLabel).getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    expect(checkbox).toBeChecked();
  });

  it("reports checked ids for a toggled model", () => {
    const { props } = renderSection();
    const row = screen.getByText("deepseek-chat").closest("label")!;
    fireEvent.click(within(row).getByRole("checkbox"));
    expect(props.onSelectedIdsChange).toHaveBeenCalledWith(["glm-5.3", "gpt-4.1"]);
  });

  it("shows an empty state when the site has no models", () => {
    renderSection({ models: [], selectedIds: [] });
    expect(screen.getByText(/站点还没有模型|no models yet/i)).toBeInTheDocument();
  });
});
