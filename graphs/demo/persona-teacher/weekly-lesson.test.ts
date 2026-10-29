import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { applyDecidedApprovals, raiseApprovalCard } from '../../../src/graph-runner/graph-approval-card.js';
import { graphTick } from '../../../src/graph-runner/graph-tick.js';
import { latestGraphRun, type GraphRunState } from '../../../src/graph-runner/runner.js';
import { DecisionLedger } from '../../../src/decisions/decision-ledger.js';
import { parseGraphTemplateYaml } from '../../../src/self-implement/graph-yaml.js';

const GRAPH = join(import.meta.dir, 'weekly-lesson.yaml');
const LESSON_PACK = join(import.meta.dir, 'lesson-pack.yaml');

/** Sunday 20:00 Asia/Seoul instants — the graph's declared weekly slot, injected by the scheduler. */
const SUNDAY_1 = '2026-11-01T11:00:00.000Z';
const SUNDAY_2 = '2026-11-08T11:00:00.000Z';
const SUNDAY_2_WITH_SECONDS = '2026-11-08T11:00:45.000Z';
const WEDNESDAY = '2026-11-04T11:00:00.000Z';

/** 주간 tick 은 실제로 bun 자식 프로세스를 띄운다 — 기본 5초 예산으로는 모자란다. */
const named = (name: string, fn: () => unknown) => test(name, async () => { await fn(); }, 60_000);

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const originalStateDir = process.env.ELANOUS_STATE_DIR;
const posts: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  posts.splice(0);
  globalThis.fetch = originalFetch;
});

/** Isolated event-injection stage: temp state root, own mine dir, fake clock instants, no network. */
function stage(): { root: string; mineDir: string; deps: { root: string } } {
  const root = mkdtempSync(join(tmpdir(), 'weekly-lesson-'));
  roots.push(root);
  // The runner pins child ELANOUS_STATE_DIR from effectiveInstanceRoot(); keep it aligned with this test ledger.
  process.env.ELANOUS_STATE_DIR = root;
  globalThis.fetch = (async (input: unknown) => {
    posts.push(String(input));
    throw new Error(`external post blocked: ${String(input)}`);
  }) as unknown as typeof fetch;
  return { root, mineDir: join(root, 'mine'), deps: { root } };
}

function tick(deps: { root: string }, mineDir: string, scheduledAt: string) {
  return graphTick(GRAPH, { startIfIdle: true, input: { scheduledAt, timezone: 'Asia/Seoul' }, mineDir, deps });
}

function ledger(root: string, runId: string): GraphRunState {
  return JSON.parse(readFileSync(join(root, 'graph-runs', 'weekly-lesson', `${runId}.json`), 'utf8')) as GraphRunState;
}

function nodeOutput(state: GraphRunState, nodeId: string): Record<string, unknown> {
  const record = state.nodes.find((node) => node.nodeId === nodeId);
  if (!record || typeof record.output !== 'string') throw new Error(`no stdout record for ${nodeId}`);
  return JSON.parse(record.output) as Record<string, unknown>;
}

named('SW-PERSONA-TEACHER-WEEKLY-FU: 주간 tick 두 번 — 첫 실행 진도 기록, 둘째 실행 다음 단원 선택 후 lesson-pack 전달·교사 승인 대기, 외부 게시 0', async () => {
  const { root, mineDir, deps } = stage();

  const first = await tick(deps, mineDir, SUNDAY_1);
  expect(first).toMatchObject({ action: 'started', status: 'done' });
  const firstRun = ledger(root, first.runId!);
  expect(firstRun.path).toEqual(['read-progress', 'select-next', 'record-progress', 'done']);
  expect(nodeOutput(firstRun, 'select-next')).toMatchObject({ outcome: 'baseline', lesson: 'unit-1', completed: [] });
  expect(nodeOutput(firstRun, 'record-progress')).toMatchObject({ outcome: 'ok', lesson: 'unit-1', completed: ['unit-1'], recordedAt: SUNDAY_1 });

  const second = await tick(deps, mineDir, SUNDAY_2);
  expect(second).toMatchObject({ action: 'started', status: 'awaiting-approval' });
  const secondRun = ledger(root, second.runId!);
  expect(secondRun.path).toEqual(['read-progress', 'select-next', 'lesson-pack', 'teacher-approval']);
  expect(nodeOutput(secondRun, 'read-progress')).toMatchObject({ outcome: 'ok', completed: ['unit-1'], nextLesson: 'unit-2', source: 'run-ledger' });
  expect(nodeOutput(secondRun, 'select-next')).toMatchObject({ outcome: 'next', lesson: 'unit-2', completed: ['unit-1'] });

  const handed = JSON.parse(readFileSync(join(root, 'lesson-pack', 'inbox', 'unit-2.json'), 'utf8')) as Record<string, unknown>;
  expect(handed).toMatchObject({ lesson: 'unit-2', requestedBy: { graphId: 'weekly-lesson', runId: second.runId } });
  const childRunId = secondRun.unitCalls?.[0]?.childRunId;
  expect(typeof childRunId).toBe('string');
  const child = JSON.parse(readFileSync(join(root, 'graph-runs', 'lesson-pack', `${childRunId}.json`), 'utf8')) as GraphRunState;
  expect(child.input).toMatchObject({ 'select-next': { lesson: 'unit-2' } });

  expect(await graphTick(GRAPH, { startIfIdle: true, mineDir, deps })).toEqual({ action: 'waiting', runId: second.runId, status: 'awaiting-approval' });

  expect(posts).toEqual([]);
  expect(existsSync(join(root, 'outbox'))).toBe(false);
});

