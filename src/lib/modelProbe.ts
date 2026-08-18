import { invoke, isAppError } from "@/lib/invoke";
import type { ModelProbeResult } from "@/types/domain";

export type ProbeMode = "serial" | "parallel";

export const DEFAULT_PARALLEL_CONCURRENCY = 6;

export async function probeSiteModel(
  siteId: string,
  modelId: string,
): Promise<ModelProbeResult> {
  return invoke<ModelProbeResult>("probe_site_model", { siteId, modelId });
}

function failedResult(modelId: string, error: unknown): ModelProbeResult {
  const message = isAppError(error)
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
  return {
    modelId,
    ok: false,
    latencyMs: 0,
    status: null,
    error: message,
    endpoint: "",
  };
}

export async function runModelProbes(opts: {
  siteId: string;
  modelIds: string[];
  mode: ProbeMode;
  concurrency?: number;
  signal?: AbortSignal;
  onStart: (modelId: string) => void;
  onResult: (result: ModelProbeResult) => void;
}): Promise<void> {
  const ids = opts.modelIds.filter((id) => id.trim().length > 0);
  if (ids.length === 0) return;

  const limit =
    opts.mode === "serial"
      ? 1
      : Math.max(1, opts.concurrency ?? DEFAULT_PARALLEL_CONCURRENCY);

  let next = 0;
  let active = 0;

  const runOne = async (modelId: string) => {
    if (opts.signal?.aborted) return;
    opts.onStart(modelId);
    try {
      const result = await probeSiteModel(opts.siteId, modelId);
      if (opts.signal?.aborted) return;
      opts.onResult(result);
    } catch (error) {
      if (opts.signal?.aborted) return;
      opts.onResult(failedResult(modelId, error));
    }
  };

  await new Promise<void>((resolve) => {
    const finishIfIdle = () => {
      if (active === 0) resolve();
    };

    const launch = () => {
      if (opts.signal?.aborted) {
        finishIfIdle();
        return;
      }
      while (active < limit && next < ids.length) {
        const modelId = ids[next];
        next += 1;
        active += 1;
        void runOne(modelId).finally(() => {
          active -= 1;
          if (opts.signal?.aborted) {
            finishIfIdle();
            return;
          }
          if (next >= ids.length && active === 0) {
            resolve();
            return;
          }
          launch();
        });
      }
    };

    opts.signal?.addEventListener("abort", finishIfIdle, { once: true });
    launch();
  });
}
