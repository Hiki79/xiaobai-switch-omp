import { fireEvent, render, screen } from "@testing-library/react";
import { App as AntdApp, ConfigProvider } from "antd";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { SiteQuota } from "@/types/domain";
import { SiteQuotaRow } from "./SiteQuotaRow";
import "@/i18n";

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

function quota(partial: Partial<SiteQuota> = {}): SiteQuota {
  return {
    status: "available",
    remainingUsd: 87.5,
    usedUsd: 12.5,
    totalUsd: 100,
    unlimited: false,
    unit: "USD",
    expiresAt: Math.floor(Date.UTC(2026, 11, 31) / 1000),
    source: "credit_grants",
    endpoint: "https://api.example.com/v1/dashboard/billing/credit_grants",
    fetchedAt: Date.now(),
    latencyMs: 12,
    error: null,
    ...partial,
  };
}

describe("SiteQuotaRow", () => {
  it("renders remaining, used/total, and a refresh control when available", () => {
    const onRefresh = vi.fn();
    render(
      <Wrapper>
        <SiteQuotaRow quota={quota()} loading={false} onRefresh={onRefresh} />
      </Wrapper>,
    );

    expect(screen.getByTestId("site-quota-row")).toBeInTheDocument();
    expect(screen.getByText("额度")).toBeInTheDocument();
    expect(screen.getByText("剩余 $87.50")).toBeInTheDocument();
    expect(screen.getByText("$12.50 / $100.00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新额度" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the probe is unsupported", () => {
    const { container } = render(
      <Wrapper>
        <SiteQuotaRow
          quota={quota({ status: "unsupported", remainingUsd: null, usedUsd: null, totalUsd: null })}
          loading={false}
          onRefresh={() => undefined}
        />
      </Wrapper>,
    );
    expect(container.querySelector("[data-testid='site-quota-row']")).toBeNull();
    expect(screen.queryByText("额度")).toBeNull();
  });

  it("shows a one-line skeleton while the first probe is in flight", () => {
    render(
      <Wrapper>
        <SiteQuotaRow quota={null} loading onRefresh={() => undefined} />
      </Wrapper>,
    );
    expect(screen.getByTestId("site-quota-loading")).toBeInTheDocument();
    expect(screen.getByText("额度")).toBeInTheDocument();
  });

  it("renders CNY remaining from token usage display", () => {
    render(
      <Wrapper>
        <SiteQuotaRow
          quota={quota({
            remainingUsd: 999.693074,
            usedUsd: 0.306926,
            totalUsd: 1000,
            unit: "CNY",
            source: "token_usage",
          })}
          loading={false}
          onRefresh={() => undefined}
        />
      </Wrapper>,
    );
    expect(screen.getByText("剩余 ¥999.69")).toBeInTheDocument();
    expect(screen.getByText("¥0.31 / ¥1,000.00")).toBeInTheDocument();
  });

  it("shows unlimited copy without a progress bar", () => {
    render(
      <Wrapper>
        <SiteQuotaRow
          quota={quota({
            unlimited: true,
            remainingUsd: null,
            totalUsd: null,
            usedUsd: 3,
          })}
          loading={false}
          onRefresh={() => undefined}
        />
      </Wrapper>,
    );
    expect(screen.getByText("不限额度")).toBeInTheDocument();
    expect(screen.getByText("已用 $3.00")).toBeInTheDocument();
    expect(document.querySelector(".ant-progress")).toBeNull();
  });
});
