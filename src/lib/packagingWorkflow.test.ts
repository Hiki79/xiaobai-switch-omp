import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  missingReleaseTargets,
  packageManagerVersion,
  parsePnpmActionSetups,
  parseReleaseRustTargets,
  pnpmSetupConflictsWithPackageManager,
  REQUIRED_RELEASE_TARGETS,
} from "./packagingWorkflow";

const root = resolve(import.meta.dirname, "../..");

function readRepoFile(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

describe("packageManagerVersion", () => {
  it("strips the pnpm@ prefix from package.json packageManager", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      packageManager: string;
    };
    expect(pkg.packageManager.startsWith("pnpm@")).toBe(true);
    expect(packageManagerVersion(pkg.packageManager)).toBe(
      pkg.packageManager.slice("pnpm@".length),
    );
  });
});

describe("parsePnpmActionSetups", () => {
  it("detects the dual-version conflict that failed Actions run 31116820861", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      packageManager: string;
    };
    const failingCi = `
jobs:
  frontend:
    steps:
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
`;
    const setups = parsePnpmActionSetups(failingCi);
    expect(setups).toEqual([{ versionInput: "10" }]);
    expect(pnpmSetupConflictsWithPackageManager(setups, pkg.packageManager)).toBe(
      true,
    );
  });

  it("treats a missing version input as using packageManager", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      packageManager: string;
    };
    const yaml = `
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
`;
    const setups = parsePnpmActionSetups(yaml);
    expect(setups).toEqual([{ versionInput: undefined }]);
    expect(pnpmSetupConflictsWithPackageManager(setups, pkg.packageManager)).toBe(
      false,
    );
  });
});

describe("shipped GitHub workflows", () => {
  it("does not pin a conflicting pnpm version in CI or Release", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      packageManager: string;
    };
    const ci = readRepoFile(".github/workflows/ci.yml");
    const release = readRepoFile(".github/workflows/release.yml");

    const ciSetups = parsePnpmActionSetups(ci);
    const releaseSetups = parsePnpmActionSetups(release);

    expect(ciSetups.length).toBeGreaterThan(0);
    expect(releaseSetups.length).toBeGreaterThan(0);
    expect(pnpmSetupConflictsWithPackageManager(ciSetups, pkg.packageManager)).toBe(
      false,
    );
    expect(
      pnpmSetupConflictsWithPackageManager(releaseSetups, pkg.packageManager),
    ).toBe(false);
  });

  it("Release matrix covers macOS arm64/intel and Windows x64/arm64", () => {
    const release = readRepoFile(".github/workflows/release.yml");
    expect(release).toMatch(/^name:\s*Release\s*$/m);
    expect(release).toMatch(/tags:\s*\n\s+-\s+"v\*\.\*\.\*"/);

    const targets = parseReleaseRustTargets(release);
    expect(missingReleaseTargets(targets)).toEqual([]);
    for (const target of REQUIRED_RELEASE_TARGETS) {
      expect(targets).toContain(target);
    }
  });

  it("enables signed updater artifacts in tauri.conf", () => {
    const tauri = JSON.parse(readRepoFile("src-tauri/tauri.conf.json")) as {
      bundle: { createUpdaterArtifacts?: boolean };
      plugins: { updater?: { pubkey?: string; endpoints?: string[] } };
    };
    expect(tauri.bundle.createUpdaterArtifacts).toBe(true);
    expect(tauri.plugins.updater?.endpoints).toEqual([
      "https://github.com/Licoy/xiaobai-switch/releases/latest/download/latest.json",
    ]);
    expect(tauri.plugins.updater?.pubkey).toMatch(/^dW50cnVzdGVk/);
  });

  it("signs updater artifacts and publishes a combined latest.json", () => {
    const release = readRepoFile(".github/workflows/release.yml");
    expect(release).toMatch(/TAURI_SIGNING_PRIVATE_KEY/);
    expect(release).toMatch(/includeUpdaterJson:\s*false/);
    expect(release).toMatch(/scripts\/generate-updater-manifest\.mjs/);
  });

  it("does not use the PowerShell Join-Path trailing-comma pitfall in the portable zip step", () => {
    const release = readRepoFile(".github/workflows/release.yml");
    // `Join-Path $dir "a.exe", Join-Path $dir "b.exe"` is one call, not two paths.
    expect(release).not.toMatch(
      /Join-Path \$releaseDir ["'](?:xiaobai-switch|XiaoBaiSwitch)\.exe["'],/,
    );
    expect(release).toMatch(
      /foreach \(\$name in @\(["']XiaoBaiSwitch\.exe["']/,
    );
  });
});
