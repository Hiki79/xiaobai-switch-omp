const DEFAULT_GITHUB_REPOSITORY = "Licoy/xiaobai-switch";

export const GITHUB_API_LATEST =
  `https://api.github.com/repos/${DEFAULT_GITHUB_REPOSITORY}/releases/latest`;

/**
 * Use the repository that owns the website build when one is provided. This
 * keeps forked builds from querying the upstream repository for a tag that
 * only exists in the fork, while local builds retain the upstream default.
 */
export function githubRepositoryName(): string {
  const configured = process.env.GITHUB_RELEASE_REPOSITORY?.trim();
  return configured && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configured)
    ? configured
    : DEFAULT_GITHUB_REPOSITORY;
}

export function githubReleaseApiUrl(tag?: string): string {
  const normalized = tag?.trim().replace(/^refs\/tags\//, "");
  const base = `https://api.github.com/repos/${githubRepositoryName()}/releases`;
  if (!normalized) return `${base}/latest`;
  return `${base}/tags/${encodeURIComponent(normalized)}`;
}

export type AssetKind =
  | "mac-arm"
  | "mac-intel"
  | "win-x64-msi"
  | "win-x64-nsis"
  | "win-x64-zip"
  | "win-arm-nsis"
  | "win-arm-zip";

export type AssetMap = Partial<Record<AssetKind, { name: string; url: string }>>;

export type LatestRelease = {
  tag: string;
  assets: AssetMap;
};

export function classifyAsset(name: string): AssetKind | null {
  const n = name.toLowerCase();
  if (n.endsWith(".sig") || n.endsWith(".json") || n.includes(".app.tar.gz")) return null;
  if (n.endsWith(".dmg") && /aarch64|arm64/.test(n)) return "mac-arm";
  if (n.endsWith(".dmg") && /(x64|x86_64)/.test(n)) return "mac-intel";
  if (n.endsWith(".msi") && n.includes("x64")) return "win-x64-msi";
  if (n.includes("x64-setup.exe")) return "win-x64-nsis";
  if (n.includes("arm64-setup.exe")) return "win-arm-nsis";
  if (n.includes("windows-x64-portable.zip")) return "win-x64-zip";
  if (n.includes("windows-arm64-portable.zip")) return "win-arm-zip";
  return null;
}

export function assetsFromRelease(release: {
  tag_name?: string;
  assets?: { name: string; browser_download_url: string }[];
}): LatestRelease {
  const assets: AssetMap = {};
  for (const asset of release.assets ?? []) {
    const kind = classifyAsset(asset.name);
    if (kind) assets[kind] = { name: asset.name, url: asset.browser_download_url };
  }
  return { tag: release.tag_name ?? "", assets };
}

export function hrefFor(assets: AssetMap, kind: AssetKind, fallback: string): string {
  return assets[kind]?.url ?? fallback;
}

type GithubReleasePayload = Parameters<typeof assetsFromRelease>[0] & {
  draft?: boolean;
};

function requireBakedRelease(tag?: string): boolean {
  return Boolean(tag?.trim() || process.env.CI);
}

export async function loadLatestRelease(
  token?: string,
  tag?: string,
): Promise<LatestRelease | null> {
  const url = githubReleaseApiUrl(tag);
  const required = requireBakedRelease(tag);
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "xiaobai-switch-website",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (required) {
        throw new Error(`Failed to load GitHub release ${tag?.trim() || "latest"}: ${res.status}`);
      }
      return null;
    }
    const payload = (await res.json()) as GithubReleasePayload;
    if (payload.draft) {
      throw new Error(
        `GitHub release ${payload.tag_name ?? tag ?? "unknown"} is still a draft`,
      );
    }
    const latest = assetsFromRelease(payload);
    if (required && Object.keys(latest.assets).length === 0) {
      throw new Error(
        `GitHub release ${latest.tag || tag || "latest"} has no installer assets`,
      );
    }
    return latest;
  } catch (error) {
    if (required) throw error;
    return null;
  }
}
