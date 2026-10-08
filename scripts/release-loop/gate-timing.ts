// F5 GATE-TIMING-REPORT — 게이트 한 판의 «시간 비용»을 보이게 한다(GATE-SPEED 의 자).
// 입력 = 게이트 로그 디렉토리(`<ledger>/release/<version>/gate-logs/cut`)의 `pod-*.json`.
//   첫 판 샤드 = `pod-<n>.json` · 재시도 = 그 밖의 모든 `pod-*.json`(`-c<k>`·`-c<k>-file-<m>`·`-retry` …).
// ⛔ 측정이 없으면 `measured:false` 로 표시한다 — 0 을 «잰 값»처럼 내지 않는다.
// ⭐ 기본 = 전 우주(LOGS-DEFAULT-ALL · 0.2.20) — 게이트는 실행 트리의 시험 우주(예: ⟨test:wt-release⟩
//   `<tree>/.elanous-test/release/<v>/gate-logs/cut`)에 쌓인다. 운영 원장만 보면 0.2.19 판처럼
//   «측정 없음»으로 오판한다. 그래서 버전 인자는 운영 원장 ⊕ 등록된 모든 우주(시험·파생 시험 포함)를
//   본다 — 우주 열거는 `eln logs --all --include-test` 와 같은 레지스트리(`readLogInstanceScope`)다.
//   좁히기는 opt-in `--prod-only`(종전 동작: `releaseLedgerRoot()` 하나).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { releaseLedgerRoot } from '../../src/instance/resolve.js';
import { readLogInstanceScope } from '../../src/mss/logging/instance-registry.js';

export interface ShardTiming { name: string; min: number; files: number; plannedMin: number | null }

export interface GateTimingReport {
  dir: string;
  /** 읽은 pod-*.json 중 durationMs 를 가진 것이 하나라도 있었나. false 면 아래 수는 «측정 없음». */
  measured: boolean;
  /** JSON 파싱 실패·durationMs 부재로 건너뛴 파일 이름. */
  unreadable: string[];
  firstPass: { shards: number; sumMin: number; medianMin: number; maxMin: number; failedShards: string[] };
  retries: { runs: number; sumMin: number; medianMin: number };
  /** 재시도 합 / (첫 판 합 + 재시도 합). 측정이 없으면 null. */
  retryShare: number | null;
  slowestShards: ShardTiming[];
}

const FIRST_PASS = /^pod-\d+\.json$/;
const POD_JSON = /^pod-.+\.json$/;

const round1 = (n: number) => Math.round(n * 10) / 10;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

interface PodRecord { durationMs?: unknown; rc?: unknown; files?: unknown; plannedSeconds?: unknown; jobFailed?: unknown }

