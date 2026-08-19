import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const brandDir = join(projectRoot, "assets", "brand");
const tauriIconsDir = join(projectRoot, "src-tauri", "icons");
const publicDir = join(projectRoot, "public");
const artworkPath = join(brandDir, "app-icon-artwork.png");

if (!existsSync(artworkPath)) {
  throw new Error(`Missing icon artwork: ${relative(projectRoot, artworkPath)}`);
}

const artworkDataUri = `data:image/png;base64,${readFileSync(artworkPath).toString("base64")}`;
const macPlate = { x: 100, y: 100, size: 824 };
const windowsPlate = { x: 64, y: 64, size: 896, radius: 43 };

function superellipsePath({ x, y, size }, exponent = 5, steps = 160) {
  const center = x + size / 2;
  const radius = size / 2;
  const points = Array.from({ length: steps }, (_, index) => {
    const angle = (Math.PI * 2 * index) / steps;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const px = center + radius * Math.sign(cos) * Math.abs(cos) ** (2 / exponent);
    const py = center + radius * Math.sign(sin) * Math.abs(sin) ** (2 / exponent);
    return `${index === 0 ? "M" : "L"}${px.toFixed(3)} ${py.toFixed(3)}`;
  });
  return `${points.join(" ")} Z`;
}

function buildMacSvg(imageHref) {
  const path = superellipsePath(macPlate);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><clipPath id="plate"><path d="${path}"/></clipPath></defs>
  <image href="${imageHref}" x="${macPlate.x}" y="${macPlate.y}" width="${macPlate.size}" height="${macPlate.size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#plate)"/>
</svg>
`;
}

function buildWindowsSvg(imageHref) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><clipPath id="plate"><rect x="${windowsPlate.x}" y="${windowsPlate.y}" width="${windowsPlate.size}" height="${windowsPlate.size}" rx="${windowsPlate.radius}"/></clipPath></defs>
  <image href="${imageHref}" x="${windowsPlate.x}" y="${windowsPlate.y}" width="${windowsPlate.size}" height="${windowsPlate.size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#plate)"/>
</svg>
`;
}

function runTauriIcon(input, output, pngSize) {
  const args = ["exec", "tauri", "icon"];
  if (pngSize) args.push("--png", String(pngSize));
  args.push("--output", output, input);
  const result = spawnSync("pnpm", args, { cwd: projectRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`tauri icon failed for ${input}`);
}

function copyFile(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

mkdirSync(brandDir, { recursive: true });
mkdirSync(tauriIconsDir, { recursive: true });
mkdirSync(publicDir, { recursive: true });

writeFileSync(join(brandDir, "app-icon.svg"), buildMacSvg("app-icon-artwork.png"));
writeFileSync(join(brandDir, "app-icon-windows.svg"), buildWindowsSvg("app-icon-artwork.png"));

const tempRoot = mkdtempSync(join(tmpdir(), "xiaobai-switch-icons-"));
const macSvg = join(tempRoot, "macos.svg");
const windowsSvg = join(tempRoot, "windows.svg");
const macIcons = join(tempRoot, "macos");
const windowsIcons = join(tempRoot, "windows");
const macBrand = join(tempRoot, "macos-brand");
const windowsBrand = join(tempRoot, "windows-brand");

try {
  writeFileSync(macSvg, buildMacSvg(artworkDataUri));
  writeFileSync(windowsSvg, buildWindowsSvg(artworkDataUri));

  runTauriIcon(macSvg, macIcons);
  runTauriIcon(windowsSvg, windowsIcons);
  runTauriIcon(macSvg, macBrand, 1024);
  runTauriIcon(windowsSvg, windowsBrand, 1024);

  for (const name of ["32x32.png", "64x64.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.icns"]) {
    copyFile(join(macIcons, name), join(tauriIconsDir, name));
  }

  copyFile(join(windowsIcons, "icon.ico"), join(tauriIconsDir, "icon.ico"));
  for (const name of readdirSync(windowsIcons).filter((name) => /^(Square.*Logo|StoreLogo)\.png$/.test(name))) {
    copyFile(join(windowsIcons, name), join(tauriIconsDir, name));
  }

  copyFile(join(macBrand, "1024x1024.png"), join(brandDir, "app-icon-1024.png"));
  copyFile(join(macBrand, "1024x1024.png"), join(brandDir, "app-icon-preview.png"));
  copyFile(join(windowsBrand, "1024x1024.png"), join(brandDir, "app-icon-windows-1024.png"));
  copyFile(join(macIcons, "32x32.png"), join(publicDir, "favicon.png"));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Generated macOS, Windows, brand, and favicon icon assets.");
