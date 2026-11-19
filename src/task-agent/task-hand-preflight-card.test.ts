import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handTask, readTaskCard, updateTaskCard, writeTaskCards } from './task-hand.js';
import { openLaunchRequestDoor } from '../execution-loop/launch-gate.js';

const keys = ['ELANOUS_TA_PREFLIGHT_RECEIPT', 'ELANOUS_TA_PREFLIGHT_SHA256', 'ELANOUS_LAUNCH_HOLD_FILE'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const dirs: string[] = [];
afterEach(() => {
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('live hand reuses the preflight receipt card and rejects a conflicting explicit id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-card-')); dirs.push(root);
  const statePath = join(root, 'tasks.json'), id = 'ta-20261119-cafe01';
  const text = '대상 경로: src/task-agent/task-hand.ts\n기존 카드 발사';
  const common = { text, statePath, prelaunchInspector: () => ({ reason: 'completion-not-code-pr' }) };
  const shadow = await handTask({ ...common, id, live: false });
  expect(shadow.card.id).toBe(id);
  const body = JSON.stringify({ kind: 'ta-preflight', createdAt: new Date().toISOString(), target: { card: id }, report: { overall: 'READY' } });
  const path = join(root, 'receipt.json'); writeFileSync(path, body);
  process.env.ELANOUS_TA_PREFLIGHT_RECEIPT = path;
  process.env.ELANOUS_TA_PREFLIGHT_SHA256 = createHash('sha256').update(body).digest('hex');
  process.env.ELANOUS_LAUNCH_HOLD_FILE = join(root, 'no-hold');
  const door = openLaunchRequestDoor({ root: join(root, 'door'), admission: { holdFile: process.env.ELANOUS_LAUNCH_HOLD_FILE } });
  let launches = 0;
  const live = { ...common, live: true, launchRequestDoor: door, launcher: (_args: string[], _cwd?: string, context?: { runId: string }) => { launches++; return { runId: context!.runId }; } };
  await expect(handTask({ ...live, id: 'ta-20261119-other' })).rejects.toThrow('card');
  await expect(handTask({ ...live, text: `${text} 변조` })).rejects.toThrow('card 내용 불일치');
  const validSha = process.env.ELANOUS_TA_PREFLIGHT_SHA256;
  process.env.ELANOUS_TA_PREFLIGHT_SHA256 = 'f'.repeat(64);
  await expect(handTask(live)).rejects.toThrow('sha256 불일치');
  process.env.ELANOUS_TA_PREFLIGHT_SHA256 = validSha;
  expect(launches).toBe(0);
  const result = await handTask(live);
  expect(result.launched).toBe(true);
  expect(result.card.id).toBe(id);
  expect(readTaskCard(id, statePath)?.id).toBe(id);
  expect(result.card.createdAt).toBe(shadow.card.createdAt);
  expect(launches).toBe(1);
});

async function fixture(id: string) {
  const root = mkdtempSync(join(tmpdir(), 'preflight-card-guard-')); dirs.push(root);
  const statePath = join(root, 'tasks.json');
  const common = { text: '대상 경로: src/task-agent/task-hand.ts\n카드 결속', seat: 'TC' as const, statePath,
    prelaunchInspector: () => ({ reason: 'completion-not-code-pr' }) };
  const shadow = await handTask({ ...common, id, live: false });
  const body = JSON.stringify({ kind: 'ta-preflight', createdAt: new Date().toISOString(), target: { card: id }, report: { overall: 'READY' } });
  const path = join(root, 'receipt.json'); writeFileSync(path, body);
  process.env.ELANOUS_TA_PREFLIGHT_RECEIPT = path;
  process.env.ELANOUS_TA_PREFLIGHT_SHA256 = createHash('sha256').update(body).digest('hex');
  process.env.ELANOUS_LAUNCH_HOLD_FILE = join(root, 'no-hold');
  const door = openLaunchRequestDoor({ root: join(root, 'door'), admission: { holdFile: process.env.ELANOUS_LAUNCH_HOLD_FILE } });
  let launches = 0;
  const live = { ...common, live: true, launchRequestDoor: door, draftMetrics: async () => ({ needsOwnerBySeat: {} }),
    launcher: (_args: string[], _cwd?: string, context?: { runId: string }) => { launches++; return { runId: context!.runId }; } };
  return { statePath, shadow: shadow.card, live, launches: () => launches };
}

test('a card changed after receipt validation is rejected inside the write lock', async () => {
  const f = await fixture('ta-20261119-race01');
  const draftMetrics = async () => {
    updateTaskCard(f.statePath, f.shadow.id, current => current ? { ...current, runId: 'run-concurrent' } : undefined);
    return { needsOwnerBySeat: {} };
  };
  await expect(handTask({ ...f.live, draftMetrics })).rejects.toThrow('다른 넘김');
  expect(f.launches()).toBe(0);
  expect(readTaskCard(f.shadow.id, f.statePath)?.runId).toBe('run-concurrent');
});

test('a non-handed card or one with an existing run or PR is never relaunched', async () => {
  const f = await fixture('ta-20261119-closed1');
  for (const patch of [{ status: 'failed' as const }, { runId: 'run-existing' }, { pr: 123 }]) {
    writeTaskCards(f.statePath, [{ ...f.shadow, ...patch }]);
    await expect(handTask(f.live)).rejects.toThrow('발사 가능한 shadow 상태가 아니다');
    expect(f.launches()).toBe(0);
  }
});

test('a receipt-bound card retains its saved numeric budget when handed live', async () => {
  const f = await fixture('ta-20261119-budget1');
  updateTaskCard(f.statePath, f.shadow.id, (current) => current ? { ...current,
    budgetLimits: { timeSec: 3600, usdCap: 3 } } : undefined);
  const result = await handTask(f.live);
  expect(result.launched).toBe(true);
  expect(result.card.budgetLimits).toEqual({ timeSec: 3600, usdCap: 3 }); // 출처: #97840 위 카드 예산 픽스처.
});

test('two concurrent live hand calls for the same receipt dispatch at most once', async () => {
  const f = await fixture('ta-20261119-race02');
  let arrivals = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const draftMetrics = async () => { if (++arrivals === 2) release(); await barrier; return { needsOwnerBySeat: {} }; };
  const outcomes = await Promise.allSettled([handTask({ ...f.live, draftMetrics }), handTask({ ...f.live, draftMetrics })]);
  expect(arrivals).toBe(2);
  expect(f.launches()).toBe(1);
  expect(outcomes.filter(result => result.status === 'fulfilled' && result.value.launched)).toHaveLength(1);
}, 30_000);

test('a claimed card remains closed after admission refuses before dispatch', async () => {
  const f = await fixture('ta-20261119-claim1');
  const denyingDoor: typeof f.live.launchRequestDoor = { ...f.live.launchRequestDoor,
    consume: requestId => ({ status: 'refused', requestId, receiptId: null, receiptAt: null, reason: 'admission refused' }) };
  const first = await handTask({ ...f.live, launchRequestDoor: denyingDoor });
  expect(first.launched).toBe(false);
  expect(f.launches()).toBe(0);
  await expect(handTask(f.live)).rejects.toThrow('발사 가능한 shadow 상태가 아니다');
  expect(f.launches()).toBe(0);
});
