import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';

/** [턴 근본 O2 realpath FU] C4 — TURN-CAPSULE-EVENTS R1 (JUD #38875): the real entry path (bin/elanous.mjs
 * --tui next → src/tui/entry.ts) must hand the wake scheduler a turn-event bus, so a scheduled wake's
 * arrival lands on the bus — `turn-life:event-queued` with source `wakeup` — observably in the isolated
 * root's debug JSONL, and the wake turn's prompt lands in the session store. The string-only wire test
 * (entry-c4-turn-event-bus-wire.test.ts) cannot prove this; this one boots the real TUI in a real PTY. */
test('real entry path: a ScheduleWakeup tool call publishes a bus event observable on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'c4-bus-realpath-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    // The front process batches debug rows and flushes on a 100 ms debounce (FLUSH_INTERVAL_MS, src/debug/log.ts);
    // its exit path runs beforeExit — not process 'exit' — so rows still in the buffer at Ctrl+Q are lost. The wake
    // turn is slowed and the TUI is kept alive past the flush window so the fire rows reach disk before the quit.
    let settleAt = 0;
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs'), '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 30, cols: 120,
      env: { ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAST_WAKEUP_CLOCK: '1', ELANOUS_TUI_GOAL_CONTINUE: '0',
        ELANOUS_TEST_FAKE_LLM_RESPONSE_RULES: JSON.stringify([{ when: '[예약 깨움', text: 'C4-WOKE' }, { when: 'C4-WAIT', text: 'C4-SCHEDULED' }]),
        // 출처: schedule-wakeup.ts R1(C4) — 예약 도래가 버스 항목(source 'wakeup')으로 publish 된다.
        ELANOUS_TEST_FAKE_LLM_TOOL_CALL: JSON.stringify({ when: 'C4-WAIT', name: 'ScheduleWakeup', args: { delaySeconds: 60, reason: 'C4 bus realpath check' } }),
        // 출처: fake-llm.ts TEST_FAKE_LLM_DELAY_* — 깨움 턴을 400 ms 늘려 fire 관측행이 100 ms flush 창 안에 갇히지 않게 한다.
        ELANOUS_TEST_FAKE_LLM_DELAY_MS: '400', ELANOUS_TEST_FAKE_LLM_DELAY_WHEN: '[예약 깨움',
        ELANOUS_CONFIG_DIR: root, ELANOUS_STATE_DIR: root },
      ready: { label: 'boot', until: (current) => /Ctrl\+Q (종료|quit)/.test(current) },
      steps: [
        { label: 'schedule', text: 'C4-WAIT please', until: (current) => current.includes('C4-SCHEDULED') },
        // The fast wakeup clock makes the 60 s wake arrive now; the wake turn must answer on screen.
        { label: 'woke', keys: '', until: (current) => { if (current.includes('C4-WOKE')) { settleAt = Date.now() + 1500; return true; } return false; } },
        // 출처: src/debug/log.ts FLUSH_INTERVAL_MS=100 — 종료 전 디스크 flush 마칠 여유(1500 ms)를 둔다.
        { label: 'settle', keys: '', until: () => Date.now() >= settleAt },
      ],
    });
    expect(run.exitCode).toBe(0);
    // ① The wake really opened a turn through the real TUI: its prompt (formatWakeupPrompt, schedule-wakeup.ts)
    //    is stored as a user message in the isolated session store.
    const storeRows = readdirSync(join(root, 'sessions')).filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => readFileSync(join(root, 'sessions', name), 'utf8').split('\n').filter(Boolean))
      .map((line) => { try { return JSON.parse(line) as { role?: unknown; content?: unknown }; } catch { return null; } });
    // 출처: schedule-wakeup.ts:300 formatWakeupPrompt — 깨움 턴 사용자 글 머리 '[예약 깨움 w1]'.
    // 출처: JUD 20261119 FU — the real PTY path must record at least one user wake-up row (real run).
    expect(storeRows.some((row) => row && row.role === 'user' && typeof row.content === 'string' && row.content.startsWith('[예약 깨움 w1]'))).toBe(true);
    // ② The scheduler fired that wake (schedule-wakeup.ts fireBody observation), and ③ the entry-wired bus
    //    (entry.ts createTurnEventBus → publishEvent) logged the queued event with source 'wakeup'.
    const debugDir = join(root, '.elanous', 'debug');
    const events = readdirSync(debugDir).filter((name) => name.startsWith('debug-'))
      .flatMap((name) => readFileSync(join(debugDir, name), 'utf8').split('\n').filter(Boolean))
      .map((line) => { try { return JSON.parse(line) as { category?: unknown; event?: unknown; data?: Record<string, unknown> }; } catch { return null; } });
    // 출처: schedule-wakeup.ts fireBody — log('tui.wakeup','fired',{id:'w1',…}).
    const fired = events.filter((row) => row && row.category === 'tui.wakeup' && row.event === 'fired' && row.data?.id === 'w1');
    // 출처: JUD 20261119 FU — the fast clock must fire the schedule at least once.
    expect(fired.some((x) => x)).toBe(true);
    // 출처: bus.ts publish → log('turn-life:event-queued',{eventId,source,…}) — entry.ts:2278 publishEvent 배선의 산출물(schedule-wakeup.ts:470).
    const queued = events.filter((row) => row && row.category === 'turn-life' && row.event === 'turn-life:event-queued'
      && row.data?.source === 'wakeup' && typeof row.data?.eventId === 'string' && row.data.eventId.startsWith('wakeup-w1-'));
    // 출처: JUD 20261119 FU — the real debug JSONL must queue at least one wakeup event.
    expect(queued.some((x) => x)).toBe(true); // queued events non-empty
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
