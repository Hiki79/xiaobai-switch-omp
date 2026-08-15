import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getAppVersion, PACKAGE_VERSION } from "./appVersion";

const root = resolve(import.meta.dirname, "../..");

function readRepoFile(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("PACKAGE_VERSION", () => {
  it("matches package.json / tauri.conf.json / Cargo.toml", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { version: string };
    const tauri = JSON.parse(readRepoFile("src-tauri/tauri.conf.json")) as {
      version: string;
    };
    const cargoMatch = readRepoFile("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m);

    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(tauri.version).toBe(pkg.version);
    expect(cargoMatch?.[1]).toBe(pkg.version);
  });
});

describe("getAppVersion", () => {
  it("returns the package version outside Tauri", async () => {
    expect(await getAppVersion()).toBe(PACKAGE_VERSION);
  });
});
