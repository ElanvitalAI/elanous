import { expect, test } from 'bun:test';
import { classifyPrLandRefusal, mayLaunchPrLandDriftRepair, observeDirectPrLandRefusal, observePrLandRefusal } from './pr-land-refusal.js';
import { readJourneyEdge } from '../self-dev/graph-journey-route.js';
import { debug } from '../debug/log.js';
import { runPrLand } from './pr-cli.js';
import { PR_LAND_CARD_ID_ENV } from './pr-land-recovery.js';
import type { GateReceipt } from '../self-implement/gate-receipt-registry.js';

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

test('a named remote host reports gate-host-busy', () => {
  expect(classifyPrLandRefusal('✗ heavy-remote: fixture-node 게이트 gate-host-busy — 로컬 게이트로 폴백하지 않는다.')).toBe('gate-host-busy');
});

for (const [line, label, destination] of observedLandRefusals) {
  test(`captured land refusal ${label} routes to ${destination}: ${line.slice(0, 50)}`, () => {
    expect(classifyPrLandRefusal(line)).toBe(label);
    const route = readJourneyEdge('merge', label);
    expect(route).toMatchObject({ source: 'graph', on: 'refusal', to: destination });
  });
}

test('typecheck failure is classified as drift only with explicit drift context', () => {
  const line = '✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: stderr: [typecheck] FAIL — tsc failed with errors.';
  const unrelatedGateFailure = '✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: stderr: tsc passed; lint failed.';
  const mainDeltaTypecheckFailure = '✗ heavy-remote: 원격 게이트 gate-rc-1 · remote: stderr: error: main-baseline tsc introduced 1 TypeScript diagnostic(s).';
  const localLine = '✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.';
  expect(classifyPrLandRefusal(line, { typecheckDrift: 'drift' })).toBe('typecheck-drift');
  expect(classifyPrLandRefusal(localLine, { typecheckDrift: 'drift' })).toBe('typecheck-drift');
  expect(classifyPrLandRefusal(line)).toBe('other');
  expect(classifyPrLandRefusal(localLine)).toBe('other');
  expect(classifyPrLandRefusal(line, { typecheckDrift: 'drift-unmeasured' })).toBe('other');
  expect(classifyPrLandRefusal(line, { typecheckDrift: 'drift-unrelated' })).toBe('other');
  expect(classifyPrLandRefusal(unrelatedGateFailure, { typecheckDrift: 'drift' })).toBe('other');
  expect(classifyPrLandRefusal(mainDeltaTypecheckFailure, { typecheckDrift: 'drift' })).toBe('typecheck-drift');
  expect(classifyPrLandRefusal('✗ heavy-remote: 원격 게이트 gate-rc-1 — 로컬 게이트로 폴백하지 않는다.', { typecheckDrift: 'drift' })).toBe('other');
});

test('observed typecheck drift uses the merge refusal edge path', () => {
  const line = '✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.';
  expect(readJourneyEdge('merge', 'typecheck-drift')).toMatchObject({ source: 'graph', on: 'refusal', to: 'main-sync' });
  const rows: { event: string; data?: unknown }[] = [];
  const off = debug.registerSink({ name: 'pr-land-typecheck-drift-refusal-test', emit: (row) => {
    if (row.event === 'graph-edge-taken') rows.push(row);
  } });
  try {
    observePrLandRefusal(line, { typecheckDrift: 'drift' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'graph-edge-taken', data: { from: 'merge', on: 'refusal', label: 'typecheck-drift', to: 'main-sync', taken: 'main-sync' } });
  } finally { off(); }
});

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

