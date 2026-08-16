import { useEffect } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { invoke, isTauri } from "@/lib/invoke";
import { useApplyStore, useUIStore } from "@/stores";
import type { ApplyTargetResult } from "@/types/domain";

export type TrayNavigate = "apply" | "settings";

export interface TrayApplyFailed {
  code: string;
  message: string;
}

async function listenSafe<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

export function useTrayEvents() {
  const { message } = App.useApp();
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const stopNav = await listenSafe<TrayNavigate>("tray-navigate", (page) => {
        if (page === "apply" || page === "settings") {
          useUIStore.getState().setPage(page);
        }
      });
      if (cancelled) {
        stopNav();
        return;
      }
      unlisteners.push(stopNav);

      const stopApplied = await listenSafe<ApplyTargetResult[]>("tray-applied", (results) => {
        void useApplyStore.getState().loadStatus({ force: true });
        const ok = results.some((r) => r.ok);
        if (ok) {
          message.success(t("settings.trayApplied"));
        } else {
          const detail = results.find((r) => !r.ok)?.message ?? "";
          message.error(t("settings.trayApplyFailed", { message: detail }));
        }
      });
      if (cancelled) {
        stopApplied();
        return;
      }
      unlisteners.push(stopApplied);

      const stopFailed = await listenSafe<TrayApplyFailed>("tray-apply-failed", (err) => {
        message.error(t("settings.trayApplyFailed", { message: err.message }));
      });
      if (cancelled) {
        stopFailed();
        return;
      }
      unlisteners.push(stopFailed);
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [message, t]);

  useEffect(() => {
    if (!isTauri()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void invoke("refresh_tray_menu").catch((error) => {
          console.warn("Failed to refresh tray menu:", error);
        });
      }, 400);
    };
    const unsub = useApplyStore.subscribe((state, prev) => {
      if (state.statuses !== prev.statuses) schedule();
    });
    schedule();
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);
}
