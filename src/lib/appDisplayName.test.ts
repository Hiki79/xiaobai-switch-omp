import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en-US.json";
import zh from "@/i18n/locales/zh-CN.json";
import { APP_NAME } from "./constants";

const root = resolve(import.meta.dirname, "../..");
const DISPLAY_NAME = "XiaoBaiSwitch";

function readRepoFile(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("user-facing app display name", () => {
  it("is XiaoBaiSwitch in UI constants and i18n", () => {
    expect(APP_NAME).toBe(DISPLAY_NAME);
    expect(zh.app.name).toBe(DISPLAY_NAME);
    expect(en.app.name).toBe(DISPLAY_NAME);
  });

  it("is XiaoBaiSwitch in HTML / README titles", () => {
    expect(readRepoFile("index.html")).toMatch(/<title>XiaoBaiSwitch<\/title>/);
    expect(readRepoFile("README.md")).toMatch(/^# XiaoBaiSwitch$/m);
  });

  it("is XiaoBaiSwitch in Tauri window, bundle, and binary metadata", () => {
    const tauri = JSON.parse(readRepoFile("src-tauri/tauri.conf.json")) as {
      productName: string;
      mainBinaryName: string;
      app: { windows: Array<{ title: string }> };
      bundle: { macOS: { bundleName: string } };
    };
    expect(tauri.productName).toBe(DISPLAY_NAME);
    expect(tauri.mainBinaryName).toBe(DISPLAY_NAME);
    expect(tauri.app.windows[0]?.title).toBe(DISPLAY_NAME);
    expect(tauri.bundle.macOS.bundleName).toBe(DISPLAY_NAME);

    const windows = JSON.parse(readRepoFile("src-tauri/tauri.windows.conf.json")) as {
      app: { windows: Array<{ title: string }> };
    };
    expect(windows.app.windows[0]?.title).toBe(DISPLAY_NAME);
  });

  it("uses XiaoBaiSwitch as the cargo binary while keeping kebab-case crate identity", () => {
    const cargo = readRepoFile("src-tauri/Cargo.toml");
    expect(cargo).toMatch(/^name = "xiaobai-switch"$/m);
    expect(cargo).toMatch(/^default-run = "XiaoBaiSwitch"$/m);
    const binSection = cargo.split("[[bin]]")[1] ?? "";
    expect(binSection).toMatch(/^name = "XiaoBaiSwitch"$/m);
  });

  it("declares XiaoBaiSwitch as the macOS Finder / menu bar name", () => {
    const plist = readRepoFile("src-tauri/Info.plist");
    expect(plist).toMatch(
      /<key>CFBundleName<\/key>\s*<string>XiaoBaiSwitch<\/string>/,
    );
    expect(plist).toMatch(
      /<key>CFBundleDisplayName<\/key>\s*<string>XiaoBaiSwitch<\/string>/,
    );
  });
});
