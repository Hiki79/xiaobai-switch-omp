import { fireEvent, render, screen } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { Site } from "@/types/domain";
import { SiteFormModal } from "./SiteFormModal";
import "@/i18n";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

function sampleSite(): Site {
  return {
    id: "s1",
    name: "Relay",
    baseUrl: "https://a.example.com",
    baseUrls: ["https://a.example.com", "https://b.example.com"],
    keyPrefix: "sk-t…",
    hasKey: true,
    protocol: "openai_compatible",
    claudeAuthKeyStyle: "anthropic_auth_token",
    notes: null,
    enabled: true,
    sortOrder: 0,
    selectedModelId: null,
    lastModelFetchAt: null,
    lastModelFetchLatencyMs: null,
    lastModelFetchError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("SiteFormModal base url list", () => {
  it("starts with one row and can add another", () => {
    render(
      <Wrapper>
        <SiteFormModal open site={null} onClose={() => undefined} />
      </Wrapper>,
    );

    expect(screen.getAllByPlaceholderText("https://api.example.com")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "添加线路" })[0]);
    expect(screen.getAllByPlaceholderText("https://api.example.com")).toHaveLength(2);
    expect(screen.getByText("第一项为当前 / 默认线路")).toBeInTheDocument();
  });

  it("wires dnd-kit sortable handles on each base url row", () => {
    render(
      <Wrapper>
        <SiteFormModal open site={sampleSite()} onClose={() => undefined} />
      </Wrapper>,
    );

    const grips = screen.getAllByRole("button", { name: "线路" });
    expect(grips).toHaveLength(2);
    expect(grips[0]).toHaveAttribute("aria-roledescription", "sortable");
    expect(grips[1]).toHaveAttribute("aria-roledescription", "sortable");
    expect(grips[0]).toHaveAttribute("aria-disabled", "false");

    const inputs = screen.getAllByPlaceholderText("https://api.example.com");
    expect(inputs[0]).toHaveValue("https://a.example.com");
    expect(inputs[1]).toHaveValue("https://b.example.com");
  });

  it("keeps Codex-specific capabilities collapsed by default", () => {
    render(
      <Wrapper>
        <SiteFormModal open site={null} onClose={() => undefined} />
      </Wrapper>,
    );

    expect(screen.getByText("Codex私有能力")).toBeInTheDocument();
    expect(document.querySelector(".ant-collapse-item-active")).toBeNull();
    expect(screen.queryByText("识图支持")).not.toBeInTheDocument();
  });

  it("expands Codex capabilities when a preset is already on", () => {
    render(
      <Wrapper>
        <SiteFormModal
          open
          site={{ ...sampleSite(), capabilities: { "codex-vision": true } }}
          onClose={() => undefined}
        />
      </Wrapper>,
    );

    expect(document.querySelector(".ant-collapse-item-active")).not.toBeNull();
    expect(screen.getByText("识图支持")).toBeInTheDocument();
  });

  it("prefills create form from a deep-link payload", () => {
    render(
      <Wrapper>
        <SiteFormModal
          open
          site={null}
          initialValues={{
            name: "Imported",
            baseUrls: ["https://a.example.com", "https://b.example.com"],
            protocol: "anthropic",
            notes: "from link",
          }}
          onClose={() => undefined}
        />
      </Wrapper>,
    );

    expect(screen.getByDisplayValue("Imported")).toBeInTheDocument();
    expect(screen.getByDisplayValue("from link")).toBeInTheDocument();
    const inputs = screen.getAllByPlaceholderText("https://api.example.com");
    expect(inputs[0]).toHaveValue("https://a.example.com");
    expect(inputs[1]).toHaveValue("https://b.example.com");
  });
});
