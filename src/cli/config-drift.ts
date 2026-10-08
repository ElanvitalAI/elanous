// ── CFG-STORE1 · 읽기 전용 «유효 config ⊕ 출처» · 드리프트 표 (0.2.20 · 2026-10-08) ──
//
// RFC-universe-by-house-not-tree-and-config-store-2026-10-06 §2·§3.
//
// S: 집(운영 `~/.elanous`)과 파생 시험 우주(`<트리>/.elanous-test` · 10-06 실측 161)가 각자
//    `config.json` 사본을 «물질화»해 갖는다. 운영 키를 바꿔도 사본은 그대로다.
// C: 10-08 밤 — 운영 `harness.podPool` 에서 node-c 를 뺐는데 자리·작업 트리의 시험 우주 사본 36개가
//    옛 podPool(node-c 포함)을 들고 있어, 그 트리에서 쏜 발사가 계속 node-c 에 Pod 를 놓았다.
// Q: 「어느 키가 어느 우주에서 운영과 다른가」를 한 명령으로 볼 수 있나.
// A: `elanous config drift` · `elanous config explain <key>` — 이 모듈이 그 계산이다.
//
// ⛔ 불변식
//   • 읽기만 한다 — 레지스트리 prune(readLogInstances)·XDG 이주(userConfigPath)도 부르지 않는다.
//   • 못 읽은 config 는 «못 읽음»으로 따로 센다 — 절대 「같다」로 접지 않는다.
//   • 비밀 값은 찍지 않는다 — 경로의 한 마디라도 token/secret/key/password 면 값을 가린다.
//   • config.json 이 «없는» 우주는 비교에서 빼되 수를 낸다(그 우주는 코드 기본값으로 돈다).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { redactSecretText } from '../debug/log.js';
import { resolveInstanceKind, type LogInstanceEntry } from '../mss/logging/instance-registry.js';
import { buildTestSafeRawConfig } from './config-test-sync.js';
import { prodInstanceRoot } from '../instance/resolve.js';

export type UniverseOrigin = 'registry' | 'tree-scan';
export type UniverseStatus = 'ok' | 'no-config' | 'unreadable' | 'gone';

export interface UniverseConfig {
  configDir: string;
  configPath: string;
  origins: UniverseOrigin[];
  status: UniverseStatus;
  /** status=unreadable 일 때 사유. */
  error?: string;
  /** status=ok 일 때 파일 원문(raw) — 겹 «파일» 층. */
  raw?: Record<string, unknown>;
}

export interface DiscoverOptions {
  prodRoot?: string;
  /** 인스턴스 레지스트리(`~/.elanous/logs/instances.json`) — 읽기만. null 이면 안 읽는다. */
  registryPath?: string | null;
  /** 명시 트리 뿌리 — 각 자식 디렉토리의 `.elanous-test` 를 본다. */
  treeScanRoots?: string[];
}

// 비밀 «이름» — 대소문자 무시 낱말 ⊕ 「auth」「pass」는 낱말 경계로만(authorOnPod·bypass 는 아니다).
const SECRET_NAME = /token|secret|key|password|passphrase|credential|authorization|oauth|bearer|cookie|session|dsn/i;
const SECRET_NAME_CAMEL = /(?:(?:^|[^a-zA-Z])(?:auth|AUTH|pass|PASS)|(?:Auth|Pass))(?![a-z])/;
// 비밀 «값» — 이름이 무해해도(notify.url) 값 모양으로 가린다.
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i,                    // URL userinfo (https://user:pass@host)
  /discord(?:app)?\.com\/api\/webhooks|hooks\.slack\.com/i, // Discord·Slack 웹훅
  /^\s*(?:ghp_|gho_|ghs_|github_pat_|sk-|xoxb-|xoxp-|Bearer\s)/, // 토큰 접두
];

/** 키 한 마디가 비밀 이름인가. */
export function isSecretName(segment: string): boolean {
  return SECRET_NAME.test(segment) || SECRET_NAME_CAMEL.test(segment);
}

/** 문자열 값이 비밀 모양인가(이름과 무관). */
export function isSecretValue(value: unknown): boolean {
  return typeof value === 'string' && SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}
export const MASK = '<masked>';

export function defaultProdRoot(): string {
  return prodInstanceRoot(); // 집 = 운영 뿌리(우주 리졸버 경유 · 격리 게이트)
}

export function defaultRegistryPath(prodRoot: string = defaultProdRoot()): string {
  return join(prodRoot, 'logs', 'instances.json');
}

