import { invoke, isTauri } from "@/lib/invoke";

/** Parent directory of a file path; directories are returned as-is when no file segment is obvious. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (slash <= 0) return path;
  return trimmed.slice(0, slash);
}

/** Reveal a file (or open its folder) in the OS file manager. */
export async function revealInExplorer(path: string): Promise<void> {
  if (isTauri()) {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
      return;
    } catch {
      await invoke("open_path", { path: parentPath(path) });
      return;
    }
  }
  await invoke("open_path", { path: parentPath(path) });
}
