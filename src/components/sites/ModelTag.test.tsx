import { fireEvent, render, screen } from "@testing-library/react";
import { ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ModelCountBadge, ModelTag } from "./ModelTag";
import "@/i18n";

function Wrapper({ children }: { children: ReactNode }) {
  return <ConfigProvider>{children}</ConfigProvider>;
}

describe("ModelTag", () => {
  it("marks selected and picked states for styling", () => {
    render(
      <Wrapper>
        <ModelTag title="gpt-4.1" selected picked>
          gpt-4.1
        </ModelTag>
      </Wrapper>,
    );

    const tag = screen.getByTitle("gpt-4.1");
    expect(tag).toHaveAttribute("data-model-tag");
    expect(tag).toHaveAttribute("data-selected", "true");
    expect(tag).toHaveAttribute("data-picked", "true");
    expect(tag).toHaveClass("model-tag");
  });

  it("invokes onClick from pointer and keyboard", () => {
    const onClick = vi.fn();
    render(
      <Wrapper>
        <ModelTag title="gpt-4.1" onClick={onClick}>
          gpt-4.1
        </ModelTag>
      </Wrapper>,
    );

    const tag = screen.getByTitle("gpt-4.1");
    fireEvent.click(tag);
    fireEvent.keyDown(tag, { key: "Enter" });
    fireEvent.keyDown(tag, { key: " " });
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("closes without selecting the model", () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    render(
      <Wrapper>
        <ModelTag title="gpt-4.1" closable onClick={onClick} onClose={onClose}>
          gpt-4.1
        </ModelTag>
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除模型" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("ModelCountBadge", () => {
  it("renders a compact count without interactive chrome", () => {
    render(
      <Wrapper>
        <ModelCountBadge>1 个模型</ModelCountBadge>
      </Wrapper>,
    );

    const badge = screen.getByText("1 个模型");
    expect(badge).toHaveAttribute("data-model-count");
    expect(badge).toHaveClass("model-count-badge");
    expect(Number.parseFloat(badge.style.fontSize)).toBeLessThan(12);
  });
});