/** 레지스트리 밖에서 시험 우주가 사는 «알려진» 트리 뿌리(10-08 사건의 세 곳). 명시 목록 — 홈 전체를 훑지 않는다. */
export function defaultTreeScanRoots(home: string = homedir()): string[] {
  return [join(home, 'elanous-hq', 'seats'), join(home, 'elanous-hq', 'work'), join(home, 'source', 'pilot')];
}

/** 읽기 실패 사유 — ⛔ 파서 메시지는 파일 «내용» 조각을 실을 수 있어 그대로 내지 않는다(비밀 노출). 종류·errno 코드만. */
export function safeReadError(err: unknown): string {
  if (err instanceof SyntaxError) return 'JSON 파싱 실패';
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return `읽기 실패(${code})`;
  return '읽기 실패';
}

function norm(p: string): string {
  return resolve(p.trim().replace(/\/+$/, ''));
}

/** 레지스트리를 «읽기만» 한다(prune 쓰기 없음). 실패는 {ok:false}. */
export function readRegistryReadOnly(path: string): { ok: boolean; entries: LogInstanceEntry[]; error?: string } {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { instances?: unknown };
    if (!Array.isArray(parsed.instances)) return { ok: false, entries: [], error: 'instances 배열 없음' };
    const entries = parsed.instances.filter((e): e is LogInstanceEntry => !!e && typeof e === 'object'
      && typeof (e as LogInstanceEntry).stateDir === 'string');
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, entries: [], error: safeReadError(err) };
  }
}

export function readUniverseConfig(configDir: string, origins: UniverseOrigin[]): UniverseConfig {
  const configPath = join(configDir, 'config.json');
  if (!existsSync(configDir)) return { configDir, configPath, origins, status: 'gone' };
  if (!existsSync(configPath)) return { configDir, configPath, origins, status: 'no-config' };
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { configDir, configPath, origins, status: 'unreadable', error: '최상위가 객체가 아님' };
    }
    return { configDir, configPath, origins, status: 'ok', raw: parsed as Record<string, unknown> };
  } catch (err) {
    return { configDir, configPath, origins, status: 'unreadable', error: safeReadError(err) };
  }
}

export interface DiscoveryResult {
  prod: UniverseConfig;
  derived: UniverseConfig[];
  registry: { path: string | null; ok: boolean; entries: number; testEntries: number; error?: string };
  treeScanRoots: string[];
}

/** 집 ⊕ 파생 시험 우주를 모은다 — 레지스트리(test 항목) ∪ 명시 트리 뿌리. configDir 로 중복 제거. */
export function discoverUniverses(opts: DiscoverOptions = {}): DiscoveryResult {
  const prodRoot = norm(opts.prodRoot ?? defaultProdRoot());
  const registryPath = opts.registryPath === undefined ? defaultRegistryPath(prodRoot) : opts.registryPath;
  const treeScanRoots = (opts.treeScanRoots ?? defaultTreeScanRoots()).map(norm);
  const found = new Map<string, Set<UniverseOrigin>>();
  const add = (dir: string, origin: UniverseOrigin) => {
    const d = norm(dir);
    if (d === prodRoot) return;
    const set = found.get(d) ?? new Set<UniverseOrigin>();
    set.add(origin);
    found.set(d, set);
  };

  let registry: DiscoveryResult['registry'] = { path: registryPath, ok: false, entries: 0, testEntries: 0 };
  if (registryPath) {
    const r = readRegistryReadOnly(registryPath);
    let testEntries = 0;
    for (const e of r.entries) {
      if (resolveInstanceKind(e) !== 'test') continue;
      testEntries++;
      add(e.configDir ?? e.stateDir, 'registry');
    }
    registry = { path: registryPath, ok: r.ok, entries: r.entries.length, testEntries, ...(r.error ? { error: r.error } : {}) };
  }

  for (const root of treeScanRoots) {
    let children: string[] = [];
    try { children = readdirSync(root); } catch { continue; }
    for (const child of children) {
      const tree = join(root, child);
      try { if (!statSync(tree).isDirectory()) continue; } catch { continue; }
      const candidate = join(tree, '.elanous-test');
      if (existsSync(candidate)) add(candidate, 'tree-scan');
    }
  }

  const derived = [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, origins]) => readUniverseConfig(dir, [...origins].sort()));
  return { prod: readUniverseConfig(prodRoot, []), derived, registry, treeScanRoots };
}

