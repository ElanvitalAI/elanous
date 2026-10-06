// ── elanous logs — adb logcat 동형 CLI (통합 로그 패브릭 LF3 · 2026-07-13) ────
//
// 전 서피스 로그(logs.db)를 조회/실시간 tail 하고 데몬 레벨을 런타임 제어한다.
//
//   elanous logs                                  # 최근 100
//   elanous logs -f                               # 실시간 follow (tail -f)
//   elanous logs -f --surface pwa,telegram --level warn
//   elanous logs --category voice --grep timeout --since 30m
//   elanous logs level                            # 데몬 현재 레벨/게이트
//   elanous logs level diag                       # 런타임 변경 (+config 영속)
//
// 설계 결정 — 조회/follow 는 logs.db **직독**(데몬 다운이어도 동작·토큰 불요·
// ELANOUS_STATE_DIR 자동 존중), follow 는 afterId 증분 폴(500ms — REST SSE 와
// 같은 케이던스). 레벨 제어만 데몬 REST(/v1/logs/level — 런타임 상태라 프로세스
// 경유 필수). 설계: 내부 문서 `PLAN-unified-log-fabric-2026-07-13` §LF3.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { Command } from 'commander';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  LogStore,
  logsDbPath,
  resolveLogInstanceName,
  type LogQuery,
  type LogStoreRow,
} from '../mss/logging/log-store.js';
import {
  logInstanceRegistryPath,
  readLogInstanceScope,
  readLogInstances,
  type LogInstanceView,
} from '../mss/logging/instance-registry.js';
import { LOG_LEVEL_ORDER, type LogLevel } from '../mss/logging/record.js';
import { isRenderCategory, RENDER_ORIENTED_PREFIXES } from '../mss/logging/render-categories.js';
import { readScopedRenderLogs } from '../mss/logging/scoped-level.js';
import { formatClock } from '../time/format.js';
import { HARNESS_SPACE_KINDS } from '../harness/harness-space.js';
import { LOG_RETENTION_DEFAULTS, LogCursorNotFoundError, STORE_SAFETY_MAX } from '../mss/logging/log-store.js';
import { resolveDaemonEndpoint } from '../nexus/daemon-endpoint.js';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { tokenizeGrepPhrase } from '../domains/logs-tool.js';
import { LOG_AXIS_CATEGORIES, knownLogAxes, resolveLogAxis } from '../mss/logging/log-axis.js';
import { KNOWN_LOG_EVENT_NAMES } from './log-event-names.js';
import { bookmarkAttachDefaults } from './remote-resolve.js';
import { RemotesStore } from './remotes.js';
import { detectRepeatedFailures, explainFailure } from '../domains/repeated-failure.js';
import { redactSecretText } from '../debug/log.js';

export interface LogsCliOpts {
  follow?: boolean;
  /** Value-less `-r` — default remote bookmark. Names go on `--remote <name>`. */
  r?: boolean;
  /** Named remote bookmark (`--remote <name>`). `true` means default, matching `-r`. */
  remote?: string | boolean;
  level?: string;
  surface?: string;
  /** ★ 하니스 공간 필터(2026-07-21·Docker `docker logs <id>` 동형) — kind(self-implement|dev-harness|
   *  solve-mission)면 그 공간 surface(harness:<kind>) exact, 그 외(run id·branch slug)면 전 harness 공간 +
   *  id grep(병렬 self-dev per-run 격리 조회). harness-space 장치의 관측 소비자. */
  space?: string;
  category?: string;
  exactCategory?: string;
  /** Read-side category axis expanded to exactCategories. */
  axis?: string;
  /** Without --axis, discover known axes; with --axis, show stored-category diagnostics. */
  explain?: boolean;
  /** ⭐ 「실제로 뜬 카테고리 전수」 — 계측 목록과 차집합을 내기 위한 표면(`OBS-T122`). */
  listCategories?: boolean;
  /** ⭐ 「이 카테고리에 어떤 이벤트가 뜨나」 — 카테고리 필터 하의 이벤트별 발화 수. */
  listEvents?: boolean;
  event?: string;
  grep?: string;
  /** rework-budget data.recurrenceDisagreement 값 필터. */
  reworkRecurrenceDisagreement?: string;
  since?: string;
  topFailures?: boolean;
  threshold?: string;
  /** ⭐ 창의 **끝**을 닫는다 — `--since` 와 대칭(상대 표기·ISO·epoch). */
  until?: string;
  /**
   * ⭐ **역방향 페이지 커서** — 이 `id` **보다 오래된** 것만 준다.
   * ⛔ 없으면 `--since` 를 넓혀도 **최근 상한만큼**만 오고 과거로 못 간다(2026-07-29 실측).
   */
  before?: string;
  session?: string;
  limit?: string;
  json?: boolean;
  /** --json 출력에서 JSON data 문자열을 파싱된 값으로 내보낸다. */
  jsonData?: boolean;
  /** cwd 레포의 `.elanous-test/` 스토어를 본다 (LF7-b). */
  test?: boolean;
  /** 레지스트리에 등록된 인스턴스 이름으로 타겟 (LF7-b). */
  instance?: string;
  /** 전 인스턴스 연합 조회 — read-only 병합 (LF7-b). */
  all?: boolean;
  /** --all 연합에 격리 test 인스턴스도 포함(기본 제외 · Phase A). */
  includeTest?: boolean;
}

// ── 인스턴스 타겟 해석 (LF7-b) ────────────────────────────────────────
//
// 정책: 쓰기는 물리 격리·읽기는 연합. CLI 조회는 전부 read-only open —
// 타 인스턴스 스토어에 마이그레이션 포함 어떤 write 도 하지 않는다.

export interface LogTarget {
  name: string;
  dbPath: string;
}

export interface ResolveTargetDeps {
  cwd?: string;
  instances?: LogInstanceView[];
  /** 현재 우주(기본 타겟). 미주입 시 실 해석(`resolveLogInstanceName`/`logsDbPath`).
   *  주입 seam 인 이유: 기본 동선이 "내 우주 ⊕ 운영"으로 바뀌었고, 그 분기를 검증하려면
   *  **현재 우주가 prod 인 경우와 아닌 경우**를 둘 다 만들 수 있어야 한다(env 조작보다 정확). */
  self?: LogTarget;
  /** 운영 타겟. 미주입 시 `~/.elanous`. */
  prod?: LogTarget;
}

/** cwd 에서 위로 걸어 올라가며 `.elanous-test/` 를 가진 레포 루트를 찾는다. */
export function findTestStateDirUp(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 30; i++) {
    const candidate = join(dir, '.elanous-test');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function prodTarget(): LogTarget {
  return { name: 'prod', dbPath: join(homedir(), '.elanous', 'logs', 'logs.db') };
}

export function resolveLogTargets(
  opts: Pick<LogsCliOpts, 'test' | 'instance' | 'all'> & { includeTest?: boolean },
  deps: ResolveTargetDeps = {},
): { targets: LogTarget[]; error?: string } {
  // `--all --instance <name>` 는 연합 후보군을 해당 인스턴스로 좁히는 조회다.
  // `--test` 는 cwd 기반의 별도 스코프이므로 다른 명시 스코프와만 배타적이다.
  if (opts.test && (opts.instance || opts.all)) {
    return { targets: [], error: '--test 는 --instance/--all 과 동시 지정 불가' };
  }

  if (opts.test) {
    const stateDir = findTestStateDirUp(deps.cwd ?? process.cwd());
    if (!stateDir) return { targets: [], error: 'cwd 상위에 .elanous-test/ 없음 — 레포 안에서 실행하거나 --instance 를 쓰세요' };
    return { targets: [{ name: `test:${basename(dirname(stateDir))}`, dbPath: join(stateDir, 'logs', 'logs.db') }] };
  }

  const instances = deps.instances ?? readLogInstances();

  if (opts.instance) {
    if (opts.instance === 'prod') return { targets: [prodTarget()] };
    const byName = instances.filter((e) => e.name === opts.instance
      || e.name === `test:${opts.instance}`);
    // 레지스트리의 물리 identity는 stateDir다. 구 레코드가 같은 stateDir를 중복해도
    // 레코드 수가 아닌 고유 경로 수로 모호성을 판정·보고해야 메타데이터와 일치한다.
    const byStateDir = [...new Map(byName.map((entry) => [entry.stateDir, entry])).values()];
    if (byStateDir.length === 1) return { targets: [{ name: byStateDir[0]!.name, dbPath: byStateDir[0]!.dbPath }] };
    if (byStateDir.length > 1) {
      // 경로 조각으로 좁힐 수 있으면 그걸 우선한다(같은 인자로 두 문법 지원).
      const byPath = byStateDir.filter((e) => e.stateDir.includes(opts.instance!));
      if (byPath.length === 1) return { targets: [{ name: byPath[0]!.name, dbPath: byPath[0]!.dbPath }] };
      const lines = byStateDir.map((e) => `    ${e.stateDir}`).join('\n');
      return {
        targets: [],
        error: `인스턴스 '${opts.instance}' 가 ${byStateDir.length}개 state 경로에 등록되어 모호하다. 경로 조각으로 지정해 좁히세요\n${lines}`,
      };
    }
    // 이름이 없으면 **경로 조각**으로도 찾는다 — 이름 충돌 환경의 실질적 탈출구.
    const byPathOnly = instances.filter((e) => e.stateDir.includes(opts.instance!));
    if (byPathOnly.length === 1) {
      return { targets: [{ name: byPathOnly[0]!.name, dbPath: byPathOnly[0]!.dbPath }] };
    }
    const known = ['prod', ...instances.map((e) => e.name)].join(', ');
    return { targets: [], error: `인스턴스 '${opts.instance}' 미등록 (등록: ${known})` };
  }

  if (opts.all) {
    const targets: LogTarget[] = [prodTarget()];
    for (const e of instances) {
      if (!e.dbExists) continue;
      if (e.kind === 'test' && !opts.includeTest) continue; // 격리 test 는 기본 제외(Phase A)
      if (targets.some((t) => t.dbPath === e.dbPath)) continue; // prod 자신의 등록 항목 dedup
      targets.push({ name: e.name, dbPath: e.dbPath });
    }
    return { targets };
  }

  // 기본 — **내 우주 ⊕ 운영**(P5 · 2026-07-27).
  //
  // ⚠️ 실측 사건: 3층 스위치(`instance.treeDerivedTest`)를 켜자 비-리더 트리에서의 조회가 **자기도
  //   test 로 파생**돼, 방금 전까지 보이던 운영 로그가 `elanous logs` 에서 통째로 사라졌다. 관측 도구가
  //   우주를 바꿔 **자기 로그를 못 찾는** 상태 — `--all --include-test` 로만 `⟨prod⟩` 태그로 보였다.
  //   격리는 실행에 필요한 것이지 **조회를 좁힐 이유가 아니다**(제1원칙: 안 보이면 자기인지가 없다).
  //
  // 그래서 현재 우주가 prod 가 아니면 prod 를 **함께** 본다. 출력은 `⟨name⟩` 태그로 갈리므로 섞이지 않는다.
  //   · 리더/운영에서 조회 → 종전과 **글자 그대로 동일**(단일 타겟·무회귀)
  //   · 격리·파생 우주에서 조회 → 내 것 + 운영 둘 다
  //
  // ⚠️ 범위 판단: DESIGN §8 은 "`--all --include-test` 를 기본 동선으로"라 적었으나, 그건 fleet 전체를
  //   기본에 들이는 것이라 노이즈가 크고 아직 실증이 없다. **실측된 결함만** 최소로 덮는다 —
  //   운영에서 자식(worktree test)을 보는 쪽은 여전히 `--all --include-test` 소관이다.
  const self: LogTarget = deps.self ?? { name: resolveLogInstanceName(), dbPath: logsDbPath() };
  const prod = deps.prod ?? prodTarget();
  return { targets: self.dbPath === prod.dbPath ? [self] : [self, prod] };
}

// ── 포맷 — logcat 감성 한 줄: `HH:MM:SS.mmm L surface category event data` ──
//
// 시각은 **사용자 시간대**로 표시한다(저장은 UTC ISO 유지). 종전엔
// `row.ts.slice(11, 23)` 로 ISO 문자열을 잘라 UTC 시분초를 그대로 찍었고, KST 머신에서
// 9시간 어긋나 보였다 — 사고를 조사할 때 엉뚱한 시간대를 뒤지게 만드는 결함이었다.
// 계약: src/time/format.ts

const LEVEL_TAG: Record<string, string> = {
  trace: 'V', debug: 'D', info: 'I', warn: 'W', error: 'E', critical: 'F',
};
const LEVEL_COLOR: Record<string, string> = {
  trace: '\x1b[2m', debug: '\x1b[2m', info: '', warn: '\x1b[33m', error: '\x1b[31m', critical: '\x1b[41m',
};
const RESET = '\x1b[0m';
const LOG_LINE_DATA_LIMIT = 200;

const WRITE_TRUNCATION_MARKER = /«\+\d+c»/;

function isLogLineDataTruncated(data: string | null): boolean {
  return data !== null && ` ${data}`.length > LOG_LINE_DATA_LIMIT;
}

function hasWriteTruncationMarker(data: string | null): boolean {
  return data !== null && WRITE_TRUNCATION_MARKER.test(data);
}

/** 사람이 읽는 출력에서 표시 절단과 저장 절단의 복구 가능 여부를 구분해 알린다. */
function rowTruncationWarning(renderTruncatedRows: number, writeTruncatedRows: number): string | null {
  const warnings: string[] = [];
  if (renderTruncatedRows > 0) {
    warnings.push(`경고: ${renderTruncatedRows}줄이 잘렸습니다. 전체를 보려면 --json --json-data 를 쓰세요.`);
  }
  if (writeTruncatedRows > 0) {
    warnings.push(`경고: ${writeTruncatedRows}줄은 저장 전에 잘렸습니다. --json --json-data 로도 원본을 복원할 수 없습니다.`);
  }
  return warnings.length > 0 ? warnings.join('\n') : null;
}

/** 실제로 반환해 표시한 행의 구조화 data에서 식별 가능한 런 범위를 사람용으로만 알린다. */
export function runCoverageHint(rows: readonly Pick<LogStoreRow, 'data'>[]): string | null {
  if (rows.length === 0) return null;
  const runIds = new Set<string>();
  for (const { data } of rows) {
    if (data === null) continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (parsed !== null && typeof parsed === 'object' && 'runId' in parsed) {
        const runId = (parsed as { runId?: unknown }).runId;
        if (typeof runId === 'string' && runId.trim().length > 0) runIds.add(runId);
      }
    } catch { /* Non-JSON data has no structured run identifier. */ }
  }
  if (runIds.size === 0) return `안내: 반환된 ${rows.length}행에는 식별 가능한 런 식별자가 없습니다.`;
  if (runIds.size === 1) return `안내: 반환된 ${rows.length}행은 식별 가능한 런 1개에서 왔습니다 (런 혼합 없음).`;
  return `안내: 반환된 ${rows.length}행은 식별 가능한 런 ${runIds.size}개에서 왔습니다 (서로 다른 런이 섞임).`;
}

const JSONL_SANITIZED_MARKER = '_elanousJsonlSanitized';

