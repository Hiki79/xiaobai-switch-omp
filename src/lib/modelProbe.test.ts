import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProbeResult } from "@/types/domain";

const invoke = vi.fn();

vi.mock("@/lib/invoke", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  isAppError: (e: unknown) =>
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    "message" in e &&
    typeof (e as { code: unknown }).code === "string",
}));

import { runModelProbes } from "./modelProbe";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function ok(modelId: string): ModelProbeResult {
  return {
    modelId,
    ok: true,
    latencyMs: 4,
    status: 200,
    error: null,
    endpoint: "https://api.example.com/v1/chat/completions",
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("runModelProbes", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("runs serial probes one after another", async () => {
    const gates = {
      a: deferred<ModelProbeResult>(),
      b: deferred<ModelProbeResult>(),
      c: deferred<ModelProbeResult>(),
    };
    const started: string[] = [];
    const inflight: string[] = [];

    invoke.mockImplementation((_cmd: string, args?: Record<string, unknown>) => {
      const id = String(args?.modelId);
      inflight.push(id);
      return gates[id as keyof typeof gates].promise;
    });

    const done = runModelProbes({
      siteId: "site-1",
      modelIds: ["a", "b", "c"],
      mode: "serial",
      onStart: (id) => started.push(id),
      onResult: () => undefined,
    });

    await flush();
    expect(started).toEqual(["a"]);
    expect(inflight).toEqual(["a"]);

    gates.a.resolve(ok("a"));
    await flush();
    expect(started).toEqual(["a", "b"]);
    expect(inflight).toEqual(["a", "b"]);

    gates.b.resolve(ok("b"));
    await flush();
    expect(started).toEqual(["a", "b", "c"]);

    gates.c.resolve(ok("c"));
    await done;
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("caps parallel probes by concurrency", async () => {
    const gates = {
      a: deferred<ModelProbeResult>(),
      b: deferred<ModelProbeResult>(),
      c: deferred<ModelProbeResult>(),
    };
    const started: string[] = [];

    invoke.mockImplementation((_cmd: string, args?: Record<string, unknown>) => {
      const id = String(args?.modelId);
      return gates[id as keyof typeof gates].promise;
    });

    const done = runModelProbes({
      siteId: "site-1",
      modelIds: ["a", "b", "c"],
      mode: "parallel",
      concurrency: 2,
      onStart: (id) => started.push(id),
      onResult: () => undefined,
    });

    await flush();
    expect(started.sort()).toEqual(["a", "b"]);
    expect(started).not.toContain("c");

    gates.a.resolve(ok("a"));
    await flush();
    expect(started).toContain("c");

    gates.b.resolve(ok("b"));
    gates.c.resolve(ok("c"));
    await done;
  });

  it("stops starting remaining probes after abort", async () => {
    const first = deferred<ModelProbeResult>();
    const started: string[] = [];
    invoke.mockImplementation((_cmd: string, args?: Record<string, unknown>) => {
      const id = String(args?.modelId);
      if (id === "a") return first.promise;
      return Promise.resolve(ok(id));
    });

    const controller = new AbortController();
    const done = runModelProbes({
      siteId: "site-1",
      modelIds: ["a", "b", "c"],
      mode: "serial",
      signal: controller.signal,
      onStart: (id) => started.push(id),
      onResult: () => undefined,
    });

    await flush();
    expect(started).toEqual(["a"]);
    controller.abort();
    first.resolve(ok("a"));
    await done;
    expect(started).toEqual(["a"]);
  });

  it("turns invoke throws into row failures and continues the batch", async () => {
    invoke
      .mockRejectedValueOnce({ code: "not_found", message: "Site not found" })
      .mockResolvedValueOnce(ok("b"));

    const results: ModelProbeResult[] = [];
    await runModelProbes({
      siteId: "missing",
      modelIds: ["a", "b"],
      mode: "serial",
      onStart: () => undefined,
      onResult: (result) => results.push(result),
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ modelId: "a", ok: false, error: "Site not found" });
    expect(results[1]).toMatchObject({ modelId: "b", ok: true });
  });
});
