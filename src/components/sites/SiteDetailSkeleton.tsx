import { Skeleton } from "antd";

/** Detail pane placeholder while site models / content settle after a switch. */
export function SiteDetailSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Skeleton.Avatar active size={32} shape="circle" />
          <Skeleton.Input active style={{ width: 140 }} />
          <Skeleton.Button active style={{ width: 128, height: 24 }} />
        </div>
        <Skeleton.Button active style={{ width: 88 }} />
      </div>
      <div className="mb-4 space-y-3">
        <Skeleton active paragraph={{ rows: 3 }} title={false} />
      </div>
      <div>
        <div className="mb-3 flex items-center gap-2">
          <Skeleton.Input active style={{ width: 72 }} />
          <Skeleton.Button active style={{ width: 80, height: 24 }} />
        </div>
        <Skeleton.Input active block style={{ marginBottom: 12 }} />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton.Button key={i} active style={{ width: 88, height: 32 }} />
          ))}
        </div>
      </div>
    </div>
  );
}
