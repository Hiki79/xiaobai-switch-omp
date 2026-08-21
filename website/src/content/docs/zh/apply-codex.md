---
title: 应用到 Codex
description: 为 Codex 选择站点、模型、目录开关、推理深度和平台能力，写入 config.toml 与环境。
order: 7
---

应用中心左侧选 **Codex**。写入 `~/.codex/`（默认为 `config.toml`），并按设置注入环境变量。`wire_api` 保持为 `responses`；provider id 由站点 id 派生。

## 站点与模型

- 选择已启用的站点
- 默认模型写入 `config.toml` 的 `model` 字段

## 模型目录

打开「将站点全部模型写入 Codex」会生成 model catalog，便于在 Codex 内切换模型。关闭则只写当前默认模型。

## 推理深度

`model_reasoning_effort` 写入 `config.toml`，仅对支持推理的模型生效。

## 平台能力

默认跟随站点「Codex私有能力」：

| 能力 | 说明 |
|------|------|
| 远程压缩 | 长会话把压缩请求发给当前站点。多数中转不支持，请保持关闭。开启后会把该 provider 显示名写成 OpenAI（Codex 据此判断能否走远程压缩）；关闭则恢复站点名称。 |
| 识图 | 允许把本地图片发给当前模型。纯文本中转请关闭。若同时写入模型目录，目录会声明 text + image。 |
| 生图 | 调用内置生图工具。多数中转没有该能力。与识图独立。 |
| 搜索 | 内置网页搜索。站点不支持时请关闭，否则请求会失败。 |

也可选「自定义」：仅本次应用覆盖站点预设，不会写回站点。

## 环境注入

在 **设置** 里选择 Codex 密钥注入方式：自动（按平台）、仅 Shell rc、用户环境变量、或仅写入 `codex.env`。应用之后密钥可能以明文出现在这些位置，见 [安全说明](../security/)。

## 还原官方配置

会从 `config.toml` 移除中转 provider、`openai_base_url` 和本应用写入的模型目录，并清除注入的 `XIAOBAI_*` 环境变量，使 Codex 回到官方 ChatGPT 账号登录。不会删除 `auth.json`；当前文件会先备份。
