import packageJson from "../../package.json";
import { isTauri } from "./invoke";

/** Build-time version from package.json (kept in sync by `pnpm bump`). */
export const PACKAGE_VERSION: string = packageJson.version;

/** Running app version: Tauri binary when available, otherwise package.json. */
export async function getAppVersion(): Promise<string> {
  if (!isTauri()) return PACKAGE_VERSION;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return PACKAGE_VERSION;
  }
}
