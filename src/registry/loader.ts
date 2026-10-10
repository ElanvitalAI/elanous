// RFC #2161 Phase 1 — Layer A Static Catalog loader.
//
// 2-tier merge: builtin (`monad-agent/catalog/`) + global
// (`~/.elanous/catalog/`). Reads YAML at startup. JSON dist artifact
// (RFC §6.5.1 build-time compile) is intentionally deferred to Phase 8 ·
// the YAML read is fast enough for daemon boot (<5ms typical) and gives
// us simpler Phase 1 scope.
//
// Behavior:
//   - builtin tier missing      → throw (this is a build-time invariant)
//   - global tier missing       → no-op (clean install · expected)
//   - malformed yaml            → log warn · skip file · keep going
//   - dup model id              → global wins · log info
//   - dup provider id           → mergeOverlay (RFC §6.4)
//
// Cache: per-process singleton via getCatalog() · invalidate via
// reloadCatalog() (used by tests + Phase 6 discovery hot-reload).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import type {
  Catalog,
  ModelPatternFallback,
  ModelSpec,
  ProviderCapabilities,
  ProviderRegistration,
} from './types.js';
import { PROVIDER_CAPABILITIES_NONE } from './types.js';
import { readDiscoveryCache, type DiscoverySnapshot } from './discovery/cache.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Resolve `monad-agent/catalog/` from this module's location. The
 *  loader sits at `src/registry/loader.ts`; the catalog lives at
 *  `<repo>/catalog/`. Walks up until it finds the catalog dir. */
function resolveBuiltinCatalogDir(): string {
  // Test override — allows test isolation without monkey-patching cwd.
  const override = process.env.ELANOUS_BUILTIN_CATALOG_DIR?.trim();
  if (override) return override;
  // Walk up from `src/registry/` to repo root.
  let cur = HERE;
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(cur, 'catalog', 'providers');
    if (existsSync(candidate)) return join(cur, 'catalog');
    cur = dirname(cur);
  }
  // Last-resort relative resolve (when bun bundles the source).
  return resolve(HERE, '..', '..', 'catalog');
}

function resolveGlobalCatalogDir(): string {
  // Central resolver (`--config-dir` / `setElanousConfigDir` / legacy
  // `ELANOUS_DAEMON_DIR`) wins. When it falls through to the home
  // default, `ELANOUS_TEST_HOME` gets a chance to redirect — preserves
  // the alternate test isolation pattern used elsewhere in the
  // registry layer.
  const central = getElanousConfigDir();
  if (central === join(homedir(), '.elanous')) {
    const testHome = process.env.ELANOUS_TEST_HOME?.trim();
    if (testHome) return join(testHome, '.elanous', 'catalog');
  }
  return join(central, 'catalog');
}

