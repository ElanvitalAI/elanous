import { describe, expect, test } from 'bun:test';
import { createTurnStallMailer, createTurnStallReporter } from './turn-stall-report.js';

// 출처: #38515 — the 10 min default (24 h stream-duration measurement in the PR body)
const FIRE = { provider: 'openrouter', model: 'qwen/qwen3.8-max', quietMs: 600_000, limitMs: 600_000 };

function reporter(seat: string | null, recipients: string[], fail = false) {
  const mails: Array<{ from: string; to: readonly string[]; body: string }> = [];
  const events: Array<[string, Record<string, unknown>, string]> = [];
  const report = createTurnStallReporter({
    seat, sessionId: 'abcdef1234', recipients,
    mailer: async (mail) => { if (fail) throw new Error('ledger locked'); mails.push(mail); },
    log: (event, data, level) => { events.push([event, data, level]); },
  });
  return { report, mails, events };
}

describe('ELN-TURN-STALL-WATCHDOG turn report', () => {
  test('nothing fired → no event, no mail', async () => {
    const { report, mails, events } = reporter('JUD-B', ['OP']);
    await report.finish({ kind: 'recovered', provider: 'grok' });
    expect(mails).toEqual([]);
    expect(events).toEqual([]);
  });

  test('one fire, recovered → one line to OP, from the seat, and a warn event', async () => {
    const { report, mails, events } = reporter('JUD-B', ['OP']);
    report.note(FIRE);
    await report.finish({ kind: 'recovered', provider: 'grok' });
    expect(mails).toEqual([{ from: 'JUD-B', to: ['OP'],
      body: '[turn-stall] JUD-B · no output for 10 min (limit 10 min) on openrouter/qwen/qwen3.8-max · recovered on grok · session abcdef12' }]);
    expect(events.map(([event, , level]) => `${event}:${level}`)).toEqual(['turn-stall:warn', 'turn-stall-mailed:warn']);
  });

  test('exhausted → error event, the line names the error; finishing twice sends one line', async () => {
    const { report, mails, events } = reporter('JUD-B', ['OP']);
    report.note(FIRE);
    report.note({ ...FIRE, provider: 'grok', model: 'grok-4.7' });
    await report.finish({ kind: 'exhausted', error: 'fallback candidates exhausted' });
    await report.finish({ kind: 'exhausted', error: 'again' });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.body).toBe('[turn-stall] JUD-B · no output for 10 min (limit 10 min) on openrouter/qwen/qwen3.8-max → grok/grok-4.7 · chain exhausted, turn ended with error: fallback candidates exhausted · session abcdef12');
    expect(events[0]![2]).toBe('error');
  });

  test('the stalled seat never mails itself; an extra owner is added once', async () => {
    const { report, mails } = reporter('HAND-ELN-MSG', ['OP', 'HAND-ELN-MSG', 'TC', 'TC']);
    report.note(FIRE);
    await report.finish({ kind: 'aborted' });
    expect(mails[0]!.to).toEqual(['OP', 'TC']);
  });

  test('no seat → said as a skipped event, no mail', async () => {
    const { report, mails, events } = reporter(null, ['OP']);
    report.note(FIRE);
    await report.finish({ kind: 'recovered', provider: null });
    expect(mails).toEqual([]);
    expect(events.map(([event, data]) => [event, data.reason])).toEqual([['turn-stall', undefined], ['turn-stall-mail-skipped', 'no-seat']]);
  });

  test('the mailer fails → an error event, never a throw', async () => {
    const { report, events } = reporter('JUD-B', ['OP'], true);
    report.note(FIRE);
    await report.finish({ kind: 'recovered', provider: 'grok' });
    expect(events.at(-1)![0]).toBe('turn-stall-mail-failed');
    expect(events.at(-1)![1].error).toBe('ledger locked');
  });

  // ── #38515 r1 must-fixes (remote-terra-38515-38515-a983090cd35e.json) ──

  test('r1 MF3: the second recipient\'s post fails → the first is still stored AND woken, the failure is named', async () => {
    const posted: string[] = [];
    const woken: Array<[string, number]> = [];
    const mailer = createTurnStallMailer({
      // A fake ledger: only post's recipient and returned id matter here (`as never` = the Message fields are not read).
      openStore: async () => ({
        post: ({ to }: { to: string }) => { if (to === 'RES') throw new Error('database is locked'); posted.push(to); return { id: 700 + posted.length }; },
        close: () => {},
      }) as never,
      wake: async (recipient, id) => { woken.push([recipient, id]); },
    });
    const result = await mailer({ from: 'JUD-B', to: ['OP', 'RES'], body: 'x' });
    expect(posted).toEqual(['OP']);
    expect(woken).toEqual([['OP', 701]]);
    expect(result).toEqual({ posted: [{ to: 'OP', id: 701 }], failed: [{ to: 'RES', stage: 'post', error: 'database is locked' }] });
  });

  test('r1 MF4: a wake failure is an error event of its own, next to «mailed» for the stored mail', async () => {
    const events: Array<[string, Record<string, unknown>, string]> = [];
    const report = createTurnStallReporter({
      seat: 'JUD-B', sessionId: 'abcdef1234', recipients: ['OP'],
      mailer: createTurnStallMailer({
        openStore: async () => ({ post: () => ({ id: 42 }), close: () => {} }) as never,
        wake: async () => { throw new Error('tmux pane gone'); },
      }),
      log: (event, data, level) => { events.push([event, data, level]); },
    });
    report.note(FIRE);
    await report.finish({ kind: 'recovered', provider: 'grok' });
    expect(events.map(([event, , level]) => `${event}:${level}`)).toEqual(['turn-stall:warn', 'turn-stall-mailed:warn', 'turn-stall-mail-failed:error']);
    expect(events[2]![1]).toEqual({ sessionId: 'abcdef1234', to: ['OP'], stage: 'wake', error: 'tmux pane gone' });
  });
});