function replaceUnpairedSurrogates(value: string): { value: string; changed: boolean } {
  let result = '';
  let changed = false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index]! + value[index + 1]!;
        index += 1;
      } else {
        result += '\uFFFD';
        changed = true;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      result += '\uFFFD';
      changed = true;
    } else {
      result += value[index]!;
    }
  }
  return changed ? { value: result, changed } : { value, changed };
}

function availableSanitizedObjectKey(key: string, reserved: Set<string>, used: Set<string>): string {
  let suffix = 1;
  let candidate = `${key}__elanousJsonlSanitizedKey${suffix}`;
  while (reserved.has(candidate) || used.has(candidate)) {
    suffix += 1;
    candidate = `${key}__elanousJsonlSanitizedKey${suffix}`;
  }
  return candidate;
}

function sanitizeJsonlValue(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === 'string') return replaceUnpairedSurrogates(value);
  if (Array.isArray(value)) {
    let changed = false;
    const sanitized = value.map((item) => {
      const result = sanitizeJsonlValue(item);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: sanitized, changed } : { value, changed };
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => ({ key, item, safeKey: replaceUnpairedSurrogates(key) }));
    const reserved = new Set(entries.filter(({ safeKey }) => !safeKey.changed).map(({ key }) => key));
    const used = new Set<string>();
    let changed = false;
    const sanitized: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const { key, item, safeKey } of entries) {
      const result = sanitizeJsonlValue(item);
      let outputKey = safeKey.value;
      if (used.has(outputKey) || (safeKey.changed && reserved.has(outputKey))) {
        outputKey = availableSanitizedObjectKey(outputKey, reserved, used);
      }
      used.add(outputKey);
      changed ||= safeKey.changed || result.changed || outputKey !== key;
      sanitized[outputKey] = result.value;
    }
    return changed ? { value: sanitized, changed } : { value, changed };
  }
  return { value, changed: false };
}

function availableJsonlSanitizedMarker(payload: Record<string, unknown>): string {
  let marker = JSONL_SANITIZED_MARKER;
  while (Object.prototype.hasOwnProperty.call(payload, marker)) marker = `_${marker}`;
  return marker;
}

/** JSONL 전용: 레거시 문자열의 lone surrogate를 읽기 시점에만 U+FFFD로 고친다. */
export function renderLogJsonLine(row: LogStoreRow, name: string, jsonData: boolean = false, storePath?: string): string {
  let data: unknown = row.data;
  if (jsonData && typeof row.data === 'string') {
    try { data = JSON.parse(row.data); } catch { /* Preserve non-JSON log data. */ }
  }
  // ⛔⭐⭐⭐ **`instance`(행이 «자기라 말하는» 것)와 `store`(그 행을 «꺼낸» 곳)는 «다른 축»이다**
  //   (2026-08-19 · `MEAS-T87`).
  //   🚨 종전엔 `instance: row.instance ?? name` 으로 ***스토어 이름이 필드에 «흡수»***됐다.
  //     ⇒ 「instance=X 인데 X 의 스토어를 열면 없다」가 되고, 읽는 사람은 우주를 옮겨 다니며
  //       ***「0」을 반복해서 본다***. 실측: 한 창에서 ***다섯 번*** 그 길을 갔다.
  //   ⇒ 🔑 그래서 ***꺼낸 스토어를 «따로» 싣는다.*** 그러면 그 두 물음이 한 줄에서 갈린다.
  //   ⛔ `instance` 의 종전 의미는 «그대로» 둔다(하위호환) — 새 칸만 더한다.
  const payload: Record<string, unknown> = { ...row, data, instance: row.instance ?? name, store: name, storePath: storePath ?? null };
  const sanitized = sanitizeJsonlValue(payload);
  if (!sanitized.changed) return JSON.stringify(payload);
  const safePayload = sanitized.value as Record<string, unknown>;
  safePayload[availableJsonlSanitizedMarker(safePayload)] = true;
  return JSON.stringify(safePayload);
}

export function formatLogLine(
  row: LogStoreRow,
  color: boolean = true,
  instanceTag?: string,
  /** 표시 시간대 override — 테스트가 실행 머신 TZ 에 의존하지 않게 하는 seam. */
  timeZone?: string,
): string {
  const t = formatClock(row.ts, { millis: true, ...(timeZone ? { timeZone } : {}) });
  const tag = LEVEL_TAG[row.level] ?? '?';
  let data = '';
  if (row.data) {
    data = ` ${row.data}`;
    if (data.length > LOG_LINE_DATA_LIMIT) data = `${data.slice(0, LOG_LINE_DATA_LIMIT)}…`;
  }
  // instanceTag — 연합 조회(--all 등)에서 출처 구분. 단일 스토어 조회는 무태그(소음 억제).
  const inst = instanceTag ? `⟨${instanceTag}⟩ ` : '';
  const line = `${t} ${tag} ${inst}[${row.surface}] ${row.category} ${row.event}${data}`;
  if (!color) return line;
  const c = LEVEL_COLOR[row.level] ?? '';
  return c ? `${c}${line}${RESET}` : line;
}

function parseBooleanFilter(raw: string | undefined, flag: string): { value?: boolean; error?: string } {
  if (raw === undefined) return {};
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return { value: true };
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return { value: false };
  return { error: `${flag} 은 true|false 중 하나` };
}

function rowReworkRecurrenceDisagreement(row: LogStoreRow): boolean | undefined {
  if (row.category !== 'self-implement' || row.event !== 'rework-budget' || row.data === null) return undefined;
  try {
    const data = JSON.parse(row.data) as { recurrenceDisagreement?: unknown };
    return typeof data.recurrenceDisagreement === 'boolean' ? data.recurrenceDisagreement : undefined;
  } catch {
    return undefined;
  }
}

export function matchesReworkRecurrenceDisagreement(row: LogStoreRow, expected: boolean | undefined): boolean {
  if (expected === undefined) return true;
  return rowReworkRecurrenceDisagreement(row) === expected;
}

/** Shared `--since` option contract for CLI consumers of the logs time grammar. */
export const LOGS_SINCE_OPTION = ['--since <t>', '최근 창만 (30s/15m/2h/7d 또는 ISO/epoch)'] as const;

/** `30s/15m/2h/7d` 상대 표기 → epoch ms (REST parseSinceParam 과 동일 문법). */
export function parseSince(raw: string): number | null {
  const rel = /^(\d+)(s|m|h|d)$/.exec(raw.trim());
  if (rel) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 's' | 'm' | 'h' | 'd'];
    return Date.now() - Number(rel[1]) * unit;
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (dateOnly) {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return null;
    const [, year, month, day] = dateOnly;
    // Date(year, ...) maps 0–99 to 1900–1999; setFullYear preserves ISO years.
    const localMidnight = new Date(0);
    localMidnight.setHours(0, 0, 0, 0);
    localMidnight.setFullYear(Number(year), Number(month) - 1, Number(day));
    return localMidnight.getTime();
  }
  const d = Date.parse(raw);
  return Number.isFinite(d) ? d : null;
}

// 렌더 지향 카테고리/서피스 — 관측 정비 트랙(PR 1-C·OH9)에서 기본 OFF 게이트라 빈
// 결과가 "정상"일 수 있다. 빈 결과를 계측 결함으로 오진하지 않게 넛지한다.
// 근거: REPORT §9-3 · INCIDENT-2026-07-24-observation-tool-empty-result-misdiagnosis.
// ⭐ 판정은 발화 게이트와 같은 SSOT(`isRenderCategory` · render-categories.ts)를
//    공유한다 — 힌트가 실제 게이트와 어긋나면 그 자체가 오진 벡터.

/** 여러 대상을 안내할 때 이름을 몇 개까지 적나 — 나머지는 개수로만 말한다. */
const NON_CURRENT_SCOPE_NAMES_SHOWN = 4;

/**
 * 조회 대상 중 **호출자 자신의 스코프가 아닌** 것들의 이름.
 *
 * ⛔⭐⭐ 이것을 «순수 함수»로 뽑은 이유는 리뷰가 잡은 실결함이다(`#7480`) — 종전엔 이 판정이
 * `runLogsCli` 의 0건 분기 «안»에만 있어서, 그것을 검사하려면 실 `logsDbPath()` 를 대상으로
 * 넣어야 했다. 그러면 ***그 DB 에 매칭 행이 하나라도 있으면 0건 분기 자체가 안 돌아*** 검사가
 * 환경에 따라 통과/미실행을 오간다(= 조용히 아무것도 안 재는 검사). 판정만 떼면 결정론이 된다.
 *
 * ⭐ `currentDbPath` 를 인자로 받는 것도 같은 이유다 — 「현재 우주」를 테스트가 지정할 수 있어야
 * 「섞인」 경우를 실 파일시스템 없이 만든다.
 */
export function nonCurrentScopeNames(
  targets: readonly LogTarget[],
  currentDbPath: string = logsDbPath(),
): string[] {
  return targets.filter((target) => target.dbPath !== currentDbPath).map((target) => target.name);
}

/** 요청이 렌더 게이팅 대상(카테고리 접두 또는 --surface tui)이면 힌트 문자열, 아니면 null.
 *  실제 억제 상태(level.json.render)를 읽어 정직하게 안내한다(OH9). */
export function renderGatedHint(
  opts: LogsCliOpts,
  /** ⭐ 억제 상태 주입 seam — 파일(level.json)을 안 건드리고 두 갈래를 결정론적으로 잰다. */
  readRender: () => boolean | null = readScopedRenderLogs,
  /** 호출자 스코프 밖의 실제 조회 대상 이름. 있으면 로컬 level.json을 읽지 않는다. */
  nonCurrentScopeTargetNames: readonly string[] = [],
): string | null {
  const cats = [opts.category, opts.exactCategory]
    .flatMap((categories) => (categories ?? '').toLowerCase().split(','))
    .map((category) => category.trim())
    .filter(Boolean);
  const catGated = cats.some((c) => isRenderCategory(c));
  const surfGated = (opts.surface ?? '').toLowerCase().split(',').some((s) => s.trim() === 'tui');
  if (nonCurrentScopeTargetNames.length > 0) {
    if (!catGated && !surfGated) return null;
    // ⛔⭐⭐⭐ 단일 대상에도 «명령을 주지 않는다** — 종전엔
    //   `elanous logs --instance '<이름>' level` 을 안내했는데 ***`logs level` 은 `--instance` 를 안 받는다***
    //   (`logs level --help` 옵션은 `--json`·`--render` 뿐). 그래서 그 명령은 «돌긴 하는데 호출자 자신의
    //   레벨»을 보여 준다(실측: 남의 우주를 지목해도 `…/axon/monad-agent/log/…` 가 떴다).
    //   ⇒ ***안 도는 명령보다 「돌지만 다른 것을 보는」 명령이 더 나쁘다*** — 이 넛지의 존재 이유가
    //      「빈 결과를 오진하지 않게」인데, 그 안내가 «다른 우주의 상태»를 답으로 준다.
    //   근거: `#7480` elanous self review must-fix(codex-app-server 백엔드).
    if (nonCurrentScopeTargetNames.length === 1) {
      const instance = nonCurrentScopeTargetNames[0]!;
      return `  ↳ 대상 인스턴스 ${quoteShellArg(instance)}의 렌더 억제 상태는 확인하지 못했다 — 빈 결과를 실제 이벤트 부재로 단언할 수 없다.`;
    }
    // ⛔⭐ 여러 대상일 때 **명령 템플릿을 만들지 않는다**(리뷰 must-fix · #7475 3라운드 반복 지적).
    //   종전엔 `elanous logs --instance <실제 인스턴스 이름> level` 을 냈는데, 그건 그대로 복사하면
    //   **안 돌아가는 문자열**이다 — 넛지가 「도움」인 척하며 사용자에게 숙제를 넘긴 것이다.
    //   ⇒ 실제 이름을 **값으로** 준다. 그러면 사용자가 채울 자리가 없고, 한 대상만 좁히고 싶으면
    //      위 단일 대상 갈래(`--instance <그 이름>`)가 실행 가능한 명령을 그대로 낸다.
    //   ⚠️ 이름이 많으면 문면이 길어져 「안 읽히는 넛지」가 된다 ⇒ 앞의 몇 개만 적고 나머지는 수로 말한다.
    const shown = nonCurrentScopeTargetNames.slice(0, NON_CURRENT_SCOPE_NAMES_SHOWN);
    const rest = nonCurrentScopeTargetNames.length - shown.length;
    const names = shown.map((name) => quoteShellArg(name)).join(' · ') + (rest > 0 ? ` 외 ${rest}개` : '');
    return `  ↳ 조회 대상 인스턴스들의 렌더 억제 상태는 확인하지 못했다 — 빈 결과를 실제 이벤트 부재로 단언할 수 없다.\n`
      + `    대상: ${names}`;
  }
  if (!catGated && !surfGated) {
    // ⛔⭐⭐⭐ 종전엔 여기서 끝났다 — **질의가 렌더 카테고리를 이름으로 댈 때만** 안내했다.
    //    그런데 억제가 켜져 있으면 **카테고리를 안 댄 질의도 그만큼 빠진다**(2026-08-02 실측:
    //    `logs --instance X --limit 2000` 으로 전 카테고리를 훑었는데 `dashboard.*` 가 통째로
    //    빠져 있었고, 힌트는 한 번도 안 떴다 ⇒ *"그 코드가 안 돈다"* 로 네 번 오진했다).
    //    ⇒ **확정 억제(level.json.render === false)일 때는 질의 모양과 무관하게 알린다.**
    //    ⚠️ `null`(미명시)에는 안 알린다 — 그건 "억제일 수도 있다" 라 매 질의에 붙이면 소음이다.
    return readRender() === false
      ? '  ↳ ⚠️ 이 인스턴스는 렌더 로그 억제 ON 이다 — 카테고리를 안 걸어도'
        + ` **${RENDER_ORIENTED_PREFIXES.join('/')}.\*** 는 이 결과에 없다.\n`
        + '    켜기=`elanous logs level --render on`.'
      : null;
  }
  const egs = RENDER_ORIENTED_PREFIXES.join('/');
  // level.json.render === false 면 확정 억제 · true 면 확정 발화 · null 이면 미명시
  // (config/uiMode 시드에 달림 → "일 수 있다").
  const scoped = readRender();
  const head = scoped === false
    ? `  ↳ 렌더 로그(${egs}.*·surface tui)는 현재 억제 ON(무음) 상태다 — 빈 결과가 정상이다.\n`
    + '    켜기=`elanous logs level --render on`.'
    : scoped === true
      ? `  ↳ 렌더 로그(${egs}.*·surface tui)는 현재 발화 ON — 빈 결과라면 실제로 이벤트가 없는 것이다.`
      : `  ↳ 렌더 로그(${egs}.*·surface tui)는 기본 OFF 게이트일 수 있어 빈 결과가 정상일 수 있다.\n`
      + '    켜기=`elanous logs level --render on` · 상태=`elanous logs level`.';
  return head + '\n    화면 관측=tmux `capture-pane` · 판단=`elanous logs --level info`. (REPORT §9-3)';
}

// ⭐ CLI 는 **로컬 직독**이라 HTTP 상한(1000)을 물려받을 이유가 없다(2026-07-29 재배치).
//   스토어의 OOM 백스톱만 공유한다. ⇒ `--limit 5000` 같은 큰 조회가 실제로 5000건을 준다.
const LOG_QUERY_LIMIT_MAX = STORE_SAFETY_MAX;

