export const GITHUB_API_LATEST =
  "https://api.github.com/repos/Licoy/xiaobai-switch/releases/latest";

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

export async function loadLatestRelease(token?: string): Promise<LatestRelease | null> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "xiaobai-switch-website",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(GITHUB_API_LATEST, { headers });
    if (!res.ok) return null;
    return assetsFromRelease((await res.json()) as Parameters<typeof assetsFromRelease>[0]);
  } catch {
    return null;
  }
}
