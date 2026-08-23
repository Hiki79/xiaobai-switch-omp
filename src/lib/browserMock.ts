import type {
  AppPaths,
  AppSettings,
  ApplyResult,
  BackupInfo,
  BackupPreview,
  CliToolInfo,
  CreateSiteInput,
  DeepLinkSiteImportInput,
  DeepLinkSiteImportResult,
  FetchModelsResult,
  HttpBytesResult,
  LaunchTargetRequest,
  ModelProbeResult,
  Site,
  SiteQuota,
  SiteModel,
  SwitchRouteResult,
  TargetKind,
  TargetLiveStatus,
  TargetRuntimeStatus,
  UpdateSiteInput,
  UrlProbeResult,
} from "@/types/domain";
import { keyPrefix, normalizeBaseUrl } from "./urlNormalize";

const DEFAULT_SETTINGS: AppSettings = {
  language: "zh-CN",
  themeMode: "system",
  primaryColor: "#1677ff",
  autoStart: false,
  alwaysOnTop: false,
  claudeHomeOverride: null,
  codexHomeOverride: null,
  ompHomeOverride: null,
  zcodeHomeOverride: null,
  dshHomeOverride: null,
  piHomeOverride: null,
  codexEnvInjectMode: "auto",
  forceExclusiveClaudeAuthKey: false,
  autoCheckUpdate: true,
  updateCheckInterval: 60,
  maxBackupCopies: 30,
  proxyMode: "system",
  proxyProtocol: "http",
  proxyHost: null,
  proxyPort: null,
  routeProbeTtlMinutes: 10,
  closeToTray: true,
  startInTray: false,
  launchWorkingDirectories: {},
};

function defaultTargetStatuses(): TargetLiveStatus[] {
  return [
    {
      kind: "claude_code",
      installed: false,
      version: null,
      configPath: "~/.claude/settings.json",
      status: "not_applied",
      appliedSiteId: null,
      appliedSiteName: null,
      appliedModelId: null,
      providerId: null,
      orphan: false,
      liveSummary: {},
      lastAppliedAt: null,
      staleReason: null,
    },
    {
      kind: "codex",
      installed: false,
      version: null,
      configPath: "~/.codex/config.toml",
      status: "not_applied",
      appliedSiteId: null,
      appliedSiteName: null,
      appliedModelId: null,
      providerId: null,
      orphan: false,
      liveSummary: {},
      lastAppliedAt: null,
      staleReason: null,
    },
    {
      kind: "omp",
      installed: false,
      version: null,
      configPath: "~/.omp/agent/models.yml",
      status: "not_applied",
      appliedSiteId: null,
      appliedSiteName: null,
      appliedModelId: null,
      providerId: null,
      orphan: false,
      liveSummary: {},
      lastAppliedAt: null,
      staleReason: null,
    },
    {
      kind: "zcode",
      installed: false,
      version: null,
      configPath: "~/.zcode/v2/config.json",
      status: "not_applied",
      appliedSiteId: null,
      appliedSiteName: null,
      appliedModelId: null,
      providerId: null,
      orphan: false,
      liveSummary: {},
      lastAppliedAt: null,
      staleReason: null,
    },
    {
      kind: "dsh",
      installed: false,
      version: null,
      configPath: "~/.dsh/settings.yaml",
      status: "not_applied",
      appliedSiteId: null,
      appliedSiteName: null,
      appliedModelId: null,
      providerId: null,
      orphan: false,
      liveSummary: {},
      lastAppliedAt: null,
      staleReason: null,
    },
    {
      kind: "pi",
      installed: false,
      version: null,
      configPath: "~/.pi/agent/models.json",
      status: "not_applied",
      appliedSiteId: null,
      appliedSiteName: null,
      appliedModelId: null,
      providerId: null,
      orphan: false,
      liveSummary: {},
      lastAppliedAt: null,
      staleReason: null,
    },
  ];
}

function defaultRuntimeStatuses(): TargetRuntimeStatus[] {
  const kinds: TargetKind[] = ["claude_code", "codex", "omp", "zcode", "dsh", "pi"];
  return kinds.map((target) => ({
    target,
    installed: false,
    running: false,
    pid: null,
    executablePath: null,
    error: null,
  }));
}

