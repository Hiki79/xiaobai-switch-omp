import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(websiteRoot, "..");
const publicDir = join(websiteRoot, "public");
const imagesDir = join(publicDir, "images");
const screenshotsDir = join(imagesDir, "screenshots");

mkdirSync(screenshotsDir, { recursive: true });

copyFileSync(join(repoRoot, "assets/brand/app-icon-1024.png"), join(imagesDir, "logo.png"));
copyFileSync(join(repoRoot, "assets/brand/app-icon-1024.png"), join(publicDir, "og.png"));
copyFileSync(join(repoRoot, "assets/brand/app-icon.svg"), join(publicDir, "favicon.svg"));
copyFileSync(join(repoRoot, "public/favicon.png"), join(publicDir, "favicon.png"));

for (const n of [1, 2, 3, 4]) {
  copyFileSync(
    join(repoRoot, `assets/screenshot/${n}.webp`),
    join(screenshotsDir, `${n}.webp`),
  );
}
