---
title: Apply to Codex
description: Choose site, model, catalog, reasoning effort, and platform capabilities for config.toml and env injection.
order: 7
---

In Apply Center, select **Codex**. This writes `~/.codex/` (typically `config.toml`) and injects environment variables per Settings. `wire_api` stays `responses`; the provider id is derived from the site id.

## Site and model

- Pick an enabled site
- The default model is written to the `model` field in `config.toml`

## Model catalog

“Write all site models into Codex” generates a model catalog so you can switch models inside Codex. Off means only the default model is written.

## Reasoning effort

`model_reasoning_effort` is written to `config.toml` and only affects models that support reasoning.

## Platform capabilities

By default these follow the site’s Codex private capability presets:

| Capability | Notes |
|------------|--------|
| Remote compaction | Long sessions send compaction to the current site. Most relays do not support this; leave it off. On writes the provider display name as OpenAI (Codex uses that to decide remote compaction); off restores the site name. |
| Vision | Allows sending local images to the current model. Turn off for text-only relays. If a catalog is written, it declares text + image. |
| Image generation | Built-in image tool. Most relays lack it. Independent from vision. |
| Search | Built-in web search. Turn off if the site has no such tool, or requests will fail. |

“Custom” overrides the site preset for this apply only and is not written back to the site.

## Environment injection

In **Settings**, choose how Codex secrets are injected: automatic (per platform), shell rc only, user environment variables, or `codex.env` only. After apply, keys may appear in plaintext in those places; see [Security](../security/).

## Restore official config

This removes the relay provider, `openai_base_url`, and catalogs this app wrote, and clears injected `XIAOBAI_*` variables so Codex can use a ChatGPT account again. `auth.json` is not deleted; the current file is backed up first.
