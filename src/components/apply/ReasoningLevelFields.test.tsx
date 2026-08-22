import { fireEvent, render, screen } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ReasoningLevelFields } from "./ReasoningLevelFields";
import "@/i18n";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

function renderFields(overrides: Partial<Parameters<typeof ReasoningLevelFields>[0]> = {}) {
  const onLevelsChange = vi.fn();
  const onDefaultLevelChange = vi.fn();
  const props = {
    levels: ["low", "high", "max"] as string[],
    onLevelsChange,
    defaultLevel: "max",
    onDefaultLevelChange,
    defaultLabel: "Default level",
    defaultHint: "default hint",
    variantsHint: "variants hint",
    ...overrides,
  };
  const utils = render(
    <Wrapper>
      <ReasoningLevelFields {...props} />
    </Wrapper>,
  );
  return { ...utils, props, onLevelsChange, onDefaultLevelChange };
}

function openAndGetOption(select: HTMLElement, text: string) {
  fireEvent.mouseDown(select);
  const popup = document.querySelector(".ant-select-dropdown:last-of-type");
  if (!popup) throw new Error("select dropdown not open");
  const option = Array.from(popup.querySelectorAll(".ant-select-item-option")).find((el) =>
    el.textContent?.includes(text),
  );
  if (!option) throw new Error(`option ${text} not found`);
  return option;
}

describe("ReasoningLevelFields", () => {
  it("renders the default level select and variant tags", () => {
    renderFields();
    expect(screen.getByText("Default level")).toBeInTheDocument();
    expect(screen.getByText(/可用等级|Available levels/i)).toBeInTheDocument();
    // The default select shows the current value plus one tag per level.
    expect(screen.getAllByTitle("low").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("high").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("max").length).toBeGreaterThan(0);
  });

  it("filters levels to the CLI whitelist and repairs an invalid default", () => {
    const { onLevelsChange, onDefaultLevelChange } = renderFields({
      levels: ["low", "custom-level", "high"],
      defaultLevel: "custom-level",
      allowed: ["off", "low", "high", "max"],
    });
    const selects = screen.getAllByRole("combobox");
    const variantsSelect = selects[selects.length - 1];
    fireEvent.click(openAndGetOption(variantsSelect, "off"));
    const changed = onLevelsChange.mock.calls[0][0];
    expect(changed).toEqual(["low", "high", "off"]);
    expect(onDefaultLevelChange).toHaveBeenCalledWith("low");
  });

  it("keeps a default level that is still in the list", () => {
    const { onLevelsChange, onDefaultLevelChange } = renderFields({
      levels: ["low", "high"],
      defaultLevel: "high",
      allowed: ["off", "low", "high", "max"],
    });
    const selects = screen.getAllByRole("combobox");
    const variantsSelect = selects[selects.length - 1];
    fireEvent.click(openAndGetOption(variantsSelect, "off"));
    expect(onLevelsChange).toHaveBeenCalledWith(["low", "high", "off"]);
    expect(onDefaultLevelChange).not.toHaveBeenCalled();
  });
});