test('LAND-DRIFT-AUTOREPAIR-LIVE simulator bounds real launch decisions and measures misses', async () => {
  const headAttempts = new Map<string, number>();
  const prAttempts = new Map<number, number>();
  const launched: string[] = [];
  const escalated: string[] = [];
  const mergeCalls: string[] = [];
  const classifications: Array<{ truth: boolean; verdict: string }> = [];
  let currentHead = 'a'.repeat(40);
  let currentSymbol = 'ChangedType';
  let hasReceipt = true;
  let truth = true;
  let mode: 'off' | 'shadow' | 'live' = 'live';
  const main = 'c'.repeat(40);
  const receiptBase = 'b'.repeat(40);
  const receipt: GateReceipt = {
    schema: 1, key: 'e'.repeat(64), verdict: 'passed', headCommit: currentHead, baseCommit: receiptBase,
    bunVersion: '1.4.2', lockfileHash: 'absent', radiusFiles: ['src/changed.ts'], checks: ['changed-file-typecheck'],
    envFingerprint: 'sim', savedAt: '2026-11-07T00:00:00.000Z',
  };
  const offSink = debug.registerSink({ name: 'land-drift-autorepair-live-sim', emit: row => {
    if (row.category === 'pr.land' && row.event === 'drift-classified') {
      const data = row.data as { verdict?: unknown } | undefined;
      classifications.push({ truth, verdict: String(data?.verdict) });
    }
  } });
  const cmd = (command: string, args: readonly string[]) => {
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return { ok: true, out: JSON.stringify({
      headRefOid: currentHead, headRefName: 'feat/fake-drift', baseRefName: 'main', state: 'OPEN', isDraft: false,
      url: `https://github.com/ElanvitalAI/elanous/pull/${args[2]}`,
    }) };
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'merge') mergeCalls.push(args.join(' '));
    if (command !== 'git') return { ok: true, out: '[]' };
    if (args[0] === 'remote' && args.length === 1) return { ok: true, out: 'origin\n' };
    if (args[0] === 'remote' && args[1] === 'get-url') return { ok: true, out: 'https://github.com/ElanvitalAI/elanous.git\n' };
    if (args[0] === 'rev-parse' && args.includes('HEAD')) return { ok: true, out: `${currentHead}\n` };
    if (args[0] === 'rev-parse' && args.includes('origin/main')) return { ok: true, out: `${main}\n` };
    if (args[0] === 'rev-list' && args[1] === '--left-right' && args[2] === '--count') return { ok: true, out: '0 0\n' };
    if (args[0] === 'diff' && args.includes('--name-only')) return { ok: true, out: 'src/changed.ts\n' };
    if (args[0] === 'status' || args[0] === 'fetch') return { ok: true, out: '' };
    return { ok: true, out: '' };
  };
  const deps = {
    run: (command: string, args: readonly string[]) => cmd(command, args),
    currentBranch: () => 'feat/fake-drift',
    resolveBase: () => 'origin/main',
    listOpenPrs: () => [],
    listUnfinishedRuns: () => [],
    queryRunningRuns: () => { throw new Error('simulated running-run observation unavailable'); },
    runTypecheckGate: (gateOut: { error: (line: string) => void }) => {
      gateOut.error(`src/consumer.ts(1,1): error TS2304: Cannot find name '${currentSymbol}'.`);
      return false;
    },
    driftAutorepair: {
      get mode() { return mode; },
      deps: {
        loadGateReceipts: () => hasReceipt ? { [receipt.key]: { ...receipt, headCommit: currentHead } } : {},
        git: (args: readonly string[]) => {
          if (args[0] === 'merge-base') return { status: 0, stdout: '', stderr: '' };
          if (args[0] === 'rev-list') return { status: 0, stdout: '1\n', stderr: '' };
          if (args[0] === 'ls-tree') return { status: 0, stdout: '100644 blob object\tsrc/changed.ts\0', stderr: '' };
          if (args[0] === 'show') {
            const source = args[1]?.startsWith(`${receiptBase}:`)
              ? 'export interface ChangedType { value: string }\n'
              : 'export interface ChangedType { value: string; required: string }\n';
            return { status: 0, stdout: source, stderr: '' };
          }
          if (args[1] === '--name-only') return { status: 0, stdout: 'src/changed.ts\n', stderr: '' };
          return { status: 0, stdout: '+++ b/src/changed.ts\n+export interface ChangedType { value: string; required: string }\n', stderr: '' };
        },
      },
      readAttempts: (pr: number, head: string) => ({ byHead: headAttempts.get(head) ?? 0, byPr: prAttempts.get(pr) ?? 0 }),
      recordAttempt: (pr: number, head: string) => {
        headAttempts.set(head, (headAttempts.get(head) ?? 0) + 1);
        prAttempts.set(pr, (prAttempts.get(pr) ?? 0) + 1);
      },
      launch: async (_goal: string, files: readonly string[]) => { launched.push(files.join(',')); },
      escalate: (mail: string) => { escalated.push(mail); },
    },
    out: { log: () => {}, error: () => {} },
    setExitCode: () => {},
    prodFreezeRoot: '/simulated/no-freeze',
  };
  const run = async (input: { pr: number; head: string; runMode: 'off' | 'shadow' | 'live'; symbol: string; receipt: boolean; actual: boolean; launches: number }) => {
    currentHead = input.head;
    currentSymbol = input.symbol;
    hasReceipt = input.receipt;
    truth = input.actual;
    mode = input.runMode;
    const observedBefore = classifications.length;
    const launchesBefore = launched.length;
    const result = await runPrLand({ pr: String(input.pr), expectedHead: currentHead, cwd: '/simulated/pr-land' }, deps);
    expect(result).toBe(1); // The injected tsc refusal is terminal; this invocation cannot merge.
    expect(classifications).toHaveLength(observedBefore + 1); // Confirms the actual CLI reached its drift classifier.
    expect(launched.length - launchesBefore).toBe(input.launches); // Observe the launch boundary for this scenario, not an aggregate.
    return classifications.at(-1)!;
  };
  const previousTrack = process.env.ELANOUS_TRACK;
  const previousCardId = process.env[PR_LAND_CARD_ID_ENV];
  const previousFileEnabled = debug.isFileEnabled();
  const previousDiagEnabled = debug.isDiagEnabled();
  // This injected tsc-refusal path only records debug/journey observations: keep file logging off,
  // use the in-memory diag/ring sink, provide no run id (so no ledger append), and fake launch/gh/git.
  debug.setFileEnabled(false);
  debug.setDiagEnabled(true);
  delete process.env[PR_LAND_CARD_ID_ENV];
  process.env.ELANOUS_TRACK = 'OP';
  try {
    try {
      const tp = await run({ pr: 71, head: 'a'.repeat(40), runMode: 'live', symbol: 'ChangedType', receipt: true, actual: true, launches: 1 });
      expect(tp.verdict).toBe('drift');
      const repeat = await run({ pr: 71, head: 'a'.repeat(40), runMode: 'live', symbol: 'ChangedType', receipt: true, actual: true, launches: 0 });
      expect(repeat.verdict).toBe('drift');
      const secondHead = await run({ pr: 71, head: 'd'.repeat(40), runMode: 'live', symbol: 'ChangedType', receipt: true, actual: true, launches: 1 });
      expect(secondHead.verdict).toBe('drift');
      const beyondPrCap = await run({ pr: 71, head: 'f'.repeat(40), runMode: 'live', symbol: 'ChangedType', receipt: true, actual: true, launches: 0 });
      expect(beyondPrCap.verdict).toBe('drift');
      const falsePositive = await run({ pr: 72, head: '2'.repeat(40), runMode: 'live', symbol: 'UnrelatedType', receipt: true, actual: false, launches: 0 });
      expect(falsePositive.verdict).toBe('drift-unrelated');
      const missedDrift = await run({ pr: 73, head: '3'.repeat(40), runMode: 'live', symbol: 'ChangedType', receipt: false, actual: true, launches: 0 });
      expect(missedDrift.verdict).toBe('drift-unmeasured');
      const shadow = await run({ pr: 74, head: '4'.repeat(40), runMode: 'shadow', symbol: 'ChangedType', receipt: true, actual: true, launches: 0 });
      expect(shadow.verdict).toBe('drift');
      const killSwitch = await run({ pr: 75, head: '5'.repeat(40), runMode: 'off', symbol: 'ChangedType', receipt: true, actual: true, launches: 0 });
      expect(killSwitch.verdict).toBe('drift');

      expect(launched).toHaveLength(2); // Cost unit = one repair request; planner caps at 1/head and 2/PR.
      expect(launched.every(value => value.includes('src/changed.ts'))).toBe(true);
      expect(escalated).toHaveLength(2); // Repeated head and PR-wide cap both stop dispatch.
      expect(mergeCalls).toEqual([]); // Spy observes the real command boundary: auto-merge stays zero.
      expect(classifications.filter(item => item.truth === false && item.verdict === 'drift').length).toBe(0); // false launches
      expect(classifications.filter(item => item.truth === true && item.verdict !== 'drift').length).toBe(1); // measured miss
    } finally { offSink(); }
  } finally {
    if (previousTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = previousTrack;
    if (previousCardId === undefined) delete process.env[PR_LAND_CARD_ID_ENV]; else process.env[PR_LAND_CARD_ID_ENV] = previousCardId;
    debug.setDiagEnabled(previousDiagEnabled);
    debug.setFileEnabled(previousFileEnabled);
  }
});
