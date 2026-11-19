import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SimWorldScenarioContext } from '../types.js';
import { simWorldScenarios } from './c6-boot-backlog.js';

test('C6 boot backlog race holds the person first, no loss, no simultaneous turns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c6-boot-'));
  const events: Array<{ name: string; data: unknown }> = [];
  try {
    const ctx = { universeRoot: root, recorder: { event: (name: string, data: unknown) => { events.push({ name, data }); } } } as unknown as SimWorldScenarioContext;
    const result = await simWorldScenarios[0]!.run(ctx);
    // The boot backlog wiring landed on main (the seat-mail queue consumes the pre-existing
    // unread mail at boot), so the designed honest-red lock flipped green: the person's first
    // Enter still goes first, both backlog notices are delivered into later turns, no turn
    // overlap, clean exit. 출처: 2026-11-19 병합 뒤 실측(main 디버그 원장 data 객체화 포함).
    if (!result.ok) throw new Error(`C6 reason: ${String(result.reason)} | diff: ${String(result.diff)}`);
    expect(result.ok).toBe(true);
    expect(events).toEqual([{ name: 'c6-boot-race',
      data: { personTurnOpened: true, personFirst: true, backlogDelivered: 2, overlap: false, exitCode: 0 } }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 180_000 }); // 출처: #38542 실 TUI 부팅 시험 예산.