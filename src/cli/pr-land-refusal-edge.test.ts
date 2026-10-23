// LAND-REFUSAL-EDGES 첫 조각 — 착지 거부 한 건이 recover@1 간선에 «근거째» 결속되고 우회 병합은 0이다.
//
// ⛔ recover@1 을 재구현하지 않는다(#29093) — 선언(graphs/implement-loop.yaml)과 planner(pr-land-recovery.ts)를
//    그대로 읽고, 거부 줄 원문·cardId·PR·head 를 그 간선 한 행에 묶는지만 문다.
// 🔎 관측: `self-implement` / `graph-edge-taken` { from: merge, on: recovery, label: land-refused, to: recover, call: recover@1 }
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { debug } from '../debug/log.js';
import { readJourneyEdge, recordJourneyEdge } from '../self-dev/graph-journey-route.js';
import { GRAPH_SPECS } from '../self-implement/graph-templates.js';
import { resetEffectiveInstanceRoot } from '../instance/resolve.js';
import type { PrManager } from '../autopilot/pr-manager.js';
import { createFakeBins } from '../ux-sim/fake-bin.js';
import { bindPrLandRefusalToRecover, executeBoundPrLandRecover, PR_LAND_CARD_ID_ENV } from './pr-land-recovery.js';
import { runQueuedLanding, type QueueLandingInput } from '../task-agent/land-queue.js';
import { runPrLand, type PrLandDeps } from './pr-cli.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { defaultLand } from '../task-agent/live-moves.js';

const HEAD = 'a'.repeat(40);
const PR = 30230;
const CARD = 'LAND-REFUSAL-EDGES-MOCK';
const DRAFT_REFUSAL = '✗ expected-head: PR OPEN non-draft, matching local HEAD and clean worktree required';
const BUSY_REFUSAL = '✗ heavy-remote: 원격 게이트 gate-host-busy — 로컬 게이트로 폴백하지 않는다.';

type Row = { event: string; data?: Record<string, unknown> };
function captureEdges(): { rows: Row[]; off: () => void } {
  const rows: Row[] = [];
  const off = debug.registerSink({ name: `land-refusal-edge-${Math.random()}`, emit: (row) => {
    if (row.event === 'graph-edge-taken' && (row.data as { from?: string } | undefined)?.from === 'merge') rows.push(row as Row);
  } });
  return { rows, off };
}
const recoveryRows = (rows: Row[]) => rows.filter((row) => row.data?.on === 'recovery');
const refusalRows = (rows: Row[]) => rows.filter((row) => row.data?.on === 'refusal');

