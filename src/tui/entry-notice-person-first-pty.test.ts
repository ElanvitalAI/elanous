import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_RESPONSE_RULES_ENV } from '../ux-sim/fake-llm.js';

// OP #129540 (entry wiring regression, SEAT-NOTICE-BUNDLE-DRAIN): 30 notices are waiting when a person line is
// queued BEHIND them. The next turn must be the person's line — the notice bundle comes the turn after. The
// person's door reservation is never stolen by drainNotices (dispatchQueued: opener 'person' skips the drain).
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SEAT = 'OPD';
const ONE = 'ONE-ANSWER';
const TWO = 'TWO-ANSWER';
const NOTICE = 'NOTICE-ANSWER';

test('a queued person line goes next even with waiting notices — the bundle comes the turn after', async () => {
  const base = mkdtempSync(join(tmpdir(), 'notice-person-first-'));
  const root = join(base, 'seats', SEAT);
  const home = join(base, 'home');
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    mkdirSync(join(root, 'msg'), { recursive: true });
    const store = new MsgStore(join(root, 'msg', 'messages.db'));
    try { for (let i = 1; i <= 30; i += 1) store.post({ from: 'OP', to: SEAT, body: `#60${String(i).padStart(2, '0')} 알림 ${i}` }); }
    finally { store.close(); }
    const order: string[] = [];
    const mark = (key: 'one' | 'two' | 'notice', screen: string): void => {
      const token = key === 'one' ? ONE : key === 'two' ? TWO : NOTICE;
      if (!order.includes(key) && screen.includes(token)) order.push(key);
    };
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 36, cols: 130,
      env: {
        HOME: home, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: ONE,
        [TEST_FAKE_LLM_RESPONSE_RULES_ENV]: JSON.stringify([
          { when: 'person line two', text: TWO },
          { when: '[notice', text: NOTICE },
        ]),
      },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        { label: 'person one', text: 'person line one', until: (screen) => { mark('one', screen); return screen.includes(ONE); } },
        // typed while the first turn is still running — the person line queues BEHIND the 30 waiting notices.
        { label: 'person two queued', text: 'person line two', until: (screen) => { mark('two', screen); mark('notice', screen); return screen.includes(TWO); } },
        { label: 'bundle answers', text: '', enter: false, until: (screen) => { mark('notice', screen); return screen.includes(NOTICE); } },
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(order).toContain('two');
    expect(order).toContain('notice');
    // The contract (OP #129540): 다음 턴 = 사람 줄 · 그다음 턴 = 알림 묶음.
    expect(order.indexOf('two')).toBeLessThan(order.indexOf('notice'));
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 180_000);
