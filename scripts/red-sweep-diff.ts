#!/usr/bin/env bun
/**
 * 파일별 빨강 스윕(`scripts/contract-red-sweep.ts`)의 «같은 범위» 최근 두 판을 비교해 «새 빨강»과 «회복»만 낸다.
 * 로드맵 4번(2026-09-24) — 전 스위트 기준선 ⊕ 야간 스윕 ⊕ «새 빨강만 알림». CI 가 없어 이 저장소에서 빨강이 이틀씩 조용히 산다.
 *
 *   bun scripts/red-sweep-diff.ts [--log <파일>] [--json] [--notify]
 *     --log     스윕 로그(줄마다 JSON 보고 · 기본 /tmp/contract-red-sweep.log)
 *     --notify  새 빨강이 있으면 기존 발송 경로(`sendOutbound`)로 한 번 알린다
 * 종료 코드: 0 = 비교함(새 빨강 유무와 무관) · 2 = 같은 범위 두 판이 없어 «못 쟀다»
 */
import { existsSync, readFileSync } from 'node:fs';

export interface SweepReport { createdAt: string; scope: { axes: string[] }; files: Array<{ file: string; status: string }> }
export interface SweepDiff { scope: string; previousAt: string; latestAt: string; newRed: string[]; recovered: string[]; stillRed: number }

export function parseSweepLog(text: string): SweepReport[] {
  const out: SweepReport[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const r = JSON.parse(t) as Partial<SweepReport>;
      if (typeof r.createdAt === 'string' && Array.isArray(r.scope?.axes) && Array.isArray(r.files)) out.push(r as SweepReport);
    } catch { /* 보고가 아닌 줄 */ }
  }
  return out;
}

const scopeKey = (r: SweepReport) => [...r.scope.axes].sort().join(' ');
const redSet = (r: SweepReport) => new Set(r.files.filter((f) => f.status === 'red').map((f) => f.file));

/** 범위마다 최근 두 판 비교. 두 판이 안 되는 범위는 뺀다. */
export function diffLatestPerScope(reports: readonly SweepReport[]): SweepDiff[] {
  const byScope = new Map<string, SweepReport[]>();
  for (const r of reports) byScope.set(scopeKey(r), [...(byScope.get(scopeKey(r)) ?? []), r]);
  const out: SweepDiff[] = [];
  for (const [scope, list] of byScope) {
    const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (sorted.length < 2) continue;
    const prev = sorted[sorted.length - 2]!;
    const last = sorted[sorted.length - 1]!;
    const before = redSet(prev);
    const now = redSet(last);
    out.push({
      scope, previousAt: prev.createdAt, latestAt: last.createdAt,
      newRed: [...now].filter((f) => !before.has(f)).sort(),
      recovered: [...before].filter((f) => !now.has(f)).sort(),
      stillRed: [...now].filter((f) => before.has(f)).length,
    });
  }
  return out;
}

export function renderDiff(d: SweepDiff): string {
  const short = (f: string) => f.replace(/^.*?\/monad-agent\//, '');
  return [
    `[red-sweep-diff] 범위 ${d.scope} · ${d.previousAt} → ${d.latestAt}: 새 빨강 ${d.newRed.length} · 회복 ${d.recovered.length} · 그대로 빨강 ${d.stillRed}`,
    ...d.newRed.map((f) => `  🔴 새로: ${short(f)}`),
    ...d.recovered.map((f) => `  🟢 회복: ${short(f)}`),
  ].join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf('--log');
  const log = at >= 0 ? argv[at + 1] ?? '' : '/tmp/contract-red-sweep.log';
  const reports = existsSync(log) ? parseSweepLog(readFileSync(log, 'utf8')) : [];
  const diffs = diffLatestPerScope(reports);
  if (argv.includes('--json')) console.log(JSON.stringify({ log, reports: reports.length, diffs }));
  else if (diffs.length === 0) console.log(`[red-sweep-diff] 못 쟀다 — 같은 범위의 보고가 두 판 이상 없다(${log} · 보고 ${reports.length})`);
  else for (const d of diffs) console.log(renderDiff(d));
  const grown = diffs.filter((d) => d.newRed.length > 0);
  if (argv.includes('--notify') && grown.length > 0) {
    const { sendOutbound } = await import('../src/domains/outbound-alert.js');
    sendOutbound(`⚠️ **파일별 빨강 스윕 — 새 빨강**\n\n${grown.map(renderDiff).join('\n\n')}`, 'ops-alert');
  }
  return diffs.length === 0 ? 2 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
