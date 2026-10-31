import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { Command } from 'commander';
import { handTask } from '../task-agent/task-hand.js';
import { installHarnessCliCommand } from './harness-cli-command.js';
import { LAUNCH_DOOR_RECEIPT_ENV, launchRequestId, openLaunchRequestDoor } from '../execution-loop/launch-gate.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

// LAUNCH-SINGLE-DOOR-1C — 발사 요청의 단일 문: append 전용 요청 원장 ⊕ requestId 단위 단일 소비 영수증.
// 격리 test 우주(임시 인스턴스 루트)에서 같은 requestId 의 중복 요청 2회가 자식 발사 1회로 수렴하고
// 거절·실패·재시도 사유가 원장 조회로 읽히는지를 잰다.
const dirs: string[] = [];
afterEach(() => {
  resetElanousConfigDir();
  process.exitCode = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('LAUNCH-SINGLE-DOOR-1C: append 요청 원장 — 소비 영수증은 requestId 단위 최초 1회만 발급된다', () => {
  const root = mkdtempSync(join(tmpdir(), 'launch-door-unit-'));
  dirs.push(root);
  const door = openLaunchRequestDoor({ root, source: 'unit' });
  const ask = '같은 원문을 두 번 두드린다';
  const requestId = door.requestId(ask);
  expect(requestId).toBe(launchRequestId(ask));
  const first = door.consume(requestId);
  if (first.status !== 'consumed') throw new Error('첫 소비는 영수증이 발급되어야 한다');
  const duplicate = door.consume(requestId);
  if (duplicate.status !== 'refused') throw new Error('같은 requestId 재소비는 거절이어야 한다');
  expect(duplicate.receiptId).toBe(first.receiptId);
  expect(duplicate.reason).toContain('이미 소비');
  // 부모(hand)가 이미 소비한 영수증 상속은 새 영수증 없이 지나간다 — hand → say 자식 사슬이 한 번만 소비한다.
  expect(door.consume(requestId, { inheritedReceipt: requestId })).toMatchObject({ status: 'consumed', inherited: true, receiptId: first.receiptId });
  // 상속 토큰이 다른 requestId 를 가리키면 상속이 아니다 — 거절이 그대로다.
  expect(door.consume(requestId, { inheritedReceipt: launchRequestId('다른 원문') }).status).toBe('refused');
  expect(door.consume(requestId, { force: true }).status).toBe('forced');
  const otherId = door.requestId('다른 원문');
  expect(door.consume(otherId)).toMatchObject({ status: 'consumed', requestId: otherId });
  expect(door.rows(requestId).map((row) => row.event)).toEqual(['requested', 'consumed', 'refused-duplicate', 'refused-duplicate', 'forced-duplicate']);
  expect(door.rows(requestId).find((row) => row.event === 'refused-duplicate')?.reason).toBe(duplicate.reason);
  expect(door.rows(otherId).map((row) => row.event)).toEqual(['requested', 'consumed']);
});

test('TASK-HAND-RETRY: 같은 카드 문면은 하루 뒤 새 넘김 시도로 다시 발사된다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'launch-door-hand-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const door = openLaunchRequestDoor({ root, source: 'hand' });
  const text = '대상 경로: src/execution-loop/launch-gate.ts\n같은 원문의 과제를 두 번 넘긴다';
  const state = join(root, 'task-agent-actions.json');
  let launches = 0;
  const launcher = async () => {
    launches += 1;
    return { runId: 'run-launch-door-1' };
  };
  let now = new Date('2026-10-28T10:00:00.000Z');
  const hand = () => handTask({ id: 'ta-retry-same-card', text, live: true, statePath: state, now: () => now, launchRequestDoor: door,
    prelaunchInspector: () => ({ reason: 'completion-not-code-pr' }), launcher });
  const first = await hand();
  now = new Date('2026-10-29T10:00:00.000Z');
  const duplicate = await hand();
  expect(launches).toBe(2);
  expect(first.launched).toBe(true);
  expect(duplicate.launched).toBe(true);
  expect(duplicate.card.id).toBe(first.card.id);
  const rows = door.rows().filter((row) => row.source === 'hand');
  const requests = rows.filter((row) => row.event === 'requested');
  expect(requests).toHaveLength(2);
  expect(new Set(requests.map((row) => row.requestId)).size).toBe(2);
  expect(rows.filter((row) => row.event === 'consumed')).toHaveLength(2);
  expect(rows.some((row) => row.event === 'refused-duplicate')).toBe(false);
});

test('TASK-HAND-RETRY: 실패한 넘김은 새 시도 키로 재발사할 수 있다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'launch-door-fail-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const door = openLaunchRequestDoor({ root, source: 'hand' });
  const text = '발사기가 죽는 과제 원문';
  const state = join(root, 'task-agent-actions.json');
  let now = new Date('2026-10-28T10:00:00.000Z');
  await expect(handTask({ text, live: true, statePath: state, launchRequestDoor: door,
    id: 'ta-failed-retry', now: () => now, prelaunchInspector: () => ({ reason: 'completion-not-code-pr' }),
    launcher: async () => { throw new Error('spawn ENOENT: bun'); } }))
    .rejects.toThrow('spawn ENOENT: bun');
  now = new Date('2026-10-29T10:00:00.000Z');
  const retry = await handTask({ text, live: true, statePath: state, launchRequestDoor: door,
    id: 'ta-failed-retry', now: () => now,
    prelaunchInspector: () => ({ reason: 'completion-not-code-pr' }),
    launcher: async () => ({ runId: 'run-retry' }) });
  expect(retry.launched).toBe(true);
  const rows = door.rows().filter((row) => row.source === 'hand');
  expect(rows.map((row) => row.event)).toEqual(['requested', 'consumed', 'launch-failed', 'requested', 'consumed']);
  expect(rows.find((row) => row.event === 'launch-failed')?.reason).toBe('spawn ENOENT: bun');
});