named('SW-PERSONA-TEACHER-WEEKLY-FU: 교사 승인은 사람 결정만 claim 하고, 승인 뒤에야 진도가 마감되어 그 다음 tick 이 다음 단원을 고른다', async () => {
  const { root, mineDir, deps } = stage();
  const first = await tick(deps, mineDir, SUNDAY_1);
  expect(first).toMatchObject({ action: 'started', status: 'done' });
  const second = await tick(deps, mineDir, SUNDAY_2);
  expect(second).toMatchObject({ action: 'started', status: 'awaiting-approval' });

  const pending = ledger(root, second.runId!);
  expect(pending.pending).toMatchObject({ nodeId: 'teacher-approval' });
  expect(typeof pending.pending?.since).toBe('string');
  expect(pending.pending?.message).toBe('다음 주 수업 팩이 준비됐다 — 교사가 확인해야 진도에 기록한다. 이 단원을 그대로 진행할까?');
  const ledgerApi = new DecisionLedger({ stateDir: root, resolveVersion: () => ({ released: '0.2.40', dev: '0.2.41', codename: null }) });
  // graphTick 이 recipes.yaml 의 approval:teacher 에서 읽은 실제 문면으로 카드를 만든다.
  const card = raiseApprovalCard(pending, pending.pending!, { root, ledger: ledgerApi })!;
  expect(card.refs).toEqual([`graph-approval:weekly-lesson:${second.runId}:teacher-approval:1`]);
  ledgerApi.decide(card.id, 'a', { kind: 'human' });
  expect(applyDecidedApprovals({ root, ledger: ledgerApi })).toBe(1);
  expect(await graphTick(GRAPH, { startIfIdle: true, mineDir, deps })).toEqual({ action: 'resumed', runId: second.runId, status: 'done' });
  const approved = ledger(root, second.runId!);
  expect(approved.path).toEqual(['read-progress', 'select-next', 'lesson-pack', 'teacher-approval', 'record-progress', 'done']);
  expect(nodeOutput(approved, 'record-progress')).toMatchObject({ outcome: 'ok', lesson: 'unit-2', completed: ['unit-1', 'unit-2'], recordedAt: SUNDAY_2 });
  expect(latestGraphRun('weekly-lesson', root)?.status).toBe('done');
  expect(posts).toEqual([]);
});

named('SW-PERSONA-TEACHER-WEEKLY-FU: 원장 root env 가 없으면 저장 진도를 비워 되돌리지 않고 loud failure', () => {
  const { root } = stage();
  const contextPath = join(root, 'context.json');
  writeFileSync(contextPath, JSON.stringify({ input: { scheduledAt: SUNDAY_1 } }));
  const env = { ...process.env, ELANOUS_GRAPH_CONTEXT: contextPath };
  delete env.ELANOUS_STATE_DIR;
  const scriptPath = join(import.meta.dir, '../../../scripts/persona-teacher/weekly-lesson-node.ts');
  const result = spawnSync('bun', [scriptPath, 'read-progress'], { cwd: root, env, encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('ELANOUS_STATE_DIR is required');
});

named('SW-PERSONA-TEACHER-WEEKLY-FU: 초 단위 스케줄 지터는 허용하고 일요일 20:00 KST 밖의 tick 은 실패로 멈춘다', async () => {
  const { root, mineDir, deps } = stage();
  const off = await tick(deps, mineDir, WEDNESDAY);
  expect(off).toMatchObject({ action: 'started', status: 'failed' });
  const run = ledger(root, off.runId!);
  expect(nodeOutput(run, 'read-progress')).toMatchObject({ outcome: 'fail', scheduledAt: WEDNESDAY });
  expect(run.path).toEqual(['read-progress', 'failed']);
  expect(existsSync(join(root, 'lesson-pack', 'inbox'))).toBe(false);
  expect(latestGraphRun('weekly-lesson', root)?.nodes.some((node) => node.nodeId === 'record-progress')).toBe(false);

  const onMinute = await tick(deps, mineDir, SUNDAY_2_WITH_SECONDS);
  expect(onMinute).toMatchObject({ action: 'started', status: 'done' });
  expect(posts).toEqual([]);
});

named('SW-PERSONA-TEACHER-WEEKLY-FU: weekly-lesson·lesson-pack 선언이 로드되고 일요일 20:00 KST 주간 슬롯과 승인·유닛 호출을 담는다', () => {
  const weekly = parseGraphTemplateYaml(readFileSync(GRAPH, 'utf8'), 'weekly-lesson.yaml');
  expect(weekly.errors).toEqual([]);
  const declaration = parseYaml(readFileSync(GRAPH, 'utf8')) as { loop: { trigger: { cron: string; timezone: string } }; graph_id: string };
  expect(declaration.graph_id).toBe('weekly-lesson');
  expect(declaration.loop.trigger).toEqual({ cron: '0 20 * * 0', timezone: 'Asia/Seoul' });
  expect(weekly.template?.nodes.find((node) => node.nodeId === 'teacher-approval')).toMatchObject({ kind: 'hitl', recipe: 'approval:teacher' });
  expect(weekly.template?.nodes.find((node) => node.nodeId === 'lesson-pack')).toMatchObject({ kind: 'subgraph', call: 'lesson-pack@1' });

  const pack = parseGraphTemplateYaml(readFileSync(LESSON_PACK, 'utf8'), 'lesson-pack.yaml');
  expect(pack.errors).toEqual([]);
  expect(pack.template?.unit).toEqual({ inputs: ['select-next'], outputs: ['lesson'], exits: ['ok', 'fail'] });
});
