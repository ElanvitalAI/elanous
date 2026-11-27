import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/** [턴 근본 배선 #5] C4 (CC-2) — TURN-CAPSULE-EVENTS R1: entry hands the wake scheduler a turn-event bus
 *  so late wakes publish TurnEvents (내부 문서 `TURN-CAPSULE-EVENTS`). No switch — production always injects. */
describe('entry C4 — turn-event bus is wired into next-wakeup unconditionally', () => {
  const entry = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');

  test('creates exactly one bus and injects publishEvent into createNextTuiWakeup', () => {
    expect(entry.split('createTurnEventBus()').length - 1).toBe(1); // 출처: 내부 문서 `TURN-CAPSULE-EVENTS` R1/C4 — 버스는 하나만 만든다.
    expect(entry.includes('        publishEvent: (event) => {\n          turnEventBus.publish(event);\n')).toBe(true);
    // The bus handle must exist before the factory call so the injected port never sees an unfinished value.
    expect(entry.indexOf('const turnEventBus = createTurnEventBus();') < entry.indexOf('wakeup = createNextTuiWakeup({')).toBe(true);
    // No stage switch for this wiring — the default path is the only path.
    expect(entry.includes("readCapsuleStage('C4'")).toBe(false);
  });

  test('publishEvent lands inside the createNextTuiWakeup deps object', () => {
    const wakeStart = entry.indexOf('wakeup = createNextTuiWakeup({');
    const depsEnd = entry.indexOf('...retroDep,', wakeStart);
    expect(depsEnd > wakeStart).toBe(true); // 출처: 내부 문서 `TURN-CAPSULE-EVENTS` R1/C4 — deps 블록 끝 표지.
    // #38905 wiring: the port publishes every event on the bus, then may open the turn door for a late wake.
    const deps = entry.slice(wakeStart, depsEnd);
    expect(deps.includes('        publishEvent: (event) => {\n          turnEventBus.publish(event);\n')).toBe(true);
    expect(deps.split('turnEventBus.publish(').length - 1).toBe(1);
  });
});
