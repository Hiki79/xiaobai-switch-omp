---
title: FAQ
description: macOS will not open, config does not take effect, key display, and import behavior.
order: 13
---

## macOS says the app is damaged

See [Install](../install/). Run `xattr -cr /Applications/XiaoBaiSwitch.app`, then right-click Open.

## Apply succeeded, but the CLI still uses the old URL

Restart the terminal, or fully quit and reopen Claude Code / Codex. Apply only writes config files; it does not hot-reload a running process.

## Why is the full API key hidden?

Only a prefix is shown on purpose. The full secret stays in the encrypted database until Apply writes it to the target config.

## Does an import link change Claude / Codex immediately?

No. Import only creates or updates a site. You still apply in Apply Center.

## Is Linux supported?

Current releases are macOS and Windows.

## What is the official site URL?

[https://xiaobaiswitch.com](https://xiaobaiswitch.com) (GitHub Pages custom domain). Docs live at `/docs/`; English at `/en/`.
