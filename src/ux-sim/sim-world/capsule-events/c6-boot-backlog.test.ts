import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
// 출처: 2026-11-20 node-b `sim world run capsule-events` 실측 — 세계 우주가 소스 트리의 .elanous-test 아래에
// 놓이면 debug/log.ts resolveLogDir 이 소스 경계 안쪽 cwd 를 `<cwd>/log` 로 보내, 판독기가 .elanous/debug 만
// 보던 C6 이 «turn timeline unreadable»(원장 0행)로 회귀 판정했다. 위 시험은 tmpdir 우주라 이 갈래를 못 덮었다.
test('C6 reads the turn timeline when the universe sits inside the source tree (log/ ledger)', async () => {
  const base = join(import.meta.dir, '../../../../.elanous-test');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'c6-intree-'));
  const events: Array<{ name: string; data: unknown }> = [];
  try {
    const ctx = { universeRoot: root, recorder: { event: (name: string, data: unknown) => { events.push({ name, data }); } } } as unknown as SimWorldScenarioContext;
    const result = await simWorldScenarios[0]!.run(ctx);
    if (!result.ok) throw new Error(`C6 reason: ${String(result.reason)} | diff: ${String(result.diff)}`);
    expect(result.ok).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 180_000 }); // 출처: 위 시험과 같은 실 TUI 부팅 예산.
