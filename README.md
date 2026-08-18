<p align="center">
  <img src="assets/brand/app-icon.svg" alt="XiaoBaiSwitch" width="160" height="160">
</p>

# Xiaobai Switch

小白也能上手的，以站点驱动的 Claude Code / Codex 上游配置桌面应用。

以「上游站点」为中心：配置 Base URL + API Key → 拉取或手输模型 → 一键应用到 Claude Code / Codex。


## 数据目录

`~/.xiaobai-switch/`

- `xiaobai-switch.db` — 站点与绑定 SSOT
- `master.key` — 密钥加密主密钥（勿丢失）
- `env/codex.env` — Codex 托管环境变量
- `backups/` — Apply 备份

## Apply 写入位置

| 目标 | 文件 |
|------|------|
| Claude Code | `~/.claude/settings.json` → `env` |
| Codex | `~/.codex/config.toml` + `~/.xiaobai-switch/env/codex.env` |

应用成功后请**重启终端或对应 CLI**。

## 安全提示

API Key 在应用内加密存储；Apply 后会以明文写入目标 CLI 配置。请勿将 `~/.xiaobai-switch`、`~/.claude`、`~/.codex` 同步到不可信云盘。

## 从链接导入站点

安装桌面端后，浏览器或其它应用可以打开 `xiaobaiswitch://` 链接，拉起 XiaoBaiSwitch 并导入上游站点。导入**不会**自动 Apply 到 Claude Code / Codex。

### 用户流程

1. 安装桌面端，或用 `pnpm tauri dev` 跑调试版（仅 `pnpm dev` 的 Vite 页面**不会**注册协议）。
2. **macOS：** 系统不允许给「裸二进制」注册自定义协议。`tauri dev` 首次启动会在 `~/Applications/XiaoBaiSwitch Dev.app` 注册 `xiaobaiswitch://`。请保持调试窗口开着，再用浏览器打开链接；若浏览器仍提示无法打开，先退出浏览器再试一次。正式发布需把 `.app` 装到 `/Applications`（`Info.plist` 已声明该协议）。
3. 点击导入链接。应用切到站点页并弹出确认框。
4. 核对名称、线路、协议、备注和 API Key 前缀后确认。
5. 若链接没有 `apikey`，确认后会打开预填的添加站点表单，补全密钥再保存。

同一协议 + 相同线路集合（顺序无关）视为同一站点：密钥相同则复用，密钥不同则更新密钥。线路多一条或少一条会新建站点，不会自动合并。

### 链接格式

```text
xiaobaiswitch://sites?name=<name>&baseurls=<url>[&baseurls=<url>…][&apikey=<key>][&protocol=openai_compatible|anthropic][&notes=<notes>][&codex-compact=1][&codex-vision=1][&codex-imagegen=1][&codex-search=1]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 站点名称，最长 128 |
| `baseurls` | 是 | 线路 Base URL，可写多条，最多 20 条 |
| `apikey` | 否 | API Key；省略则确认后打开预填表单，由用户补全 |
| `protocol` | 否 | `openai_compatible`（默认）或 `anthropic` |
| `notes` | 否 | 备注，最长 2000 |
| `codex-compact` | 否 | Codex 远程压缩预设，`1`/`true`/`on`/`yes` 为开 |
| `codex-vision` | 否 | Codex 识图预设 |
| `codex-imagegen` | 否 | Codex 生图预设 |
| `codex-search` | 否 | Codex 内置搜索预设 |

别名：`baseurl` = `baseurls`；`type=openai` / `type=anthropic` = `protocol`。其它符合 `平台-能力` 的 kebab 键会原样存入站点，当前界面只展示 Codex 四个。链接里只要出现任一能力参数，即视为一套完整 Codex 预设（未写的已知键为关）；老链接不加这些参数，不会覆盖站点里已有的预设。

### 多条线路怎么写

**第一项是当前 / 默认线路。** 推荐重复写 `baseurls`，避免 URL 本身带逗号时被拆错：

```text
xiaobaiswitch://sites?name=Example%20Relay&baseurls=https://a.example.com/v1&baseurls=https://b.example.com/v1&apikey=sk-xxx&protocol=openai_compatible
```

也接受写在同一个参数里，用逗号或 `|` 分隔：

```text
xiaobaiswitch://sites?name=Example&baseurls=https://a.example.com/v1,https://b.example.com/v1
xiaobaiswitch://sites?name=Example&baseurls=https://a.example.com/v1|https://b.example.com/v1
```

`baseurl` 和 `baseurls` 可以混用，按查询串出现顺序合并：

```text
xiaobaiswitch://sites?name=Mix&baseurl=https://first.example.com/v1&baseurls=https://second.example.com/v1
```

后台生成时用 `append`，不要用 `set`（`set` 会覆盖前一条）：

```html
<script>
  const params = new URLSearchParams();
  params.set("name", "Example Relay");
  params.append("baseurls", "https://a.example.com/v1");
  params.append("baseurls", "https://b.example.com/v1");
  params.set("apikey", "sk-user-key");
  params.set("protocol", "openai_compatible");
  document.getElementById("open-xbs").href = `xiaobaiswitch://sites?${params.toString()}`;
</script>
```

URL 中携带 API Key 可能被浏览器历史、扩展或系统日志记录。不要把真实密钥写在公开页面；推荐登录后的私有后台按需生成，或省略 `apikey` 让用户在应用内补全。

## 版本支持

| 平台 | Runner | Target |
|------|--------|--------|
| macOS Apple Silicon | `macos-latest` | `aarch64-apple-darwin` |
| macOS Intel | `macos-latest` | `x86_64-apple-darwin` |
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` |
| Windows ARM64 | `windows-latest`（交叉编译） | `aarch64-pc-windows-msvc` 

## License

MIT
