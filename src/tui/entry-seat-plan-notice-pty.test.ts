import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from '../msg/msg-store.js';
import { mockSeatPtySequence } from '../ux-sim/mock-seat-pty-sequence.js';
import { TEST_FAKE_LLM_RESPONSE_RULES_ENV, TEST_FAKE_LLM_TOOL_CALL_ENV } from '../ux-sim/fake-llm.js';

// PLAN-WIRE-SEAT through the real Next TUI: an unread mail becomes a plan item, its notice is dispatched as its OWN turn (the notice
// branch of dispatchQueued — not the person's submit path), the model finishes its plan in that turn, and the turn end closes the item.
// Regression guard: the notice branch used to return before the plan link learned which turn belonged to the item (#38128 vs #38115).
const BIN = join(import.meta.dir, '..', '..', 'bin', 'elanous.mjs');
const SEAT = 'OPC';
const DONE = 'PLAN-ITEM-DONE';
const HUMAN = 'HUMAN-REPLY';

test('a plan item started from its queue notice is closed when that turn ends with a finished plan', async () => {
  const base = mkdtempSync(join(tmpdir(), 'seat-plan-notice-'));
  const root = join(base, 'seats', SEAT); // the seat is named by the cwd path
  const home = join(base, 'home');
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(join(home, 'elanous-hq', 'seat-state', SEAT), { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } }));
    mkdirSync(join(root, 'msg'), { recursive: true });
    const store = new MsgStore(join(root, 'msg', 'messages.db'));
    try { store.post({ from: 'OP', to: SEAT, body: '#5001 merge 시험 보고' }); } finally { store.close(); }
    const seen: Record<string, string> = {};
    const run = await mockSeatPtySequence({
      executable: process.execPath,
      args: [BIN, '--test={root}', '--config-dir', '{root}', '--test-state-dir', '{root}', '--tui', 'next'],
      root, rows: 36, cols: 130,
      env: {
        HOME: home, ELANOUS_SESSION_ROOT: join(root, 'sessions'), ELANOUS_TEST_FAKE_LLM: '1', ELANOUS_TEST_FAKE_LLM_AS_PROVIDER: '1',
        ELANOUS_TEST_FAKE_LLM_RESPONSE: HUMAN,
        [TEST_FAKE_LLM_RESPONSE_RULES_ENV]: JSON.stringify([{ when: '[계획]', text: DONE }]),
        // The model answers the plan notice by recording a finished plan.
        [TEST_FAKE_LLM_TOOL_CALL_ENV]: JSON.stringify([{ when: '[계획]', name: 'update_plan', args: { plan: [{ step: 'finish the merge report', status: 'completed' }] } }]),
      },
      ready: { label: 'boot', until: (screen) => /Ctrl\+Q (종료|quit)/.test(screen) },
      steps: [
        // A queued notice starts when the running turn settles. The person talks first (a turn that has nothing to do with the plan) …
        { label: 'person turn', text: 'hello there', until: (screen) => { seen.human = screen; return screen.includes(HUMAN); } },
        // … and when it settles, the plan item's notice is dispatched as its own turn (the notice branch) and answered.
        { label: 'notice turn answers', text: '', enter: false, until: (screen) => { seen.answered = screen; return screen.includes(DONE); } },
        { label: 'turn settled', text: '', enter: false, until: (screen) => { seen.settled = screen; return /Turn done|○ done/.test(screen); } },
      ],
    });
    expect(run.exitCode).toBe(0);
    expect(seen.answered).toContain(DONE);
    const saved = JSON.parse(readFileSync(join(root, 'seat-plans', `${SEAT}.json`), 'utf8')) as { items: Array<{ status: string; doneEvidence?: string }> };
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]).toMatchObject({ status: 'done' });
    expect(saved.items[0]!.doneEvidence).toContain('update_plan');
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 180_000);
