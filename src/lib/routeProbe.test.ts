import { afterEach, describe, expect, it } from "vitest";
import {
  colorForLatency,
  isFresh,
  resetProbeCache,
  urlsNeedingProbe,
  upsertProbeResults,
} from "./routeProbe";

describe("routeProbe", () => {
  afterEach(() => {
    resetProbeCache();
  });

  it("buckets latency colors", () => {
    expect(colorForLatency(true, 999)).toBe("green");
    expect(colorForLatency(true, 1000)).toBe("yellow");
    expect(colorForLatency(true, 3000)).toBe("yellow");
    expect(colorForLatency(true, 3001)).toBe("red");
    expect(colorForLatency(false, 10)).toBe("red");
  });

  it("treats entries inside the ttl as fresh", () => {
    const now = 1_000_000;
    expect(isFresh({ url: "u", ok: true, latencyMs: 1, probedAt: now - 9 * 60 * 1000 }, 10, now)).toBe(
      true,
    );
    expect(isFresh({ url: "u", ok: true, latencyMs: 1, probedAt: now - 11 * 60 * 1000 }, 10, now)).toBe(
      false,
    );
  });

  it("lists stale or missing urls for auto probe", () => {
    const now = 5_000_000;
    upsertProbeResults(
      [{ url: "https://fresh.example", ok: true, latencyMs: 80 }],
      now - 60_000,
    );
    upsertProbeResults(
      [{ url: "https://stale.example", ok: true, latencyMs: 80 }],
      now - 20 * 60 * 1000,
    );
    expect(
      urlsNeedingProbe(
        ["https://fresh.example", "https://stale.example", "https://missing.example"],
        10,
        now,
      ),
    ).toEqual(["https://stale.example", "https://missing.example"]);
  });
});
