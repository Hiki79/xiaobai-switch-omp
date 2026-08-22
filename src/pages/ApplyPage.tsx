import { theme } from "antd";
import { useEffect } from "react";
import { ApplySidebar } from "@/components/apply/ApplySidebar";
import { ApplyPanelSkeleton } from "@/components/apply/ApplyPanelSkeleton";
import { ClaudeApplyPanel } from "@/components/apply/ClaudeApplyPanel";
import { CodexApplyPanel } from "@/components/apply/CodexApplyPanel";
import { DshApplyPanel } from "@/components/apply/DshApplyPanel";
import { OmpApplyPanel } from "@/components/apply/OmpApplyPanel";
import { ZcodeApplyPanel } from "@/components/apply/ZcodeApplyPanel";
import { useDeferredTabContent } from "@/hooks/useDeferredTabContent";
import { useRuntimeStore } from "@/stores/runtimeStore";
import { useApplyStore, useSiteStore, useUIStore } from "@/stores";

/**
 * Sidebar selection commits immediately. The first visit to a target shows
 * a skeleton while the heavy form mounts off-screen; later visits reuse the
 * already-mounted panel (display:none) so Claude ↔ Codex stays instant.
 */
export function ApplyPage() {
  const { token } = theme.useToken();
  const applyTab = useUIStore((s) => s.applyTab);
  const activePage = useUIStore((s) => s.activePage);
  const loadSites = useSiteStore((s) => s.loadSites);
  const ensureApplyData = useApplyStore((s) => s.ensureApplyData);
  const startPolling = useRuntimeStore((s) => s.startPolling);
  const stopPolling = useRuntimeStore((s) => s.stopPolling);
  const { mounted, showSkeleton } = useDeferredTabContent(applyTab);

  useEffect(() => {
    void loadSites({ soft: true });
    void ensureApplyData();
  }, [loadSites, ensureApplyData]);

  // Runtime status polling runs only while the apply center is the active
  // page and stops when the user navigates away or the page unmounts.
  // startPolling performs the initial load when nothing is cached yet.
  useEffect(() => {
    if (activePage !== "apply") return;
    startPolling();
    return () => stopPolling();
  }, [activePage, startPolling, stopPolling]);

  return (
    <div className="flex h-full min-h-0">
      <div
        className="h-full w-56 shrink-0"
        style={{ borderRight: "1px solid var(--border-color)", backgroundColor: token.colorBgContainer }}
      >
        <ApplySidebar />
      </div>
      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        style={{ backgroundColor: token.colorBgElevated }}
      >
        {showSkeleton && <ApplyPanelSkeleton />}

        {mounted.has("claude_code") && (
          <div
            className="h-full min-h-0"
            style={{
              display: applyTab === "claude_code" && !showSkeleton ? "flex" : "none",
              flexDirection: "column",
            }}
            aria-hidden={applyTab !== "claude_code"}
          >
            <ClaudeApplyPanel />
          </div>
        )}
        {mounted.has("codex") && (
          <div
            className="h-full min-h-0"
            style={{
              display: applyTab === "codex" && !showSkeleton ? "flex" : "none",
              flexDirection: "column",
            }}
            aria-hidden={applyTab !== "codex"}
          >
            <CodexApplyPanel />
          </div>
        )}
        {mounted.has("omp") && (
          <div
            className="h-full min-h-0"
            style={{
              display: applyTab === "omp" && !showSkeleton ? "flex" : "none",
              flexDirection: "column",
            }}
            aria-hidden={applyTab !== "omp"}
          >
            <OmpApplyPanel />
          </div>
        )}
        {mounted.has("zcode") && (
          <div
            className="h-full min-h-0"
            style={{
              display: applyTab === "zcode" && !showSkeleton ? "flex" : "none",
              flexDirection: "column",
            }}
            aria-hidden={applyTab !== "zcode"}
          >
            <ZcodeApplyPanel />
          </div>
        )}
        {mounted.has("dsh") && (
          <div
            className="h-full min-h-0"
            style={{
              display: applyTab === "dsh" && !showSkeleton ? "flex" : "none",
              flexDirection: "column",
            }}
            aria-hidden={applyTab !== "dsh"}
          >
            <DshApplyPanel />
          </div>
        )}
      </div>
    </div>
  );
}
