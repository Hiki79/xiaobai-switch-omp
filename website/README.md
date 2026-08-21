# XiaoBaiSwitch website

Official site for XiaoBaiSwitch, published at **https://xiaobaiswitch.com** (GitHub Pages custom domain).

Stack: Astro (static) + Tailwind CSS v4 + daisyUI. No VitePress / Starlight.

## Local

```bash
pnpm install
pnpm dev
```

```bash
pnpm build
pnpm preview
```

Brand images and screenshots are copied from `../assets` by `scripts/sync-assets.mjs` on `dev` / `build`.

## Deploy

GitHub Actions (`.github/workflows/website.yml`) builds `website/` when that tree, `assets/`, or the workflow file changes on `main`, then deploys to GitHub Pages.

`public/CNAME` must stay `xiaobaiswitch.com` so deploys do not drop the custom domain. Repo Settings → Pages should use **GitHub Actions** as the source (not the `/docs` folder).
