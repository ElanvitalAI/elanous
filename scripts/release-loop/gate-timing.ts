// F5 GATE-TIMING-REPORT — 게이트 한 판의 «시간 비용»을 보이게 한다(GATE-SPEED 의 자).
// 입력 = 게이트 로그 디렉토리(`<ledger>/release/<version>/gate-logs/cut`)의 `pod-*.json`.
//   첫 판 샤드 = `pod-<n>.json` · 재시도 = 그 밖의 모든 `pod-*.json`(`-c<k>`·`-c<k>-file-<m>`·`-retry` …).
// ⛔ 측정이 없으면 `measured:false` 로 표시한다 — 0 을 «잰 값»처럼 내지 않는다.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { releaseLedgerRoot } from '../../src/instance/resolve.js';

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

/** `<version>` 이면 원장 루트(`releaseLedgerRoot()`)의 `release/<version>/gate-logs/cut`, 경로처럼 보이면 그대로. */
export function resolveGateLogDir(arg: string, ledgerRoot: string = releaseLedgerRoot()): string {
  if (arg.includes('/') || arg.startsWith('.') || existsSync(arg)) return arg;
  return join(ledgerRoot, 'release', arg, 'gate-logs', 'cut');
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('사용법: bun scripts/release-loop/gate-timing.ts <version|dir> [--json]');
    process.exit(2);
  }
  const report = gateTiming(resolveGateLogDir(target));
  console.log(json ? JSON.stringify(report, null, 2) : formatGateTiming(report));
  if (!report.measured) process.exit(1);
}