// ── 값 평탄화 · 가림 ──

export function isSecretPath(key: string): boolean {
  return key.split('.').some(isSecretName);
}

/** 객체는 내려가고, 배열·원시값·빈 객체는 잎으로 둔다. */
export function flattenConfig(raw: Record<string, unknown>, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
  for (const [k, v] of Object.entries(raw)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0) {
      flattenConfig(v as Record<string, unknown>, key, out);
    } else {
      out.set(key, v);
    }
  }
  return out;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
}

/** 잎 안의 구조(배열 속 객체 등)도 내려가 비밀 이름 키의 값을 가린다 — `telegram.channels[].botToken` 같은 자리. */
export function maskDeep(value: unknown): unknown {
  if (isSecretValue(value)) return MASK;
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, isSecretName(k) ? MASK : maskDeep(v)]));
  }
  return value;
}

/** 표시용 값 — 비밀 경로면 가린다, 아니면 구조 안 비밀 키 가림 ⊕ 텍스트 축 가림. */
export function displayValue(key: string, value: unknown, present = true): string {
  if (!present) return '(없음)';
  if (isSecretPath(key) || isSecretValue(value)) return MASK;
  const s = typeof value === 'string' ? JSON.stringify(value) : stableStringify(maskDeep(value));
  const red = redactSecretText(s);
  return red.length > 160 ? `${red.slice(0, 157)}...` : red;
}

function matchesKey(key: string, filter?: string): boolean {
  if (!filter) return true;
  return key === filter || key.startsWith(`${filter}.`);
}

// ── 드리프트 ──

export interface DriftValueGroup {
  /** 표시값(가림 적용). 없으면 '(없음)'. */
  value: string;
  present: boolean;
  count: number;
  examples: string[];
}

export interface DriftRow {
  key: string;
  prodPresent: boolean;
  prodValue: string;
  /** 운영과 다른 파생 우주 수(비교 대상 중). */
  differing: number;
  /** 운영엔 있는데 파생엔 없음. */
  missingInDerived: number;
  /** 운영엔 없는데 파생엔 있음. */
  extraInDerived: number;
  /** 둘 다 있는데 값이 다름. */
  valueDiffers: number;
  groups: DriftValueGroup[];
}

export interface DriftReport {
  prodConfigPath: string;
  prodStatus: UniverseStatus;
  prodError?: string;
  keyFilter?: string;
  /** false(기본)면 «의도된 차이»를 드리프트로 안 센다 — `config sync-test` 의 test-safe 변환 결과와 같은 값 ⊕ `_test*` 메타 키. */
  includeExpected: boolean;
  universes: { total: number; compared: number; noConfig: number; unreadable: number; gone: number };
  registry: DiscoveryResult['registry'];
  treeScanRoots: string[];
  unreadable: Array<{ configPath: string; error: string }>;
  rows: DriftRow[];
}

const EXAMPLES = 3;

/** 사본 메타 키(`_testSyncedAt`·`_testSyncedFrom`·`_testSecretsStripped`) — 우주마다 다른 게 정상이다. */
export function isSyncMetaKey(key: string): boolean {
  return key.startsWith('_test');
}