/** 로그 스토어가 실제로 적용하는 상한. 힌트는 이 유효값과 출력 행수만 비교한다. */
export function effectiveLogLimit(limit?: number): number {
  return Math.min(Math.max(1, limit ?? 100), LOG_QUERY_LIMIT_MAX);
}

/** 출력이 유효 상한에 정확히 닿았다는 사실만 알린다. 초과 일치의 존재는 알 수 없다. */
export type FederatedLogCursors = Record<string, number>;

export function limitReachedJsonMeta(
  outputCount: number, limit: number, requestedLimit?: number, oldestId?: number, nextCursors?: FederatedLogCursors | boolean,
): { _meta: { type: 'log-query-limit'; limitReached: true; requestedLimit?: number; effectiveLimit: number; nextCursor: number | null; nextCursors?: FederatedLogCursors; pagination: 'before-id' | 'before-id-by-instance' | 'select-instance' } } | null {
  if (outputCount !== limit) return null;
  const federated = typeof nextCursors === 'object';
  const legacyFederated = nextCursors === true;
  return {
    _meta: {
      type: 'log-query-limit',
      limitReached: true,
      ...(requestedLimit !== undefined ? { requestedLimit } : {}),
      effectiveLimit: limit,
      nextCursor: federated || legacyFederated ? null : oldestId ?? null,
      ...(federated ? { nextCursors } : {}),
      pagination: federated ? 'before-id-by-instance' : legacyFederated ? 'select-instance' : 'before-id',
    },
  };
}

/** JSON stdout에서 `_meta`를 제거하는 소비자도 stderr와 함께 상한 도달을 판정할 수 있는 안정된 신호. */
export function limitReachedStderrSignal(limitMeta: ReturnType<typeof limitReachedJsonMeta>): string | null {
  return limitMeta ? 'elanous logs: result may be truncated (limitReached=true)' : null;
}

interface MultiSurfaceDuplicateGroup {
  ts: string;
  category: string;
  event: string;
  surfaces: string[];
  rowCount: number;
}

export function multiSurfaceDuplicateJsonMeta(
  rows: readonly Pick<LogStoreRow, 'ts' | 'category' | 'event' | 'surface'>[],
): { _meta: { type: 'log-query-multi-surface-duplicates'; duplicateGroupCount: number; surfaceKindCount: number; surfaces: string[]; groups: MultiSurfaceDuplicateGroup[] } } {
  const groups = new Map<string, { ts: string; category: string; event: string; surfaces: Set<string>; rowCount: number }>();
  for (const row of rows) {
    const key = JSON.stringify([row.ts, row.category, row.event]);
    const existing = groups.get(key);
    if (existing) {
      existing.surfaces.add(row.surface);
      existing.rowCount += 1;
      continue;
    }
    groups.set(key, {
      ts: row.ts,
      category: row.category,
      event: row.event,
      surfaces: new Set([row.surface]),
      rowCount: 1,
    });
  }
  const duplicateGroups = [...groups.values()]
    .filter((group) => group.surfaces.size > 1)
    .map((group) => ({
      ts: group.ts,
      category: group.category,
      event: group.event,
      surfaces: [...group.surfaces].sort(),
      rowCount: group.rowCount,
    }));
  const surfaces = [...new Set(duplicateGroups.flatMap((group) => group.surfaces))].sort();
  return {
    _meta: {
      type: 'log-query-multi-surface-duplicates',
      duplicateGroupCount: duplicateGroups.length,
      surfaceKindCount: surfaces.length,
      surfaces,
      groups: duplicateGroups,
    },
  };
}

function parseFederatedLogCursors(raw: string): FederatedLogCursors | null {
  if (!raw.trim().startsWith('{')) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const cursors: FederatedLogCursors = {};
  for (const [name, cursor] of Object.entries(value)) {
    if (!name || !Number.isInteger(cursor) || cursor < 1) return null;
    cursors[name] = cursor;
  }
  return Object.keys(cursors).length > 0 ? cursors : null;
}

function cursorsForOutput(
  out: readonly { row: LogStoreRow; name: string }[],
  previous: FederatedLogCursors | null = null,
): FederatedLogCursors {
  const cursors: FederatedLogCursors = { ...previous };
  for (const { row, name } of out) {
    const current = cursors[name];
    if (current === undefined || row.id < current) cursors[name] = row.id;
  }
  return cursors;
}

export function limitReachedHint(
  outputCount: number, limit: number, requestedLimit?: number, oldestId?: number, federated?: boolean,
): string | null {
  if (outputCount !== limit) return null;
  const clamped = requestedLimit !== undefined && requestedLimit !== limit
    ? ` (요청 --limit ${requestedLimit}은 유효 상한 ${limit}으로 제한됨)`
    : '';
  // ⛔⭐ 초판은 *"--since 로 창을 좁혀라"* 만 말했다. **그것으로는 과거로 못 간다** — 정렬이
  //   최근순이라 창을 넓히든 좁히든 **최근 상한만큼**만 온다(2026-07-29 실측: 어떤 창이든 정확히 1000행).
  //   그걸 "7일치" 로 읽어 두 트랙이 같은 오독을 했다. ⇒ **다음 쪽 명령을 그대로 찍어 준다.**
  const next = federated
    ? '⚠️ 연합(--all) 조회는 행 id 가 인스턴스마다 독립이라 --before 를 쓸 수 없다 — --instance 로 하나를 골라 페이지를 넘긴다.'
    : oldestId !== undefined
      ? `↳ 다음 쪽(더 오래된 것):  elanous logs … --before ${oldestId}`
      : '↳ 과거로 가려면 --before <id> 로 페이지를 넘긴다(--json 의 id).';
  // ⚠️ *"있다"* 가 아니라 **"있을 수 있다"** — 상한에 정확히 걸린 것이 더 있다는 증거는 아니다.
  //   (초판 문구가 옳았고 내가 강화했다가 기존 테스트에 잡혔다)
  return `↳ 상한 ${limit} 도달${clamped} — 더 오래된 일치가 있을 수 있다.${next ? `\n${next}` : ''}`;
}

/** POSIX 셸에서 사용자 제공 값을 정확히 하나의 인자로 보존한다. */
export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** `--grep`은 OR 문법이 아닌 단일 연속 문자열 검색임을 오해하기 쉬운 인자다. */
export function grepPhraseWarning(grep?: string): string | null {
  if (!grep) return null;
  const tokens = tokenizeGrepPhrase(grep);
  if (tokens.length < 2) return null;
  return `경고: --grep은 OR 검색이 아니라 단일 연속 문자열 검색입니다: ${quoteShellArg(grep)}. 분리 토큰: ${tokens.map(quoteShellArg).join(', ')}. 0건이면 이 해석 때문일 수 있습니다.`;
}

/** `--event`에 넣으면 정확 일치 0건으로 오독하기 쉬운, CLI가 안내하는 카테고리들. */
const KNOWN_LOG_CATEGORIES: ReadonlySet<string> = new Set([
  'dev-pipeline',
]);

/** `--event`에 알려진 카테고리를 넣은 경우 카테고리 필터를 안내한다. */
export function eventCategoryWarning(event?: string): string | null {
  const categories = (event ?? '').split(',').map((value) => value.trim()).filter(
    (value) => KNOWN_LOG_CATEGORIES.has(value),
  );
  if (categories.length === 0) return null;
  const quoted = categories.map(quoteShellArg).join(', ');
  return `경고: --event에 ${quoted}을(를) 지정했습니다. 이는 알려진 카테고리이므로 카테고리와 이벤트를 혼동했을 수 있습니다 — --category ${quoted} 를 쓰세요.`;
}

/** 각 prefix/exact 카테고리 후보의 독립 존재 판정으로, 한 결합 조회의 0건을 이름 부재로 오독하지 않는다. */
export function categoryCandidateWarning(
  query: Pick<LogQuery, 'categories' | 'exactCategories'>,
  countMatching: (candidate: Pick<LogQuery, 'categories' | 'exactCategories'>) => number,
): string | null {
  const missing = [
    ...(query.categories ?? []).filter((category) => countMatching({ categories: [category] }) === 0),
    ...(query.exactCategories ?? []).filter((category) => countMatching({ exactCategories: [category] }) === 0),
  ];
  const names = [...new Set(missing)];
  if (names.length === 0) return null;
  const shown = names.slice(0, NON_CURRENT_SCOPE_NAMES_SHOWN).map(quoteShellArg).join(', ');
  const rest = names.length - Math.min(names.length, NON_CURRENT_SCOPE_NAMES_SHOWN);
  return `안내: 지정한 카테고리 이름은 이 로그 스토어에서 관측된 적 없습니다: ${shown}${rest > 0 ? ` 외 ${rest}개` : ''}.`;
}

/** A child-observation query can miss Pod-only logs even when the local store was read successfully. */
export function podObservationGapNotice(
  query: Pick<LogQuery, 'categories' | 'exactCategories' | 'events'>,
  podRuns: number,
): string | null {
  if (podRuns <= 0) return null;
  const childCategory = (category: string): boolean => ['self-implement', 'self-dev', 'harness']
    .some((prefix) => category.startsWith(prefix));
  const categories = [...(query.categories ?? []), ...(query.exactCategories ?? [])];
  if (!categories.some(childCategory) && !(categories.length === 0 && (query.events?.length ?? 0) > 0)) return null;
  return `안내: 이 창에 Pod 에서 돈 런 ${podRuns}개 — Pod 자식의 관측은 «발사한 트리의 파생 우주» logs.db 로 회수된다(POD-OBS) — 전체: elanous logs --all --include-test · 런 하나: elanous self run-ledger <runId>`;
}

/** Select ledger roots independently of DB existence; --all includes registered roots with no logs.db. */
function podLedgerDirectories(opts: LogsCliOpts, targets: readonly LogTarget[], instances: readonly LogInstanceView[]): string[] {
  const roots = targets.map(({ dbPath }) => dirname(dirname(dbPath)));
  if (opts.all && !opts.instance) {
    roots.push(dirname(dirname(prodTarget().dbPath)));
    for (const instance of instances) {
      if (instance.kind !== 'test' || opts.includeTest) roots.push(instance.stateDir);
    }
  }
  return [...new Set(roots.map((root) => join(root, 'run-ledger')))];
}

/** Read-only run-ledger scan over the independently selected instance roots. */
async function countPodRunLedgers(
  directories: readonly string[],
  query: Pick<LogQuery, 'sinceMs' | 'untilMs'>,
): Promise<{ podRuns: number; unreadableLedgers: number }> {
  const { loadRunLedger } = await import('../self-implement/run-ledger.js');
  const untilMs = query.untilMs ?? Date.now();
  const sinceMs = query.sinceMs ?? untilMs - LOG_RETENTION_DEFAULTS.maxAgeDays * 86_400_000;
  let podRuns = 0;
  let unreadableLedgers = 0;
  for (const directory of directories) {
    let files: string[];
    try { files = readdirSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unreadableLedgers += 1;
      continue;
    }
    for (const file of files) {
      if (!/^run-[a-zA-Z0-9-]+\.jsonl$/.test(file)) continue;
      try {
        const stamp = statSync(join(directory, file));
        if (!stamp.isFile() || stamp.mtimeMs < sinceMs) continue;
        const ledger = loadRunLedger(file.slice(0, -'.jsonl'.length), directory);
        if (!ledger) { unreadableLedgers += 1; continue; }
        const origin = ledger.find((entry) => entry.event === 'run-origin');
        if (!origin || typeof origin.data.hostname !== 'string' || !origin.data.hostname.startsWith('si-task-')) continue;
        let start = Number.POSITIVE_INFINITY;
        let end = Number.NEGATIVE_INFINITY;
        for (const entry of ledger) {
          const time = entry.timestamp === undefined ? NaN : Date.parse(entry.timestamp);
          if (!Number.isFinite(time)) continue;
          start = Math.min(start, time);
          end = Math.max(end, time);
        }
        // Older ledgers may have no timestamp at all; their mtime is the only available window evidence.
        if (start === Number.POSITIVE_INFINITY) { start = stamp.mtimeMs; end = stamp.mtimeMs; }
        if (start <= untilMs && end >= sinceMs) podRuns += 1;
      } catch { unreadableLedgers += 1; }
    }
  }
  return { podRuns, unreadableLedgers };
}

// ── 0건 --event 안내: 이미 찍힌 기록에서만 답한다 ────────────────────────
//
// 갈림 ① 어느 범위에서 모으나 — **고정 24시간 관측 창**.
//   사용자 `--since`/`--until`을 그대로 쓰면 5분 창은 후보가 자주 비고
//   (「안내를 만들 수 없다」가 오타에도 난다), 60일 창은 DISTINCT 비용이 커진다.
//   하루 창 측정(이름다운 58 · 비이름 14)과 같은 길이를 써서 모양 규칙의
//   표본과 수집 범위가 어긋나지 않게 한다. 창의 끝은 사용자 `--until`(없으면 지금).
//   ⛔ 이 창 밖 부재를 저장소 전체 부재로 말하지 않는다.
//
// 갈림 ② 이름답지 않은 것을 어떻게 거르나 — **모양 규칙**.
//   하루 창 58/14 분류의 비이름 14는 주소·식별자·문장이 이벤트 칸에 그대로
//   들어간 것이었다. 글자로 시작하는 짧은 토큰(`a-z0-9_.:-`)만 남기고
//   공백·URL·경로·UUID·긴 hex 식별자를 버린다. 소스 목록이 아니다.
//
// 갈림 ③ 가까운 이름을 어떻게 고르나 — **대소문자 무시 Levenshtein**,
//   거리 오름차순·동점이면 이름 오름차순, **최대 5개**. 58개를 다 찍으면
//   안 읽힌다. 후보가 없으면 「안내를 만들 수 없다」고 명시한다.
//
// 경계: 소스를 훑어 「이 저장소가 내는 이름 전체」를 만드는 방식은 폐기.
// 경계: 카테고리·수준 필터 오타 안내는 하지 않는다.

/** 갈림 ① — 후보 수집 창. 하루 창 측정과 같은 길이. */
export const EVENT_NAME_HINT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 갈림 ③ — 가까운 이름 노출 상한. */
export const EVENT_NAME_HINT_SHOWN = 5;

const EVENT_NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const EVENT_NAME_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const EVENT_NAME_URLISH = /^(https?|file|ftp):/i;

/** 갈림 ② — 주소·식별자·문장을 이벤트 이름 후보에서 뺀다. */
export function isNameLikeEvent(name: string): boolean {
  if (!EVENT_NAME_SHAPE.test(name)) return false;
  if (EVENT_NAME_UUID.test(name)) return false;
  if (EVENT_NAME_URLISH.test(name)) return false;
  const compact = name.replace(/[-_.:]/g, '');
  if (compact.length >= 16 && /^[0-9a-f]+$/i.test(compact)) return false;
  return true;
}

/** 갈림 ③ — 대소문자 무시 Levenshtein. O(|a|×|b|) 두 행. */
export function eventNameDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 0;
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let prev = new Array<number>(y.length + 1);
  let curr = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[y.length]!;
}

function minDistanceToRequested(candidate: string, requested: readonly string[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const name of requested) {
    const distance = eventNameDistance(name, candidate);
    if (distance < best) best = distance;
  }
  return best;
}

