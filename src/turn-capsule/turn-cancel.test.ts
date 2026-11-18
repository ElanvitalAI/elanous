import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeLocalChatSession, onLocalChatCapsuleEvent, runLocalChatTurn } from '../tui-client/local-chat-turn.js';
import type { CapsuleEvent } from './contract.js';
import { createTurnCancelRouter, isTurnCancelMessage, TURN_CANCEL_GRACE_MS, TURN_CANCEL_HELD_MAX, TURN_CANCEL_TYPE } from './turn-cancel.js';

describe('turn-cancel router (child side, B2)', () => {
  test('cancels only the listening turn, once; a late or foreign cancel is consumed and ignored', () => {
    const router = createTurnCancelRouter();
    const cancelled: string[] = [];
    const stop = router.listen('tui-2', () => { cancelled.push('tui-2'); });
    expect(router.receive({ type: TURN_CANCEL_TYPE, sessionId: 's', turnId: 'tui-1' })).toBe(true);
    expect(cancelled).toEqual([]);
    expect(router.receive({ type: TURN_CANCEL_TYPE, sessionId: 's', turnId: 'tui-2' })).toBe(true);
    expect(router.receive({ type: TURN_CANCEL_TYPE, sessionId: 's', turnId: 'tui-2' })).toBe(true);
    expect(cancelled).toEqual(['tui-2']);
    stop();
    router.listen('tui-3', () => { cancelled.push('tui-3'); })();
    router.receive({ type: TURN_CANCEL_TYPE, sessionId: 's', turnId: 'tui-3' });
    expect(cancelled).toEqual(['tui-2']);
  });

  test('JUD ⓑ: a cancel before its turn listens (cold boot) is held and fires the moment that turn listens — once', () => {
    const router = createTurnCancelRouter();
    const cancelled: string[] = [];
    expect(router.receive({ type: TURN_CANCEL_TYPE, sessionId: 's', turnId: 'tui-1' })).toBe(true);
    expect(router.heldCount()).toBe(1);
    router.listen('tui-1', () => { cancelled.push('tui-1'); });
    expect(cancelled).toEqual(['tui-1']);
    expect(router.heldCount()).toBe(0);
    router.listen('tui-2', () => { cancelled.push('tui-2'); });
    expect(cancelled).toEqual(['tui-1']);
  });

  test('held cancels are bounded and a late cancel for a finished turn never touches a later turn', () => {
    const router = createTurnCancelRouter();
    for (let i = 0; i < TURN_CANCEL_HELD_MAX + 5; i++) router.receive({ type: TURN_CANCEL_TYPE, sessionId: 's', turnId: `old-${i}` });
    expect(router.heldCount()).toBe(TURN_CANCEL_HELD_MAX);
    const cancelled: string[] = [];
    router.listen('tui-99', () => { cancelled.push('tui-99'); });
    expect(cancelled).toEqual([]);
  });

  test('other IPC messages pass through; malformed cancels are not cancels', () => {
    const router = createTurnCancelRouter();
    expect(router.receive({ type: 'elanous.next-tui.push-now', turnId: 'tui-1' })).toBe(false);
    expect(isTurnCancelMessage({ type: TURN_CANCEL_TYPE, sessionId: 's', turnId: '' })).toBe(false);
    expect(isTurnCancelMessage({ type: TURN_CANCEL_TYPE, turnId: 'tui-1' })).toBe(false);
    expect(isTurnCancelMessage(null)).toBe(false);
  });

  test('grace = the sync capsule cap (10s)', () => {
    expect(TURN_CANCEL_GRACE_MS).toBe(10_000);
  });
});

// A sticky fake child: turn «hold» waits for the host's turn-cancel IPC, answers the cancelled turn, then reports a
// capsule that kept running through the cancel. Every reply carries the child pid.
const FAKE_CHILD = `
import { createInterface } from 'node:readline';
const sessionId = process.argv[process.argv.indexOf('--session') + 1];
let cancel = null;
process.on('message', (message) => {
  if (message && message.type === '${TURN_CANCEL_TYPE}' && cancel && message.turnId === cancel.turnId) cancel.resolve();
});
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.prompt === 'hold') {
    await new Promise((resolve) => { cancel = { turnId: input.id, resolve }; });
    cancel = null;
    console.log(JSON.stringify({ sessionId, error: 'aborted' }));
    process.stderr.write('ELANOUS_TUI_CAPSULE\\t' + JSON.stringify({ type: 'capsule-done', capsuleId: 'bg-1', kind: 'agent',
      sessionId, startedAt: 1, endedAt: 2, status: 'ok', summary: 'kept running' }) + '\\n');
    continue;
  }
  console.log(JSON.stringify({ event: 'delta', turnId: input.id, text: String(process.pid) }));
  console.log(JSON.stringify({ turnId: input.id, reply: 'ok' }));
}
`;

