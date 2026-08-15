import { invoke, isTauri } from "@/lib/invoke";

/** Open an http(s) URL in the system browser (Tauri) or a new tab (browser mock). */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    if (isTauri()) {
      await invoke("open_url", { url });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
