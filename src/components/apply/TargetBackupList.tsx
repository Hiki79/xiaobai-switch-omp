import { useEffect, useMemo, useState } from "react";
import { App, Button, Collapse, Descriptions, Space, theme } from "antd";
import { useTranslation } from "react-i18next";
import { isAppError, invoke } from "@/lib/invoke";
import { revealInExplorer } from "@/lib/revealInExplorer";
import { useApplyStore } from "@/stores";
import type { BackupInfo, BackupPreview, TargetKind } from "@/types/domain";

interface TargetBackupListProps {
  target: TargetKind;
}

function formatWhen(ts: number, locale: string): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(locale === "zh-CN" ? "zh-CN" : "en-US");
}

function primaryFile(backup: BackupInfo, preview: BackupPreview | undefined): string | null {
  const names = preview?.files.map((f) => f.name) ?? backup.files;
  const preferred =
    names.find((n) => n === "settings.json" || n === "config.toml") ?? names[0];
  if (!preferred) return null;
  const fromPreview = preview?.files.find((f) => f.name === preferred)?.path;
  return fromPreview ?? `${backup.dir}/${preferred}`;
}

export function TargetBackupList({ target }: TargetBackupListProps) {
  const { t, i18n } = useTranslation();
  const { token } = theme.useToken();
  const { message, modal } = App.useApp();
  const allBackups = useApplyStore((s) => s.backups);
  const loadBackups = useApplyStore((s) => s.loadBackups);
  const deleteBackup = useApplyStore((s) => s.deleteBackup);
  const restoreBackup = useApplyStore((s) => s.restoreBackup);
  const [previews, setPreviews] = useState<Record<string, BackupPreview>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  const backups = useMemo(
    () => allBackups.filter((b) => b.target === target),
    [allBackups, target],
  );

  const loadPreview = async (id: string) => {
    if (previews[id]) return;
    setLoadingId(id);
    try {
      const preview = await invoke<BackupPreview>("preview_backup", { id });
      setPreviews((prev) => ({ ...prev, [id]: preview }));
    } catch (e) {
      message.error(isAppError(e) ? e.message : t("apply.backupPreviewFailed"));
    } finally {
      setLoadingId(null);
    }
  };

  const handleExpand = (key: string | string[]) => {
    const id = Array.isArray(key) ? key[0] : key;
    if (id) void loadPreview(id);
  };

  const handleViewSource = async (backup: BackupInfo) => {
    const path = primaryFile(backup, previews[backup.id]) ?? backup.dir;
    try {
      await revealInExplorer(path);
    } catch (e) {
      message.error(isAppError(e) ? e.message : t("apply.openPathFailed"));
    }
  };

  const handleViewFile = async (path: string) => {
    try {
      await revealInExplorer(path);
    } catch (e) {
      message.error(isAppError(e) ? e.message : t("apply.openPathFailed"));
    }
  };

  const handleRestore = (backup: BackupInfo) => {
    modal.confirm({
      centered: true,
      title: t("apply.restoreBackupConfirm"),
      content: t("apply.restoreBackupConfirmHint"),
      okText: t("apply.restoreBackupOk"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        await restoreBackup(backup.id);
        message.success(t("apply.restoreBackupSuccess"));
      },
    });
  };

  const handleDelete = (backup: BackupInfo) => {
    modal.confirm({
      centered: true,
      title: t("apply.deleteBackupConfirm"),
      content: t("apply.deleteBackupConfirmHint"),
      okText: t("apply.deleteBackupOk"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        await deleteBackup(backup.id);
        setPreviews((prev) => {
          const next = { ...prev };
          delete next[backup.id];
          return next;
        });
        message.success(t("apply.deleteBackupSuccess"));
      },
    });
  };

  if (backups.length === 0) {
    return (
      <div className="text-sm" style={{ color: token.colorTextSecondary }}>
        <div>{t("apply.noBackups")}</div>
        <div className="mt-1 text-xs" style={{ color: token.colorTextTertiary }}>
          {t("apply.noBackupsHint")}
        </div>
      </div>
    );
  }

  return (
    <Collapse
      accordion
      size="small"
      data-testid="target-backup-list"
      onChange={handleExpand}
      items={backups.map((backup) => {
        const preview = previews[backup.id];
        const summaryEntries = preview
          ? Object.entries(preview.summary).filter(([, v]) => v != null && String(v).length > 0)
          : [];
        const site = backup.siteNameSnapshot;
        const model = backup.modelId;
        return {
          key: backup.id,
          label: (
            <div className="flex min-w-0 items-center justify-between gap-3 pr-2">
              <span className="shrink-0">{formatWhen(backup.createdAt, i18n.language)}</span>
              {(site || model) && (
                <span className="min-w-0 truncate" style={{ color: token.colorTextTertiary }}>
                  {site}
                  {model ? <span>（{model}）</span> : null}
                </span>
              )}
            </div>
          ),
          children: (
            <div className="flex flex-col gap-3">
              {loadingId === backup.id && !preview && (
                <div className="text-sm" style={{ color: token.colorTextSecondary }}>
                  {t("common.loading")}
                </div>
              )}
              {summaryEntries.length > 0 && (
                <Descriptions
                  size="small"
                  column={1}
                  items={summaryEntries.map(([k, v]) => ({
                    key: k,
                    label: k,
                    children: v ?? "—",
                  }))}
                />
              )}

              {(preview?.files.length || backup.files.length) > 0 && (
                <div>
                  <div className="mb-1 text-xs" style={{ color: token.colorTextTertiary }}>
                    {t("apply.backupFiles")}
                  </div>
                  <div className="flex flex-col gap-1">
                    {(preview?.files ?? backup.files.map((name) => ({ name, path: `${backup.dir}/${name}` }))).map(
                      (file) => (
                        <button
                          key={file.name}
                          type="button"
                          className="apply-config-path"
                          title={t("apply.viewSource")}
                          onClick={() => void handleViewFile(file.path)}
                        >
                          {file.name}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              )}

              <Space wrap size="small">
                <Button size="small" onClick={() => void handleViewSource(backup)}>
                  {t("apply.viewSource")}
                </Button>
                <Button size="small" onClick={() => handleRestore(backup)}>
                  {t("apply.restoreBackup")}
                </Button>
                <Button size="small" danger onClick={() => handleDelete(backup)}>
                  {t("apply.deleteBackup")}
                </Button>
              </Space>
            </div>
          ),
        };
      })}
    />
  );
}