describe('Esc with stage B2 (host ↔ sticky child)', () => {
  const scenario = async (mode: 'on' | 'off', sessionId: string, stages?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'capsule-b2-'));
    const cli = join(dir, 'fake-cli.ts');
    writeFileSync(cli, FAKE_CHILD);
    const saved = process.env.ELANOUS_TURN_CAPSULE_MODE;
    const savedStages = process.env.ELANOUS_TURN_CAPSULE_STAGES;
    process.env.ELANOUS_TURN_CAPSULE_MODE = mode;
    if (stages === undefined) delete process.env.ELANOUS_TURN_CAPSULE_STAGES; else process.env.ELANOUS_TURN_CAPSULE_STAGES = stages;
    const logSpy = spyOn(debug, 'log');
    const pids: string[] = [];
    const capsules: CapsuleEvent[] = [];
    const stop = onLocalChatCapsuleEvent(sessionId, (event) => { capsules.push(event); });
    try {
      await runLocalChatTurn(sessionId, 'first', new AbortController().signal, cli, undefined, (delta) => { pids.push(delta); });
      const esc = new AbortController();
      const held = runLocalChatTurn(sessionId, 'hold', esc.signal, cli);
      await Bun.sleep(300);
      const cancelledAt = performance.now();
      esc.abort();
      await expect(held).rejects.toThrow('응답을 취소했습니다');
      const settleMs = performance.now() - cancelledAt;
      await Bun.sleep(100);
      await runLocalChatTurn(sessionId, 'after', new AbortController().signal, cli, undefined, (delta) => { pids.push(delta); });
      const turnLife = logSpy.mock.calls.filter((call) => call[0] === 'turn-life').map((call) => call[1]);
      return { pids, capsules, settleMs, turnLife };
    } finally {
      logSpy.mockRestore();
      stop();
      await closeLocalChatSession(sessionId);
      if (saved === undefined) delete process.env.ELANOUS_TURN_CAPSULE_MODE; else process.env.ELANOUS_TURN_CAPSULE_MODE = saved;
      if (savedStages === undefined) delete process.env.ELANOUS_TURN_CAPSULE_STAGES;
      else process.env.ELANOUS_TURN_CAPSULE_STAGES = savedStages;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('always on (no flag): Esc cancels the turn, the same child answers next, and its capsule-done still arrives', async () => {
    const { pids, capsules, settleMs, turnLife } = await scenario('on', 'b2-on');
    expect(pids.length).toBe(2);
    expect(pids[1]).toBe(pids[0]);
    expect(turnLife.filter((event) => event === 'turn-life:turn-cancel-sent').length).toBe(1);
    expect(settleMs).toBeLessThan(TURN_CANCEL_GRACE_MS);
    expect(capsules).toEqual([{ type: 'capsule-done', capsuleId: 'bg-1', kind: 'agent', sessionId: 'b2-on',
      startedAt: 1, endedAt: 2, status: 'ok', summary: 'kept running' }]);
  }, 20_000);
});

// JUD #38560 ⓑ — cold boot: the IPC handler is installed at module load (as in repl/index.ts) but the turn loop
// registers its listener only after a slow boot. An Esc sent in between must still end that turn.
const routerPath = join(import.meta.dir, 'turn-cancel.ts');
const BOOTING_CHILD = `
import { createInterface } from 'node:readline';
import { createTurnCancelRouter } from ${JSON.stringify(routerPath)};
const sessionId = process.argv[process.argv.indexOf('--session') + 1];
const router = createTurnCancelRouter();
process.on('message', (message) => { router.receive(message); });
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.prompt === 'boot') await new Promise((resolve) => setTimeout(resolve, 800));
  let stop;
  const cancelled = new Promise((resolve) => { stop = router.listen(input.id, resolve); });
  if (input.prompt === 'boot') { await cancelled; stop(); console.log(JSON.stringify({ sessionId, error: 'aborted' })); continue; }
  stop();
  console.log(JSON.stringify({ event: 'delta', turnId: input.id, text: String(process.pid) }));
  console.log(JSON.stringify({ turnId: input.id, reply: 'ok' }));
}
`;

describe('Esc during a cold boot (JUD #38560 ⓑ · stage B2)', () => {
  test('a cancel sent before the child listens still ends that turn fast — no fallback kill, same child next', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capsule-b2-boot-'));
    const cli = join(dir, 'fake-cli.ts');
    writeFileSync(cli, BOOTING_CHILD);
    const saved = { mode: process.env.ELANOUS_TURN_CAPSULE_MODE, stages: process.env.ELANOUS_TURN_CAPSULE_STAGES };
    process.env.ELANOUS_TURN_CAPSULE_MODE = 'on';
    delete process.env.ELANOUS_TURN_CAPSULE_STAGES;
    const pids: string[] = [];
    try {
      await runLocalChatTurn('b2-boot', 'first', new AbortController().signal, cli, undefined, (delta) => { pids.push(delta); });
      const esc = new AbortController();
      const held = runLocalChatTurn('b2-boot', 'boot', esc.signal, cli);
      await Bun.sleep(50);
      const cancelledAt = performance.now();
      esc.abort();
      await expect(held).rejects.toThrow('응답을 취소했습니다');
      expect(performance.now() - cancelledAt).toBeLessThan(3_000); // 출처: #38560 JUD ⓑ — well under the 10 s fallback grace (old code ended at 10,003 ms)
      await runLocalChatTurn('b2-boot', 'after', new AbortController().signal, cli, undefined, (delta) => { pids.push(delta); });
      expect(pids.length).toBe(2);
      expect(pids[1]).toBe(pids[0]);
    } finally {
      await closeLocalChatSession('b2-boot');
      for (const [key, value] of [['ELANOUS_TURN_CAPSULE_MODE', saved.mode], ['ELANOUS_TURN_CAPSULE_STAGES', saved.stages]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
