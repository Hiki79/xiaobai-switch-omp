import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { AppError } from "@/types/domain";
import { handleBrowserCommand } from "./browserMock";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e &&
    typeof (e as AppError).code === "string"
  );
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    if (isTauri()) {
      return await tauriInvoke<T>(cmd, args);
    }
    return await handleBrowserCommand<T>(cmd, args);
  } catch (error) {
    // Tauri serializes AppError as the error payload
    if (isAppError(error)) throw error;
    if (typeof error === "object" && error !== null) {
      const obj = error as Record<string, unknown>;
      if (typeof obj.code === "string" && typeof obj.message === "string") {
        throw error as AppError;
      }
    }
    throw {
      code: "internal",
      message: error instanceof Error ? error.message : String(error),
      details: null,
    } satisfies AppError;
  }
}
