// ELS-PRODUCT-SPLIT 경계 가드 — 대표 2026-11-18 «사이드탭 제품 분리».
// els = 바깥 액자(에이전트 무관), eln = 세션·턴·도구·기억·그래프 코어 하나. 경계는 프로세스·프로토콜(소켓)이지
// 코드 import 가 아니다 — 그래서 코드 import 는 양쪽 다 늘지 않게 단속한다(정본 내부 문서 `SIDETAB-ONE-SPACE`
// «지금의 경계» 절 · 래칫: 줄어들기만 허용).
//
// 방향 1 (els→eln): src/els/** 는 eln 코어 실행 모듈을 런타임 import 하지 않는다(목표 = 0).
//   경계를 넘는 것은 소켓 프로토콜의 상태·알림 이벤트뿐이다(child-producer 의 `child` op).
//   타입 공유(import type)는 같은 저장소·같은 열차 안에서 허용한다.
// 방향 2 (eln→els): src/els/** 를 src/els 밖에서 import 하는 비-시험 파일은 기준선(아래 표)에서
//   늘지 않는다 — «새 import 는 만들지 않는다»(import type 도 새 import 다). 시험 배선(.test.ts)은 제외.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanImports, walkSources } from './boundary-scan.js';

const repoRoot = join(import.meta.dir, '..', '..');
const elsDir = join(repoRoot, 'src', 'els');

// eln 코어(세션·턴·도구·기억·그래프·에이전트 두뇌) — 상대 import 경로의 디렉터리/파일 세그먼트.
const CORE_SEGMENTS = [
  'agent', // 에이전트 두뇌·하위 에이전트 실행 (src/agents/ 아님 — 세그먼트 정확 매치)
  'core-turn', 'execution-loop', 'turn-checkpoint', // 턴
  'session', 'session-store', 'session-runtime', // 세션
  'llm', // 모델 호출
  'skills', 'tool-runtime', 'tool-router', // 도구
  'memory', 'memory-triage', 'seat-memory', 'knowledge', 'knowhow', // 기억
  'graph-runner', 'graph-unify', 'graph-v2', 'graph-kinds', 'graph-view', 'graph-wizard', // 그래프
] as const;

// 방향 2 기준선 — 2026-11-21 main 실측(11-18 4개 + 그 뒤 main 에 들어온 9개). 줄어들기만 허용(빠지면 이 표를 줄여 갱신).
const ELN_TO_ELS_BASELINE = new Set([
  'src/cli/els-cli.ts', // els 제품 자신의 CLI 진입
  'src/dashboard/index.ts',
  'src/tui/sidetab/els-rows.ts', // 칸 1 교량: eln --side 가 els 를 구독
  'src/tui/sidetab/els-subscribe.ts',
  // 11-18 뒤 main 에 들어온 els 로의 import — 새로 늘리지 않는다. 출처: 파일:줄 · 유입 PR.
  'src/acp/els-acp-serve.ts', // :11 ../els/mcp-serve.js · #38829
  'src/boot/daemon-tools/index.ts', // :25 els-control-tool.js · #39087
  'src/cli/hosts-cli.ts', // :2 els/build-badge.js · #39165
  'src/loops/msg-wake.ts', // :32,33 els/client.js · els/server.js · #39012
  'src/nexus/worker-registry/store.ts', // :10 els/hosts.js · #39073
  'src/prompt-library/universal-preamble.ts', // :36 els/els-self-context.js · #39105
  'src/tui/els-handoff.ts', // :10-13 els/client.js 외 3 · #39329
  'src/tui/entry.ts', // :794 graph-producer.js · #39320 / :965 build-reporter.js · #38986 (동적 import)
  'src/tui/sidetab/els-actions.ts', // :5 import type els/core.js · #38431
]);

// ⚠ ELS-PRODUCT-SPLIT 칸은 두 기준선이 0 이 되기 전까지 🟡 — 이 가드 착지 ≠ 칸 완료.
// 두 기준선 모두 제거 칸 = ELS-ELN-BOUNDARY-BASELINE-ZERO (0.3.32 P1). 현재 10건 동결 · 새 결합 0 · 줄어들기만.
// 출처 = 2026-11-21 origin/main 의 파일:줄 + 유입 PR(git log -S 실측).
// 방향 1 기준선 — 목표 = 0. 해소되면 이 표를 줄여 갱신.
// 출처: src/els/server.ts:162,252 · #39311 ELS-PTY-RECORD — els 서버가 PTY 녹화 런타임을 직접 require. 프로토콜 호출로 바꿔 끊을 대상.
const ELS_TO_ELN_BASELINE = new Set([
  "src/els/server.ts: eln 코어 런타임 import '../tool-runtime/pty-recording-runtimes.js'",
]);

const isCoreSpecifier = (spec: string): boolean => {
  if (!spec.startsWith('..')) return false;
  const path = spec.replace(/\.(js|ts)$/, '');
  for (const segment of CORE_SEGMENTS) {
    if (path.includes(`../${segment}/`) || path.endsWith(`../${segment}`)) return true;
  }
  return false;
};

const rel = (file: string) => relative(repoRoot, file);

test('방향 1 — src/els 는 eln 코어를 런타임 import 하지 않는다 (경계 = 프로토콜)', () => {
  const violations: string[] = [];
  for (const file of walkSources(elsDir)) {
    if (/\.test\.tsx?$/.test(file)) continue; // 시험 배선은 검증용 — 대상 아님
    for (const { spec, typeOnly } of scanImports(readFileSync(file, 'utf8'))) {
      if (typeOnly) continue; // 타입 공유는 허용
      if (isCoreSpecifier(spec)) violations.push(`${rel(file)}: eln 코어 런타임 import '${spec}'`);
    }
  }
  const fresh = [...new Set(violations)].filter((v) => !ELS_TO_ELN_BASELINE.has(v));
  expect(fresh).toEqual([]);
});

test('방향 2 — src/els 를 밖에서 import 하는 파일은 기준선에서 늘지 않는다 (줄어들기만)', () => {
  const importers = new Set<string>();
  for (const file of walkSources(join(repoRoot, 'src'))) {
    if (/\.test\.tsx?$/.test(file) || file.startsWith(elsDir)) continue;
    for (const { spec } of scanImports(readFileSync(file, 'utf8'))) {
      // ../els/… · ../../els/… — 상대 경로로 src/els 안 모듈을 가리키는 지정자(타입 import 포함).
      if (/^(\.\.\/)+els(\/|$)/.test(spec)) importers.add(rel(file));
    }
  }
  const fresh = [...importers].filter((f) => !ELN_TO_ELS_BASELINE.has(f));
  expect(
    fresh,
    fresh.length
      ? `src/els 로의 새 import 금지(동결 — 새 액자 기능은 els 칸으로): ${fresh.join(', ')}`
      : `기준선: ${[...importers].sort().join(', ')}`,
  ).toEqual([]);
  for (const baseline of ELN_TO_ELS_BASELINE) {
    // 기준선보다 줄었다면: 표를 줄여 갱신(래칫은 줄어들기만 허용).
    if (!importers.has(baseline)) console.warn(`[boundary] 기준선 ${baseline} 이(가) 사라졌다 — ELN_TO_ELS_BASELINE 을 줄여 갱신하라`);
  }
});
