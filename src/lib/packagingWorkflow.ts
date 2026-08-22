/** Desktop rustc targets the Release workflow must build. */
export const REQUIRED_RELEASE_TARGETS = [
  "x86_64-pc-windows-msvc",
] as const;

export type PnpmSetup = {
  versionInput: string | undefined;
};

/** `packageManager: "pnpm@10.32.1"` → `"10.32.1"`. */
export function packageManagerVersion(packageManagerField: string): string {
  const match = packageManagerField.match(/^pnpm@(.+)$/);
  if (!match) {
    throw new Error(`unsupported packageManager: ${packageManagerField}`);
  }
  return match[1];
}

/**
 * Collect every `pnpm/action-setup` step and its optional `version:` input.
 * When `version` is omitted, the action uses `package.json` `packageManager`.
 */
export function parsePnpmActionSetups(yaml: string): PnpmSetup[] {
  const lines = yaml.split(/\r?\n/);
  const setups: PnpmSetup[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*pnpm\/action-setup@/.test(lines[i])) continue;

    const usesIndent = lines[i].search(/\S/);
    let versionInput: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
      const indent = line.search(/\S/);
      if (indent <= usesIndent) break;
      const versionMatch = line.match(/^[ \t]+version:[ \t]*['"]?([^'"\s#]+)/);
      if (versionMatch) {
        versionInput = versionMatch[1];
        break;
      }
    }
    setups.push({ versionInput });
  }

  return setups;
}

/** True when any setup pins a pnpm version other than `packageManager`. */
export function pnpmSetupConflictsWithPackageManager(
  setups: PnpmSetup[],
  packageManagerField: string,
): boolean {
  const expected = packageManagerVersion(packageManagerField);
  return setups.some(
    (setup) => setup.versionInput !== undefined && setup.versionInput !== expected,
  );
}

/** Unique `target:` rust triples from a Release workflow matrix. */
export function parseReleaseRustTargets(yaml: string): string[] {
  const targets: string[] = [];
  const re =
    /^[ \t]+target:[ \t]+['"]?([A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)?)['"]?[ \t]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(yaml)) !== null) {
    targets.push(match[1]);
  }
  return [...new Set(targets)];
}

export function missingReleaseTargets(
  targets: readonly string[],
  required: readonly string[] = REQUIRED_RELEASE_TARGETS,
): string[] {
  return required.filter((target) => !targets.includes(target));
}