/** 관측된 이름 중 이름다운 것만 거리순으로 최대 `cap`개. 요청과 같은 이름은 빼다. */
export function rankNearbyEventNames(
  requested: readonly string[],
  observed: readonly string[],
  cap: number = EVENT_NAME_HINT_SHOWN,
): string[] {
  const requestedFold = new Set(requested.map((name) => name.toLowerCase()));
  const unique = [...new Set(observed.filter((name) => (
    isNameLikeEvent(name) && !requestedFold.has(name.toLowerCase())
  )))];
  unique.sort((a, b) => {
    const da = minDistanceToRequested(a, requested);
    const db = minDistanceToRequested(b, requested);
    return da - db || (a < b ? -1 : a > b ? 1 : 0);
  });
  return unique.slice(0, Math.max(0, cap));
}

export interface ObservedEventSource {
  events: (q: Omit<LogQuery, 'events' | 'limit' | 'afterId' | 'beforeId'>) => string[];
}

/**
 * 열린 스토어에서 후보 이벤트 이름을 모은다. 스토어 실패는 fail-soft.
 * 사용자 `--since`는 쓰지 않고 갈림 ①의 24시간 창만 쓴다. `events` 축은 뺀다.
 */
export function collectObservedEventNames(
  stores: readonly ObservedEventSource[],
  query: LogQuery,
  nowMs: number = Date.now(),
): string[] {
  const untilMs = query.untilMs ?? nowMs;
  const hintQuery: Omit<LogQuery, 'events' | 'limit' | 'afterId' | 'beforeId'> = {
    minLevel: query.minLevel,
    surfaces: query.surfaces,
    categories: query.categories,
    exactCategories: query.exactCategories,
    sessionId: query.sessionId,
    sinceMs: untilMs - EVENT_NAME_HINT_WINDOW_MS,
    untilMs,
  };
  const names = new Set<string>();
  for (const store of stores) {
    try {
      for (const event of store.events(hintQuery)) names.add(event);
    } catch { /* 후보 수집 실패가 원 조회 0건 안내를 막지 않는다. */ }
  }
  return [...names];
}

/**
 * 영 건 `--event` 조회 전용 사람용 안내.
 * 「이 저장소에 없다」는 단정을 내지 않는다. 후보가 없으면 안내 불가를 명시한다.
 */
export function eventNameHint(requested: readonly string[], observed: readonly string[]): string | null {
  const names = requested.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return null;
  const quoted = names.map(quoteShellArg).join(', ');
  const nearby = rankNearbyEventNames(names, observed);
  if (nearby.length === 0) {
    return `안내: 이벤트 이름 ${quoted} 은(는) 이 조회 범위에서 본 적 없다. 가까운 관측 이름을 안내할 수 없다.`;
  }
  return `안내: 이벤트 이름 ${quoted} 은(는) 이 조회 범위에서 본 적 없다. 가까운 관측 이름: ${nearby.map(quoteShellArg).join(', ')}.`;
}

/**
 * 정적 이름 목록에 대한 0건 `--event` 판정.
 * 목록에 있으면 「이 저장소가 낸다」. 없으면 정적 목록 부재만 말하고 「내지 않는다」고 단정하지 않는다.
 * 이름을 하나로 특정할 수 없으면(쉼표·빈 값) 아무 말도 하지 않는다.
 */
export function eventNameVerdict(event?: string): string | null {
  const raw = event ?? '';
  const tokens = raw.split(',');
  // 쉼표·빈 토큰이 하나라도 있으면 이름을 하나로 특정할 수 없다.
  // 빈 토큰을 먼저 지우면 'plan-sizing,' / ',plan-sizing' 이 단일 이름으로 오판된다.
  if (raw.includes(',') || tokens.some((token) => token.trim() === '')) return null;
  const name = tokens[0]!.trim();
  return KNOWN_LOG_EVENT_NAMES.has(name)
    ? `안내: 지정한 이벤트 이름은 이 저장소가 냅니다. 현재 조회 범위에서는 아직 관측되지 않았습니다: ${quoteShellArg(name)}.`
    : `안내: 지정한 이벤트 이름은 이 정적 목록에 없습니다: ${quoteShellArg(name)}. 이 목록은 별칭·래퍼·동적 producer 를 못 봅니다 — 목록 부재는 저장소 부재가 아닙니다.`;
}

type RequeryFilter = {
  flag: string;
  option: keyof LogsCliOpts;
  field: keyof LogQuery;
  applies: (query: LogQuery, opts?: LogsCliOpts) => boolean;
  omit: (query: LogQuery, opts?: LogsCliOpts) => LogQuery;
};

function fieldRequeryFilter(
  flag: string,
  option: keyof LogsCliOpts,
  field: keyof LogQuery,
): RequeryFilter {
  return {
    flag,
    option,
    field,
    applies: (query, opts) => opts ? Boolean(opts[option]) && query[field] !== undefined : query[field] !== undefined,
    omit: (query) => {
      const candidate = { ...query };
      delete candidate[field];
      return candidate;
    },
  };
}

const REQUERY_FILTERS: readonly RequeryFilter[] = [
  fieldRequeryFilter('--level', 'level', 'minLevel'),
  {
    flag: '--surface', option: 'surface', field: 'surfaces',
    applies: (query, opts) => opts ? Boolean(opts.surface) && !opts.space && query.surfaces !== undefined : query.surfaces !== undefined,
    omit: (query) => ({ ...query, surfaces: undefined }),
  },
  {
    flag: '--space', option: 'space', field: 'surfaces',
    applies: (query, opts) => Boolean(opts?.space) && query.surfaces !== undefined,
    omit: (query, opts) => ({
      ...query,
      surfaces: undefined,
      // A run-id space adds this grep only when the user did not supply --grep.
      grep: opts?.space && !opts.grep && !(HARNESS_SPACE_KINDS as readonly string[]).includes(opts.space.trim())
        ? undefined
        : query.grep,
    }),
  },
  fieldRequeryFilter('--category', 'category', 'categories'),
  fieldRequeryFilter('--exact-category', 'exactCategory', 'exactCategories'),
  fieldRequeryFilter('--event', 'event', 'events'),
  fieldRequeryFilter('--grep', 'grep', 'grep'),
  fieldRequeryFilter('--since', 'since', 'sinceMs'),
  fieldRequeryFilter('--session', 'session', 'sessionId'),
  fieldRequeryFilter('--limit', 'limit', 'limit'),
];

function requeryFilterArgs(opts: LogsCliOpts): string {
  return REQUERY_FILTERS.flatMap(({ flag, option }) => {
    const value = opts[option];
    return typeof value === 'string' ? [flag, quoteShellArg(value)] : [];
  }).join(' ');
}

/**
 * Each CLI filter owns both its application test and removal transform: --space
 * therefore removes its derived surface and grep together, while --surface remains
 * a distinct axis even though both write LogQuery.surfaces.
 */
export function zeroResultFilterRelaxationWarning(
  query: LogQuery,
  countMatching: (candidate: LogQuery) => number,
  opts?: LogsCliOpts,
): string {
  const applied = REQUERY_FILTERS.filter((filter) => filter.applies(query, opts));
  if (applied.length === 0) return '안내: 적용된 필터가 없어 뺄 축이 없습니다.';
  const counts = applied.map((filter) => `${filter.flag} 제외 ${countMatching(filter.omit(query, opts))}건`);
  return `안내: 적용 필터를 하나씩 제외한 일치 수: ${counts.join(' · ')}.`;
}

/** 빈 단일/부분 연합 조회에서만 타 등록 인스턴스의 같은 필터 일치 수를 fail-soft로 탐침한다. */
export function probeOtherInstanceMatches(
  opts: LogsCliOpts,
  query: LogQuery,
  targetPaths: readonly string[],
  instances: readonly LogInstanceView[] = readLogInstances(),
  openReadOnly: (path: string) => LogStore = LogStore.openReadOnly,
): Array<{ name: string; count: number }> {
  if (opts.all && opts.includeTest) return [];
  const targetSet = new Set(targetPaths);
  const seen = new Set<string>();
  const matches: Array<{ name: string; count: number }> = [];
  for (const instance of instances) {
    if (!instance.dbExists || targetSet.has(instance.dbPath) || seen.has(instance.dbPath)) continue;
    seen.add(instance.dbPath);
    let store: LogStore | undefined;
    try {
      store = openReadOnly(instance.dbPath);
      const count = store.countMatching(query);
      if (count > 0) matches.push({ name: instance.name, count });
    } catch { /* 탐침은 원 조회에 영향을 주지 않는다. */ }
    finally {
      try { store?.close(); } catch { /* close 실패도 탐침 밖으로 전파하지 않는다. */ }
    }
  }
  return matches;
}

/** 인스턴스 탐침 결과를 사람용 재조회 안내로만 렌더한다. */
export function otherInstanceHint(matches: readonly { name: string; count: number }[], opts: LogsCliOpts): string | null {
  if (matches.length === 0) return null;
  const found = matches.map((match) => `${match.name} ${match.count}건`).join(' · ');
  const filters = requeryFilterArgs(opts);
  return `  ↳ 다른 인스턴스에는 있다 — ${found}\n    전체를 보려면: elanous logs --all --include-test${filters ? ` ${filters}` : ''}`;
}

/** POD-OBS(10-06): 결과가 «0이 아닌데 적을 때»도 조용하지 않게 — 다른 우주에 더 많으면 경고한다.
 *  실측: 24h `pre-pr-sync` 운영 1건 vs 발사 트리 파생 우주 276건(Pod 자식 재방출은 부모 하니스의 우주에 쌓인다). */
export function otherInstanceMajorityWarning(
  shown: number,
  matches: readonly { name: string; count: number }[],
  opts: LogsCliOpts,
): string | null {
  const elsewhere = matches.reduce((sum, match) => sum + match.count, 0);
  if (shown <= 0 || elsewhere <= shown) return null;
  const top = [...matches].sort((a, b) => b.count - a.count);
  const named = top.slice(0, 3).map((match) => `${match.name} ${match.count}건`).join(' · ');
  const more = top.length > 3 ? ` 외 ${top.length - 3}곳` : '';
  const filters = requeryFilterArgs(opts);
  return `⚠ 여기 ${shown}건 · 다른 우주에 ${elsewhere}건이 더 있다 — ${named}${more}\n`
    + '    (Pod 자식 관측은 발사한 트리의 파생 우주에 쌓인다 · 이 수만 보고 «적다»로 읽지 말 것)\n'
    + `    전체를 보려면: elanous logs --all --include-test${filters ? ` ${filters}` : ''}`;
}

export function buildQuery(opts: LogsCliOpts): { query: LogQuery; error?: string } {
  const q: LogQuery = {};
  if (opts.level) {
    if (!(opts.level in LOG_LEVEL_ORDER)) {
      return { query: q, error: `--level 은 ${Object.keys(LOG_LEVEL_ORDER).join('|')} 중 하나` };
    }
    q.minLevel = opts.level as LogLevel;
  }
  if (opts.surface) q.surfaces = opts.surface.split(',').map((s) => s.trim()).filter(Boolean);
  // ★ --space — 하니스 공간별 격리 조회(Docker `docker logs <id>` 동형). kind 면 그 공간 surface exact,
  //   그 외(run id/branch slug)면 전 harness 공간으로 좁히고 id 를 grep(병렬 self-dev per-run 조회). exact
  //   surface 매칭 + prefix grep 조합(store 계약). --surface 와 함께면 --space 가 surface 를 정한다.
  if (opts.space) {
    const v = opts.space.trim();
    const kinds = HARNESS_SPACE_KINDS as readonly string[];
    q.surfaces = kinds.includes(v) ? [`harness:${v}`] : kinds.map((k) => `harness:${k}`);
    if (!kinds.includes(v) && !opts.grep) q.grep = v;   // per-run id → grep(명시 --grep 우선)
  }
  if (opts.category) q.categories = opts.category.split(',').map((s) => s.trim().replace(/\.\*$/, '')).filter(Boolean);
  const exactCategories = opts.exactCategory?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  // ⛔ `undefined` 로 검사한다 — `if (opts.axis)` 는 **빈 문자열을 미지정으로 읽어** 무필터로 통과시킨다.
  //    ⭐ `pty` 매뉴얼의 `--actor` 규율과 같다: ***미지정과 미지원은 다르다.*** 값이 있는데 아는 값이
  //    아니면(빈 문자열·공백 포함) 거부해야 fail-closed 가 성립한다(무인 리뷰 지적).
  if (opts.axis !== undefined) {
    const axisCategories = resolveLogAxis(opts.axis.trim());
    if (!axisCategories) {
      return { query: q, error: `--axis 는 ${knownLogAxes().join('|')} 중 하나 (받은 값: '${opts.axis}')` };
    }
    exactCategories.push(...axisCategories);
  }
  if (exactCategories.length > 0) q.exactCategories = [...new Set(exactCategories)];
  if (opts.event) q.events = opts.event.split(',').map((s) => s.trim()).filter(Boolean);
  if (opts.grep) q.grep = opts.grep;
  if (opts.session) q.sessionId = opts.session;
  if (opts.since) {
    const ms = parseSince(opts.since);
    if (ms === null) return { query: q, error: `--since 파싱 불가: '${opts.since}' (30s/15m/2h/7d 또는 ISO)` };
    q.sinceMs = ms;
  }
  if (opts.until) {
    const ms = parseSince(opts.until);
    if (ms === null) return { query: q, error: `--until 파싱 불가: '${opts.until}' (30s/15m/2h/7d 또는 ISO)` };
    q.untilMs = ms;
  }
  if (opts.before !== undefined) {
    const n = Number(opts.before);
    if (Number.isInteger(n) && n >= 1) {
      q.beforeId = n;
    } else if (!parseFederatedLogCursors(opts.before)) {
      return { query: q, error: `--before 는 행 id(양의 정수) 또는 --json 메타의 nextCursors JSON 객체` };
    }
  }
  if (opts.since && opts.until && q.sinceMs !== undefined && q.untilMs !== undefined && q.sinceMs > q.untilMs) {
    // ⛔ 조용히 0건을 내지 않는다 — 빈 창은 "로그가 없다" 와 구별되지 않는다.
    return { query: q, error: '--since 가 --until 보다 늦다 — 빈 창이라 0건이 나오는데 그것은 부재와 구별되지 않는다' };
  }
  if (opts.limit) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 1) return { query: q, error: `--limit 은 양의 정수` };
    q.limit = n;
  }
  return { query: q };
}

/** 「미분류」 미리보기 상한 — 전수는 개수로 알리고 표본만 보인다(전량 출력은 읽을 수 없다). */
export const UNCLASSIFIED_PREVIEW = 12;

/** Category discovery without choosing a surface or axis. Stored category strings are read unchanged. */
export function renderLogAxisDiscovery(): string {
  const axes = knownLogAxes();
  return [
    `알려진 로그 축 ${axes.length}개:`,
    ...axes.map((axis) => {
      const categories = resolveLogAxis(axis)!;
      return `${axis} (${categories.length}개): ${categories.join(', ')}`;
    }),
    '축을 고른 뒤: elanous logs --axis <name> --explain',
  ].join('\n');
}

