import { fireEvent, render, screen } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBrowserMock, seedBackups } from "@/lib/browserMock";
import { useApplyStore } from "@/stores";
import type { BackupInfo } from "@/types/domain";
import { ApplyFooter } from "./ApplyFooter";
import "@/i18n";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

const backup: BackupInfo = {
  id: "claude_code-1710000000000",
  target: "claude_code",
  dir: "/tmp/backups/claude_code/1710000000000",
  createdAt: 1710000000000,
  files: ["settings.json"],
  applyRecordId: "rec-1",
  siteNameSnapshot: "shuai",
  modelId: "gpt-5.6",
};

describe("ApplyFooter", () => {
  beforeEach(() => {
    resetBrowserMock();
    seedBackups([backup]);
    useApplyStore.setState({ backups: [] });
  });

  it("puts backup records beside apply and opens them in a modal", async () => {
    const onApply = vi.fn();
    render(
      <Wrapper>
        <ApplyFooter target="claude_code" loading={false} disabled={false} onApply={onApply} />
      </Wrapper>,
    );

    const footer = screen.getByTestId("apply-footer");
    expect(footer).toHaveTextContent("配置备份记录");
    expect(footer).toHaveTextContent("应用配置");
    expect(screen.getByRole("button", { name: /配置备份记录/ }).querySelector("svg.lucide")).toBeTruthy();
    expect(screen.getByRole("button", { name: "应用配置" }).querySelector("svg.lucide")).toBeTruthy();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /配置备份记录/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("配置备份记录");
    expect(await screen.findByText("shuai")).toBeInTheDocument();
    expect(screen.getByText("（gpt-5.6）")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "应用配置" }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("does not list backups until the modal is opened", () => {
    render(
      <Wrapper>
        <ApplyFooter target="claude_code" loading={false} disabled={false} onApply={() => {}} />
      </Wrapper>,
    );
    expect(screen.queryByText("shuai")).not.toBeInTheDocument();
    expect(screen.queryByText("暂无备份")).not.toBeInTheDocument();
  });
});
