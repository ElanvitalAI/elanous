import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { planAction, repoFileExists, runSeatLoopOnce, seatTargetPaths, seatTaskText, type SeatDeps, type SeatItem } from './seat-loop.js';

const title = 'src/seat-loop/seat-loop.ts 구현';
const item: SeatItem = { source: 'checklist', kind: 'cell', id: 'TC-path', version: '0.2.9', title, text: title,
  evidence: 'src/seat-loop/seat-task-text.test.ts 검증', status: 'yellow' };
const plain = `[TC 자리 · 0.2.9 체크리스트 칸 TC-path · 역할 docs/roles/TC.md] ${title}`;
const targetEvents = (spy: ReturnType<typeof spyOn<typeof debug, 'log'>>) => spy.mock.calls
  .filter(([category, event]) => category === 'seat.loop' && event === 'target-paths');

test('checklist target paths lead the task text; planning (not comparison) emits one count observation', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    expect(seatTaskText('TC', item)).toBe(`대상 경로: src/seat-loop/seat-loop.ts · src/seat-loop/seat-task-text.test.ts\n${plain}`);
    expect(targetEvents(log)).toEqual([]);
    expect(planAction(item, 'TC').text).toBe(seatTaskText('TC', item));
    expect(targetEvents(log)).toEqual([['seat.loop', 'target-paths', { item: 'TC-path', count: 2 }]]);
  } finally { log.mockRestore(); }
});

test('without target paths and for non-checklist sources the task text is byte-identical and no paths are observed', () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const noPaths = { ...item, title: '구현\r\n검토', text: '구현\r\n검토', evidence: '추가 근거' };
    expect(seatTaskText('TC', noPaths)).toBe('[TC 자리 · 0.2.9 체크리스트 칸 TC-path · 역할 docs/roles/TC.md] 구현 검토');
    for (const [source, where] of [
      ['request', '자리 요청 TC-path'], ['hook', '웹훅 작업 카드 TC-path'], ['seat-question', '자리 요청 TC-path'],
    ] as const) {
      expect(seatTaskText('TC', { ...item, source })).toBe(`[TC 자리 · ${where} · 역할 docs/roles/TC.md] ${title}`);
    }
    expect(targetEvents(log)).toEqual([]);
  } finally { log.mockRestore(); }
});

test('a path through a symlink that leaves the root is refused by the default file check', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-target-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'seat-target-outside-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'inside.ts'), 'export {};\n');
    writeFileSync(join(outside, 'file.ts'), 'export {};\n');
    symlinkSync(join(outside, 'file.ts'), join(root, 'src', 'link.ts'));
    const isFile = repoFileExists(root);
    expect(isFile('src/inside.ts')).toBe(true);
    expect(isFile('src/link.ts')).toBe(false);
    expect(isFile('src/missing.ts')).toBe(false);
    expect(isFile('src')).toBe(false);
    const linked = { ...item, title: 'src/link.ts 와 src/inside.ts 구현', evidence: '' };
    expect(seatTargetPaths(linked, isFile)).toEqual(['src/inside.ts']);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('live-safe checklist queue receives the prefixed text without changing the key or item snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-task-text-'));
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    mkdirSync(join(root, 'seat-requests'));
    const captured: Array<{ text: string; key: string; item: SeatItem }> = [];
    const now = new Date('2026-10-02T23:20:00Z');
    const deps: SeatDeps = { root, repo: root, now: () => now, config: { mode: 'live-safe', seats: ['TC'] },
      read: (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } },
      versions: () => ['0.2.9'], schedules: () => [{ version: '0.2.9', cutAt: '2099-01-01T00:00:00Z' }],
      checklistItems: () => [{ id: item.id, title: item.title, status: 'yellow', owner: 'TC', evidence: item.evidence }],
      queueItems: () => [], running: () => [], run: async () => '{"outcome":"proceed"}',
      enqueue: async (_seat, text, _root, key, picked) => {
        captured.push({ text, key, item: picked });
        return { id: 'hq-12345678-1234-1234-1234-123456789abc' };
      } };
    const result = await runSeatLoopOnce('TC', deps);
    expect(result).toMatchObject({ status: 'queued', item: { source: 'checklist', id: 'TC-path', title, text: title, evidence: item.evidence } });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.text).toBe(`대상 경로: src/seat-loop/seat-loop.ts · src/seat-loop/seat-task-text.test.ts\n${plain}`);
    expect(captured[0]!.item).toEqual((result as { item: SeatItem }).item);
    const picked = captured[0]!.item;
    const snapshot = JSON.stringify([picked.title, picked.text, picked.evidence ?? null, picked.status ?? null]);
    const identity = `${picked.source}:${picked.version ?? ''}:${picked.id}:${JSON.stringify([picked.evidenceHash ?? null, snapshot])}`;
    expect(captured[0]!.key).toBe(`seat-loop:TC:${createHash('sha256').update(identity).digest('hex')}`);
    expect(targetEvents(log)).toHaveLength(1);
    expect(targetEvents(log)[0]?.[2]).toEqual({ item: 'TC-path', count: 2 });
  } finally { log.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