export function gateTiming(dir: string): GateTimingReport {
  const names = existsSync(dir) && statSync(dir).isDirectory()
    ? readdirSync(dir).filter((n) => POD_JSON.test(n)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    : [];
  const first: Array<ShardTiming & { failed: boolean }> = [];
  const retryMin: number[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    let rec: PodRecord;
    try { rec = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PodRecord; } catch { unreadable.push(name); continue; }
    if (!rec || typeof rec !== 'object' || typeof rec.durationMs !== 'number' || !Number.isFinite(rec.durationMs)) { unreadable.push(name); continue; }
    const min = rec.durationMs / 60_000;
    if (FIRST_PASS.test(name)) {
      first.push({
        name: name.replace(/\.json$/, ''),
        min,
        files: Array.isArray(rec.files) ? rec.files.length : 0,
        plannedMin: typeof rec.plannedSeconds === 'number' ? rec.plannedSeconds / 60 : null,
        failed: rec.jobFailed === true || (typeof rec.rc === 'number' && rec.rc !== 0),
      });
    } else {
      retryMin.push(min);
    }
  }
  const firstMins = first.map((s) => s.min);
  const firstSum = firstMins.reduce((a, b) => a + b, 0);
  const retrySum = retryMin.reduce((a, b) => a + b, 0);
  const total = firstSum + retrySum;
  const measured = first.length + retryMin.length > 0;
  return {
    dir,
    measured,
    unreadable,
    firstPass: {
      shards: first.length,
      sumMin: round1(firstSum),
      medianMin: round1(median(firstMins)),
      maxMin: round1(firstMins.length ? Math.max(...firstMins) : 0),
      failedShards: first.filter((s) => s.failed).map((s) => s.name),
    },
    retries: { runs: retryMin.length, sumMin: round1(retrySum), medianMin: round1(median(retryMin)) },
    retryShare: measured && total > 0 ? Math.round((retrySum / total) * 1000) / 1000 : null,
    slowestShards: [...first].sort((a, b) => b.min - a.min).slice(0, 5)
      .map(({ name, min, files, plannedMin }) => ({ name, min: round1(min), files, plannedMin: plannedMin === null ? null : round1(plannedMin) })),
  };
}

/** 인자가 버전이 아니라 디렉토리인가 — 경로처럼 보이거나 실제로 있으면. */
export function isGateLogDirArg(arg: string): boolean {
  return arg.includes('/') || arg.startsWith('.') || existsSync(arg);
}

/** `<version>` 이면 원장 루트(`releaseLedgerRoot()`)의 `release/<version>/gate-logs/cut`, 경로처럼 보이면 그대로. */
export function resolveGateLogDir(arg: string, ledgerRoot: string = releaseLedgerRoot()): string {
  if (isGateLogDirArg(arg)) return arg;
  return join(ledgerRoot, 'release', arg, 'gate-logs', 'cut');
}

export interface GateLogCandidate { universe: string; dir: string }

export interface GateLogScope {
  /** 본 후보 원장 루트 수(물리 경로 dedup 뒤). */
  roots: number;
  /** 우주 레지스트리 — `read` 읽음 · `unreadable` 못 읽음(«등록 우주 0»이 아니라 «못 셈» — 운영 원장만 봤다)
   *  · `skipped` `--prod-only` 라 안 읽음. */
  registry: 'read' | 'unreadable' | 'skipped';
  /** `--prod-only` 로 좁혔나. */
  prodOnly: boolean;
}

export interface GateLogScopeDeps {
  ledgerRoot?: string;
  readInstances?: () => { instances: ReadonlyArray<{ name: string; stateDir: string }>; queryStatus: { registeredStores: boolean } };
}

function physical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/** 버전의 게이트 로그 후보 — 운영 원장 루트(`releaseLedgerRoot()`) ⊕ 등록된 모든 우주.
 *  물리 경로로 dedup 한다(`~/.monad` → `~/.elanous` 심링크가 같은 판을 두 번 세지 않게). */
export function gateLogCandidates(
  version: string,
  opts: { prodOnly?: boolean } = {},
  deps: GateLogScopeDeps = {},
): { candidates: GateLogCandidate[]; scope: GateLogScope } {
  const primary = deps.ledgerRoot ?? releaseLedgerRoot();
  const roots: Array<{ universe: string; root: string }> = [{ universe: 'prod', root: primary }];
  let registry: GateLogScope['registry'] = 'skipped';
  if (!opts.prodOnly) {
    const scope = (deps.readInstances ?? readLogInstanceScope)();
    registry = scope.queryStatus.registeredStores ? 'read' : 'unreadable';
    // 못 읽은 판의 부분 목록은 쓰지 않는다 — «운영만 봤다»는 표시와 실제 본 범위를 일치시킨다.
    if (registry === 'read') for (const instance of scope.instances) roots.push({ universe: instance.name, root: instance.stateDir });
  }
  const seen = new Set<string>();
  const candidates: GateLogCandidate[] = [];
  for (const { universe, root } of roots) {
    const key = physical(root);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ universe, dir: resolveGateLogDir(version, root) });
  }
  return { candidates, scope: { roots: candidates.length, registry, prodOnly: opts.prodOnly === true } };
}

export interface GateTimingScan {
  version: string;
  scope: GateLogScope & { found: number };
  /** pod-*.json 디렉토리가 «있는» 우주만 — 판마다 따로 낸다(서로 다른 판의 샤드를 섞지 않는다). */
  reports: Array<GateTimingReport & { universe: string }>;
}

/** 버전 인자의 기본 동선 — 후보 우주 전부에서 게이트 로그 디렉토리가 있는 것만 보고한다. */
export function scanGateTiming(version: string, opts: { prodOnly?: boolean } = {}, deps: GateLogScopeDeps = {}): GateTimingScan {
  const { candidates, scope } = gateLogCandidates(version, opts, deps);
  const reports = candidates
    .filter(({ dir }) => existsSync(dir) && statSync(dir).isDirectory())
    .map(({ universe, dir }) => ({ universe, ...gateTiming(dir) }));
  return { version, scope: { ...scope, found: reports.length }, reports };
}