export function computeDrift(d: DiscoveryResult, opts: { key?: string; includeExpected?: boolean } = {}): DriftReport {
  const includeExpected = opts.includeExpected === true;
  const compared = d.derived.filter((u) => u.status === 'ok');
  const unreadable = d.derived.filter((u) => u.status === 'unreadable');
  const report: DriftReport = {
    prodConfigPath: d.prod.configPath,
    prodStatus: d.prod.status,
    ...(d.prod.error ? { prodError: d.prod.error } : {}),
    ...(opts.key ? { keyFilter: opts.key } : {}),
    includeExpected,
    universes: {
      total: d.derived.length,
      compared: compared.length,
      noConfig: d.derived.filter((u) => u.status === 'no-config').length,
      unreadable: unreadable.length,
      gone: d.derived.filter((u) => u.status === 'gone').length,
    },
    registry: d.registry,
    treeScanRoots: d.treeScanRoots,
    unreadable: unreadable.map((u) => ({ configPath: u.configPath, error: u.error ?? '알 수 없음' })),
    rows: [],
  };
  // ⛔ 운영을 못 읽으면 비교 자체를 하지 않는다 — 「드리프트 0」으로 보이면 안 된다.
  if (d.prod.status !== 'ok' || !d.prod.raw) return report;

  const prodFlat = flattenConfig(d.prod.raw);
  // 「의도된 차이」의 자 — 오늘 운영 config 로 sync-test 를 돌리면 사본에 박힐 값.
  const safeFlat = includeExpected ? null : flattenConfig(buildTestSafeRawConfig(d.prod.raw));
  const derivedFlat = compared.map((u) => ({ u, flat: flattenConfig(u.raw!) }));
  const keys = new Set<string>([...prodFlat.keys()].filter((k) => matchesKey(k, opts.key)));
  for (const { flat } of derivedFlat) for (const k of flat.keys()) if (matchesKey(k, opts.key)) keys.add(k);

  for (const key of [...keys].sort()) {
    if (!includeExpected && isSyncMetaKey(key)) continue;
    const prodPresent = prodFlat.has(key);
    const prodSig = prodPresent ? stableStringify(prodFlat.get(key)) : undefined;
    const safePresent = safeFlat?.has(key) ?? false;
    const safeSig = safePresent ? stableStringify(safeFlat!.get(key)) : undefined;
    const groups = new Map<string, DriftValueGroup>();
    let missingInDerived = 0, extraInDerived = 0, valueDiffers = 0;
    for (const { u, flat } of derivedFlat) {
      const present = flat.has(key);
      const sig = present ? stableStringify(flat.get(key)) : undefined;
      if (present === prodPresent && sig === prodSig) continue;
      if (safeFlat && present === safePresent && sig === safeSig) continue; // test-safe 변환 그대로 — 의도된 차이
      if (!present) missingInDerived++;
      else if (!prodPresent) extraInDerived++;
      else valueDiffers++;
      const groupKey = present ? `v:${sig}` : 'absent';
      const g = groups.get(groupKey) ?? {
        // 비밀 경로는 값 그룹마다 번호만 — 서로 다른지는 보이되 값은 안 보인다.
        value: present ? (isSecretPath(key) ? `${MASK}#${groups.size + 1}` : displayValue(key, flat.get(key))) : '(없음)',
        present, count: 0, examples: [],
      };
      g.count++;
      if (g.examples.length < EXAMPLES) g.examples.push(u.configPath);
      groups.set(groupKey, g);
    }
    const differing = missingInDerived + extraInDerived + valueDiffers;
    if (differing === 0) continue;
    report.rows.push({
      key, prodPresent,
      prodValue: displayValue(key, prodFlat.get(key), prodPresent),
      differing, missingInDerived, extraInDerived, valueDiffers,
      groups: [...groups.values()].sort((a, b) => b.count - a.count),
    });
  }
  report.rows.sort((a, b) => b.differing - a.differing || a.key.localeCompare(b.key));
  return report;
}

function walk(root: unknown, key: string): { present: boolean; value?: unknown } {
  let cur: unknown = root;
  for (const part of key.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object' || !(part in (cur as Record<string, unknown>))) return { present: false };
    cur = (cur as Record<string, unknown>)[part];
  }
  return { present: true, value: cur };
}

