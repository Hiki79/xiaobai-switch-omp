import { useCallback, useEffect, useRef } from "react";
import { App, Button, Progress } from "antd";
import { useTranslation } from "react-i18next";
import { invoke, isTauri } from "@/lib/invoke";
import { useSettingsStore } from "@/stores";

let checkInFlight = false;

export function UpdateReleaseNotes({ content }: { content: string }) {
  return (
    <pre
      data-testid="update-release-notes"
      className="mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap break-words text-sm"
      style={{ marginTop: 8, maxHeight: 300, overflow: "auto" }}
    >
      {content}
    </pre>
  );
}

export function useUpdateChecker() {
  const { t } = useTranslation();
  const { modal, message } = App.useApp();

  const checkForUpdate = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!isTauri()) return false;
      if (checkInFlight) return false;
      checkInFlight = true;
      const silent = options?.silent ?? false;
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (!update) {
          if (!silent) message.success(t("settings.noUpdate"));
          return false;
        }

        if (silent) {
          void invoke("restore_main_window").catch(() => null);
        }

        modal.confirm({
          title: t("settings.updateAvailable"),
          centered: true,
          content: (
            <div>
              <p>
                {t("settings.newVersion")}: {update.version}
              </p>
              {update.body ? <UpdateReleaseNotes content={update.body} /> : null}
            </div>
          ),
          okText: t("settings.updateNow"),
          cancelText: t("settings.updateLater"),
          onOk: async () => {
            let cancelled = false;
            const handleCancel = async () => {
              cancelled = true;
              try {
                await update.close();
              } catch {
                /* ignore */
              }
            };
            const renderContent = (percent: number, status: "active" | "success") => (
              <div>
                <Progress percent={percent} status={status} />
                {status !== "success" && (
                  <div style={{ textAlign: "right", marginTop: 12 }}>
                    <Button onClick={() => void handleCancel()}>{t("settings.cancelUpdate")}</Button>
                  </div>
                )}
              </div>
            );
            const progressModal = modal.info({
              title: t("settings.updating"),
              content: renderContent(0, "active"),
              closable: false,
              footer: null,
              maskClosable: false,
              keyboard: false,
            });
            try {
              let totalSize = 0;
              let downloaded = 0;
              await update.downloadAndInstall((event) => {
                if (event.event === "Started" && event.data.contentLength) {
                  totalSize = event.data.contentLength;
                } else if (event.event === "Progress") {
                  downloaded += event.data.chunkLength;
                  if (totalSize > 0) {
                    progressModal.update({
                      content: renderContent(
                        Math.round((downloaded / totalSize) * 100),
                        "active",
                      ),
                    });
                  }
                } else if (event.event === "Finished") {
                  progressModal.update({ content: renderContent(100, "success") });
                }
              });
              const { relaunch } = await import("@tauri-apps/plugin-process");
              await relaunch();
            } catch (e) {
              progressModal.destroy();
              if (!cancelled) {
                message.error(t("settings.updateFailed"));
                console.error("Update install failed:", e);
              }
            }
          },
        });
        return true;
      } catch (e) {
        if (!silent) message.error(t("settings.checkUpdateFailed"));
        console.error("Update check failed:", e);
        return false;
      } finally {
        checkInFlight = false;
      }
    },
    [t, modal, message],
  );

  return { checkForUpdate };
}

export function useAutoCheckUpdate() {
  const { checkForUpdate } = useUpdateChecker();
  const loaded = useSettingsStore((s) => s.loaded);
  const autoCheckUpdate = useSettingsStore((s) => s.settings.autoCheckUpdate);
  const updateCheckInterval = useSettingsStore((s) => s.settings.updateCheckInterval);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isTauri() || !loaded || !autoCheckUpdate) return;
    const timer = setTimeout(() => {
      void checkForUpdate({ silent: true });
    }, 3000);
    return () => clearTimeout(timer);
  }, [autoCheckUpdate, checkForUpdate, loaded]);

  useEffect(() => {
    if (!isTauri() || !loaded || !autoCheckUpdate || !updateCheckInterval) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    const intervalMs = Math.max(updateCheckInterval, 1) * 60 * 1000;
    intervalRef.current = setInterval(() => {
      void checkForUpdate({ silent: true });
    }, intervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoCheckUpdate, checkForUpdate, loaded, updateCheckInterval]);
}