export function formatGateTimingScan(scan: GateTimingScan): string {
  const s = scan.scope;
  const head = `게이트 로그 ${scan.version} — ${s.prodOnly ? '운영 원장만(--prod-only)' : '전 우주'} · 본 원장 루트 ${s.roots}개 · 로그 있는 우주 ${s.found}개`
    + (s.registry === 'unreadable' ? ' · ⚠ 우주 레지스트리를 못 읽었다(운영만 봤다 — «없다»가 아니라 «못 셈»)' : '');
  if (scan.reports.length === 0) {
    const where = s.registry === 'read' ? '본 우주 어디에도' : '운영 원장에';
    const unknown = s.registry === 'unreadable' ? ' · 시험 우주는 못 셌다(있을 수 있다)' : '';
    return [head, `  게이트 시간 — 측정 없음 · ${where} release/${scan.version}/gate-logs/cut 가 없다${unknown}`,
      ...(s.prodOnly ? ['  (--prod-only 를 빼면 시험 우주까지 본다)'] : [])].join('\n');
  }
  return [head, ...scan.reports.map((r) => `⟨${r.universe}⟩ ${formatGateTiming(r)}`)].join('\n');
}

export function formatGateTiming(r: GateTimingReport): string {
  if (!r.measured) {
    return [`게이트 시간 — 측정 없음 (${r.dir})`, '  pod-*.json 에 durationMs 가 하나도 없다 · 0 은 «잰 값»이 아니다',
      ...(r.unreadable.length ? [`  읽지 못한 파일 ${r.unreadable.length}개`] : [])].join('\n');
  }
  const f = r.firstPass;
  const lines = [
    `게이트 시간 (${r.dir})`,
    `  첫 판   샤드 ${f.shards}개 · 합 ${f.sumMin}분 · 중앙 ${f.medianMin}분 · 최대 ${f.maxMin}분 · 실패 샤드 ${f.failedShards.length}개${f.failedShards.length ? ` (${f.failedShards.join(', ')})` : ''}`,
    `  재시도  ${r.retries.runs}회 · 합 ${r.retries.sumMin}분 · 중앙 ${r.retries.medianMin}분`,
    `  재시도 비중 ${r.retryShare === null ? '측정 없음' : `${round1(r.retryShare * 100)}%`} (재시도 합 / 전체 합)`,
    '  느린 샤드 상위 5:',
    ...r.slowestShards.map((s) => `    ${s.name}  ${s.min}분 · 파일 ${s.files}개 · 계획 ${s.plannedMin === null ? '—' : `${s.plannedMin}분`}`),
  ];
  if (r.unreadable.length) lines.push(`  ⚠ 읽지 못한 파일 ${r.unreadable.length}개: ${r.unreadable.slice(0, 5).join(', ')}${r.unreadable.length > 5 ? ' …' : ''}`);
  return lines.join('\n');
}

export const GATE_TIMING_USAGE = [
  '기본 = 전 우주 — 운영 원장 ⊕ 시험 우주(⟨test:wt-release⟩ 등)의 게이트 로그를 옵션 없이 함께 읽는다',
  '사용법: bun scripts/release-loop/gate-timing.ts <version|dir> [--json] [--prod-only]',
  '  <version>    등록된 모든 우주의 release/<version>/gate-logs/cut 를 우주마다 따로 보고한다(⟨우주⟩ 태그)',
  '  <dir>        그 디렉토리 하나만 (종전과 같은 단일 보고)',
  '  --prod-only  운영 원장 루트(releaseLedgerRoot)만 본다 — 종전 기본',
  '  --json       구조화 출력 (<version> 이면 { version, scope, reports[] })',
].join('\n');

const KNOWN_FLAGS = new Set(['--json', '--prod-only', '--help', '-h']);

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(GATE_TIMING_USAGE); process.exit(0); }
  const unknown = args.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
  if (unknown.length) { console.error(`알 수 없는 옵션: ${unknown.join(' ')}\n${GATE_TIMING_USAGE}`); process.exit(2); }
  const json = args.includes('--json');
  const prodOnly = args.includes('--prod-only');
  const target = args.find((a) => !a.startsWith('-'));
  if (!target) {
    console.error(GATE_TIMING_USAGE);
    process.exit(2);
  }
  if (isGateLogDirArg(target)) {
    const report = gateTiming(target);
    console.log(json ? JSON.stringify(report, null, 2) : formatGateTiming(report));
    if (!report.measured) process.exit(1);
  } else {
    const scan = scanGateTiming(target, { prodOnly });
    console.log(json ? JSON.stringify(scan, null, 2) : formatGateTimingScan(scan));
    if (!scan.reports.some((r) => r.measured)) process.exit(1);
  }
}
