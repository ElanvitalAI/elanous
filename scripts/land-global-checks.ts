#!/usr/bin/env bun
// LAND-GLOBAL-CHECKS — 착지 게이트가 «전역 검사»를 바뀐 파일로 끌어온다.
//
// `pr land` 는 바뀐 파일만 본다. 그런데 저장소 전체를 훑는 정적 시험(전역 검사)은 «그 시험 파일»이
// 안 바뀌면 착지에서 한 번도 안 돈다 — 0.2.19 회귀 9 중 넷이 이 꼴이었다
// (hook-order-sweep #24719 · next.md B11 #24688 · machines 생성 Markdown #24729 · harness 하위 명령 목록 #24661).
//
// ⭐ 표는 «여기 한 곳»이다(경로 꼴 → 시험). 새 전역 검사를 붙이려면 이 표에 줄을 더한다.
// 재는 명령: `bun scripts/land-global-checks.ts` (표) · `bun scripts/land-global-checks.ts <바뀐 파일…>` (끌려오는 시험)

import { spawnSync } from 'node:child_process';

type LandGlobalCheck = {
  /** 바뀐 파일 경로(저장소 루트 기준 · `/` 구분)에 대는 꼴. */
  pattern: RegExp;
  /** 끌려오는 전역 시험 파일. */
  test: string;
  /** 왜 이 꼴이 이 시험을 부르나 — 회귀 근거. */
  why: string;
};

export const LAND_GLOBAL_CHECKS: readonly LandGlobalCheck[] = [
  { pattern: /^apps\/pwa\/.+\.tsx$/, test: 'test/hook-order-sweep.test.ts', why: 'PWA 컴포넌트 훅 순서(#24719)' },
  { pattern: /^release\/next\.md$/, test: 'scripts/release-story/draft.test.ts', why: '판 노트 초안·브랜드 규칙(#24688)' },
  { pattern: /^docs\/ops\/machines\.yaml$/, test: 'test/machines-ledger-data.test.ts', why: '기계 원장 데이터 ↔ 생성 Markdown(#24729)' },
  // 새 CLI 하위 명령은 `src/index.ts` 또는 `src/cli/` 의 등록 모듈에서 생긴다 — 입구 목록 시험(#24661).
  { pattern: /^src\/(?:index|cli\/(?:[^/]+\/)*[^/]+)(?<!\.test)\.ts$/, test: 'src/index.test.ts', why: 'CLI 입구·하위 명령 목록(#24661)' },
];

/** 바뀐 파일 → 끌려오는 전역 시험(표 순서 · 중복 없음). */
export function landGlobalChecks(changedFiles: readonly string[], table: readonly LandGlobalCheck[] = LAND_GLOBAL_CHECKS): string[] {
  const tests: string[] = [];
  for (const { pattern, test } of table) {
    if (!tests.includes(test) && changedFiles.some((file) => pattern.test(file.replace(/\\/g, '/')))) tests.push(test);
  }
  return tests;
}

export type LandGlobalChecksRun = { status: number | null; output: string; error?: string };

type LandGlobalChecksGateIo = {
  changedFiles: readonly string[];
  cwd: string;
  log: (message: string) => void;
  error: (message: string) => void;
  /** 시험 주입용 — 기본은 결정적 러너(`scripts/test-deterministic.ts`)로 끌려온 시험만 돌린다. */
  runTests?: (tests: readonly string[], cwd: string) => LandGlobalChecksRun;
};

function runDeterministic(tests: readonly string[], cwd: string): LandGlobalChecksRun {
  const r = spawnSync('bun', ['run', 'scripts/test-deterministic.ts', ...tests], {
    cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60_000,
  });
  return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`, ...(r.error ? { error: r.error.message } : {}) };
}

/**
 * 반환: true = 해당 없음 또는 끌려온 시험 통과 · false = 끌려온 시험이 실패했다(착지를 막는다).
 * ⛔ 러너가 «못 돌았다»(spawn 실패·시간 초과)면 던진다 — 호출부(`gateVerdict`)가 「검사 못 함」으로 말한다.
 */
export function runLandGlobalChecksGate(io: LandGlobalChecksGateIo): boolean {
  const tests = landGlobalChecks(io.changedFiles);
  if (tests.length === 0) {
    io.log(`[land-global-checks] 해당 없음 — 바뀐 파일 ${io.changedFiles.length}개가 전역 검사 표(${LAND_GLOBAL_CHECKS.length}줄)의 꼴에 안 걸린다.`);
    return true;
  }
  io.log(`[land-global-checks] 전역 검사 ${tests.length}개를 끌어온다: ${tests.join(' · ')}`);
  const result = (io.runTests ?? runDeterministic)(tests, io.cwd);
  if (result.error !== undefined || result.status === null) {
    throw new Error(`전역 검사 러너가 못 돌았다 — ${result.error ?? 'status=null'}`);
  }
  if (result.status !== 0) {
    const tail = result.output.split('\n').filter((line) => /\(fail\)|^\s*\d+ (pass|fail)|^Ran /.test(line)).slice(-12);
    for (const line of tail) io.error(`[land-global-checks] ${line.trim()}`);
    return false;
  }
  return true;
}

if (import.meta.main) {
  const changed = process.argv.slice(2);
  if (changed.length === 0) {
    console.log(`전역 검사 표 ${LAND_GLOBAL_CHECKS.length}줄`);
    for (const row of LAND_GLOBAL_CHECKS) console.log(`${row.pattern.source} → ${row.test} · ${row.why}`);
  } else {
    const tests = landGlobalChecks(changed);
    console.log(`끌려오는 전역 시험 ${tests.length}개${tests.length ? `: ${tests.join(' · ')}` : ''}`);
  }
}
