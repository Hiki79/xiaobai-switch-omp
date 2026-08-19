import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Progress } from "antd";
import { useTranslation } from "react-i18next";
import { invoke, isTauri } from "@/lib/invoke";
import { useSettingsStore } from "@/stores";

type UpdateLike = {
  version: string;
  body?: string | null;
  close: () => Promise<void>;
  downloadAndInstall: (
    onEvent?: (event: {
      event: "Started" | "Progress" | "Finished";
      data: { contentLength?: number; chunkLength?: number };
    }) => void,
  ) => Promise<void>;
};

type Fetched =
  | { status: "latest" }
  | { status: "available"; update: UpdateLike }
  | { status: "error"; error: unknown };

let inFlight: Promise<Fetched> | null = null;
let busy = false;
const busyListeners = new Set<(value: boolean) => void>();
let updatePromptOpen = false;

function setBusy(next: boolean) {
  if (busy === next) return;
  busy = next;
  busyListeners.forEach((listener) => listener(next));
}

export function resetUpdateCheckerForTests() {
  inFlight = null;
  updatePromptOpen = false;
  setBusy(false);
}

export function useUpdateCheckBusy() {
  const [value, setValue] = useState(busy);
  useEffect(() => {
    busyListeners.add(setValue);
    setValue(busy);
    return () => {
      busyListeners.delete(setValue);
    };
  }, []);
  return value;
}

function fetchUpdateStatus(): Promise<Fetched> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const { Update } = await import("@tauri-apps/plugin-updater");
      const metadata = await invoke<{
        rid: number;
        currentVersion: string;
        version: string;
        date?: string | null;
        body?: string | null;
        rawJson: Record<string, unknown>;
      } | null>("check_app_update");
      const update = metadata
        ? (new Update({
            rid: metadata.rid,
            currentVersion: metadata.currentVersion,
            version: metadata.version,
            date: metadata.date ?? undefined,
            body: metadata.body ?? undefined,
            rawJson: metadata.rawJson,
          }) as unknown as UpdateLike)
        : null;
      return update ? { status: "available" as const, update } : { status: "latest" as const };
    } catch (error) {
      return { status: "error" as const, error };
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

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

  const presentUpdate = useCallback(
    (update: UpdateLike, silent: boolean) => {
      if (updatePromptOpen) return;
      updatePromptOpen = true;
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
        onCancel: () => {
          updatePromptOpen = false;
        },
        onOk: async () => {
          updatePromptOpen = false;
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
                downloaded += event.data.chunkLength ?? 0;
                if (totalSize > 0) {
                  progressModal.update({
                    content: renderContent(Math.round((downloaded / totalSize) * 100), "active"),
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
    },
    [t, modal, message],
  );

  const checkForUpdate = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!isTauri()) {
        if (!silent) message.info(t("settings.checkUpdateDesktopOnly"));
        return false;
      }

      if (!silent) setBusy(true);
      const hideLoading = silent ? undefined : message.loading(t("settings.checkingUpdate"), 0);
      try {
        const result = await fetchUpdateStatus();
        hideLoading?.();
        if (result.status === "error") {
          if (!silent) message.error(t("settings.checkUpdateFailed"));
          console.error("Update check failed:", result.error);
          return false;
        }
        if (result.status === "latest") {
          if (!silent) message.success(t("settings.noUpdate"));
          return false;
        }
        presentUpdate(result.update, silent);
        return true;
      } finally {
        hideLoading?.();
        if (!silent) setBusy(false);
      }
    },
    [t, message, presentUpdate],
  );

  return { checkForUpdate };
}

export const STARTUP_UPDATE_CHECK_DELAY_MS = 3_000;

export function useAutoCheckUpdate() {
  const { checkForUpdate } = useUpdateChecker();
  const loaded = useSettingsStore((s) => s.loaded);
  const autoCheckUpdate = useSettingsStore((s) => s.settings.autoCheckUpdate);
  const updateCheckInterval = useSettingsStore((s) => s.settings.updateCheckInterval);
  const checkRef = useRef(checkForUpdate);
  checkRef.current = checkForUpdate;

  useEffect(() => {
    if (!isTauri() || !loaded || !autoCheckUpdate) return;
    const timer = window.setTimeout(() => {
      void checkRef.current({ silent: true });
    }, STARTUP_UPDATE_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autoCheckUpdate, loaded]);

  useEffect(() => {
    if (!isTauri() || !loaded || !autoCheckUpdate) return;
    const intervalMs = Math.max(updateCheckInterval || 60, 1) * 60 * 1000;
    const id = window.setInterval(() => {
      void checkRef.current({ silent: true });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [autoCheckUpdate, loaded, updateCheckInterval]);
}
