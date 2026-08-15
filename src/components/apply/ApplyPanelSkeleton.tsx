import { Skeleton, theme } from "antd";
import { SettingsGroup } from "@/components/settings/SettingsGroup";

/** Lightweight placeholder while apply panel data / heavy form mounts. */
export function ApplyPanelSkeleton() {
  const { token } = theme.useToken();

  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy="true" aria-live="polite">
      <div className="min-h-0 flex-1 overflow-y-auto p-6 pb-4">
        <SettingsGroup>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Skeleton.Input active size="small" style={{ width: 120 }} />
              <Skeleton.Button active size="small" style={{ width: 64 }} />
            </div>
            <Skeleton active paragraph={{ rows: 3 }} title={false} />
          </div>
        </SettingsGroup>

        <SettingsGroup>
          <div className="space-y-4">
            <div>
              <Skeleton.Input active size="small" style={{ width: 96, marginBottom: 8 }} />
              <Skeleton.Input active block style={{ height: 32 }} />
            </div>
            <div>
              <Skeleton.Input active size="small" style={{ width: 96, marginBottom: 8 }} />
              <Skeleton.Input active block style={{ height: 32 }} />
            </div>
          </div>
        </SettingsGroup>

        <SettingsGroup>
          <Skeleton active paragraph={{ rows: 2 }} title={{ width: "40%" }} />
        </SettingsGroup>
      </div>
      <div
        className="shrink-0 px-6 py-3"
        style={{
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          backgroundColor: token.colorBgContainer,
        }}
      >
        <Skeleton.Button active block style={{ height: 36 }} />
      </div>
    </div>
  );
}