let settings: AppSettings = { ...DEFAULT_SETTINGS };
let sites: Site[] = [];
let backups: BackupInfo[] = [];
let targetStatuses: TargetLiveStatus[] = defaultTargetStatuses();
let runtimeStatuses: TargetRuntimeStatus[] = defaultRuntimeStatuses();
let lastLaunchRequest: LaunchTargetRequest | null = null;
const models = new Map<string, SiteModel[]>();
const keys = new Map<string, string>();
const exclusions = new Map<string, Set<string>>();

export function resetBrowserMock() {
  settings = { ...DEFAULT_SETTINGS };
  sites = [];
  backups = [];
  targetStatuses = defaultTargetStatuses();
  runtimeStatuses = defaultRuntimeStatuses();
  lastLaunchRequest = null;
  models.clear();
  keys.clear();
  exclusions.clear();
}

export function seedTargetStatuses(items: TargetLiveStatus[]) {
  targetStatuses = items;
}

export function seedRuntimeStatuses(items: TargetRuntimeStatus[]) {
  runtimeStatuses = runtimeStatuses.map(
    (row) => items.find((item) => item.target === row.target) ?? row,
  );
}

/** Last `launch_target` request seen by the mock (for contract tests). */
export function getLastLaunchRequest(): LaunchTargetRequest | null {
  return lastLaunchRequest;
}

export function seedBackups(items: BackupInfo[]) {
  backups = items;
}

function now() {
  return Date.now();
}

function uid() {
  return crypto.randomUUID();
}

