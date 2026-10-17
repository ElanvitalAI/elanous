import { expect, test } from 'bun:test';
import { classifyPrLandRefusal, observeDirectPrLandRefusal, observePrLandRefusal } from './pr-land-refusal.js';
import { readJourneyEdge } from '../self-dev/graph-journey-route.js';
import { debug } from '../debug/log.js';

// Captured `pr land` refusal lines from #26614, #26968, #27026, #27063, #27081 and #27113.
const cases = [
  ['✗ expected-head: PR OPEN non-draft, matching local HEAD and clean worktree required', { isDraft: true }, 'draft', 'ready'],
  ['✗ branch: PR head branch와 현재 브랜치가 다릅니다.', {}, 'head-branch', 'pr-head-checkout'],
  ['✗ ancestor-auto: ancestor-auto-not-ancestor: 123 is not an ancestor of 456', {}, 'not-ancestor', 'main-sync'],
  ['✗ ancestor-auto: review-not-reviewed', {}, 'review-missing', 'review'],
  ['✗ overlap-evidence: review-path-not-for-this-pr-head', {}, 'review-missing', 'review'],
  ['✗ ancestor-auto: review-must-fix-1', {}, 'other', 'next-move'],
] as const;

for (const [line, context, label, destination] of cases) {
  test(`real refusal ${label} routes to ${destination}`, () => {
    expect(classifyPrLandRefusal(line, context)).toBe(label);
    const route = readJourneyEdge('merge', label);
    expect(route.source).toBe('graph');
    expect(route.on).toBe('refusal');
    expect(route.to).toBe(destination);
  });
}

// Exact first refusal lines captured in OP land logs; duplicate busy lines are distinct attempts.
const observedLandRefusals = [
  ["✗ heavy-remote: 원격 게이트 gate-host-busy — 로컬 게이트로 폴백하지 않는다.", "gate-host-busy", "next-move"], // land-26887-2051.log
  ["✗ heavy-remote: 병합 직전 원격 게이트 gate-host-busy — 로컬 게이트로 폴백하지 않는다.", "gate-host-busy", "next-move"], // land-27267-1907.log
  ["✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: stdout: CONFLICT (content): Merge conflict in scripts/test-deterministic.ts | stdout: Automatic merge failed; fix conflicts and then commit the result. — 로컬 게이트로 폴백하지 않는다.", "gate-merge-conflict", "main-sync"], // land-27271-1843.log
  ["✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: stdout: CONFLICT (content): Merge conflict in src/harness/harness-substrate-default.ts | stdout: Automatic merge failed; fix conflicts and then commit the result. — 로컬 게이트로 폴백하지 않는다.", "gate-merge-conflict", "main-sync"], // land-28060-1735.log
  ["✗ heavy-remote: 원격 게이트 gate-host-busy — 로컬 게이트로 폴백하지 않는다.", "gate-host-busy", "next-move"], // land-28827-2050.log
  ["✗ heavy-remote: 원격 게이트 gate-host-busy — 로컬 게이트로 폴백하지 않는다.", "gate-host-busy", "next-move"], // land-28827-2056.log
  ["✗ heavy-remote: PR base=unreadable ≠ main — 재타기팅된 PR은 통과한 head/main 쌍이 아니다. 병합하지 않는다.", "pr-base-unreadable", "next-move"], // land-28865-2115.log
  ["✗ heavy-remote: PR base=unreadable ≠ main — 재타기팅된 PR은 통과한 head/main 쌍이 아니다. 병합하지 않는다.", "pr-base-unreadable", "next-move"], // land-28876-1947.log
  ["✗ public-export-leak: 바뀐 파일 1곳이 공개본에 사적 흔적을 싣는다 — 다음 release prepare 가 여기서 실패한다:", "public-export-leak", "next-move"], // land-28883-2103.log
  ["✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: stderr: 건드린 src/scripts 파일과 baseline 밖 test 파일은 tsc 클린이어야 합니다(touch-clean). | stderr: [tsc-gate] FAIL — 타입 에러가 있다 (범위·파일·건수는 위 [tsc-gate] FAIL 줄). | stdout: [tsc-gate] PWA env 패스 — 루트 비시험 2개 (Next ProcessEnv 선언 포함). | stdout: [tsc-cache] miss-cold key=1b7fd47da2c1 warmRc=2 coldRc=2 warmGate=FAIL coldGate=FAIL normalized=same — 로컬 게이트로 폴백하지 않는다.", "gate-touch-clean", "next-move"], // land-28888-2104.log
] as const;

for (const [line, label, destination] of observedLandRefusals) {
  test(`captured land refusal ${label} routes to ${destination}: ${line.slice(0, 50)}`, () => {
    expect(classifyPrLandRefusal(line)).toBe(label);
    const route = readJourneyEdge('merge', label);
    expect(route).toMatchObject({ source: 'graph', on: 'refusal', to: destination });
  });
}

test('generic pinned preflight without draft evidence does not claim draft', () => {
  expect(classifyPrLandRefusal(cases[0][0])).toBe('other');
});

test('unmeasured remote gate failure is outside the direct observation sample', () => {
  const line = '✗ heavy-remote: 원격 게이트 gate-rc-1 — 로컬 게이트로 폴백하지 않는다.';
  expect(classifyPrLandRefusal(line)).toBe('other');
  expect(classifyPrLandRefusal('✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: stderr: ssh-down | stdout: CONFLICT (content): Merge conflict in incidental.log | stderr: touch-clean — 로컬 게이트로 폴백하지 않는다.')).toBe('other');
  expect(classifyPrLandRefusal('✗ heavy-remote: 원격 게이트 ssh-down · remote: stderr: 원격 게이트 gate-host-busy — 로컬 게이트로 폴백하지 않는다.')).toBe('other');
  const rows: unknown[] = [];
  const off = debug.registerSink({ name: 'pr-land-unmeasured-refusal-test', emit: (row) => {
    if (row.event === 'graph-edge-taken') rows.push(row);
  } });
  try { observeDirectPrLandRefusal(line); expect(rows).toEqual([]); }
  finally { off(); }
});

test('observed refusal emits one graph edge with recovery execution deferred', () => {
  const rows: { event: string; data?: unknown }[] = [];
  const off = debug.registerSink({ name: 'pr-land-refusal-test', emit: (row) => {
    if (row.event === 'graph-edge-taken') rows.push(row);
  } });
  try {
    observePrLandRefusal(cases[2][0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data: {
      from: 'merge', on: 'refusal', label: 'not-ancestor', to: 'main-sync',
      taken: 'main-sync', reason: 'pr-land-refused; recovery-execution=none',
    } });
  } finally { off(); }
});

test('captured direct landing refusal records a candidate edge without executing recovery', () => {
  const rows: { event: string; data?: unknown }[] = [];
  const off = debug.registerSink({ name: 'pr-land-direct-refusal-test', emit: (row) => {
    if (row.event === 'graph-edge-taken') rows.push(row);
  } });
  try {
    observeDirectPrLandRefusal(observedLandRefusals[2][0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data: {
      from: 'merge', on: 'refusal', label: 'gate-merge-conflict', to: 'main-sync',
      taken: 'main-sync', reason: 'pr-land-refused; recovery-execution=none',
    } });
  } finally { off(); }
});