export function renderAxisExplanation(axis: string, storedCategories: readonly string[]): string {
  const mapped = resolveLogAxis(axis);
  if (!mapped) throw new Error(`unknown log axis: ${axis}`);
  const allMapped = new Set<string>(Object.values(LOG_AXIS_CATEGORIES).flat());
  const present = new Set(storedCategories);
  const unclassified = storedCategories.filter((category) => !allMapped.has(category));
  const inactive = mapped.filter((category) => !present.has(category));
  const list = (categories: readonly string[]): string => categories.length > 0 ? categories.join(', ') : '(없음)';
  // ⚠️ 미분류는 실측 ~200 개다(라이브 확인 2026-08-01) — 한 줄로 다 뱉으면 읽을 수 없고
  //    그 아래 「발화 0」 칸까지 화면 밖으로 밀어낸다. ⇒ 개수를 먼저 주고 표본만 보인다.
  //    ⛔ 자르는 사실을 반드시 밝힌다(조용한 절단이 이 저장소에서 반복해 오판을 낳았다).
  const preview = (categories: readonly string[], max: number): string => {
    if (categories.length === 0) return '(없음)';
    if (categories.length <= max) return categories.join(', ');
    return `${categories.slice(0, max).join(', ')} … 외 ${categories.length - max}개`;
  };
  return [
    `매핑됨 (${axis}) ${mapped.length}개: ${list(mapped)}`,
    `미분류 ${unclassified.length}개: ${preview(unclassified, UNCLASSIFIED_PREVIEW)}`,
    `매핑됐는데 발화 0 (${inactive.length}개): ${list(inactive)}`,
  ].join('\n');
}

const FOLLOW_POLL_MS = 500;

/** 레지스트리 모집단은 성공적으로 읽은 경우에만 0으로 보고한다.
 * 파일 부재는 비어 있는 레지스트리지만, 파손·비가독은 "못 셈"이다. */
function readRegisteredStoreScope(): { instances: LogInstanceView[]; queryStatus: { registeredStores: boolean } } {
  const registryPath = logInstanceRegistryPath();
  if (!existsSync(registryPath)) return { instances: [], queryStatus: { registeredStores: true } };
  return readLogInstanceScope(registryPath);
}

interface RunLogsCliDeps {
  resolveTargets?: (opts: LogsCliOpts) => { targets: LogTarget[]; error?: string };
  readRender?: () => boolean | null;
  /** Test seam for zero-result diagnostic re-counts; normal CLI reads use opened stores. */
  countMatching?: (candidate: LogQuery) => number;
  /** Bookmark store for `logs -r` / `--remote <name>`. Tests inject a fixture store. */
  remotesStore?: () => RemotesStore;
  /** Authenticated GET /v1/logs. Tests inject a mock; live path uses fetch. */
  fetchRemoteLogs?: (url: string, token: string) => Promise<RemoteLogsFetchResult>;
}

type RemoteLogsFetchResult =
  | { readonly ok: true; readonly logs: readonly Record<string, unknown>[] }
  | { readonly ok: false; readonly status: number; readonly reason: string };

/** `-r` is value-less (default bookmark). Names go on `--remote <name>`. */
export function resolveLogsRemoteFlag(opts: LogsCliOpts): string | boolean | undefined {
  if (opts.remote !== undefined) return opts.remote;
  if (opts.r === true) return true;
  return undefined;
}

function logsRemoteHttpOrigin(host: string): string {
  const raw = host.trim();
  if (!raw) throw new Error('elanous logs: remote bookmark host is empty');
  const parsed = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`elanous logs: remote bookmark host has unsupported protocol ${parsed.protocol}`);
  }
  return parsed.origin;
}

function logQuerySearchParams(query: LogQuery, opts: LogsCliOpts): URLSearchParams {
  const params = new URLSearchParams();
  if (query.minLevel) params.set('level', query.minLevel);
  if (query.surfaces?.length) params.set('surface', query.surfaces.join(','));
  if (query.categories?.length) params.set('category', query.categories.join(','));
  if (query.exactCategories?.length) params.set('exactCategory', query.exactCategories.join(','));
  if (query.events?.length) params.set('event', query.events.join(','));
  if (query.grep) params.set('grep', query.grep);
  if (query.sessionId) {
    // parseLogQuery reads `sessionId` (PLAN + log-fabric tests). The
    // route comment historically named the same filter `session`.
    // Send both so `--session` still applies on a remote that only
    // implements one spelling — silently dropping the filter is the
    // lie this landing exists to stop.
    params.set('sessionId', query.sessionId);
    params.set('session', query.sessionId);
  }
  if (opts.since) params.set('since', opts.since);
  else if (query.sinceMs !== undefined) params.set('since', String(query.sinceMs));
  if (opts.until) params.set('until', opts.until);
  else if (query.untilMs !== undefined) params.set('until', String(query.untilMs));
  // ⛔ `before` 는 «원격 경로에 도달하지 않는다» — 그 전에 통째로 거절한다(row id 는 스토어마다 다르다).
  //   ⇒ 여기 분기를 두면 「원격 커서를 지원한다」로 읽힌다. 그래서 «두지 않는다»(리뷰 should-fix).
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  return params;
}

function remoteLogsUrl(host: string, query: LogQuery, opts: LogsCliOpts): string {
  const origin = logsRemoteHttpOrigin(host);
  const params = logQuerySearchParams(query, opts);
  const qs = params.toString();
  return qs.length > 0 ? `${origin}/v1/logs?${qs}` : `${origin}/v1/logs`;
}

function parseRemoteLogsBody(body: unknown): readonly Record<string, unknown>[] {
  const items = Array.isArray(body)
    ? body
    : (body !== null && typeof body === 'object' && Array.isArray((body as { logs?: unknown }).logs))
      ? (body as { logs: unknown[] }).logs
      : null;
  if (!items) throw new Error('elanous logs: remote /v1/logs response is not a log list');
  return items.map((value, index) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`elanous logs: remote /v1/logs item ${index} is malformed`);
    }
    return value as Record<string, unknown>;
  });
}

/** ⛔⭐ **상한이 없으면 「실패를 말한다」가 성립하지 않는다.**
 *  응답 없는 원격에 붙으면 CLI 가 «영영» 기다리고, 사람은 그것을 「느리다」로 읽는다.
 *  ⇒ 무응답을 «시간»으로 실패시키고, 그 실패를 다른 실패와 «다른 문면»으로 낸다(리뷰 should-fix). */
const REMOTE_LOGS_TIMEOUT_MS = 20_000;

export async function liveFetchRemoteLogs(url: string, token: string, timeoutMs = REMOTE_LOGS_TIMEOUT_MS): Promise<RemoteLogsFetchResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // ⛔ 「시간 초과」와 「연결 자체가 안 됨」을 한 문면으로 접지 않는다 — 사람이 할 일이 다르다.
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, status: 0, reason: `no response within ${timeoutMs}ms (remote daemon unreachable or hung)` };
    }
    return { ok: false, status: 0, reason: (error as Error).message };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, reason: `HTTP ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, status: response.status, reason: `invalid JSON: ${(error as Error).message}` };
  }
  try {
    return { ok: true, logs: parseRemoteLogsBody(body) };
  } catch (error) {
    return { ok: false, status: response.status, reason: (error as Error).message };
  }
}

function resolveLogsBookmark(
  remote: string | boolean,
  store: RemotesStore,
): { entry: ReturnType<RemotesStore['getDefaultRemote']>; named?: string; label: string } {
  const named = typeof remote === 'string' && remote.length > 0 ? remote : undefined;
  const entry = named ? store.getRemote(named) : store.getDefaultRemote();
  const defaultName = named ? undefined : store.listRemotes().find((r) => r.isDefault)?.name;
  return { entry, ...(named ? { named } : {}), label: named ?? defaultName ?? '<default>' };
}

function logsBookmarkError(named: string | undefined): number {
  console.error(named
    ? `--remote ${named}: unknown bookmark. Run \`elanous nexus list\` to see available remotes.`
    : 'no default remote bookmark. Run `elanous nexus connect <host> --default` to set one.');
  return 1;
}