export async function handleBrowserCommand<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (cmd) {
    case "get_settings":
      return settings as T;
    case "save_settings": {
      const partial = (args?.partial ?? {}) as Partial<AppSettings>;
      settings = { ...settings, ...partial };
      if (!settings.closeToTray) settings.startInTray = false;
      return settings as T;
    }
    case "restore_main_window":
    case "force_quit":
    case "refresh_tray_menu":
      return undefined as T;
    case "list_sites":
      return sites as T;
    case "get_site": {
      const site = sites.find((s) => s.id === args?.id);
      if (!site) throw { code: "not_found", message: "Site not found" };
      return site as T;
    }
    case "create_site": {
      const input = args?.input as CreateSiteInput;
      const id = uid();
      const t = now();
      keys.set(id, input.apiKey);
      const urls =
        input.baseUrls && input.baseUrls.length > 0
          ? input.baseUrls
          : [input.baseUrl ?? ""];
      const site: Site = {
        id,
        name: input.name,
        baseUrl: urls[0] ?? "",
        baseUrls: urls,
        keyPrefix: keyPrefix(input.apiKey),
        hasKey: true,
        protocol: input.protocol ?? "openai_compatible",
        claudeAuthKeyStyle: input.claudeAuthKeyStyle ?? "anthropic_auth_token",
        notes: input.notes ?? null,
        enabled: true,
        sortOrder: sites.length,
        selectedModelId: null,
        lastModelFetchAt: null,
        lastModelFetchLatencyMs: null,
        lastModelFetchError: null,
        createdAt: t,
        updatedAt: t,
        capabilities: input.capabilities ?? {},
      };
      sites = [...sites, site];
      return site as T;
    }
    case "import_site_from_deep_link": {
      const input = args?.input as DeepLinkSiteImportInput;
      const name = input?.name?.trim() ?? "";
      const apiKey = input?.apiKey?.trim() ?? "";
      if (!name) throw { code: "validation_failed", message: "site name is required" };
      if (!apiKey) throw { code: "validation_failed", message: "API key is required" };
      const protocol =
        input.protocol === "anthropic"
          ? "anthropic"
          : input.protocol === "openai_native"
            ? "openai_native"
            : "openai_compatible";
      const urls =
        input.baseUrls && input.baseUrls.length > 0
          ? input.baseUrls
          : [];
      if (urls.length === 0) {
        throw { code: "validation_failed", message: "at least one base URL is required" };
      }
      const sameSet = (a: string[], b: string[]) => {
        if (a.length !== b.length) return false;
        const sa = [...a].sort();
        const sb = [...b].sort();
        return sa.every((v, i) => v === sb[i]);
      };
      const existing = sites.find(
        (s) => s.protocol === protocol && sameSet(s.baseUrls ?? [s.baseUrl], urls),
      );
      if (existing) {
        const sameKey = keys.get(existing.id) === apiKey;
        const updated: Site = {
          ...existing,
          name,
          notes: input.notes !== undefined ? input.notes : existing.notes,
          keyPrefix: sameKey ? existing.keyPrefix : keyPrefix(apiKey),
          capabilities:
            input.capabilities !== undefined ? input.capabilities : existing.capabilities,
          updatedAt: now(),
        };
        if (!sameKey) keys.set(existing.id, apiKey);
        sites = sites.map((s) => (s.id === existing.id ? updated : s));
        const result: DeepLinkSiteImportResult = {
          site: updated,
          created: false,
          updatedKey: !sameKey,
          reused: sameKey,
        };
        return result as T;
      }
      const created = await handleBrowserCommand<Site>("create_site", {
        input: {
          name,
          baseUrls: urls,
          baseUrl: urls[0],
          apiKey,
          protocol,
          notes: input.notes ?? null,
          capabilities: input.capabilities,
        } satisfies CreateSiteInput,
      });
      const result: DeepLinkSiteImportResult = {
        site: created,
        created: true,
        updatedKey: false,
        reused: false,
      };
      return result as T;
    }
    case "update_site": {
      const id = args?.id as string;
      const input = (args?.input ?? {}) as UpdateSiteInput;
      sites = sites.map((s) => {
        if (s.id !== id) return s;
        if (input.apiKey) {
          keys.set(id, input.apiKey);
        }
        let baseUrls = s.baseUrls?.length ? s.baseUrls : [s.baseUrl];
        let baseUrl = s.baseUrl;
        if (input.baseUrls && input.baseUrls.length > 0) {
          baseUrls = input.baseUrls;
          baseUrl = baseUrls[0];
        } else if (input.baseUrl) {
          if (baseUrls.includes(input.baseUrl)) {
            baseUrls = [input.baseUrl, ...baseUrls.filter((u) => u !== input.baseUrl)];
          } else {
            baseUrls = [input.baseUrl, ...baseUrls.slice(1)];
          }
          baseUrl = input.baseUrl;
        }
        return {
          ...s,
          name: input.name ?? s.name,
          baseUrl,
          baseUrls,
          keyPrefix: input.apiKey ? keyPrefix(input.apiKey) : s.keyPrefix,
          protocol: input.protocol ?? s.protocol,
          claudeAuthKeyStyle: input.claudeAuthKeyStyle ?? s.claudeAuthKeyStyle,
          notes: input.notes !== undefined ? input.notes : s.notes,
          enabled: input.enabled ?? s.enabled,
          selectedModelId:
            input.selectedModelId !== undefined ? input.selectedModelId : s.selectedModelId,
          sortOrder: input.sortOrder ?? s.sortOrder,
          capabilities: input.capabilities !== undefined ? input.capabilities : s.capabilities,
          updatedAt: now(),
        };
      });
      const site = sites.find((s) => s.id === id);
      if (!site) throw { code: "not_found", message: "Site not found" };
      return site as T;
    }
    case "delete_site": {
      const id = args?.id as string;
      sites = sites.filter((s) => s.id !== id);
      models.delete(id);
      keys.delete(id);
      exclusions.delete(id);
      return undefined as T;
    }
    case "reorder_sites": {
      const ids = args?.ids as string[];
      sites = ids
        .map((id, i) => {
          const s = sites.find((x) => x.id === id);
          return s ? { ...s, sortOrder: i } : null;
        })
        .filter(Boolean) as Site[];
      return undefined as T;
    }
    case "fetch_site_models": {
      const siteId = args?.siteId as string;
      const site = sites.find((s) => s.id === siteId);
      if (!site) throw { code: "not_found", message: "Site not found" };
      const sample: SiteModel[] = [
        {
          id: uid(),
          siteId,
          modelId: "gpt-4.1",
          displayName: "gpt-4.1",
          ownedBy: "mock",
          raw: null,
          isManual: false,
        },
        {
          id: uid(),
          siteId,
          modelId: "claude-sonnet-4",
          displayName: "claude-sonnet-4",
          ownedBy: "mock",
          raw: null,
          isManual: false,
        },
      ];
      const existing = models.get(siteId) ?? [];
      const hidden = exclusions.get(siteId) ?? new Set<string>();
      const visibleSample = sample.filter((m) => !hidden.has(m.modelId));
      const fetchedIds = new Set(visibleSample.map((m) => m.modelId));
      const manuals = existing.filter((m) => m.isManual && !fetchedIds.has(m.modelId) && !hidden.has(m.modelId));
      const merged = [...visibleSample, ...manuals];
      models.set(siteId, merged);
      sites = sites.map((s) =>
        s.id === siteId
          ? {
              ...s,
              lastModelFetchAt: now(),
              lastModelFetchLatencyMs: 42,
              lastModelFetchError: null,
              updatedAt: now(),
            }
          : s,
      );
      const result: FetchModelsResult = {
        models: merged,
        latencyMs: 42,
        endpoint: `${site.baseUrl}/v1/models`,
        fetchedAt: now(),
      };
      return result as T;
    }
    case "list_site_models":
      return (models.get(args?.siteId as string) ?? []) as T;
    case "set_selected_model": {
      const siteId = args?.siteId as string;
      const modelId = args?.modelId as string;
      exclusions.get(siteId)?.delete(modelId);
      sites = sites.map((s) =>
        s.id === siteId ? { ...s, selectedModelId: modelId, updatedAt: now() } : s,
      );
      const list = models.get(siteId) ?? [];
      if (!list.some((m) => m.modelId === modelId)) {
        models.set(siteId, [
          ...list,
          {
            id: uid(),
            siteId,
            modelId,
            displayName: modelId,
            ownedBy: null,
            raw: null,
            isManual: true,
          },
        ]);
      }
      return undefined as T;
    }
    case "clear_site_models": {
      const siteId = args?.siteId as string;
      const site = sites.find((s) => s.id === siteId);
      if (!site) throw { code: "not_found", message: "Site not found" };
      models.set(siteId, []);
      site.selectedModelId = null;
      site.updatedAt = now();
      return site as T;
    }
    case "delete_site_model": {
      const siteId = args?.siteId as string;
      const modelId = args?.modelId as string;
      const list = (models.get(siteId) ?? []).filter((m) => m.modelId !== modelId);
      if (list.length === (models.get(siteId) ?? []).length) {
        throw { code: "not_found", message: "model not found" };
      }
      const hidden = exclusions.get(siteId) ?? new Set<string>();
      hidden.add(modelId);
      exclusions.set(siteId, hidden);
      models.set(siteId, list);
      const site = sites.find((s) => s.id === siteId);
      if (!site) throw { code: "not_found", message: "Site not found" };
      if (site.selectedModelId === modelId) {
        site.selectedModelId = list[0]?.modelId ?? null;
        site.updatedAt = now();
      }
      return site as T;
    }
    case "list_target_status": {
      return targetStatuses as T;
    }
    case "apply_site": {
      const siteId = args?.siteId as string;
      const modelId = args?.modelId as string;
      const site = sites.find((s) => s.id === siteId);
      const targets = ((args?.targets as string[]) ?? []) as TargetKind[];
      const catalogIds = (args?.catalogModelIds as string[] | null) ?? null;
      const appliedAt = now();
      targetStatuses = targetStatuses.map((row) => {
        if (!targets.includes(row.kind)) return row;
        const writeAll =
          row.kind === "codex"
            ? Boolean(args?.codexWriteAllModels)
            : row.kind === "omp"
              ? Boolean(args?.ompWriteAllModels)
              : row.kind === "zcode"
                ? Boolean(args?.zcodeWriteAllModels)
                : row.kind === "dsh"
                  ? Boolean(args?.dshWriteAllModels)
                : false;
        const allIds = (models.get(siteId) ?? []).map((m) => m.modelId);
        const written = writeAll
          ? Array.from(new Set([...(catalogIds ?? allIds), modelId]))
          : [modelId];
        return {
          ...row,
          status: "applied",
          appliedSiteId: siteId,
          appliedSiteName: site?.name ?? null,
          appliedModelId: modelId,
          lastAppliedAt: appliedAt,
          liveSummary: {
            ...row.liveSummary,
            model: modelId,
            models: String(written.length),
            model_ids: written.join(","),
            ...(row.kind === "zcode" && typeof args?.zcodeContextWindow === "number"
              ? { model_context: String(args.zcodeContextWindow) }
              : {}),
          },
        };
      });
      const result: ApplyResult = {
        siteId,
        modelId,
        results: targets.map((t) => ({
          target: t,
          ok: true,
          status: "applied",
          backupPaths: [],
          message: "Browser mock: apply simulated (no filesystem writes)",
        })),
        appliedAt,
      };
      return result as T;
    }
    case "revert_target":
    case "restore_official_target": {
      const target = args?.target as TargetKind;
      targetStatuses = targetStatuses.map((row) =>
        row.kind === target
          ? {
              ...row,
              status: "not_applied",
              appliedSiteId: null,
              appliedSiteName: null,
              appliedModelId: null,
              lastAppliedAt: null,
              liveSummary: {},
              orphan: false,
              staleReason: null,
            }
          : row,
      );
      return undefined as T;
    }
    case "cleanup_orphan_target":
      return undefined as T;
    case "list_target_runtime_statuses":
      return runtimeStatuses as T;
    case "get_target_runtime_status": {
      const target = args?.target as TargetKind;
      const status = runtimeStatuses.find((s) => s.target === target);
      if (!status) throw { code: "not_found", message: "target not found" };
      return status as T;
    }
    case "launch_target": {
      const req = args?.req as LaunchTargetRequest;
      if (!req?.target) {
        throw { code: "validation_failed", message: "target is required" };
      }
      lastLaunchRequest = req;
      const dir = req.workingDirectory?.trim();
      if (dir && /[\\/]missing[\\/]/.test(dir)) {
        throw { code: "working_dir_missing", message: "working directory does not exist" };
      }
      let updated: TargetRuntimeStatus | undefined;
      runtimeStatuses = runtimeStatuses.map((row) => {
        if (row.target !== req.target) return row;
        if (!row.installed) {
          throw { code: "not_installed", message: "target executable not found" };
        }
        // GUI targets never spawn a second instance while running.
        if (row.running && req.target === "zcode") {
          updated = row;
          return row;
        }
        updated = {
          ...row,
          running: true,
          pid: row.pid ?? 4242,
          error: null,
        };
        return updated;
      });
      if (!updated) throw { code: "not_found", message: "target not found" };
      if (dir) {
        settings = {
          ...settings,
          launchWorkingDirectories: {
            ...settings.launchWorkingDirectories,
            [req.target]: dir,
          },
        };
      }
      return updated as T;
    }
    case "focus_target": {
      const target = args?.target as TargetKind;
      const status = runtimeStatuses.find((s) => s.target === target);
      if (!status) throw { code: "not_found", message: "target not found" };
      if (!status.running) throw { code: "not_running", message: "target is not running" };
      return status as T;
    }
    case "list_apply_records":
      return [] as T;
    case "list_backups": {
      const target = args?.target as TargetKind | undefined;
      const list = target ? backups.filter((b) => b.target === target) : backups;
      return list as T;
    }
    case "preview_backup": {
      const id = String(args?.id ?? "");
      const b = backups.find((x) => x.id === id);
      const preview: BackupPreview = {
        id,
        summary: {
          ANTHROPIC_MODEL: b?.modelId ?? "gpt-5.6",
          ANTHROPIC_BASE_URL: "https://api.example.com",
        },
        files: (b?.files ?? []).map((name) => ({
          name,
          path: `${b?.dir ?? ""}/${name}`,
        })),
      };
      return preview as T;
    }
    case "delete_backup": {
      const id = String(args?.id ?? "");
      backups = backups.filter((b) => b.id !== id);
      return undefined as T;
    }
    case "restore_backup":
      return undefined as T;
    case "detect_cli_tools": {
      const tools: CliToolInfo[] = [
        { kind: "claude_code", installed: false, version: null, path: null },
        { kind: "codex", installed: false, version: null, path: null },
        { kind: "omp", installed: false, version: null, path: null },
        { kind: "zcode", installed: false, version: null, path: null },
        { kind: "dsh", installed: false, version: null, path: null },
        { kind: "pi", installed: false, version: null, path: null },
      ];
      return tools as T;
    }
    case "get_app_paths": {
      const paths: AppPaths = {
        appDir: "~/.xiaobai-switch",
        dbPath: "~/.xiaobai-switch/xiaobai-switch.db",
        masterKeyPath: "~/.xiaobai-switch/master.key",
        backupsDir: "~/.xiaobai-switch/backups",
        codexEnvPath: "~/.xiaobai-switch/env/codex.env",
        logsDir: "~/.xiaobai-switch/logs",
      };
      return paths as T;
    }
    case "sync_windows_chrome":
    case "set_always_on_top":
    case "minimize_window":
    case "toggle_maximize_window":
    case "open_path":
    case "open_url":
      return undefined as T;
    case "take_pending_deep_link":
      return null as T;
    case "fetch_http_text": {
      const url = String(args?.url ?? "");
      return {
        status: 0,
        contentType: "",
        finalUrl: url,
        body: "",
      } as T;
    }
    case "fetch_http_bytes": {
      const url = String(args?.url ?? "");
      const empty: HttpBytesResult = {
        status: 0,
        contentType: "",
        finalUrl: url,
        base64: "",
      };
      return empty as T;
    }
    case "resolve_http_proxy":
      return null as T;
    case "check_app_update":
      return null as T;
    case "probe_urls": {
      const urls = (args?.urls as string[]) ?? [];
      const results: UrlProbeResult[] = urls.map((url, i) => ({
        url,
        ok: true,
        latencyMs: [80, 1500, 4000][i % 3] ?? 80,
        status: 200,
        error: null,
      }));
      return results as T;
    }
    case "probe_site_quota": {
      const siteId = String(args?.siteId ?? "");
      const site = sites.find((s) => s.id === siteId);
      if (!site) throw { code: "not_found", message: "Site not found" };
      if (!site.hasKey || /no-quota/i.test(site.baseUrl) || /no-quota/i.test(site.name)) {
        const unsupported: SiteQuota = {
          status: "unsupported",
          remainingUsd: null,
          usedUsd: null,
          totalUsd: null,
          unlimited: false,
          expiresAt: null,
          source: null,
          endpoint: null,
          fetchedAt: now(),
          latencyMs: 4,
          error: null,
        };
        return unsupported as T;
      }
      const result: SiteQuota = {
        status: "available",
        remainingUsd: 87.5,
        usedUsd: 12.5,
        totalUsd: 100,
        unlimited: false,
        unit: "USD",
        expiresAt: Math.floor(Date.UTC(2026, 11, 31) / 1000),
        source: "credit_grants",
        endpoint: `${normalizeBaseUrl(site.baseUrl).codexBaseUrl}/dashboard/billing/credit_grants`,
        fetchedAt: now(),
        latencyMs: 12,
        error: null,
      };
      return result as T;
    }
    case "probe_site_model": {
      const siteId = args?.siteId as string;
      const modelId = String(args?.modelId ?? "").trim();
      const site = sites.find((s) => s.id === siteId);
      if (!site) throw { code: "not_found", message: "Site not found" };
      if (!modelId) throw { code: "validation_failed", message: "model id required" };
      await new Promise((r) => setTimeout(r, 5));
      const endpoint = `${normalizeBaseUrl(site.baseUrl).codexBaseUrl}/chat/completions`;
      if (/fail-long/i.test(modelId)) {
        const result: ModelProbeResult = {
          modelId,
          ok: false,
          latencyMs: 8,
          status: 400,
          error:
            "mock upstream rejected this model because the requested identifier is not available on this gateway and the provider returned a very long diagnostic payload",
          endpoint,
        };
        return result as T;
      }
      if (/fail/i.test(modelId)) {
        const result: ModelProbeResult = {
          modelId,
          ok: false,
          latencyMs: 8,
          status: 400,
          error: "mock upstream rejected this model",
          endpoint,
        };
        return result as T;
      }
      const result: ModelProbeResult = {
        modelId,
        ok: true,
        latencyMs: 12,
        status: 200,
        error: null,
        endpoint,
      };
      return result as T;
    }
    case "switch_site_route": {
      const siteId = args?.siteId as string;
      const baseUrl = String(args?.baseUrl ?? "").trim();
      const current = sites.find((s) => s.id === siteId);
      if (!current) throw { code: "not_found", message: "Site not found" };
      const urls = current.baseUrls?.length ? current.baseUrls : [current.baseUrl];
      if (!urls.includes(baseUrl)) {
        throw { code: "validation_failed", message: "base URL is not a configured route" };
      }
      const next = [baseUrl, ...urls.filter((u) => u !== baseUrl)];
      sites = sites.map((s) =>
        s.id === siteId ? { ...s, baseUrl, baseUrls: next, updatedAt: now() } : s,
      );
      const site = sites.find((s) => s.id === siteId)!;
      const result: SwitchRouteResult = { site, results: [] };
      return result as T;
    }
    case "preview_urls":
      return normalizeBaseUrl(String(args?.baseUrl ?? "")) as T;
    default:
      throw {
        code: "internal",
        message: `Unknown command in browser mock: ${cmd}`,
      };
  }
}