function safeReadYaml(path: string): unknown | null {
  try {
    return parseYaml(readFileSync(path, 'utf-8'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[catalog] failed to parse ${path}: ${(err as Error).message}`);
    return null;
  }
}

function listYamlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries
    .filter((e) => e.endsWith('.yaml') || e.endsWith('.yml'))
    .map((e) => join(dir, e));
}

// ── Provider parse + validate ─────────────────────────────────────────

function parseProvider(raw: unknown, source: string): ProviderRegistration | null {
  if (!raw || typeof raw !== 'object') {
    // eslint-disable-next-line no-console
    console.error(`[catalog] ${source}: provider yaml must be an object`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!id) {
    // eslint-disable-next-line no-console
    console.error(`[catalog] ${source}: provider missing 'id'`);
    return null;
  }
  const caps = parseCapabilities(r.capabilities);
  return {
    id,
    displayName: typeof r.displayName === 'string' ? r.displayName : id,
    aliases: stringArray(r.aliases),
    modelPrefixes: stringArray(r.modelPrefixes),
    apiKeyEnv: typeof r.apiKeyEnv === 'string' ? r.apiKeyEnv : '',
    endpointPattern: typeof r.endpointPattern === 'string' ? r.endpointPattern : '',
    defaultStreaming: enumOr(r.defaultStreaming, ['sse', 'ws', 'polling'], 'sse'),
    toolCallingFormat: enumOr(
      r.toolCallingFormat,
      ['native-anthropic', 'native-openai', 'native-gemini', 'none'],
      'none',
    ),
    capabilities: caps,
    builtIn: r.builtIn === true,
    ...(r.catalogFromDiscovery === true ? { catalogFromDiscovery: true } : {}),
  };
}

function parseCapabilities(raw: unknown): ProviderCapabilities {
  const out: ProviderCapabilities = { ...PROVIDER_CAPABILITIES_NONE };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(out) as (keyof ProviderCapabilities)[]) {
    if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  }
  return out;
}

// ── Model parse ───────────────────────────────────────────────────────

function parseModel(raw: unknown, source: string): ModelSpec | null {
  if (!raw || typeof raw !== 'object') {
    // eslint-disable-next-line no-console
    console.error(`[catalog] ${source}: model yaml must be an object`);
    return null;
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  const provider = typeof r.provider === 'string' ? r.provider : '';
  if (!id || !provider) {
    // eslint-disable-next-line no-console
    console.error(`[catalog] ${source}: model missing 'id' or 'provider'`);
    return null;
  }
  const spec: ModelSpec = {
    id,
    provider,
    displayName: typeof r.displayName === 'string' ? r.displayName : id,
  };
  if (typeof r.family === 'string') spec.family = r.family;
  if (typeof r.familyShortcut === 'string') spec.familyShortcut = r.familyShortcut;
  if (typeof r.contextSize === 'number') spec.contextSize = r.contextSize;
  if (typeof r.outputMaxTokens === 'number') spec.outputMaxTokens = r.outputMaxTokens;
  if (typeof r.vision === 'string' || r.vision === null) {
    spec.vision = r.vision as ModelSpec['vision'];
  }
  if (r.audio && typeof r.audio === 'object') {
    const a = r.audio as Record<string, unknown>;
    spec.audio = { input: a.input === true, output: a.output === true };
  }
  if (typeof r.reasoning === 'string' || r.reasoning === null) {
    spec.reasoning = r.reasoning as ModelSpec['reasoning'];
  }
  if (typeof r.toolCalling === 'string') spec.toolCalling = r.toolCalling as ModelSpec['toolCalling'];
  if (typeof r.streamingProtocol === 'string') {
    spec.streamingProtocol = r.streamingProtocol as ModelSpec['streamingProtocol'];
  }
  if (r.pricing && typeof r.pricing === 'object') {
    const p = r.pricing as Record<string, unknown>;
    if (typeof p.inputPerMTok === 'number' && typeof p.outputPerMTok === 'number') {
      spec.pricing = {
        inputPerMTok: p.inputPerMTok,
        outputPerMTok: p.outputPerMTok,
        ...(typeof p.cachedInputPerMTok === 'number' ? { cachedInputPerMTok: p.cachedInputPerMTok } : {}),
      };
    }
  }
  if (r.rateLimits && typeof r.rateLimits === 'object') {
    const rl = r.rateLimits as Record<string, unknown>;
    spec.rateLimits = {
      ...(typeof rl.rpm === 'number' ? { rpm: rl.rpm } : {}),
      ...(typeof rl.tpm === 'number' ? { tpm: rl.tpm } : {}),
    };
  }
  if (r.deprecated === null || typeof r.deprecated === 'string') {
    spec.deprecated = r.deprecated as string | null;
  }
  if (typeof r.releaseDate === 'string') spec.releaseDate = r.releaseDate;
  if (typeof r.tokenizer === 'string') spec.tokenizer = r.tokenizer as ModelSpec['tokenizer'];
  if (typeof r.kind === 'string') spec.kind = r.kind as ModelSpec['kind'];
  if (r.capabilities && typeof r.capabilities === 'object') {
    spec.capabilities = parseCapabilities(r.capabilities);
  }
  if (r.discoveryMeta && typeof r.discoveryMeta === 'object') {
    const dm = r.discoveryMeta as Record<string, unknown>;
    if (typeof dm.source === 'string' && typeof dm.lastSeen === 'string') {
      spec.discoveryMeta = {
        source: dm.source as ModelSpec['discoveryMeta'] extends infer T ? T extends { source: infer S } ? S : never : never,
        lastSeen: dm.lastSeen,
        autoFilled: dm.autoFilled === true,
        ...(typeof dm.confidence === 'string'
          ? { confidence: dm.confidence as 'high' | 'medium' | 'low' }
          : {}),
      };
    }
  }
  return spec;
}

// ── Pattern parse ────────────────────────────────────────────────────

function parsePatterns(raw: unknown, source: string): ModelPatternFallback | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const provider = typeof r.provider === 'string' ? r.provider : '';
  if (!provider) {
    // eslint-disable-next-line no-console
    console.error(`[catalog] ${source}: _patterns missing 'provider'`);
    return null;
  }
  const prefArr = Array.isArray(r.prefixes) ? r.prefixes : [];
  const prefixes: ModelPatternFallback['prefixes'] = [];
  for (const item of prefArr) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    if (typeof it.prefix !== 'string' || !it.fallback || typeof it.fallback !== 'object') continue;
    prefixes.push({
      prefix: it.prefix,
      fallback: it.fallback as Partial<ModelSpec>,
    });
  }
  return { provider, prefixes };
}

// ── Helpers ──────────────────────────────────────────────────────────

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string');
}

function enumOr<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  if (typeof v === 'string' && (allowed as string[]).includes(v)) return v as T;
  return fallback;
}

// ── Tier merge (RFC §6.4) ─────────────────────────────────────────────

function mergeProviders(
  builtin: ProviderRegistration,
  overlay: ProviderRegistration,
): ProviderRegistration {
  return {
    ...builtin,
    // Replace single-value fields when overlay specifies them.
    displayName: overlay.displayName || builtin.displayName,
    apiKeyEnv: overlay.apiKeyEnv || builtin.apiKeyEnv,
    endpointPattern: overlay.endpointPattern || builtin.endpointPattern,
    defaultStreaming: overlay.defaultStreaming || builtin.defaultStreaming,
    toolCallingFormat: overlay.toolCallingFormat || builtin.toolCallingFormat,
    builtIn: builtin.builtIn,
    // Union for aliases / modelPrefixes (RFC §6.4 — "alias 추가가 의도").
    aliases: dedup([...builtin.aliases, ...overlay.aliases]),
    modelPrefixes: dedup([...builtin.modelPrefixes, ...overlay.modelPrefixes]),
    // Partial merge for capabilities (only overlay's true/false specified
    // fields override; missing fields keep builtin).
    capabilities: { ...builtin.capabilities, ...overlay.capabilities },
  };
}

function dedup(xs: string[]): string[] {
  return [...new Set(xs)];
}

// ── Loader ────────────────────────────────────────────────────────────

let cachedCatalog: Catalog | null = null;

function buildCatalog(): Catalog {
  const builtinDir = resolveBuiltinCatalogDir();
  const globalDir = resolveGlobalCatalogDir();

  const providers = new Map<string, ProviderRegistration>();
  const models = new Map<string, ModelSpec>();
  const patterns = new Map<string, ModelPatternFallback>();
  let fileCount = 0;

  // --- builtin tier ---
  const builtinProviderDir = join(builtinDir, 'providers');
  for (const path of listYamlFiles(builtinProviderDir)) {
    const raw = safeReadYaml(path);
    const provider = parseProvider(raw, path);
    if (provider) {
      providers.set(provider.id, provider);
      fileCount++;
    }
  }

  const builtinModelsDir = join(builtinDir, 'models');
  if (existsSync(builtinModelsDir)) {
    for (const providerDir of readdirSync(builtinModelsDir)) {
      const dir = join(builtinModelsDir, providerDir);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch { continue; }
      for (const path of listYamlFiles(dir)) {
        const raw = safeReadYaml(path);
        if (path.endsWith('_patterns.yaml') || path.endsWith('_patterns.yml')) {
          const pat = parsePatterns(raw, path);
          if (pat) {
            patterns.set(pat.provider, pat);
            fileCount++;
          }
          continue;
        }
        const model = parseModel(raw, path);
        if (model) {
          models.set(model.id, model);
          fileCount++;
        }
      }
    }
  }

  // --- global tier overlay ---
  const globalProviderDir = join(globalDir, 'providers');
  for (const path of listYamlFiles(globalProviderDir)) {
    const raw = safeReadYaml(path);
    const overlay = parseProvider(raw, path);
    if (!overlay) continue;
    fileCount++;
    const base = providers.get(overlay.id);
    providers.set(overlay.id, base ? mergeProviders(base, overlay) : overlay);
  }

  const globalModelsDir = join(globalDir, 'models');
  if (existsSync(globalModelsDir)) {
    for (const providerDir of readdirSync(globalModelsDir)) {
      const dir = join(globalModelsDir, providerDir);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch { continue; }
      for (const path of listYamlFiles(dir)) {
        const raw = safeReadYaml(path);
        if (path.endsWith('_patterns.yaml') || path.endsWith('_patterns.yml')) {
          const pat = parsePatterns(raw, path);
          if (pat) {
            const existing = patterns.get(pat.provider);
            patterns.set(pat.provider, existing
              ? { provider: pat.provider, prefixes: [...existing.prefixes, ...pat.prefixes] }
              : pat);
            fileCount++;
          }
          continue;
        }
        const model = parseModel(raw, path);
        if (model) {
          // global wins on dup id (RFC §6.4 — single-value fields replace).
          models.set(model.id, model);
          fileCount++;
        }
      }
    }
  }

  // --- discovery fold (대표 2026-09-23 «파생한다») ---
  const folded = foldDiscoveredModels(providers, models, loadFoldSnapshot());
  for (const m of folded) models.set(m.id, m);

  return {
    catalogVersion: 1,
    providers,
    models,
    patterns,
    manifest: {
      builtinSource: builtinDir,
      globalSource: globalDir,
      fileCount,
      loadedAt: new Date().toISOString(),
    },
  };
}

/** 시험 런타임(NODE_ENV=test)은 카탈로그 스냅숏을 기본 경로에서 접지 않는다 — 이 판정을 쓰는 쪽(자식 모델 형식 검사)과 공유한다. */
export function isolatedCatalogTestUniverse(): boolean {
  return process.env.NODE_ENV === 'test';
}

/** 폴드할 스냅숏을 고른다. ⛔ 시험 런타임은 preload 가 config-dir 를 격리하지 않아 실제
 *  `~/.elanous/discovery-snapshot.json` 을 읽게 되므로(=기계마다 다른 카탈로그), 경로를 «명시»했을
 *  때만 접는다. 운영은 기본 경로를 읽고, 없으면 «모른다»(null) — 접을 것이 없을 뿐 오류가 아니다. */
function loadFoldSnapshot(): DiscoverySnapshot | null {
  const explicit = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT?.trim();
  if (explicit) return readDiscoveryCache({ cachePath: explicit });
  if (isolatedCatalogTestUniverse()) return null;
  return readDiscoveryCache();
}

/** 발견 스냅숏을 카탈로그 모델로 «접는다» — `catalogFromDiscovery: true` 로 선언한 provider 만.
 *  - id 는 `<provider>/<upstream id>` 로 네임스페이스한다: OpenRouter id(`anthropic/claude-…`)를 그대로
 *    넣으면 `inferProviderFromModel` 1단계(정확 일치)가 기존 provider 판정을 조용히 뒤집는다.
 *  - YAML(builtin·global)에 같은 id 가 있으면 YAML 이 이긴다 — 발견은 «채우기»지 «덮기»가 아니다.
 *  - 스냅숏 안의 중복 id 는 첫 것만. 스냅숏이 없으면 빈 배열(= 모른다). */
export function foldDiscoveredModels(
  providers: ReadonlyMap<string, ProviderRegistration>,
  existing: ReadonlyMap<string, ModelSpec>,
  snapshot: DiscoverySnapshot | null,
): ModelSpec[] {
  if (!snapshot) return [];
  const out: ModelSpec[] = [];
  const seen = new Set<string>();
  for (const d of snapshot.models) {
    const reg = providers.get(d.provider);
    if (!reg?.catalogFromDiscovery || typeof d.id !== 'string' || !d.id) continue;
    const id = d.id.startsWith(`${reg.id}/`) ? d.id : `${reg.id}/${d.id}`;
    if (existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      ...d.partial,
      id,
      provider: reg.id,
      displayName: d.partial.displayName ?? d.id,
      discoveryMeta: d.discoveryMeta,
    });
  }
  return out;
}

/** Per-process singleton accessor. First call reads YAML; subsequent
 *  calls return the cached snapshot. Use `reloadCatalog()` to bust. */
export function getCatalog(): Catalog {
  if (cachedCatalog) return cachedCatalog;
  cachedCatalog = buildCatalog();
  return cachedCatalog;
}

/** Force re-read from disk — used by tests + Phase 6 hot-reload. */
export function reloadCatalog(): Catalog {
  cachedCatalog = buildCatalog();
  return cachedCatalog;
}

/** Test-only: drop the cached snapshot. */
export function __resetCatalogForTests(): void {
  cachedCatalog = null;
}