function remoteOwn(row: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

function remoteDisplay(row: Record<string, unknown>, key: string): string {
  if (!remoteOwn(row, key)) return 'unknown';
  const value = row[key];
  // Present JSON `null` is "the remote did not know" — not an explicit
  // empty string. Collapsing the two made unknown and empty look alike.
  if (value === null || value === undefined) return 'unknown';
  return String(value);
}

/** Human line for a remote wire row. Missing identity fields are `unknown`; present empty stays empty. */
export function formatRemoteLogLine(
  row: Record<string, unknown>,
  bookmark: string,
  color: boolean = false,
  timeZone?: string,
): string {
  const tsRaw = remoteOwn(row, 'ts') ? row.ts : undefined;
  const t = typeof tsRaw === 'string' && tsRaw.length > 0
    ? formatClock(tsRaw, { millis: true, ...(timeZone ? { timeZone } : {}) })
    : tsRaw === null || tsRaw === undefined ? 'unknown' : String(tsRaw);
  const level = remoteDisplay(row, 'level');
  const tag = LEVEL_TAG[level] ?? '?';
  let data = '';
  if (remoteOwn(row, 'data')) {
    const raw = row.data;
    if (raw != null && raw !== '') {
      data = ` ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`;
      if (data.length > LOG_LINE_DATA_LIMIT) data = `${data.slice(0, LOG_LINE_DATA_LIMIT)}…`;
    }
  }
  const inst = `⟨remote:${bookmark}⟩ `;
  const line = `${t} ${tag} ${inst}[${remoteDisplay(row, 'surface')}] ${remoteDisplay(row, 'category')} ${remoteDisplay(row, 'event')}${data}`;
  if (!color) return line;
  const c = LEVEL_COLOR[level] ?? '';
  return c ? `${c}${line}${RESET}` : line;
}

/** JSON line for a remote wire row. Identity defaults are `unknown` until the row overwrites present keys. */
export function renderRemoteLogJsonLine(row: Record<string, unknown>, bookmark: string): string {
  const payload: Record<string, unknown> = {
    id: 'unknown',
    ts: 'unknown',
    level: 'unknown',
    surface: 'unknown',
    category: 'unknown',
    event: 'unknown',
    store: `remote:${bookmark}`,
  };
  Object.assign(payload, row);
  return JSON.stringify(payload);
}

async function runLogsCliRemote(
  opts: LogsCliOpts,
  remote: string | boolean,
  deps: RunLogsCliDeps,
): Promise<number> {
  const store = deps.remotesStore?.() ?? new RemotesStore();
  const { entry, named, label } = resolveLogsBookmark(remote, store);
  if (!entry) return logsBookmarkError(named);

  const localScopeFlags = [
    ...(opts.all === true ? ['--all'] : []),
    ...(opts.includeTest === true ? ['--include-test'] : []),
    ...(opts.test === true ? ['--test'] : []),
    ...(opts.instance ? ['--instance'] : []),
  ];
  if (localScopeFlags.length > 0) {
    console.error(`elanous logs: ${localScopeFlags.join(' / ')} is a local store scope and has no meaning with --remote; drop it (the remote daemon decides its own scope).`);
    return 1;
  }
  if (opts.follow === true) {
    console.error(`elanous logs: --follow is not supported with remote bookmark ${label}; drop --follow (this landing is one-shot GET /v1/logs).`);
    return 1;
  }

  const { query, error } = buildQuery(opts);
  if (error) { console.error(`elanous logs: ${error}`); return 1; }
  // ⛔⭐ **`--before` 는 원격에서 «통째로» 거절한다.**
  //   🩸 앞 판은 「숫자면 보낸다」였다. 그런데 그 숫자는 ***이쪽 스토어의 row id*** 이고
  //      저쪽 스토어에서 «같은 줄»을 가리킨다는 보장이 없다 — 연속성도 없다.
  //      ⇒ 그러면 사람은 「그 지점부터 봤다」고 믿는데 실제로는 «다른 곳»부터 본다.
  //      리뷰 must-fix 로 잡혔고, 내 PR 본문은 이미 「거절한다」고 «말하고 있었다»(말과 코드가 어긋남).
  if (opts.before !== undefined) {
    console.error(`elanous logs: remote bookmark ${label}: --before is local-only (row ids are per-store and do not address the same row remotely); drop --before.`);
    return 1;
  }

  let defaults: { host: string; tokenFile: string };
  try {
    defaults = bookmarkAttachDefaults(entry);
  } catch (err) {
    console.error(`elanous logs: remote bookmark ${label}: ${(err as Error).message}`);
    return 1;
  }
  const token = store.readToken(entry)?.trim();
  if (!token) {
    console.error(`elanous logs: remote bookmark ${label} (${entry.host}): token file is missing or empty (${defaults.tokenFile})`);
    return 1;
  }
  let url: string;
  try {
    url = remoteLogsUrl(defaults.host, query, opts);
  } catch (err) {
    console.error(`elanous logs: remote bookmark ${label}: ${(err as Error).message}`);
    return 1;
  }
  const fetchRemote = deps.fetchRemoteLogs ?? liveFetchRemoteLogs;
  let fetched: RemoteLogsFetchResult;
  try {
    fetched = await fetchRemote(url, token);
  } catch (err) {
    console.error(`elanous logs: remote bookmark ${label}: lookup failed for ${url}: ${(err as Error).message}`);
    return 1;
  }
  if (!fetched.ok) {
    console.error(`elanous logs: remote bookmark ${label}: lookup failed for ${url}: ${fetched.reason}`);
    return 1;
  }

  const color = process.stdout.isTTY === true && !opts.json;
  if (opts.json) {
    const meta = `${JSON.stringify({ _meta: { type: 'log-query-remote', bookmark: label, url, count: fetched.logs.length } })}\n`;
    await new Promise<void>((resolve, reject) => process.stdout.write(meta, (error) => error ? reject(error) : resolve()));
  } else {
    console.error(`원격 로그 북마크 ${label} · ${fetched.logs.length}건 · GET /v1/logs`);
  }
  if (fetched.logs.length === 0) {
    if (!opts.json) console.error('(일치하는 로그 없음)');
    return 0;
  }
  const lines = fetched.logs.map((row) => (
    opts.json ? renderRemoteLogJsonLine(row, label) : formatRemoteLogLine(row, label, color)
  ));
  const output = `${lines.join('\n')}\n`;
  await new Promise<void>((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
  return 0;
}

export interface ListEventsStore {
  query(q: LogQuery): LogStoreRow[];
}

export interface ListEventsAggregation {
  events: Array<{ event: string; count: number }>;
  truncated: boolean;
  unreadable: Array<{ name: string; message: string }>;
}

/**
 * `--list-events` 집계 — 스토어 API 를 늘리지 않고 기존 `query` 경로만 쓴다.
 * `--limit N` 은 스토어별이 아니라 병합 후 전역 N 이다. 절단은 전역 N+1 행의 존재로 판정한다.
 * `query()` 가 safety max 에서 멈추면 가장 오래된 행 커서로 한 행만 더 본다.
 */
export function aggregateListEvents(
  opened: ReadonlyArray<{ name: string; store: ListEventsStore }>,
  query: LogQuery,
  safetyMax: number = STORE_SAFETY_MAX,
): ListEventsAggregation {
  const fetchLimit = query.limit === undefined
    ? Math.min(safetyMax, LOG_QUERY_LIMIT_MAX)
    : Math.min(effectiveLogLimit(query.limit), safetyMax);
  const atSafetyMax = fetchLimit === safetyMax;
  const perStoreLimit = atSafetyMax ? safetyMax : fetchLimit + 1;
  const pages: LogStoreRow[][] = [];
  const unreadable: Array<{ name: string; message: string }> = [];
  const safetyFullPages: Array<{ store: ListEventsStore; page: LogStoreRow[] }> = [];

  for (const { name, store } of opened) {
    try {
      const page = store.query({ ...query, limit: perStoreLimit, beforeId: undefined, afterId: undefined });
      pages.push(page);
      if (atSafetyMax && page.length === safetyMax) safetyFullPages.push({ store, page });
    } catch (e) {
      unreadable.push({ name, message: e instanceof Error ? e.message : String(e) });
    }
  }

  const collected = pages.flat();
  collected.sort((a, b) => b.ts_ms - a.ts_ms || b.id - a.id);
  let truncated = collected.length > fetchLimit;
  if (!truncated) {
    for (const { store, page } of safetyFullPages) {
      const oldest = page[page.length - 1];
      if (!oldest) continue;
      try {
        const extra = store.query({
          ...query,
          limit: 1,
          beforeId: oldest.id,
          afterId: undefined,
        });
        if (extra.length > 0) {
          truncated = true;
          break;
        }
      } catch { /* 추가 행을 확인하지 못하면 절단을 단정하지 않는다 */ }
    }
  }

  const counts = new Map<string, number>();
  for (const row of collected.slice(0, fetchLimit)) {
    if (row.category === '_meta' || row.event === '_meta') continue;
    counts.set(row.event, (counts.get(row.event) ?? 0) + 1);
  }
  const events = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([event, count]) => ({ event, count }));
  return { events, truncated, unreadable };
}

/** 조회 또는 follow. follow 는 Ctrl-C 까지 블록. 복수 타겟(--all)은 ts 병합. */
export async function runLogsCli(opts: LogsCliOpts, deps: RunLogsCliDeps = {}): Promise<number> {
  const remoteFlag = resolveLogsRemoteFlag(opts);
  if (remoteFlag !== undefined) {
    if (opts.topFailures) { console.error('elanous logs: --top-failures 는 로컬 스토어 조회에서만 지원'); return 1; }
    return runLogsCliRemote(opts, remoteFlag, deps);
  }
  if (opts.topFailures && opts.follow) { console.error('elanous logs: --top-failures 는 --follow 와 함께 쓸 수 없다'); return 1; }
  const threshold = opts.threshold === undefined ? 20 : Number(opts.threshold);
  if (opts.topFailures && (!Number.isSafeInteger(threshold) || threshold < 1)) {
    console.error('elanous logs: --threshold 는 양의 정수여야 한다'); return 1;
  }

  const { query, error } = buildQuery(opts);
  if (error) { console.error(`elanous logs: ${error}`); return 1; }
  const recurrenceDisagreementFilter = parseBooleanFilter(
    opts.reworkRecurrenceDisagreement,
    '--rework-recurrence-disagreement',
  );
  if (recurrenceDisagreementFilter.error) { console.error(`elanous logs: ${recurrenceDisagreementFilter.error}`); return 1; }
  const resolved = deps.resolveTargets?.(opts) ?? resolveLogTargets(opts);
  if (resolved.error) { console.error(`elanous logs: ${resolved.error}`); return 1; }

  // read-only open — 타겟이 어느 인스턴스든 CLI 조회는 write 0 (연합 불변식).
  const opened: Array<{ name: string; store: LogStore }> = [];
  const missing: string[] = [];
  for (const t of resolved.targets) {
    if (!existsSync(t.dbPath)) { missing.push(`${t.name} (${t.dbPath})`); continue; }
    try { opened.push({ name: t.name, store: LogStore.openReadOnly(t.dbPath) }); }
    catch { missing.push(`${t.name} (${t.dbPath} — open 실패)`); }
  }
  const openedStores = opened.map(({ name, store }) => ({ name, path: store.path }));
  // 등록된 존재 DB의 고유 경로가 조회 가능 모집단이다. 선택 규칙은 건드리지 않고,
  // 그 모집단 중 이번 조회에서 열지 않은 수만 드러낸다. 레지스트리가 못 읽히면
  // 0으로 정규화하지 않아 "등록 0"과 "못 셈"을 구별한다.
  const registryScope = readRegisteredStoreScope();
  const registeredStorePaths = new Set(registryScope.instances.filter((instance) => instance.dbExists).map((instance) => instance.dbPath));
  const unopenedStores = registryScope.queryStatus.registeredStores
    ? [...registeredStorePaths].filter((path) => !openedStores.some((store) => store.path === path)).length
    : undefined;
  const scope = registryScope.queryStatus.registeredStores
    ? { registeredStores: registeredStorePaths.size, unopenedStores }
    : {};
  const queryStatus = registryScope.queryStatus;
  const unopenedStoreBanner = unopenedStores === undefined ? '안 본 스토어 수 미측정' : `안 본 스토어 ${unopenedStores}개`;
  const podGap = !opts.topFailures && podObservationGapNotice(query, 1) !== null
    ? await countPodRunLedgers(podLedgerDirectories(opts, resolved.targets, registryScope.instances), query)
    : null;
  const podNotice = podGap ? podObservationGapNotice(query, podGap.podRuns) : null;
  const podGapMeta = podGap && (podNotice || podGap.unreadableLedgers > 0)
    ? { _meta: { type: 'log-query-pod-observation-gap', ...podGap } }
    : null;
  const emitPodGap = (): void => {
    if (!opts.json && podGap) {
      if (podNotice) console.error(`${podNotice}${podGap.unreadableLedgers > 0 ? ` (못 읽은 원장 ${podGap.unreadableLedgers})` : ''}`);
      else if (podGap.unreadableLedgers > 0) console.error(`안내: Pod 원장 조회 중 못 읽은 원장 ${podGap.unreadableLedgers}개 — Pod 런 수를 확정할 수 없다(POD-OBS).`);
    }
    if (podGapMeta && podGap) debug.log('logs.query', 'pod-observation-gap', podGap);
  };
  if (opened.length === 0) {
    console.error(`elanous logs: 열 수 있는 로그 스토어 없음 — ${missing.join(' · ') || '타겟 0'} · scope=${JSON.stringify(scope)} · queryStatus=${JSON.stringify(queryStatus)}`);
    console.error('  스토어는 해당 인스턴스 데몬(LF0 이후)이 한 번은 떠야 생성됩니다.');
    if (opts.json && podGapMeta) console.log(JSON.stringify(podGapMeta));
    emitPodGap();
    return 1;
  }
  if (missing.length > 0) console.error(`elanous logs: 스킵 — ${missing.join(' · ')}`);
  if (opts.topFailures) {
    const rows: LogStoreRow[] = [];
    const unreadable: string[] = [];
    // Query the entire selected window, not the usual most recent page: a high-volume log can exceed --limit.
    const windowQuery = { ...query };
    delete windowQuery.limit;
    for (const { name, store } of opened) {
      try {
        for (const row of store.queryAll({ ...windowQuery, sinceMs: query.sinceMs ?? Date.now() - 10 * 60_000 })) rows.push(row);
      }
      catch (e) { unreadable.push(name); console.error(`elanous logs: ${name} 조회 실패 — ${e instanceof Error ? e.message : String(e)}`); }
    }
    const groups = detectRepeatedFailures(rows, { threshold }).map((group) => ({
      ...group,
      key: redactSecretText(group.key), reason: redactSecretText(group.reason),
      explanation: redactSecretText(explainFailure(group)),
    }));
    if (opts.json) console.log(JSON.stringify({ groups, unreadable }));
    else {
      console.log('개수  영역  사유  원인 — 조치');
      for (const group of groups) console.log(`${group.count}  ${group.area}  ${group.reason}  ${group.explanation}`);
    }
    for (const { store } of opened) store.close();
    return unreadable.length ? 2 : 0;
  }
  if (opts.json) {
    const meta = `${JSON.stringify({ _meta: { type: 'log-query-opened-stores', stores: openedStores, scope, queryStatus } })}\n`;
    await new Promise<void>((resolve, reject) => process.stdout.write(meta, (error) => error ? reject(error) : resolve()));
  } else if (!opts.follow) {
    console.error(`열린 로그 스토어 ${openedStores.length}개 · ${unopenedStoreBanner} · scope=${JSON.stringify(scope)} · queryStatus=${JSON.stringify(queryStatus)}`);
  }
  const multi = opened.length > 1;
  const color = process.stdout.isTTY === true && !opts.json;
  const closeAll = (): void => { for (const o of opened) o.store.close(); };
  const render = (row: LogStoreRow, name: string, path?: string): string => (
    opts.json
      ? renderLogJsonLine(row, name, opts.jsonData, path)
      : formatLogLine(row, color, multi ? name : undefined)
  );
  const emit = (row: LogStoreRow, name: string, path?: string): void => { console.log(render(row, name, path)); };

  // ⛔⭐⭐ **「실제로 뜬 카테고리 전수」** — `F12` 감사를 «반복 가능»하게 만드는 자리(`OBS-T122`).
  //   소스의 `debug.log('<cat>')` 목록과 «차집합»을 내면 「계측했는데 한 번도 안 뜬 것」이 나온다.
  if (opts.listCategories === true) {
    const merged = new Map<string, number>();
    for (const { store } of opened) {
      try {
        for (const { category, count } of store.categoryCounts({ sinceMs: query.sinceMs, untilMs: query.untilMs })) {
          merged.set(category, (merged.get(category) ?? 0) + count);
        }
      } catch { /* 한 스토어가 못 읽혀도 «셈»을 막지 않는다 — 아래 경고가 그 사실을 말한다 */ }
    }
    const rows = [...merged.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    if (opts.json) {
      console.log(JSON.stringify({ stores: openedStores.length, categories: rows.map(([category, count]) => ({ category, count })) }));
    } else {
      console.error(`카테고리 ${rows.length}개 · 스토어 ${openedStores.length}개`);
      for (const [category, count] of rows) console.log(`${String(count).padStart(8)}  ${category}`);
    }
    closeAll();
    return 0;
  }

  // ⭐ 「이 카테고리에 «어떤» 이벤트가 뜨나」 — `--list-categories` 와 같은 모양.
  //   카테고리·시간 필터는 존중한다(그것이 이 명령의 요점). 스토어 API 를 늘리지 않고
  //   기존 `query` 경로로 센다. `_meta` 절단 경고 행은 이벤트 수에 넣지 않는다.
  if (opts.listEvents === true) {
    const { events, truncated, unreadable } = aggregateListEvents(opened, query);
    for (const { name, message } of unreadable) {
      console.error(`elanous logs: ${name} 조회 실패 — ${message}`);
    }
    if (opts.json) {
      console.log(JSON.stringify({
        stores: openedStores.length,
        events,
        ...(truncated ? { truncated: true } : {}),
      }));
    } else {
      console.error(`이벤트 ${events.length}개 · 스토어 ${openedStores.length}개`);
      for (const { event, count } of events) console.log(`${String(count).padStart(8)}  ${event}`);
    }
    if (truncated) console.error('elanous logs: result may be truncated (limitReached=true)');
    closeAll();
    return unreadable.length > 0 ? 2 : 0;
  }
  if (opts.explain && opts.axis === undefined) {
    const explanation = renderLogAxisDiscovery();
    console.log(opts.json ? JSON.stringify({ _meta: { type: 'log-query-axis-discovery', explanation } }) : explanation);
    closeAll();
    return 0;
  }

  if (opts.explain && opts.axis) {
    const storedCategories = [...new Set(opened.flatMap(({ store }) => store.categories({ sinceMs: query.sinceMs, untilMs: query.untilMs })))]
      .sort();
    const explanation = renderAxisExplanation(opts.axis.trim(), storedCategories);
    console.log(opts.json ? JSON.stringify({ _meta: { type: 'log-query-axis-explanation', explanation } }) : explanation);
    closeAll();
    return 0;
  }

  if (!opts.follow) {
    const federatedCursors = opts.before === undefined ? null : parseFederatedLogCursors(opts.before);
    if (query.beforeId !== undefined && opened.length > 1) {
      console.error('elanous logs: 숫자 --before 는 연합 조회와 함께 쓸 수 없다 — --json 메타의 nextCursors JSON 객체를 그대로 쓰세요.');
      return 2;
    }
    if (federatedCursors && opened.length === 1) {
      console.error('elanous logs: 인스턴스별 nextCursors 는 연합 조회에서만 쓸 수 있다.');
      return 2;
    }
    const limit = effectiveLogLimit(query.limit);
    const merged: Array<{ row: LogStoreRow; name: string; path: string }> = [];
    const unreadableInstances: string[] = [];
    const pushQueriedRows = (name: string, path: string, rows: readonly LogStoreRow[]): void => {
      for (const row of rows) merged.push({ row, name, path });
    };
    const queryStoreRows = (store: LogStore, beforeId: number | undefined, requestedLimit: number): LogStoreRow[] => (
      store.query({ ...query, limit: requestedLimit, ...(beforeId !== undefined ? { beforeId } : {}) })
    );
    for (const { name, store } of opened) {
      let beforeId = federatedCursors?.[name];
      try {
        if (recurrenceDisagreementFilter.value === undefined) {
          pushQueriedRows(name, store.path, queryStoreRows(store, beforeId, limit));
          continue;
        }
        let matchedCount = 0;
        const seenIds = new Set<number>();
        for (;;) {
          const batch = queryStoreRows(store, beforeId, STORE_SAFETY_MAX);
          if (batch.length === 0) break;
          pushQueriedRows(name, store.path, batch.filter((row) => {
            if (seenIds.has(row.id)) return false;
            seenIds.add(row.id);
            const matched = matchesReworkRecurrenceDisagreement(row, recurrenceDisagreementFilter.value);
            if (matched) matchedCount += 1;
            return matched;
          }));
          if (matchedCount >= limit || batch.length < STORE_SAFETY_MAX) break;
          beforeId = batch.at(-1)?.id;
          if (beforeId === undefined) break;
        }
      } catch (e) {
        // ⛔⭐ 커서가 가리키는 행이 없으면 **빈 쪽을 조용히 내주지 않는다** — 그 0 은
        //   "더 없다" 와 구별되지 않아 페이징을 여기서 멈추게 만든다(거짓 완주).
        if (e instanceof LogCursorNotFoundError) {
          console.error(`elanous logs: --before ${e.beforeId} 행이 ${name} 에 없다 — 커서가 딴 인스턴스이거나 보존 정리로 사라진 행이다.`);
          console.error('  ⇒ 이 결과는 "더 없다" 가 아니다. --instance 를 맞추거나 마지막 쪽의 --json id 를 다시 확인한다.');
          return 2;
        }
        unreadableInstances.push(name);
        console.error(`elanous logs: ${name} 조회 실패 — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const filtered = merged;
    filtered.sort((a, b) => a.row.ts_ms - b.row.ts_ms || a.row.id - b.row.id);
    const out = filtered.slice(-limit);
    // 출력은 시간순(오래→최신)이라 **가장 오래된 것이 out[0]** 이다 — 다음 쪽 커서는 그 id.
    const oldest = out[0]?.row.id;
    const multiCursors = opened.length > 1 ? cursorsForOutput(out, federatedCursors) : undefined;
    const limitMeta = opts.json
      ? limitReachedJsonMeta(out.length, limit, query.limit, oldest, multiCursors)
      : null;
    const outputLines = out.map((m) => render(m.row, m.name, m.path));
    if (!opts.json) {
      const contributingStorePaths = new Set(out.map(({ path }) => path));
      for (const { name, path } of openedStores) {
        if (contributingStorePaths.has(path)) console.error(`log store: ${path} (${name})`);
      }
    }
    const unreadableMeta = unreadableInstances.length > 0
      ? { _meta: { type: 'log-query-unreadable-instances', unreadableInstanceCount: unreadableInstances.length, unreadableInstances } }
      : null;
    const multiSurfaceDuplicateMeta = opts.json
      ? multiSurfaceDuplicateJsonMeta(out.map(({ row }) => row))
      : null;
    // JSONL 소비자는 stdout만 읽는다. 결손·중복 성격·상한 메타도 별도 행으로 내어 행별 JSON 파싱을 보존한다.
    if (opts.json && multiSurfaceDuplicateMeta) outputLines.unshift(JSON.stringify(multiSurfaceDuplicateMeta));
    if (opts.json && unreadableMeta) outputLines.unshift(JSON.stringify(unreadableMeta));
    if (opts.json && podGapMeta) outputLines.unshift(JSON.stringify(podGapMeta));
    if (unreadableInstances.length > 0 && !opts.json) {
      outputLines.unshift(`⚠️ 못 읽은 인스턴스 ${unreadableInstances.length}개: ${unreadableInstances.join(', ')}`);
    }
    if (limitMeta) outputLines.push(JSON.stringify(limitMeta));
    const limitSignal = opts.json ? limitReachedStderrSignal(limitMeta) : null;
    if (limitSignal) console.error(limitSignal);
    if (outputLines.length > 0) {
      const output = `${outputLines.join('\n')}\n`;
      await new Promise<void>((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
    }
    emitPodGap();
    const eventWarning = eventCategoryWarning(opts.event);
    if (eventWarning) {
      console.error(eventWarning);
      debug.log('logs.cli', 'event-category-warning', { event: opts.event, resultCount: out.length });
    }
    if (!opts.json) {
      const writeTruncatedRows = out.filter(({ row }) => hasWriteTruncationMarker(row.data)).length;
      const renderTruncatedRows = out.filter(({ row }) => (
        isLogLineDataTruncated(row.data) && !hasWriteTruncationMarker(row.data)
      )).length;
      const truncationWarning = rowTruncationWarning(renderTruncatedRows, writeTruncatedRows);
      if (truncationWarning) {
        console.error(truncationWarning);
        debug.log('logs.cli', 'row-truncated', {
          renderTruncatedRows,
          writeTruncatedRows,
          totalRows: out.length,
          limitChars: LOG_LINE_DATA_LIMIT,
        });
      }
      const grepWarning = grepPhraseWarning(opts.grep);
      if (grepWarning) {
        console.error(grepWarning);
        debug.log('logs.cli', 'grep-phrase-warning', { grep: opts.grep, resultCount: out.length });
      }
      const coverageHint = runCoverageHint(out.map(({ row }) => row));
      if (coverageHint) console.error(coverageHint);
      // 좁힌 조회(이벤트·카테고리)만 — 넓은 조회까지 매번 전 우주를 열지 않는다.
      if (out.length > 0 && ((query.events?.length ?? 0) > 0 || (query.categories?.length ?? 0) > 0
        || (query.exactCategories?.length ?? 0) > 0)) {
        const matches = probeOtherInstanceMatches(opts, query, resolved.targets.map((target) => target.dbPath));
        // 표시 상한(--limit)이 아니라 «여기» 실제 일치 수와 비교한다(상한 100 을 «100건»으로 말하지 않는다).
        let here: number | null = null;
        try {
          here = Math.max(out.length, (deps.countMatching ?? ((candidate: LogQuery) => opened.reduce(
            (count, { store }) => count + store.countMatching(candidate), 0)))(query));
        } catch (error) {
          // 셈을 못 했으면 경고하지 않는다 — 잘린 표시 수를 «여기 N건»으로 말하지 않는다.
          debug.log('logs.cli', 'other-instance-count-failed', { shown: out.length, error: error instanceof Error ? error.message : String(error) });
        }
        const majority = here === null ? null : otherInstanceMajorityWarning(here, matches, opts);
        if (majority) {
          console.error(majority);
          debug.log('logs.cli', 'other-instance-majority', {
            shown: out.length,
            here,
            elsewhere: matches.reduce((sum, match) => sum + match.count, 0),
            instances: matches.length,
          });
        }
      }
      if (out.length === 0) {
        console.error('(일치하는 로그 없음)');
        const instanceHint = otherInstanceHint(
          probeOtherInstanceMatches(opts, query, resolved.targets.map((target) => target.dbPath)),
          opts,
        );
        if (instanceHint) console.error(instanceHint);
        const countMatching = deps.countMatching ?? ((candidate: LogQuery) => opened.reduce(
          (count, { store }) => count + store.countMatching(candidate),
          0,
        ));
        const categoryWarning = categoryCandidateWarning(query, countMatching);
        if (categoryWarning) console.error(categoryWarning);
        if (query.events && query.events.length > 0) {
          const observedEvents = collectObservedEventNames(opened.map(({ store }) => store), query);
          const nameHint = eventNameHint(query.events, observedEvents);
          if (nameHint) console.error(nameHint);
          const eventVerdict = eventNameVerdict(opts.event);
          if (eventVerdict) console.error(eventVerdict);
        }
        console.error(zeroResultFilterRelaxationWarning(query, countMatching, opts));
        const nonCurrentScopeTargetNames = nonCurrentScopeNames(resolved.targets);
        const hint = renderGatedHint(opts, deps.readRender ?? readScopedRenderLogs, nonCurrentScopeTargetNames);
        if (hint) console.error(hint);
        debug.log('logs.cli', 'zero-result', { grep: opts.grep, query, targetCount: resolved.targets.length });
      }
    }
    const limitHint = limitReachedHint(out.length, limit, query.limit, oldest, opened.length > 1);
    if (!opts.json && limitHint) console.log(limitHint);
    closeAll();
    return unreadableInstances.length > 0 ? 2 : 0;
  }

  // follow — 스토어별 afterId 커서 증분 폴, 폴마다 ts 병합 출력.
  const seed: Array<{ row: LogStoreRow; name: string; path: string }> = [];
  for (const { name, store } of opened) {
    try { for (const row of store.query({ ...query, limit: 20 })) seed.push({ row, name, path: store.path }); }
    catch { /* 스킵 */ }
  }
  seed.sort((a, b) => a.row.ts_ms - b.row.ts_ms || a.row.id - b.row.id);
  for (const m of seed.slice(-20)) emit(m.row, m.name, m.path);
  if (opts.json && podGapMeta) console.log(JSON.stringify(podGapMeta));
  emitPodGap();
  const cursors = new Map<string, number>();
  for (const { name, store } of opened) {
    try { cursors.set(name, store.maxId()); } catch { cursors.set(name, 0); }
  }
  console.error(`--- following 열린 로그 스토어 ${opened.length}개 (Ctrl-C 종료) ---`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, FOLLOW_POLL_MS));
    const batch: Array<{ row: LogStoreRow; name: string; path: string }> = [];
    for (const { name, store } of opened) {
      try {
        const cursor = cursors.get(name) ?? 0;
        const rows = store.query({ ...query, afterId: cursor, limit: 500 });
        for (const row of rows) {
          cursors.set(name, Math.max(cursors.get(name) ?? 0, row.id));
          batch.push({ row, name, path: store.path });
        }
        if (rows.length === 0) {
          const m = store.maxId();
          if (m > cursor) cursors.set(name, m); // 필터에 걸러진 행도 커서 전진
        }
      } catch { /* 다음 폴 — DB 회전/락 순간 대비 */ }
    }
    batch.sort((a, b) => a.row.ts_ms - b.row.ts_ms || a.row.id - b.row.id);
    for (const m of batch) emit(m.row, m.name, m.path);
  }
}

// ── elanous logs instances — 레지스트리 조회 (LF7-b) ────────────────────

export function formatLogInstance(view: LogInstanceView): string {
  const live = view.pid > 0 ? (view.alive ? `alive pid=${view.pid}` : `dead pid=${view.pid}`) : 'unregistered';
  const db = view.dbExists ? 'store OK' : 'store 없음';
  const ambiguity = view.ambiguous ? `ambiguous ${view.stateDirCount} paths` : '';
  return `${view.name.padEnd(24)} ${live.padEnd(18)} ${db.padEnd(10)} ${ambiguity.padEnd(18)} ${view.stateDir}`;
}

export function runLogsInstances(opts: { json?: boolean }): number {
  const views = readLogInstances();
  const prodRoot = join(homedir(), '.elanous'); // prod 는 config-dir==state-dir(단일 뿌리)
  const prodDb = join(prodRoot, 'logs', 'logs.db');
  // prod 는 레지스트리 미등록이어도 항상 표시(암묵 타겟).
  const hasProd = views.some((v) => v.dbPath === prodDb);
  const rows = [
    ...(hasProd ? [] : [{
      name: 'prod', stateDir: prodRoot, pid: 0, startedAt: '', stateDirCount: 1, ambiguous: false,
      kind: 'prod', configDir: prodRoot, alive: false, liveness: 'dead', dbExists: existsSync(prodDb), dbPath: prodDb,
    } satisfies LogInstanceView]),
    ...views,
  ];
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const v of rows) console.log(formatLogInstance(v));
  if (rows.length === 0) console.log('(등록된 인스턴스 없음)');
  return 0;
}

// ── elanous logs level [lvl] — 데몬 REST 경유 (런타임 상태) ────────────────

function daemonBase(): string | null {
  return resolveDaemonEndpoint()?.baseUrl ?? null;
}

function readToken(): string | null {
  const p = join(getElanousConfigDir(), 'acp-token');
  try { return existsSync(p) ? readFileSync(p, 'utf-8').trim() : null; } catch { return null; }
}

export async function runLogsLevel(level: string | undefined, opts: { json?: boolean; render?: string }): Promise<number> {
  const base = daemonBase();
  if (!base) {
    console.error('elanous logs level: 이 우주의 데몬 주소를 모른다 — 포트를 짐작하지 않는다. 데몬을 띄우거나 주소를 확인하세요.');
    return 1;
  }
  const token = readToken();
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  // OH9 — --render on|off (레벨과 직교 축). level 없이 render 만 보낼 수 있고,
  // 함께 보내면 둘 다 적용된다. 미지정이면 종전처럼 조회(GET)만.
  let render: boolean | undefined;
  if (opts.render !== undefined) {
    const r = String(opts.render).trim().toLowerCase();
    if (r === 'on' || r === 'true') render = true;
    else if (r === 'off' || r === 'false') render = false;
    else { console.error(`elanous logs level: --render 은 on|off (받은 값: '${opts.render}')`); return 1; }
  }
  const isMutation = level !== undefined || render !== undefined;
  try {
    const res = isMutation
      ? await fetch(`${base}/v1/logs/level`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(level !== undefined ? { level } : {}),
            ...(render !== undefined ? { render } : {}),
          }),
        })
      : await fetch(`${base}/v1/logs/level`, { headers });
    const body = await res.json() as {
      ok?: boolean; level?: string; render?: boolean; persisted?: boolean; error?: string; valid?: unknown[];
      gates?: Record<string, boolean>; filePath?: string;
    };
    if (opts.json) { console.log(JSON.stringify(body, null, 2)); return res.ok ? 0 : 1; }
    if (!res.ok || body.ok === false) {
      console.error(`elanous logs level: ${body.error ?? res.status}${body.valid ? ` (유효: ${body.valid.join('|')})` : ''}`);
      if (res.status === 404) {
        console.error('  데몬이 /v1/logs/level 을 모릅니다 — LF1 이전 구버전일 수 있습니다(재기동/발효 필요).');
      }
      return 1;
    }
    if (isMutation) {
      const parts: string[] = [];
      if (level !== undefined) parts.push(`레벨 → ${body.level}`);
      if (render !== undefined) parts.push(`렌더 로그 → ${body.render ? 'ON(발화)' : 'OFF(억제)'}`);
      console.log(`${parts.join(' · ')} (인스턴스 영속: ${body.persisted ? 'OK' : '실패 — 라이브만 적용'})`);
    } else {
      const g = body.gates ?? {};
      const renderSuppressed = g.renderSuppressed === true;
      // renderSuppressed 는 "억제" 상태라 일반 on-게이트 목록과 의미가 반대 —
      // 목록에서 빼고 렌더 로그 상태를 따로 명시(정직한 표시).
      const on = Object.entries(g).filter(([k, v]) => v && k !== 'renderSuppressed').map(([k]) => k).join('·') || '없음';
      console.log(`레벨 ${body.level} · 게이트 ${on} · 렌더 로그 ${renderSuppressed ? 'OFF(억제)' : 'ON(발화)'}`);
      if (body.filePath) console.log(`파일 트레일 ${body.filePath}`);
    }
    return 0;
  } catch (e) {
    console.error(`elanous logs level: 데몬(${base}) 연결 실패 — ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  레벨은 데몬 런타임 상태입니다. 데몬이 없으면 기본값을 config 로 지정하세요: elanous config set debug.level <lvl>`);
    console.error(`  (인스턴스별 영속은 <stateDir>/logs/level.json — 데몬이 있을 때 이 명령이 관리)`);
    return 1;
  }
}

export function registerLogsCommands(program: Command): void {
// ── logs (통합 로그 패브릭 LF3 — adb logcat 동형 · 2026-07-13) ──
// 조회/follow 는 logs.db 직독(데몬 다운 무관·토큰 불요), level 만 데몬 REST.
const logsCmd = program.command('logs')
  .description('전 서피스 로그 조회/실시간 tail (adb logcat 동형) — level/surface/category/grep 필터')
  .option('-f, --follow', '실시간 follow (tail -f · Ctrl-C 종료)')
  .option('--level <lvl>', '이 레벨 이상만 (trace|debug|info|warn|error|critical)')
  .option('--surface <s>', 'surface 필터 CSV (nexus,pwa,telegram,discord,…)')
  .option('--space <v>', '하니스 공간 필터 (self-implement|dev-harness|solve-mission = 종류별 · 그 외 = run id/branch slug 로 격리 조회)')
  .option('--category <c>', 'category prefix 필터 CSV (voice,webterm.tabs,…)')
  .option('--exact-category <c>', 'category 정확 일치 필터 CSV (자식 category 제외)')
  // ⭐ 「무엇이 «실제로» 뜨나」 — 소스의 debug.log 목록과 «차집합»을 내면 미배선이 나온다(`OBS-T122`)
  .option('--list-categories', '이 스토어들에 «실제로 뜬» 카테고리와 발화 수를 전수로 낸다(필터 무시)')
  .option('--list-events', '이 스토어들에 «실제로 뜬» 이벤트와 발화 수를 낸다(카테고리 필터 존중)')
  .option('--axis <name>', `축 이름을 정확 카테고리 묶음으로 조회 (${knownLogAxes().join('|')})`)   // ⛔ 목록을 손으로 적지 않는다 — 축이 늘면 도움말이 낡는다(A3)
  .option('--explain', '축 미지정이면 축·카테고리를 발견, --axis와 함께면 매핑·미분류·최근 창 발화 0을 설명')
  .option('--event <e>', 'event 정확 일치 필터 CSV')
  .option('--grep <q>', 'event/data/category 부분 일치')
  .option('--rework-recurrence-disagreement <true|false>', 'rework-budget data.recurrenceDisagreement 값 필터')
  .option(...LOGS_SINCE_OPTION)
  .option('--until <t>', '끝 시각 — --since 와 대칭 (30s|15m|2h|7d 상대 또는 ISO/epoch)')
  .option('--before <cursor>', '⭐ 페이지 커서 — 행 id 또는 연합 --json 메타의 nextCursors JSON 객체')
  .option('--session <id>', 'session_id 필터')
  .option('--limit <n>', '최대 행 수 (기본 100 · 로컬 직독은 1000 에 갇히지 않는다 — 그 상한은 HTTP 경계로 옮겼다)')
  .option('--top-failures', '최근 실패를 레벨 무관하게 사유별 집계 (기본 10m)')
  .option('--threshold <n>', '반복 실패 최소 횟수 (기본 20)')
  .option('--json', 'JSON 출력')
  .option('--json-data', '--json 출력에서 JSON data를 파싱된 값으로 출력')
  .option('--test', 'cwd 레포의 격리 테스트 인스턴스(.elanous-test/) 로그를 본다 (LF7-b)')
  .option('--instance <name>', '레지스트리 등록 인스턴스 타겟 (prod|test:<repo>|…)')
  .option('--all', '전 인스턴스 연합 조회 — read-only 병합·⟨instance⟩ 태그')
  .option('--include-test', '--all 연합에 격리 test 인스턴스도 포함(기본 제외)')
  // ⛔ `-r` 은 값을 받지 않는다 — default 북마크만. 이름은 `--remote <name>` 으로만 준다.
  .option('-r', 'query logs on the default remote bookmark (does not take a value)')
  .option('--remote <name>', 'query logs on a named remote bookmark via GET /v1/logs')
  .action(async (o: import('./logs-cli.js').LogsCliOpts) => {
    const { runLogsCli } = await import('./logs-cli.js');
    process.exitCode = await runLogsCli(o);
  });
// ★ 발견성 — 플래그 18개를 나열만 하면 **이미 있는 기능을 못 찾고 손으로 다시 만든다**.
//   실측(2026-07-28): `--since 30m` 을 모른 채 `$(date -u -v-30M …)` 를 손으로 썼고(macOS 전용),
//   `-f` 를 모른 채 폴 루프를 짰다. 그래서 예시를 **맨 앞**에 둔다(`before` = Usage 위).
//   ⚠️ 자리표시자는 **대문자**다 — `<ref>` 로 쓰면 셸에서 입력 리다이렉션이라 복사해서 못 돌린다.
logsCmd.addHelpText('before', `
자주 쓰는 5가지 (복사해서 그대로 실행 · 자리표시자는 대문자)

  elanous logs --category dev-pipeline --since 30m
      최근 시간창. ⭐ --since 는 상대 표기를 받는다(30s|15m|2h|7d) — date 로 계산하지 마라.

  elanous logs --category self-review -f
      실시간 follow (tail -f 동형 · Ctrl-C 종료).

  elanous logs --event headless.spawn --since 6h | grep -c .
      그 이벤트가 몇 건인가. ⭐ --event 는 정확 일치 — --grep 은 data 본문도 매칭해 과다 계수한다.
      ⚠️ 0건은 stderr 로 나가므로 이 파이프는 정직하게 0 을 낸다.

  elanous logs --grep RUNID --since 3h --all --include-test
      한 실행을 끝까지 따라간다. ⚠️ 런의 이벤트는 prod 와 격리 인스턴스에 **나뉘어** 있어
      --all --include-test 가 없으면 일부만 보인다. (--space RUNID 는 harness 공간만 본다)

  elanous logs --category self-review --event done --since 6h --json | jq '.data | fromjson | .verdict'
      JSON 파이프. ⚠️ data 는 **문자열**이라 fromjson 을 거쳐야 필드를 뽑는다.

  elanous logs --event frame-stall --since 7d --instance prod --limit 1000 --json | tail -1
      ⭐ 과거로 가려면 페이지를 넘긴다. --since 를 넓히는 것으로는 못 간다 —
      정렬이 최근순이라 어떤 창을 걸어도 **최근 상한만큼**만 온다(실측).
      상한에 걸리면 다음 쪽 명령(--before ID)을 stderr 로 찍어 준다.

더 보기: elanous logs timeline --help (자율빌드 드라이브를 내러티브로) · elanous logs instances
`);
logsCmd.command('instances')
  .description('로그 인스턴스 레지스트리 조회 — 이름·state dir·liveness·store 유무 (LF7-b)')
  .option('--json')
  .action(async (o: { json?: boolean }) => {
    const { runLogsInstances } = await import('./logs-cli.js');
    process.exit(runLogsInstances(o));
  });
logsCmd.command('level [lvl]')
  .description('데몬 로그 레벨 조회/런타임 변경 (off|trail|diag|normal|verbose|detail|keytrace · 변경은 인스턴스 영속 — LF7-c). --render on|off = 렌더 로그 무음 스위치(레벨과 직교 · OH9)')
  .option('--json')
  .option('--render <on|off>', '렌더 카테고리(dashboard/key/mouse/…) 발화 on|off — 진단 레벨과 직교(OH9)')
  .action(async (lvl: string | undefined, o: { json?: boolean; render?: string }) => {
    const { runLogsLevel } = await import('./logs-cli.js');
    process.exit(await runLogsLevel(lvl, o));
  });
logsCmd.command('timeline')
  .description('세션/드라이브를 휴먼 리더블 내러티브로 렌더 — 렌더 노이즈 제외·turn/tool-call/reasoning/edit 타임라인 (자율빌드 드라이브 진단용)')
  .option('--session <id>', 'session_id 필터 (예: elanous-session-1)')
  .option('--since <t>', '시작 시각 (30s|15m|2h|7d 상대 또는 ISO/epoch)')
  .option('--until <t>', '종료 시각 (동일 문법)')
  .option('--out <path>', '파일로 저장 (미지정 시 stdout)')
  .option('--test', 'cwd 레포의 격리 테스트 인스턴스(.elanous-test/)')
  .option('--instance <name>', '레지스트리 등록 인스턴스 (prod|test:<repo>|…)')
  .action(async (o: import('./logs-timeline.js').LogsTimelineOpts, cmd: { optsWithGlobals(): Record<string, unknown> }) => {
    // Parent `logs` also declares --since/--session/--test/--instance; merge
    // parent+child so those don't get swallowed by the parent scope.
    const merged = { ...cmd.optsWithGlobals(), ...o } as import('./logs-timeline.js').LogsTimelineOpts;
    const { runLogsTimeline } = await import('./logs-timeline.js');
    process.exit(runLogsTimeline(merged));
  });

logsCmd.command('durations')
  .description('대화 표면과 헤드리스 core 경로를 분리해 툴별 소요 분포(count·median·p90·max)를 조회')
  .option('--json', '구조화 JSON 출력')
  .option('--limit <n>', '인스턴스별 최대 수집 행 수 (상한 도달 여부를 산출에 표시)')
  .option('--test', 'cwd 레포의 격리 테스트 인스턴스(.elanous-test/)')
  .option('--instance <name>', '레지스트리 등록 인스턴스 (prod|test:<repo>|…)')
  .option('--all', '등록된 모든 로그 인스턴스를 연합 조회')
  .option('--include-test', '--all 연합에 격리 test 인스턴스 포함')
  .action(async (o: import('./logs-tool-durations.js').LogsToolDurationsOpts, cmd: { optsWithGlobals(): Record<string, unknown> }) => {
    const merged = { ...cmd.optsWithGlobals(), ...o } as import('./logs-tool-durations.js').LogsToolDurationsOpts;
    const { runLogsToolDurations } = await import('./logs-tool-durations.js');
    process.exit(runLogsToolDurations(merged));
  });

logsCmd.command('model-input')
  .description('최근 노드 종류별 모델 입력 토큰 기준선 (중앙값·p90·못 잼 별도 집계, 기본 3일)')
  .option('--since <t>', '조회 시작 (기본 3d · 30s|15m|2h|7d 또는 ISO)')
  .option('--json', '구조화 JSON 출력')
  .option('--test', 'cwd 레포의 격리 테스트 인스턴스(.elanous-test/)')
  .option('--instance <name>', '레지스트리 등록 인스턴스')
  .option('--all', '등록된 모든 로그 인스턴스 연합 조회')
  .option('--include-test', '--all 연합에 격리 test 인스턴스 포함')
  .action(async (o: import('./logs-model-input.js').LogsModelInputOpts, cmd: { optsWithGlobals(): Record<string, unknown> }) => {
    const merged = { ...cmd.optsWithGlobals(), ...o } as import('./logs-model-input.js').LogsModelInputOpts;
    const { runLogsModelInput } = await import('./logs-model-input.js');
    process.exitCode = runLogsModelInput(merged);
  });

logsCmd.command('degenerate')
  .description('수치 로그 필드의 always-same/all-zero/표본 부족 퇴화를 NDJSON으로 판정 (기본 표본 50)')
  .option('--category <prefix>', '카테고리 접두 필터 (복수는 쉼표)')
  .option('--event <event>', '이벤트 정확 일치 필터 (복수는 쉼표)')
  .option('--since <t>', '시작 시각 (30s|15m|2h|7d 상대 또는 ISO)')
  .option('--min-samples <n>', '판정 최소 표본 수 (기본 50)')
  .option('--test', 'cwd 레포의 격리 테스트 인스턴스(.elanous-test/)')
  .option('--instance <name>', '레지스트리 등록 인스턴스 (prod|test:<repo>|…)')
  .option('--all', '등록된 모든 로그 인스턴스를 연합 조회')
  .option('--include-test', '--all 연합에 격리 test 인스턴스 포함')
  .action(async (o: import('./logs-degenerate.js').LogsDegenerateOpts, cmd: { optsWithGlobals(): Record<string, unknown> }) => {
    const merged = { ...cmd.optsWithGlobals(), ...o } as import('./logs-degenerate.js').LogsDegenerateOpts;
    const { runLogsDegenerate } = await import('./logs-degenerate.js');
    process.exit(runLogsDegenerate(merged));
  });

logsCmd.command('fields')
  .description('모든 최상위 data 필드의 존재 행 수·이벤트 전체 행 수·관측 기간을 NDJSON으로 조회')
  .option('--category <prefix>', '카테고리 접두 필터 (복수는 쉼표)')
  .option('--exact-category <category>', '카테고리 정확 일치 필터 (복수는 쉼표)')
  .option('--event <event>', '이벤트 정확 일치 필터 (복수는 쉼표)')
  .option('--since <t>', '시작 시각 (30s|15m|2h|7d 상대 또는 ISO)')
  .option('--limit <n>', '최대 수집 행 수 (상한 도달 시 firstSeen은 창 안에서 처음)')
  .option('--values [n]', '필드별 최빈 primitive 값 분포 (기본 10개)')
  .option('--test', 'cwd 레포의 격리 테스트 인스턴스(.elanous-test/)')
  .option('--instance <name>', '레지스트리 등록 인스턴스 (prod|test:<repo>|…)')
  .option('--all', '등록된 모든 로그 인스턴스를 연합 조회')
  .option('--include-test', '--all 연합에 격리 test 인스턴스 포함')
  .action(async (o: import('./logs-fields.js').LogsFieldsOpts, cmd: { optsWithGlobals(): Record<string, unknown> }) => {
    const merged = { ...cmd.optsWithGlobals(), ...o } as import('./logs-fields.js').LogsFieldsOpts;
    const { runLogsFields } = await import('./logs-fields.js');
    process.exit(runLogsFields(merged));
  });

logsCmd.command('unclosed')
  .description('시작만 있고 종료가 없는 작업을 나이순으로 — 행(hang) 후보. ⛔ 임계값을 정하지 않는다(자르는 선은 --older-than 으로 읽는 쪽이 고른다)')
  .option('--since <t>', '스캔 창 (30s|15m|2h|7d · 기본 24h)')
  .option('--older-than <t>', '이 나이 이상만 (동일 문법 · 미지정 시 전부)')
  .option('--json', 'JSON Lines 출력')
  .option('--test', 'cwd 레포의 격리 테스트 인스턴스(.elanous-test/)')
  .option('--instance <name>', '레지스트리 등록 인스턴스 (prod|test:<repo>|…)')
  .action(async (o: import('./logs-unclosed.js').LogsUnclosedOpts, cmd: { optsWithGlobals(): Record<string, unknown> }) => {
    const merged = { ...cmd.optsWithGlobals(), ...o } as import('./logs-unclosed.js').LogsUnclosedOpts;
    const { runLogsUnclosed } = await import('./logs-unclosed.js');
    process.exit(runLogsUnclosed(merged));
  });

logsCmd.command('abandoned-draft-prs')
  .description('중단 산출 draft PR 중 salvage 판정이 안 붙은 것을 세고 이름을 댄다 (읽기 전용 · 닫기/라벨/코멘트 없음)')
  .option('--json', '구조화 JSON 출력')
  .option('--store-names', '사람 산출에 본 스토어 이름을 전부 나열 (기본은 수·상한·못 읽은 수만)')
  .option('--lookup-merged', '같은 골의 병합된 PR 을 GitHub 에서 조회해 superseded 를 이름으로 댄다 (기본은 오프라인)')
  .option('--lookup-current-status', '각 draft PR의 현재 병합·닫힘·열림 상태를 GitHub 에서 조회한다 (기본은 오프라인 · 읽기 전용)')
  .option('--count-domain-gap', '열린 draft PR 전체를 GitHub에서 조회해 이 보고서가 못 이은 수를 낸다 (기본은 오프라인 · 읽기 전용)')
  .option('--run-lineage', '같은 런 원장에서 draft 뒤 병합된 PR 번호를 이름으로 댄다 (로컬 원장 읽기 전용)')
  .option('--limit <n>', '전역 최대 수집 행 수 (스토어 합산, 상한 도달 여부를 산출에 표시)')
  .option('--since <t>', '시작 시각 (30s|15m|2h|7d 상대 또는 ISO)')
  .option('--test', 'cwd 레포의 격리 테스트 인스턴스(.elanous-test/)')
  .option('--instance <name>', '레지스트리 등록 인스턴스 (prod|test:<repo>|…)')
  .option('--all', '등록된 모든 로그 인스턴스를 연합 조회')
  .option('--include-test', '--all 연합에 격리 test 인스턴스 포함')
  .action(async (o: import('./logs-abandoned-draft-prs.js').LogsAbandonedDraftPrsOpts, cmd: { optsWithGlobals(): Record<string, unknown> }) => {
    const merged = { ...cmd.optsWithGlobals(), ...o } as import('./logs-abandoned-draft-prs.js').LogsAbandonedDraftPrsOpts;
    const { runLogsAbandonedDraftPrs } = await import('./logs-abandoned-draft-prs.js');
    process.exit(runLogsAbandonedDraftPrs(merged));
  });


}