function shortHome(p: string): string {
  const h = homedir();
  return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

function universeSummaryLine(r: DriftReport): string {
  const u = r.universes;
  return `파생 우주 ${u.total} (비교 ${u.compared} · config 없음 ${u.noConfig} · 못 읽음 ${u.unreadable} · 사라짐 ${u.gone})`
    + ` · 레지스트리 ${r.registry.path === null ? '끔' : r.registry.ok ? `test ${r.registry.testEntries}/${r.registry.entries}` : `못 읽음${r.registry.error ? `(${r.registry.error})` : ''}`}`
    + ` · 트리 뿌리 ${r.treeScanRoots.length}`;
}

export function renderDrift(r: DriftReport, opts: { limit?: number } = {}): string {
  const lines: string[] = [];
  lines.push(`config drift — 집 ${shortHome(r.prodConfigPath)}${r.keyFilter ? ` · 키 ${r.keyFilter}` : ''}`
    + (r.includeExpected ? ' · 의도된 차이 포함' : ' · 의도된 차이(test-safe 변환·_test 메타) 제외 — --include-expected'));
  lines.push(`  ${universeSummaryLine(r)}`);
  if (r.prodStatus !== 'ok') {
    lines.push(`  ⛔ 운영 config 못 읽음(${r.prodStatus}${r.prodError ? `: ${r.prodError}` : ''}) — 비교하지 않았다(「드리프트 0」이 아니다)`);
  }
  if (r.universes.compared === 0 && r.prodStatus === 'ok') lines.push('  ⚠️ 비교한 파생 우주 0 — 「드리프트 0」이 아니라 «잴 대상이 없었다»');
  const limit = opts.limit ?? 50;
  const shown = limit > 0 ? r.rows.slice(0, limit) : r.rows;
  lines.push(`  드리프트 키 ${r.rows.length}`);
  for (const row of shown) {
    const parts: string[] = [];
    if (row.missingInDerived) parts.push(`파생에 없음 ${row.missingInDerived}`);
    if (row.extraInDerived) parts.push(`운영에 없음 ${row.extraInDerived}`);
    if (row.valueDiffers) parts.push(`값 다름 ${row.valueDiffers}`);
    lines.push(`\n  ${row.key}  ${row.differing}/${r.universes.compared} 우주 다름 (${parts.join(' · ')})`);
    lines.push(`    운영: ${row.prodValue}`);
    for (const g of row.groups.slice(0, 4)) {
      lines.push(`    ${g.value} × ${g.count}  예: ${g.examples.map(shortHome).join(', ')}`);
    }
    if (row.groups.length > 4) lines.push(`    … 값 묶음 ${row.groups.length - 4}개 더 (--json)`);
  }
  if (shown.length < r.rows.length) lines.push(`\n  … ${r.rows.length - shown.length}개 키 더 — --limit 0 또는 --json (⚠️ 잘린 표다)`);
  if (r.unreadable.length) {
    lines.push('\n  못 읽음 (같다고 보지 않음):');
    for (const u of r.unreadable.slice(0, 20)) lines.push(`    ${shortHome(u.configPath)} — ${u.error}`);
    if (r.unreadable.length > 20) lines.push(`    … ${r.unreadable.length - 20}개 더 (--json)`);
  }
  return lines.join('\n');
}

// ── explain ──

export type ProdSourceLayer = 'prod-file' | 'llm-fallback' | 'code-default' | 'unset' | 'prod-unreadable';

export interface ExplainReport {
  key: string;
  prod: { configPath: string; layer: ProdSourceLayer; value: string; note?: string };
  codeDefault: { present: boolean; value: string };
  /** false 면 운영을 못 읽어 파생과 «비교하지 않았다» — groups 는 비고 「다름」으로 세지 않는다. */
  comparable?: boolean;
  universes: DriftReport['universes'];
  registry: DiscoveryResult['registry'];
  treeScanRoots: string[];
  /** 파생 우주 값 묶음 — 운영과 같은 것도 포함(sameAsProd). */
  groups: Array<DriftValueGroup & { sameAsProd: boolean }>;
  unreadable: Array<{ configPath: string; error: string }>;
}

export interface ExplainDeps {
  /** 코드 기본값 객체(파일 없이 만든 유효 config). ⛔ 필수 — 없으면 「기본값 없음」과 「모름」이 섞인다. */
  codeDefaults: () => unknown;
  /** `<prodRoot>/llm-fallback.json` 원문. */
  llmFallbackPath?: string;
}

/** `buildUserConfig` 의 llm-fallback 적용 조건과 같은 판정 — provider 가 없거나 auto/none 이면 «빈» llm 절. */
export function isLlmSectionEmptyRaw(llm: unknown): boolean {
  if (!llm || typeof llm !== 'object' || Array.isArray(llm)) return true;
  const provider = (llm as Record<string, unknown>).provider;
  return typeof provider !== 'string' || provider.trim() === '' || provider === 'auto' || provider === 'none';
}

export function computeExplain(d: DiscoveryResult, key: string, deps: ExplainDeps): ExplainReport {
  const defaults = walk(deps.codeDefaults(), key);
  const codeDefault = { present: defaults.present, value: displayValue(key, defaults.value, defaults.present) };

  let prod: ExplainReport['prod'];
  if (d.prod.status !== 'ok' || !d.prod.raw) {
    prod = { configPath: d.prod.configPath, layer: 'prod-unreadable', value: '(못 읽음)', note: d.prod.error ?? d.prod.status };
  } else {
    const fromFile = walk(d.prod.raw, key);
    if (fromFile.present) {
      prod = { configPath: d.prod.configPath, layer: 'prod-file', value: displayValue(key, fromFile.value) };
    } else {
      let fb: { present: boolean; value?: unknown } = { present: false };
      const fbPath = deps.llmFallbackPath ?? join(d.prod.configDir, 'llm-fallback.json');
      // 폴백 파일은 운영 llm 절이 «비었을 때만» 합쳐진다 — 그 조건이 아닐 땐 출처 층이 아니다.
      if (key.startsWith('llm.') && isLlmSectionEmptyRaw(d.prod.raw.llm) && existsSync(fbPath)) {
        try { fb = walk(JSON.parse(readFileSync(fbPath, 'utf-8')), key.slice(4)); } catch { /* 못 읽으면 폴백 층 아님 */ }
      }
      if (fb.present) {
        prod = { configPath: fbPath, layer: 'llm-fallback', value: displayValue(key, fb.value), note: '운영 llm 절이 비어 폴백 파일이 쓰인다' };
      } else if (defaults.present) {
        prod = { configPath: d.prod.configPath, layer: 'code-default', value: codeDefault.value, note: '파일에 없음 — 코드 기본값' };
      } else {
        prod = { configPath: d.prod.configPath, layer: 'unset', value: '(없음)' };
      }
    }
  }

  const prodRaw = d.prod.raw ? walk(d.prod.raw, key) : { present: false };
  const prodSig = prodRaw.present ? stableStringify(prodRaw.value) : undefined;
  const groups = new Map<string, DriftValueGroup & { sameAsProd: boolean }>();
  const compared = d.derived.filter((u) => u.status === 'ok');
  const comparable = d.prod.status === 'ok' && !!d.prod.raw;
  for (const u of comparable ? compared : []) {
    const w = walk(u.raw, key);
    const sig = w.present ? stableStringify(w.value) : undefined;
    const gk = w.present ? `v:${sig}` : 'absent';
    const sameAsProd = w.present === prodRaw.present && sig === prodSig;
    const g = groups.get(gk) ?? {
      value: w.present
        ? (isSecretPath(key) ? `${MASK}#${groups.size + 1}` : displayValue(key, w.value))
        : codeDefault.present ? `(없음 → 코드 기본값 ${codeDefault.value})` : '(없음 · 코드 기본값도 없음)',
      present: w.present, count: 0, examples: [], sameAsProd,
    };
    g.count++;
    if (g.examples.length < EXAMPLES) g.examples.push(u.configPath);
    groups.set(gk, g);
  }
  const unreadable = d.derived.filter((u) => u.status === 'unreadable');
  return {
    key, prod, codeDefault, comparable,
    universes: {
      total: d.derived.length,
      compared: compared.length,
      noConfig: d.derived.filter((u) => u.status === 'no-config').length,
      unreadable: unreadable.length,
      gone: d.derived.filter((u) => u.status === 'gone').length,
    },
    registry: d.registry,
    treeScanRoots: d.treeScanRoots,
    groups: [...groups.values()].sort((a, b) => Number(a.sameAsProd) - Number(b.sameAsProd) || b.count - a.count),
    unreadable: unreadable.map((u) => ({ configPath: u.configPath, error: u.error ?? '알 수 없음' })),
  };
}

export function renderExplain(r: ExplainReport): string {
  const lines: string[] = [];
  lines.push(`config explain ${r.key}`);
  lines.push(`  운영 값: ${r.prod.value}`);
  lines.push(`  출처 층: ${r.prod.layer} (${shortHome(r.prod.configPath)})${r.prod.note ? ` — ${r.prod.note}` : ''}`);
  lines.push(`  코드 기본값: ${r.codeDefault.value}`);
  lines.push(`  ${universeSummaryLine({ universes: r.universes, registry: r.registry, treeScanRoots: r.treeScanRoots } as DriftReport)}`);
  if (r.comparable === false) {
    lines.push('  ⛔ 운영 config 를 못 읽어 파생 우주와 비교하지 않았다(「다름」도 「같음」도 아니다)');
  } else {
    const differing = r.groups.filter((g) => !g.sameAsProd).reduce((s, g) => s + g.count, 0);
    lines.push(`  운영과 다른 우주 ${differing}/${r.universes.compared}`);
  }
  for (const g of r.groups) {
    lines.push(`    ${g.sameAsProd ? '= 운영과 같음' : '≠'} ${g.value} × ${g.count}  예: ${g.examples.map(shortHome).join(', ')}`);
  }
  if (r.unreadable.length) {
    lines.push('  못 읽음 (같다고 보지 않음):');
    for (const u of r.unreadable.slice(0, 20)) lines.push(`    ${shortHome(u.configPath)} — ${u.error}`);
  }
  return lines.join('\n');
}
