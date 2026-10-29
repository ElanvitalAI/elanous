import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { incidentLastLines, readRunExits, type RunExit } from './harness-incidents.js';

// 실물 무대(격리 --test · L2): 생산 writer(recordRunExit)를 자식 프로세스로 실제 실행해 원장에 행을 남기고,
// 생산 분류 경로(readRunExits)로 되읽어 lastLines 재분류와 unknown 보존을 확인한다.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-incidents-writer-'));
  roots.push(dir);
  return dir;
}

function write(dir: string, exit: RunExit): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    Bun.spawn(['bun', 'src/harness/harness-incidents-writer.fixture.ts', dir, JSON.stringify(exit)], {
      stdout: 'ignore',
      stderr: 'ignore',
      onExit: (_process, code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))),
    });
  });
}

function exitAt(id: string, lastLines?: string[]): RunExit {
  return { runId: id, reason: 'unknown', status: 1, signal: null, at: '2026-10-22T08:00:00.000Z', ...(lastLines ? { lastLines } : {}) };
}

test('실물 writer→readRunExits: 각 terminal marker 를 정규화된 사유로 되읽는다', async () => {
  const dir = root();
  const tails: Array<[string, string[], string]> = [
    ['run-deadline', ['  ❌ failed · 대상 경로: src/x.ts — pod-deadline-exceeded'], 'pod-deadline-exceeded'],
    ['run-dependency', ['  ❌ blocked · 대상 경로: src/x.ts — DEPENDENCY_NEEDS_HUMAN'], 'dependency-needs-human'],
    ['run-needs-human', ['[supervisor] 정지(needs-human)'], 'needs-human'],
  ];
  for (const [id, lines] of tails) await write(dir, exitAt(id, lines));
  const exits = readRunExits(dir);
  for (const [id, , reason] of tails) {
    expect(exits.find((exit) => exit.runId === id)).toMatchObject({ reason, recordedReason: 'unknown', reasonSource: 'lastLines' });
  }
  // ux-sim device 표지는 사유가 아니라 조각 표지 — 사유를 지어내지 않고 device 조각으로 남는다.
  await write(dir, exitAt('run-device', incidentLastLines('❌ failed · 대상 경로: src/ux-sim/hq-seats-device.ts — DEVICE-FIRST')));
  expect(readRunExits(dir).find((exit) => exit.runId === 'run-device')).toMatchObject({ reason: 'unknown', slice: 'device' });
});

test('실물 writer→readRunExits: 빈 꼬리·무증거·충돌 꼬리는 unknown 을 보존한다', async () => {
  const dir = root();
  await write(dir, exitAt('run-empty'));
  await write(dir, exitAt('run-no-evidence', incidentLastLines('그냥 끝났다')));
  await write(dir, exitAt('run-conflict', ['  ❌ failed · a [needs-human] — GOAL_DONE_BOUNDARY_MISSING', '  ❌ blocked · b — DEPENDENCY_NEEDS_HUMAN']));
  const exits = readRunExits(dir);
  for (const id of ['run-empty', 'run-no-evidence', 'run-conflict']) {
    const found = exits.find((exit) => exit.runId === id)!;
    expect(found.reason).toBe('unknown');
    expect(found.recordedReason).toBeUndefined();
    expect(found.reasonSource).toBeUndefined();
  }
});

test('실물 writer 원장 형식 불변: 사유 원문과 lastLines 만 적고 분류 결과는 쓰지 않는다', async () => {
  const dir = root();
  const tail = ['  ❌ failed · 대상 경로: src/x.ts — pod-deadline-exceeded'];
  await write(dir, exitAt('run-format', tail));
  const raw = JSON.parse(readFileSync(join(dir, 'incidents', '2026-10-22.jsonl'), 'utf8').trim()) as RunExit;
  expect(raw).toMatchObject({ runId: 'run-format', reason: 'unknown', lastLines: tail });
  expect(raw.recordedReason).toBeUndefined();
  expect(raw.reasonSource).toBeUndefined();
});
