#!/usr/bin/env bun
/**
 * 게이트 조각 junit(`gate-logs/<cut|baseline>/pod-*.junit.xml`)에서 파일별 소요를 모은다 — K10 D4 «느린 시험 목록»의 자.
 * 같은 파일이 여러 번 돌았으면(반쪼개기·격리) 가장 적은 파일과 함께 돈 기록을 쓴다 — 혼자 돈 값이 그 파일의 값에 가장 가깝다.
 *
 *   bun scripts/release-loop/test-durations.ts <gate-logs/cut 디렉터리> [--top 5] [--json]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type FileDuration = { file: string; seconds: number; tests: number; runFiles: number };

/** junit 한 벌에서 `<testsuite file=… time=… tests=…>` 를 읽는다. */
export function parseJunitSuites(xml: string): Array<{ file: string; seconds: number; tests: number }> {
  const suites: Array<{ file: string; seconds: number; tests: number }> = [];
  for (const match of xml.matchAll(/<testsuite\b([^>]*)>/g)) {
    const attrs = match[1]!;
    const file = /\bfile="([^"]+)"/.exec(attrs)?.[1];
    const time = Number(/\btime="([^"]+)"/.exec(attrs)?.[1]);
    const tests = Number(/\btests="([^"]+)"/.exec(attrs)?.[1] ?? '0');
    if (file && Number.isFinite(time)) suites.push({ file, seconds: time, tests: Number.isFinite(tests) ? tests : 0 });
  }
  return suites;
}

/** 여러 조각의 junit 을 파일별 하나로 접는다. */
export function collectDurations(reports: string[]): FileDuration[] {
  const best = new Map<string, FileDuration>();
  for (const xml of reports) {
    const suites = parseJunitSuites(xml);
    for (const suite of suites) {
      const current = best.get(suite.file);
      if (!current || suites.length < current.runFiles) best.set(suite.file, { ...suite, runFiles: suites.length });
    }
  }
  return [...best.values()].sort((a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file));
}

/** 상위 `percent`% 파일과 그 몫. */
export function topShare(durations: FileDuration[], percent: number): { files: FileDuration[]; seconds: number; totalSeconds: number; share: number } {
  const count = Math.max(1, Math.ceil(durations.length * percent / 100));
  const files = durations.slice(0, count);
  const seconds = files.reduce((sum, item) => sum + item.seconds, 0);
  const totalSeconds = durations.reduce((sum, item) => sum + item.seconds, 0);
  return { files, seconds, totalSeconds, share: totalSeconds ? seconds / totalSeconds : 0 };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args.find((arg) => !arg.startsWith('--'));
  if (!dir) { console.error('usage: test-durations.ts <gate-logs/cut> [--top 5] [--json]'); process.exit(2); }
  const topIndex = args.indexOf('--top');
  const percent = topIndex >= 0 ? Number(args[topIndex + 1]) : 5;
  const names = readdirSync(dir).filter((name) => name.endsWith('.junit.xml'));
  if (!names.length) { console.error(`no *.junit.xml under ${dir} — was this sweep run before junit reports were kept?`); process.exit(1); }
  const durations = collectDurations(names.map((name) => readFileSync(join(dir, name), 'utf8')));
  const top = topShare(durations, percent);
  if (args.includes('--json')) console.log(JSON.stringify({ reports: names.length, files: durations.length, totalSeconds: top.totalSeconds, topPercent: percent, topSeconds: top.seconds, topShare: top.share, top: top.files }, null, 2));
  else {
    console.log(`reports ${names.length} · files ${durations.length} · total ${top.totalSeconds.toFixed(0)}s · top ${percent}% = ${top.files.length} files · ${top.seconds.toFixed(0)}s (${(top.share * 100).toFixed(1)}%)`);
    for (const item of top.files) console.log(`${item.seconds.toFixed(1)}\t${item.tests}\t${item.file}`);
  }
}
