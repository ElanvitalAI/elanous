// TURN-FIELD-BUG-1 — the parent always answers the child's ScheduleWakeup call (HAND-ELN-ELS-MCP #89315 · JUD-B tuiPid 48751:
// three calls «next TUI did not answer» at 15001ms; the parent handled one 54s late). Literal times, fake clocks.
import { describe, expect, test } from 'bun:test';
import type { LLMToolDef } from '../plugins/core/types.js';
import { answerWakeupCall, createReplWakeupTool, replyToWakeupCall, type WakeupCallMessage } from './next-wakeup.js';

const tool = (handler: LLMToolDef['handler']): LLMToolDef => ({ name: 'ScheduleWakeup', description: '', parameters: {}, handler }) as unknown as LLMToolDef;
const call = (extra: Partial<WakeupCallMessage> = {}): WakeupCallMessage =>
  ({ type: 'elanous.wakeup.call', callId: 'c1', args: { action: 'schedule', reason: 'x', delaySeconds: 60 }, ...extra });

function clock(start = 5_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

describe('answerWakeupCall — never leaves the child without an answer', () => {
  test('a handler that never settles → error answer at the cap (50ms here), well inside the child\'s 15s', async () => {
    const life: Array<[string, Record<string, unknown>]> = [];
    const started = Date.now();
    // 출처: #38599 — a 50ms cap stands in for WAKEUP_ANSWER_CAP_MS (10s) so the test is fast
    const reply = await answerWakeupCall(tool(() => new Promise(() => {})), call(), { capMs: 50, turnLifeLog: (e, d) => { life.push([e, d]); } });
    // 출처: #38599 — the error answer arrives at the cap, far below the child's 15s wait
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(reply).toEqual({ type: 'elanous.wakeup.result', callId: 'c1',
      result: { error: "ScheduleWakeup: the TUI did not finish within 50ms — run action:'list' before retrying (it may still be scheduled)" } });
    expect(life.map(([e, d]) => [e, d.result ?? null])).toEqual([['turn-life:wakeup-call-received', null], ['turn-life:wakeup-call-answered', 'timeout']]);
  });

  test('a handler that rejects → error answer', async () => {
    const reply = await answerWakeupCall(tool(async () => { throw new Error('scheduler disposed'); }), call(), { turnLifeLog: () => {} });
    expect(reply.result).toEqual({ error: 'ScheduleWakeup failed: scheduler disposed' });
  });

  test('a handler that throws synchronously → error answer', async () => {
    const reply = await answerWakeupCall(tool(() => { throw new Error('boom'); }), call(), { turnLifeLog: () => {} });
    expect(reply.result).toEqual({ error: 'ScheduleWakeup failed: boom' });
  });

  test('turn-life: received carries the delivery lag from the child\'s sentAt; answered carries result and ms', async () => {
    const c = clock(10_000);
    const life: Array<[string, Record<string, unknown>]> = [];
    await answerWakeupCall(tool(async () => { c.advance(7); return { scheduled: { id: 'w1' } }; }), call({ sentAt: 9_946 }),
      { now: c.now, turnLifeLog: (e, d) => { life.push([e, d]); } });
    expect(life).toEqual([
      ['turn-life:wakeup-call-received', { callId: 'c1', action: 'schedule', lagMs: 54 }],
      ['turn-life:wakeup-call-answered', { callId: 'c1', action: 'schedule', result: 'ok', ms: 7, lagMs: 54 }],
    ]);
  });

  test('an {error} result from the scheduler is answered as is, marked error', async () => {
    const life: Array<[string, Record<string, unknown>]> = [];
    const reply = await answerWakeupCall(tool(async () => ({ error: 'delay too short' })), call(), { turnLifeLog: (e, d) => { life.push([e, d]); } });
    expect(reply.result).toEqual({ error: 'delay too short' });
    expect(life[1]![1].result).toBe('error');
  });
});

describe('replyToWakeupCall — the parent IPC branch sends exactly one reply on every path', () => {
  test('throwing, rejecting and hanging handlers each send one error reply', async () => {
    for (const handler of [() => { throw new Error('a'); }, async () => { throw new Error('b'); }, () => new Promise(() => {})] as LLMToolDef['handler'][]) {
      const sent: unknown[] = [];
      // 출처: #38599 — short fixture cap; the hanging handler must still produce one reply
      await replyToWakeupCall(tool(handler), call(), (reply) => { sent.push(reply); }, { capMs: 20, turnLifeLog: () => {} });
      expect(sent).toHaveLength(1);
      expect((sent[0] as { result: { error?: string } }).result.error).toBeString();
    }
  });

  test('a send that throws (child exited) does not reject', async () => {
    await expect(replyToWakeupCall(tool(async () => ({ ok: true })), call(), () => { throw new Error('EPIPE'); }, { turnLifeLog: () => {} })).resolves.toBeUndefined();
  });
});

describe('createReplWakeupTool — the child side', () => {
  function fakeProc() {
    const listeners = new Set<(m: unknown) => void>();
    const sent: WakeupCallMessage[] = [];
    return {
      sent,
      deliver: (m: unknown) => { for (const l of listeners) l(m); },
      proc: { send: (m: unknown) => { sent.push(m as WakeupCallMessage); return true; },
        on: (_e: 'message', l: (m: unknown) => void) => { listeners.add(l); }, off: (_e: 'message', l: (m: unknown) => void) => { listeners.delete(l); } },
    };
  }

  test('the call carries sentAt; a timeout tells the model to list before retrying (no duplicate wakeups)', async () => {
    const f = fakeProc();
    // 출처: #38599 — short fixture wait standing in for the child's 15s
    const wake = createReplWakeupTool(f.proc, { ELANOUS_NEXT_TUI_WAKEUP_IPC: '1' }, { timeoutMs: 20 })!;
    const before = Date.now();
    const result = await wake.dispatch({ action: 'schedule', reason: 'x' });
    expect(typeof f.sent[0]!.sentAt).toBe('number');
    expect(f.sent[0]!.sentAt!).toBeGreaterThanOrEqual(before);
    expect(result).toEqual({ error: "ScheduleWakeup: next TUI did not answer within 20ms — it may still schedule this; run action:'list' before retrying" });
  });

  test('an answer in time resolves with the parent\'s result', async () => {
    const f = fakeProc();
    // 출처: #38599 — a wait long enough that the in-time answer always wins
    const wake = createReplWakeupTool(f.proc, { ELANOUS_NEXT_TUI_WAKEUP_IPC: '1' }, { timeoutMs: 1_000 })!;
    const pending = wake.dispatch({ action: 'list' });
    f.deliver({ type: 'elanous.wakeup.result', callId: f.sent[0]!.callId, result: { wakeups: [] } });
    expect(await pending).toEqual({ wakeups: [] });
  });
});
