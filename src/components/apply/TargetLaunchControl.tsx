import { App, Button, Input, Tag, theme } from "antd";
import { FolderOpen, Focus, Play, SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isAppError, isTauri } from "@/lib/invoke";
import { runtimeStatusKind, type RuntimeStatusKind } from "@/stores/runtimeStore";
import type { TargetKind, TargetRuntimeStatus } from "@/types/domain";
import { TARGET_LABEL_KEY } from "@/lib/targetMeta";

const KIND_COLOR: Partial<Record<RuntimeStatusKind, string>> = {
  not_installed: "default",
  not_running: "default",
  starting: "processing",
  running: "success",
  launch_failed: "error",
};

export interface TargetLaunchControlProps {
  target: TargetKind;
  runtimeStatus?: TargetRuntimeStatus;
  /** The target has successfully applied a site config. */
  configured: boolean;
  /** Current working directory (TUI targets). */
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  onLaunch?: () => Promise<void> | void;
  onFocus?: () => Promise<void> | void;
  /** True while a launch is in flight (prevents duplicate clicks). */
  starting?: boolean;
  /** Redacted launch error to surface when the last launch failed. */
  launchError?: string | null;
  /** Hide the built-in target label (e.g. inside the status card header). */
  showName?: boolean;
}

/**
 * Shared launch + run-state control used by every target panel. All status
 * text goes through i18n; toasts use `App.useApp()` only.
 */
export function TargetLaunchControl({
  target,
  runtimeStatus,
  configured,
  workingDirectory,
  onWorkingDirectoryChange,
  onLaunch,
  onFocus,
  starting = false,
  launchError = null,
  showName = true,
}: TargetLaunchControlProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { token } = theme.useToken();

  const isTui = target !== "zcode";
  const kind = runtimeStatusKind(runtimeStatus, { starting, launchError }) ?? "not_installed";
  const error = launchError ?? runtimeStatus?.error ?? null;

  const handleLaunch = async () => {
    if (!onLaunch) return;
    try {
      await onLaunch();
      message.success(t("launch.launchSuccess"));
    } catch (e) {
      message.error(isAppError(e) ? e.message : String(e));
    }
  };

  const handleFocus = async () => {
    if (!onFocus) return;
    try {
      await onFocus();
      if (runtimeStatus?.error) {
        message.warning(runtimeStatus.error);
      } else {
        message.success(t("launch.focusSuccess"));
      }
    } catch (e) {
      message.error(isAppError(e) ? e.message : String(e));
    }
  };

  const handlePickDirectory = async () => {
    if (!isTauri()) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        onWorkingDirectoryChange?.(selected);
      }
    } catch (e) {
      message.error(isAppError(e) ? e.message : String(e));
    }
  };

  const action = (() => {
    if (kind === "not_installed") {
      return (
        <Button size="small" disabled icon={<Play size={14} />}>
          {t("launch.notDetected")}
        </Button>
      );
    }
    if (kind === "starting") {
      return (
        <Button size="small" type="primary" loading icon={<Play size={14} />}>
          {t("launch.starting")}
        </Button>
      );
    }
    if (kind === "running") {
      if (isTui) {
        return (
          <Button size="small" type="primary" icon={<SquareTerminal size={14} />} onClick={() => void handleLaunch()}>
            {t("launch.openTerminalAgain")}
          </Button>
        );
      }
      return (
        <Button size="small" type="primary" icon={<Focus size={14} />} onClick={() => void handleFocus()}>
          {t("launch.openOrFocus")}
        </Button>
      );
    }
    return (
      <Button
        size="small"
        type={configured ? "primary" : "default"}
        icon={<Play size={14} />}
        onClick={() => void handleLaunch()}
      >
        {t("launch.launch")}
      </Button>
    );
  })();

  return (
    <div className="flex flex-col" style={{ gap: 8 }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {showName !== false && <span className="font-medium">{t(TARGET_LABEL_KEY[target])}</span>}
          <Tag color={(kind && KIND_COLOR[kind]) || "default"}>{t(`launch.kind_${kind}`)}</Tag>
        </div>
        {action}
      </div>

      {isTui && (
        <div className="flex items-center gap-2">
          <Input
            size="small"
            value={workingDirectory ?? ""}
            placeholder={t("launch.workingDirectoryPlaceholder")}
            onChange={(e) => onWorkingDirectoryChange?.(e.target.value)}
            allowClear
          />
          <Button
            size="small"
            icon={<FolderOpen size={14} />}
            title={t("launch.pickDirectory")}
            disabled={!isTauri()}
            aria-label={t("launch.pickDirectory")}
            onClick={() => void handlePickDirectory()}
          />
        </div>
      )}

      {!configured && (
        <div className="text-xs" style={{ color: token.colorTextTertiary }}>
          {t("launch.applyFirstHint")}
        </div>
      )}

      {error && kind === "launch_failed" && (
        <div className="break-all text-xs" style={{ color: token.colorError }}>
          {error}
        </div>
      )}
      {error && kind !== "launch_failed" && kind !== undefined && (
        <div className="break-all text-xs" style={{ color: token.colorWarning }}>
          {error}
        </div>
      )}
    </div>
  );
}