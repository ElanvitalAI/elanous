import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { seatReport } from './seat-report.js';
import { seatLedgerPath } from './seat-loop.js';

const now = new Date('2026-10-02T23:20:00Z');

test('report: launch, decision, skip in one paragraph; without --post no sending', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const path = seatLedgerPath('TC', root, now);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      { seat: 'TC', at: now.toISOString(), status: 'launched', item: { source: 'checklist', id: 'K1', title: 'build', text: 'build', version: '0.2.9' }, runId: 'run-12345678-1234-1234-1234-123456789abc' },
      { seat: 'TC', at: now.toISOString(), status: 'hitl', item: { source: 'checklist', id: 'K2', title: '게시', text: '게시' } },
      { seat: 'TC', at: now.toISOString(), status: 'skipped-budget', item: { source: 'request', id: 'a', title: 'wait', text: 'wait' } },
    ].map((v) => JSON.stringify(v)).join('\n') + '\n');
    const calls: unknown[] = [];
    const deps = { root, now: () => now, config: { mode: 'shadow' as const, reportPr: 16815 }, send: async (...args: unknown[]) => { calls.push(args); } };
    const result = await seatReport('TC', deps);
    expect(result.body).toContain('발사 0.2.9 K1 build (run-12345678-1234-1234-1234-123456789abc)');
    expect(result.body).toContain('결정 상정 K2 게시');
    expect(result.body).toContain('건너뜀 skipped-budget a wait');
    expect(result.body.split('\n')).toHaveLength(1);
    expect(result.body).toStartWith('**[TC]** {{TS}} → 보고');
    expect(calls).toHaveLength(0);
    expect((await seatReport('TC', { ...deps, post: true })).posted).toBe(true);
    expect(calls).toEqual([[result.body, 'TC', 16815]]);
    expect((await seatReport('TC', { ...deps, config: { mode: 'shadow' }, post: true })).posted).toBe(false);
    expect(calls).toHaveLength(1);
    writeFileSync(path, JSON.stringify({ seat: 'TC', at: now.toISOString(), status: 'outcome-unknown',
      item: { source: 'request', id: 'b', title: 'verify', text: 'verify' } }) + '\n');
    expect((await seatReport('TC', deps)).body).toContain('결과 확인 필요 outcome-unknown b verify');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('report: one line per item, last state wins — attempting then launched is not «unconfirmed»', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-report-'));
  try {
    const path = seatLedgerPath('TC', root, now);
    mkdirSync(dirname(path), { recursive: true });
    const k1 = { source: 'checklist', id: 'K1', title: 'build', text: 'build', version: '0.2.9' };
    const k2 = { source: 'checklist', id: 'K2', title: 'ship', text: 'ship', version: '0.2.9' };
    writeFileSync(path, [
      { seat: 'TC', at: now.toISOString(), status: 'attempting', item: k1 },
      { seat: 'TC', at: now.toISOString(), status: 'launched', item: k1, runId: 'run-12345678-1234-1234-1234-123456789abc' },
      { seat: 'TC', at: now.toISOString(), status: 'attempting', item: k2 },
    ].map((v) => JSON.stringify(v)).join('\n') + '\n');
    const body = (await seatReport('TC', { root, now: () => now, config: { mode: 'on' } })).body;
    expect(body).toContain('발사 0.2.9 K1 build');
    expect(body).not.toContain('결과 확인 필요 attempting 0.2.9 K1');
    expect(body).toContain('결과 확인 필요 attempting 0.2.9 K2 ship');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
