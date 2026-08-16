import { Badge, theme } from "antd";
import { clsx } from "clsx";

interface Props {
  active: boolean;
  title?: string;
  className?: string;
}

/** Green pulsing Badge when active; gray static Badge when not. */
export function StatusDot({ active, title, className }: Props) {
  const { token } = theme.useToken();
  return (
    <Badge
      className={clsx("status-dot inline-flex shrink-0", className)}
      status={active ? "processing" : "default"}
      color={active ? token.colorSuccess : token.colorTextQuaternary}
      title={title}
      aria-hidden
      data-status={active ? "active" : "inactive"}
    />
  );
}
