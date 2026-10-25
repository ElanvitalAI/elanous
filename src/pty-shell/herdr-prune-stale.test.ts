import { describe, expect, test } from 'bun:test';
import { createHerdrAgentReporter } from './herdr-agent-report.js';

const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'wM:p7' };

describe('TUI-HERDR-EXIT-RACE startup prune', () => {
  test('releases a stale custom agent before registering the new TUI session', () => {
    const calls: Array<{ argv: string[]; sync: boolean }> = [];
    const events: string[] = [];
    const reporter = createHerdrAgentReporter({
      env, sessionId: 'new-session', now: () => 100, pruneStaleOnStart: true,
      seqStore: { read: () => 90, write: () => {} },
      run: (argv, opts) => { calls.push({ argv, sync: opts.sync }); return { ok: true }; },
      log: (event) => events.push(event),
    })!;

    reporter.start();

    expect(calls.map(({ argv }) => argv.slice(0, 3))).toEqual([
      ['pane', 'release-agent', 'wM:p7'],
      ['pane', 'report-agent', '--source'],
      ['pane', 'report-agent-session', '--source'],
    ]);
    const pruneSeq = Number(calls[0].argv[calls[0].argv.indexOf('--seq') + 1]);
    expect(pruneSeq).toBeGreaterThan(90);
    expect(Number.isSafeInteger(pruneSeq)).toBe(true);
    expect(calls.map(({ sync }) => sync)).toEqual([true, false, false]);
    expect(events).toContain('startup-prune-complete');
    reporter.release();
  });

  test('prune failure is observed but does not suppress fresh registration', () => {
    const calls: string[] = [];
    const events: string[] = [];
    const reporter = createHerdrAgentReporter({
      env, sessionId: 'new-session', now: () => 100, pruneStaleOnStart: true,
      seqStore: { read: () => undefined, write: () => {} },
      run: (argv) => { calls.push(argv[1]); return { ok: argv[1] !== 'release-agent', stderr: 'unavailable' }; },
      log: (event) => events.push(event),
    })!;

    reporter.start();

    expect(calls).toEqual(['release-agent', 'report-agent', 'report-agent-session']);
    expect(events).toContain('startup-prune-failed');
    reporter.release();
  });

  test('next start replaces a SIGKILL-stale custom agent in the same pane', () => {
    let active: { session: string; seq: number } | undefined;
    const run = (argv: string[]) => {
      const seq = Number(argv[argv.indexOf('--seq') + 1]);
      if (argv[1] === 'release-agent') {
        if (active && seq > active.seq) active = undefined;
      } else if (argv[1] === 'report-agent' && seq > (active?.seq ?? -1)) {
        active = { session: argv[argv.indexOf('--agent-session-id') + 1] ?? '', seq };
      }
      return { ok: true };
    };
    const seqStore = { read: () => undefined, write: () => {} };
    const previous = createHerdrAgentReporter({
      env, sessionId: 'crashed-session', now: () => 100, pruneStaleOnStart: true, seqStore, run,
    })!;
    previous.start();
    expect(active?.session).toBe('crashed-session');
    // SIGKILL: no reporter.release(), so herdr retains its last custom-agent record.
    const restarted = createHerdrAgentReporter({
      env, sessionId: 'restarted-session', now: () => 200, pruneStaleOnStart: true, seqStore, run,
    })!;

    restarted.start();

    expect(active?.session).toBe('restarted-session');
    restarted.release();
  });
});