test('TASK-HAND-RETRY: 시도별 영수증이 있어도 실행 중인 같은 골은 harness active-run gate가 거부한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'launch-door-active-hand-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const door = openLaunchRequestDoor({ root, source: 'hand' });
  const text = '대상 경로: src/task-agent/task-hand.ts\n같은 카드의 활성 런은 중복 실행하지 않는다';
  let contextEnv: Record<string, string> | undefined;
  const handed = await handTask({ id: 'ta-active-card', text, live: true, statePath: join(root, 'task-agent-actions.json'),
    launchRequestDoor: door, prelaunchInspector: () => ({ reason: 'completion-not-code-pr' }),
    launcher: (_args, _cwd, context) => { contextEnv = context?.env; return { runId: 'run-active-card' }; } });
  expect(handed.launched).toBe(true);
  expect(contextEnv?.ELANOUS_TASK_CARD_ID).toBe('ta-active-card');
  const inherited = contextEnv?.[LAUNCH_DOOR_RECEIPT_ENV];
  expect(inherited).toBeDefined();
  expect(inherited).not.toBe(launchRequestId(text));

  const previousCardId = process.env.ELANOUS_TASK_CARD_ID;
  const previousReceipt = process.env[LAUNCH_DOOR_RECEIPT_ENV];
  process.env.ELANOUS_TASK_CARD_ID = contextEnv!.ELANOUS_TASK_CARD_ID!;
  process.env[LAUNCH_DOOR_RECEIPT_ENV] = inherited!;
  const dispatched: string[] = [];
  const errors: string[] = [];
  const originalError = console.error;
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, {
    registerSink: async () => {}, resolveSurface: async () => 'harness',
    say: async (words) => { dispatched.push(words.join(' ')); },
    launchGate: { readBudget: async () => ({ action: 'proceed', reasons: [] }), activeRuns: () => ['run-active-card'], launchDoor: door },
  });
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'say', text]);
  } finally {
    console.error = originalError;
    if (previousCardId === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
    else process.env.ELANOUS_TASK_CARD_ID = previousCardId;
    if (previousReceipt === undefined) delete process.env[LAUNCH_DOOR_RECEIPT_ENV];
    else process.env[LAUNCH_DOOR_RECEIPT_ENV] = previousReceipt;
  }
  expect(dispatched).toEqual([]);
  expect(errors.join('\n')).toContain('blocked-duplicate — same-goal active runs: run-active-card');
  expect(door.rows(inherited).map((row) => row.event)).toEqual(['requested', 'consumed']);
});

test('LAUNCH-SINGLE-DOOR-1C: harness say 관문 배선 — 같은 원문 2회가 dispatch 1회로 수렴하고 두 번째는 관문 문면으로 거절된다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'launch-door-say-'));
  dirs.push(root);
  setElanousConfigDir(root);
  const door = openLaunchRequestDoor({ root, source: 'cli-harness-say' });
  const sentence = '같은문장으로-두-번-두드린다';
  const dispatched: string[] = [];
  const program = new Command().exitOverride();
  installHarnessCliCommand(program, {
    registerSink: async () => {},
    resolveSurface: async () => 'harness',
    say: async (words) => { dispatched.push(words.join(' ')); },
    launchGate: { readBudget: async () => ({ action: 'proceed', reasons: ['within budget'] }), activeRuns: () => [], launchDoor: door },
  });
  await program.parseAsync(['node', 'elanous', 'harness', 'say', sentence]);
  expect(dispatched).toEqual([sentence]);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    await program.parseAsync(['node', 'elanous', 'harness', 'say', sentence]);
  } finally {
    console.error = originalError;
  }
  expect(dispatched).toEqual([sentence]);      // 두 번째 요청은 자식 발사 없이 거절됐다
  expect(process.exitCode).toBe(3);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('❌ launch gate: blocked-duplicate — ');
  expect(errors[0]).toContain('이미 소비');
  expect(door.rows(launchRequestId(sentence)).map((row) => row.event))
    .toEqual(['requested', 'consumed', 'requested', 'refused-duplicate']);
});
