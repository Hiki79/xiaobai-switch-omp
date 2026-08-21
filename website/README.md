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

GitHub Actions (`.github/workflows/website.yml`) builds `website/` when that tree or the workflow file changes on `main`, when the **Release** workflow finishes publishing a GitHub Release, or on manual `workflow_dispatch`. The download page bakes installer URLs into the static HTML at build time (no browser calls to the GitHub API). Version tags do not deploy the site by themselves.

`public/CNAME` must stay `xiaobaiswitch.com` so deploys do not drop the custom domain. Repo Settings → Pages should use **GitHub Actions** as the source (not the `/docs` folder).