let prodFreezeRoot: string;
let stateDir: string;
let savedStateDir: string | undefined;
let savedCard: string | undefined;
beforeEach(() => {
  prodFreezeRoot = mkdtempSync(join(tmpdir(), 'land-refusal-edge-freeze-'));
  stateDir = mkdtempSync(join(tmpdir(), 'land-refusal-edge-state-'));
  savedStateDir = process.env.ELANOUS_STATE_DIR;
  savedCard = process.env[PR_LAND_CARD_ID_ENV];
  process.env.ELANOUS_STATE_DIR = stateDir;
  resetEffectiveInstanceRoot();
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = savedStateDir;
  if (savedCard === undefined) delete process.env[PR_LAND_CARD_ID_ENV]; else process.env[PR_LAND_CARD_ID_ENV] = savedCard;
  resetEffectiveInstanceRoot();
  rmSync(prodFreezeRoot, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function fakeManager() {
  const calls: string[] = [];
  const manager: PrManager = {
    findPrForBranch: () => { calls.push('find-legacy'); return null; },
    findPrForBranchOutcome: () => { calls.push('find'); return { status: 'ok EMPTY', url: null }; },
    upsertPr: () => { calls.push('upsert'); return { ok: true, url: `https://github.com/example/repo/pull/${PR}`, reused: false }; },
    closePr: () => { calls.push('close'); return true; },
    mergePr: () => { calls.push('merge'); return true; },
    mergePrOutcome: () => { calls.push('merge'); return { ok: true, kind: 'merge-exit-0' }; },
  };
  return { manager, calls };
}

test('implement-loop declares merge → recover (recover@1) as the landing-refusal recovery edge', () => {
  const route = readJourneyEdge('merge', 'land-refused');
  expect(route).toMatchObject({ from: 'merge', on: 'recovery', label: 'land-refused', to: 'recover', source: 'graph' });
  const node = GRAPH_SPECS['self-implement']?.nodes.find((n) => n.nodeId === 'recover');
  expect(node).toMatchObject({ kind: 'subgraph', call: 'recover@1' });
  // 기존 거부 계약 보존 — 다섯 이유의 목적지는 그대로다.
  expect(readJourneyEdge('merge', 'draft').to).toBe('ready');
  expect(readJourneyEdge('merge', 'review-missing').to).toBe('review');
  expect(readJourneyEdge('merge', 'gate-host-busy').to).toBe('next-move');
  expect(readJourneyEdge('merge', 'not-ancestor').to).toBe('main-sync');
  expect(readJourneyEdge('merge', 'merged').to).toBe('cleanup');
});

test('a bound refusal row carries the raw refusal, card, PR, head and the recover@1 plan — no merge SHA', () => {
  const { rows, off } = captureEdges();
  try {
    const plan = bindPrLandRefusalToRecover({ refusal: BUSY_REFUSAL, pr: PR, head: HEAD, cardId: CARD });
    expect(plan.result).toMatchObject({ action: 'wait-retry', delayMs: 30_000 });
  } finally { off(); }
  expect(recoveryRows(rows)).toHaveLength(1);
  expect(recoveryRows(rows)[0]!.data).toMatchObject({
    from: 'merge', on: 'recovery', label: 'land-refused', to: 'recover', taken: 'recover', honored: true,
    call: 'recover@1', execution: 'none', mergeSha: null,
    evidence: { cardId: CARD, pr: PR, head: HEAD, refusal: BUSY_REFUSAL, refusalLabel: 'gate-host-busy', refusalRoute: 'next-move' },
    recover: { outcome: 'rework', action: 'wait-retry', delayMs: 30_000 },
  });
});

test('pinned pr land refusal binds to recover@1 once, keeps the refusal edge, and never merges', async () => {
  process.env[PR_LAND_CARD_ID_ENV] = CARD;
  const { manager, calls } = fakeManager();
  const errors: string[] = [];
  const out = { log: () => {}, error: (message: string) => { errors.push(message); } };
  const run: NonNullable<PrLandDeps['run']> = (cmd, args) => {
    if (cmd === 'gh') return { ok: true, out: JSON.stringify({ headRefOid: HEAD, headRefName: 'feat/land', baseRefName: 'main', state: 'OPEN', isDraft: true, url: `https://github.com/example/repo/pull/${PR}` }) };
    if (args.join(' ') === 'rev-parse HEAD') return { ok: true, out: HEAD };
    if (args.join(' ') === 'status --porcelain') return { ok: true, out: '' };
    return { ok: false, out: '' };
  };
  const { rows, off } = captureEdges();
  let code: number;
  try {
    code = await runPrLand({ pr: String(PR), expectedHead: HEAD }, {
      prodFreezeRoot, manager, out, run, currentBranch: () => 'feat/land', resolveBase: () => 'origin/main',
      listUnfinishedRuns: () => [], isInteractive: () => false,
    });
  } finally { off(); }
  expect(code).toBe(1);
  expect(errors).toContain(DRAFT_REFUSAL);
  expect(refusalRows(rows)).toHaveLength(1);
  expect(refusalRows(rows)[0]!.data).toMatchObject({ label: 'draft', to: 'ready', reason: 'pr-land-refused; recovery-execution=none' });
  expect(recoveryRows(rows)).toHaveLength(1);
  expect(recoveryRows(rows)[0]!.data).toMatchObject({
    to: 'recover', call: 'recover@1', execution: 'none', mergeSha: null,
    evidence: { cardId: CARD, pr: PR, head: HEAD, refusal: DRAFT_REFUSAL, refusalLabel: 'draft', refusalRoute: 'ready' },
    recover: { outcome: 'needs-human', action: 'needs-human' },
  });
  expect(calls).not.toContain('merge');
  expect(calls).not.toContain('upsert');
});

test('evidence cannot override edge fields or the reason', () => {
  const { rows, off } = captureEdges();
  try {
    recordJourneyEdge(readJourneyEdge('merge', 'land-refused'), 'recover', undefined, { to: 'cleanup', taken: 'cleanup', reason: 'forged', mergeSha: null });
  } finally { off(); }
  expect(recoveryRows(rows)).toHaveLength(1);
  expect(recoveryRows(rows)[0]!.data).toMatchObject({ to: 'recover', taken: 'recover', mergeSha: null });
  expect(recoveryRows(rows)[0]!.data).not.toHaveProperty('reason');
});

test('an unpinned refusal is not bound — recover@1 needs pinned identity', async () => {
  const { rows, off } = captureEdges();
  try { bindPrLandRefusalToRecover({ refusal: BUSY_REFUSAL, pr: PR, head: undefined }); }
  finally { off(); }
  expect(recoveryRows(rows)).toEqual([]);
});

// ⭐ 생산 경로 실물 — TA 의 진짜 `defaultLand` 가 진짜 CLI(`bin/elanous.mjs pr land`)를 띄우고,
//    fake gh(PATH shim · src/ux-sim/fake-bin)가 draft 를 돌려 거부를 세운다. 격리 config-dir 의 logs 를 진짜 `logs` CLI 로 읽는다.
test('TA defaultLand → real pr land refusal → graph-edge-taken recover@1 row with the same cardId · merge SHA absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'land-refusal-edge-ta-'));
  const repo = join(root, 'repo');
  const instanceName = `lre-${process.pid}-${Date.now()}`;
  const configDir = join(root, instanceName);
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };
  spawnSync('mkdir', ['-p', repo, configDir]);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=mock@example.invalid', '-c', 'user.name=mock', 'commit', '-q', '--allow-empty', '-m', 'base');
  const head = git('rev-parse', 'HEAD');
  const fakes = createFakeBins({
    gh: { stdout: `${JSON.stringify({ headRefOid: head, headRefName: 'main', baseRefName: 'main', state: 'OPEN', isDraft: true, url: `https://github.com/example/repo/pull/${PR}` })}\n` },
  });
  const savedPath = process.env.PATH;
  const savedNodeEnv = process.env.NODE_ENV;
  try {
    process.env.PATH = fakes.path();
    process.env.ELANOUS_STATE_DIR = configDir;
    // The child is the production CLI: under NODE_ENV=test its logs.db sink is off (log-store.ts), so the
    // isolated universe would record nothing. The state dir above keeps every write out of ~/.elanous.
    process.env.NODE_ENV = 'production';
    setElanousConfigDir(configDir);
    let outcome: { status: number; stdout: string; stderr?: string };
    try { outcome = await defaultLand(PR, head, repo, { cardId: CARD }); }
    finally { resetElanousConfigDir(); }
    expect(outcome.status).toBe(1);
    expect(outcome.stderr ?? '').toContain(DRAFT_REFUSAL);
    expect(fakes.calls().some((call) => call.argv.join(' ').startsWith('pr merge'))).toBe(false);
    const logs = spawnSync(process.execPath, [join(import.meta.dir, '../../bin/elanous.mjs'), '--config-dir', configDir,
      'logs', '--instance', `test:${instanceName}`, '--event', 'graph-edge-taken', '--since', '10m', '--json', '--json-data'], {
      encoding: 'utf8', env: { ...process.env, ELANOUS_STATE_DIR: configDir }, timeout: 60_000,
    });
    const parsed = logs.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { data?: unknown; _meta?: unknown }).filter((row) => row._meta === undefined);
    const data = parsed.map((row) => (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<string, unknown>);
    const bound = data.filter((row) => row.on === 'recovery' && row.call === 'recover@1');
    // 영수증 — 다른 자리가 같은 줄을 다시 친다.
    console.log(`[land-refusal-edge] refusal=${JSON.stringify((outcome.stderr ?? '').trim().split('\n').find((l) => l.startsWith('✗ expected-head')))}`);
    console.log(`[land-refusal-edge] recover-rows=${bound.length} ${JSON.stringify(bound[0] ?? null)}`);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({
      from: 'merge', to: 'recover', taken: 'recover', mergeSha: null, execution: 'none',
      evidence: { cardId: CARD, pr: PR, head, refusal: DRAFT_REFUSAL, refusalLabel: 'draft' },
    });
  } finally {
    process.env.PATH = savedPath;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    fakes.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

// ── LAND-REFUSAL-EXEC — 결속된 recover@1 을 «실제로» 한 단계 실행(있는 유닛 graphs/units/recover.yaml 을 진짜 runner 로)
//    🔎 같은 행 키(graph-edge-taken · from merge · on recovery · call recover@1)에 execution: 'graph-run' 행이 하나 더 붙는다.
test('a bound refusal executes recover@1 one step through the real unit — execution row next to the binding row', async () => {
  const { rows, off } = captureEdges();
  let execution: Awaited<ReturnType<typeof executeBoundPrLandRecover>>;
  try { execution = await executeBoundPrLandRecover({ refusal: BUSY_REFUSAL, pr: PR, head: HEAD, cardId: CARD }, { root: stateDir }); }
  finally { off(); }
  expect(execution.executed).toBe(true);
  expect(execution.plan.result).toMatchObject({ action: 'wait-retry', pr: PR, head: HEAD });
  const bound = recoveryRows(rows);
  expect(bound.map((row) => row.data?.execution)).toEqual(['none', 'graph-run']);
  expect(bound[1]!.data).toMatchObject({
    from: 'merge', on: 'recovery', label: 'land-refused', to: 'recover', call: 'recover@1', execution: 'graph-run', mergeSha: null,
    evidence: { cardId: CARD, pr: PR, head: HEAD, refusal: BUSY_REFUSAL, refusalLabel: 'gate-host-busy' },
    recover: { outcome: 'rework', action: 'wait-retry', delayMs: 30_000 },
    run: { status: 'done', path: ['plan', 'rework'], exit: 'rework' },
  });
  expect(typeof (bound[1]!.data?.run as { runId?: unknown }).runId).toBe('string');
}, 60_000);

test('an untrusted recover@1 run fails closed to a human — no retry action survives', async () => {
  const { rows, off } = captureEdges();
  let execution: Awaited<ReturnType<typeof executeBoundPrLandRecover>>;
  try {
    execution = await executeBoundPrLandRecover({ refusal: BUSY_REFUSAL, pr: PR, head: HEAD, cardId: CARD }, {
      root: stateDir,
      runGraph: async () => ({ runId: 'forged', status: 'done', path: ['plan', 'rework'], nodes: [{ nodeId: 'plan', output: JSON.stringify({ outcome: 'rework', result: { action: 'wait-retry', pr: PR, head: 'b'.repeat(40) } }) }] }),
    });
  } finally { off(); }
  expect(execution.plan).toMatchObject({ outcome: 'needs-human', result: { action: 'needs-human' } });
  expect(recoveryRows(rows)[1]!.data).toMatchObject({ execution: 'graph-run', mergeSha: null,
    recover: { outcome: 'needs-human', action: 'needs-human' }, run: { runId: 'forged', trusted: false } });
});

test('queue landing refusal → same cardId on the refusal, the recover@1 binding and the execution row · merge SHA absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'land-refusal-exec-queue-'));
  const base = 'b'.repeat(40);
  const source: QueueLandingInput = { card: CARD, pr: PR, head: HEAD, cwd: root, statePath: join(root, 'tasks.json'),
    reviewResult: join(root, 'review-results', 'r.json'), command: '/ops/land-enqueue.sh', remote: 'node-c', entry: '/ops/bin/elanous.mjs', configDir: root };
  const summary = { head40: HEAD, base40: base, remoteHost: 'node-c', verdict: 'passed', exitCode: 0, introduced: 0, unknown: 0, preconditionUnmet: 0 };
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const { rows, off } = captureEdges();
  let result: Awaited<ReturnType<typeof runQueuedLanding>>;
  try {
    result = await runQueuedLanding(source, {
      read: (path) => path === source.reviewResult ? JSON.stringify({ pr: PR, headCommit: HEAD, verdict: 'pass', reviewed: true, mustFix: [] }) : JSON.stringify(summary),
      run: async (command, args, _cwd, env) => {
        calls.push({ command, args, env });
        if (args.includes('origin/main') && args.includes('rev-parse')) return { status: 0, stdout: base, stderr: '' };
        if (args.includes('HEAD') && args.includes('rev-parse')) return { status: 0, stdout: HEAD, stderr: '' };
        if (command === 'gh') return { status: 0, stdout: JSON.stringify({ headRefOid: HEAD, state: 'OPEN', isDraft: false }), stderr: '' };
        if (command === source.command) return { status: 1, stdout: 'REFUSE review-fail-newer', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
  } finally { off(); rmSync(root, { recursive: true, force: true }); }
  const bound = recoveryRows(rows);
  // 영수증 — 단언 «전에» 원문 그대로 찍는다.
  console.log(`[land-refusal-exec] queue refusal=${JSON.stringify(result.stderr)} rows=${JSON.stringify(bound.map((row) => ({ execution: row.data?.execution, cardId: (row.data?.evidence as { cardId?: unknown }).cardId, recover: row.data?.recover, run: row.data?.run ?? null, mergeSha: row.data?.mergeSha })))}`);
  // 기존 거부 계약 그대로 — 결과 문면·상태는 바뀌지 않는다.
  expect(result).toEqual({ status: 1, stdout: '', stderr: 'land-enqueue-refused: REFUSE review-fail-newer' });
  // ① 큐 착지도 카드 id 를 같은 env 로 넘긴다(게이트 ⊕ 등록 명령).
  const enqueue = calls.find((call) => call.command === source.command)!;
  expect(enqueue.env?.[PR_LAND_CARD_ID_ENV]).toBe(CARD);
  expect(calls.find((call) => call.args.includes('gate'))!.env?.[PR_LAND_CARD_ID_ENV]).toBe(CARD);
  expect(calls.some((call) => call.args.includes('merge') || call.args.includes('land'))).toBe(false);
  // ② 같은 카드의 거부 원문 · recover@1 결속 행 · 실행 행.
  expect(bound.map((row) => row.data?.execution)).toEqual(['none', 'graph-run']);
  for (const row of bound) expect(row.data).toMatchObject({ call: 'recover@1', mergeSha: null,
    evidence: { cardId: CARD, pr: PR, head: HEAD, refusal: 'land-enqueue-refused: REFUSE review-fail-newer' } });
  expect(bound[1]!.data).toMatchObject({ recover: { outcome: 'needs-human', action: 'needs-human' }, run: { status: 'done', path: ['plan', 'needs-human'], exit: 'needs-human', trusted: true } });
}, 60_000);

// ── LAND-REFUSAL-EXEC r1 should-fix(운영 위험) — recover@1 유닛이 매달려도 TA 착지 틱이 붙잡히지 않는다:
//    시간 한도 안에 needs-human(fail-closed) · executed=false(유닛이 런을 못 냈다) · merge 0.
test('a hanging recover@1 run times out to needs-human and is not reported as executed', async () => {
  const { rows, off } = captureEdges();
  const started = Date.now();
  let execution: Awaited<ReturnType<typeof executeBoundPrLandRecover>>;
  try {
    execution = await executeBoundPrLandRecover(
      { refusal: BUSY_REFUSAL, pr: PR, head: HEAD, cardId: CARD },
      { root: stateDir, timeoutMs: 50, runGraph: () => new Promise(() => {}) },
    );
  } finally { off(); }
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(execution.executed).toBe(false);
  expect(execution.plan.outcome).toBe('needs-human');
  expect(execution.plan.result).toMatchObject({ action: 'needs-human', pr: PR, head: HEAD });
  const bound = recoveryRows(rows);
  expect(bound.every((row) => row.data?.mergeSha === null)).toBe(true);
});
