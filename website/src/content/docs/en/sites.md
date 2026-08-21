---
title: Sites
description: Manage upstream names, routes, protocol, API keys, and Codex capability presets.
order: 4
---

A site is one upstream relay: a set of Base URLs plus an API key, then models and target presets.

## Core fields

| Field | Notes |
|-------|--------|
| Display name | Up to 128 characters |
| Routes / Base URL | Up to 20; the first item is the current / default route |
| API key | Encrypted in the app database; the UI only shows a prefix |
| Protocol | `OpenAI-compatible` (default) or `Anthropic` |
| Notes | Optional, up to 2000 characters |

Advanced settings (protocol, notes) are collapsed by default.

## Multiple routes

The first item is the current default. You can probe and switch; see [Route switching](../routes/).

The write preview shows the models URL, Claude Base URL, and Codex `base_url` so you can check suffixes such as `/v1`.

## Codex private capability presets

Site edit has a collapsed “Codex private capabilities” block. Kebab keys match import links:

- `codex-compact` remote compaction
- `codex-vision` vision
- `codex-imagegen` image generation
- `codex-search` built-in search

Most relays do not support these; turn them on only when the upstream actually does. Apply Center can follow the site preset or override for one apply.

## Enable and disable

When you disable a site that is already applied, you can choose whether to clear those target configs. If you skip clearing, the target shows as an orphan.
