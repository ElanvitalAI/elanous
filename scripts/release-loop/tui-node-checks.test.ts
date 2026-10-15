import { describe, expect, test } from 'bun:test';
import type { spawnSync } from 'node:child_process';
import { measureTuiRegress, tuiNodeOutput } from './tui-sim-node';
import { executeTuiNodeCheck, parseTuiRegress, regressWarning, reusableTui, tuiChecks, tuiVerdict } from './tui-node-checks';

const first = `─┤ ChatLog ├──\n❯ /command, or type a question\n 📁 elan/monad-agent  │ ⌥ main │ some-model │ ctx 0 │ 🖥 mbp`;
const help = `┌── Dashboard help ──\n│Commands\n│/help  Show help overlay\n${first}`;

describe('release-loop TUI node checks', () => {
  test('executable check invokes screen node and rejects help text without captured screens', async () => {
    const commit = 'a'.repeat(40);
    const calls: string[][] = [];
    const command = async (_cmd: string, args: string[], _cwd: string) => {
      calls.push(args);
      return { rc: 0, output: 'Usage: --help Dashboard help Commands ❯ ctx 0' };
    };
    expect(await executeTuiNodeCheck(commit, '/repo', command)).toMatchObject({ outcome: 'unmeasured' });
    expect(calls).toEqual([['scripts/release-loop/tui-sim-node.ts', '--commit', commit, '--json']]);
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc: first });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 0, output: JSON.stringify({ commit, verdict: 'pass', attempts: 1, checks, regress: { unmeasured: 'no regress' } }) }))).toMatchObject({ outcome: 'ok' });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 0, output: JSON.stringify({ commit, verdict: 'pass', attempts: 1, checks: checks.map((check) => ({ id: check.id, pass: true })) }) }))).toMatchObject({ outcome: 'unmeasured' });
    const broken = tuiChecks({ readyMs: 9000, first, help, afterEsc: help });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 1, output: JSON.stringify({ commit, verdict: 'fail', attempts: 2, checks: broken }) }))).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('help-closes') });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 1, output: '{}' }))).toMatchObject({ outcome: 'unmeasured' });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 1, output: JSON.stringify({ commit: 'other', verdict: 'fail', attempts: 2, checks: broken }) }))).toMatchObject({ outcome: 'unmeasured' });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 1, output: JSON.stringify({ commit, verdict: 'fail', attempts: 2, checks: broken.slice(1) }) }))).toMatchObject({ outcome: 'unmeasured' });
  });
  test('a healthy session passes every check', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc: first });
    expect(checks.filter((c) => !c.pass)).toEqual([]);
    expect(tuiVerdict(checks)).toBe('pass');
  });

  test('cached TUI requires matching commit and complete passing checks', () => {
    const commit = 'a'.repeat(40);
    const value = { ...tuiNodeOutput(commit, [{ checks: tuiChecks({ readyMs: 9000, first, help, afterEsc: first }) }], { unmeasured: 'not run' }), outcome: 'ok' };
    expect(reusableTui(value, commit)).toEqual(value);
    expect(reusableTui(value, 'b'.repeat(40))).toBeNull();
    expect(reusableTui({ ...value, checks: value.checks.slice(1) }, commit)).toBeNull();
    expect(reusableTui({ ...value, outcome: 'fail' }, commit)).toBeNull();
  });

  test('never ready → boot fails', () => {
    const checks = tuiChecks({ readyMs: null, first: '', help: '', afterEsc: '' });
    expect(checks.find((c) => c.id === 'boot')!.pass).toBe(false);
    expect(tuiVerdict(checks)).toBe('fail');
  });

  test('overlay still open after Esc → help-closes fails', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc: help });
    expect(checks.find((c) => c.id === 'help-closes')!.pass).toBe(false);
  });

  test('startup Commands guidance remains after Esc without counting as an open overlay', () => {
    const guidance = '· Commands — /help lists every command';
    const checks = tuiChecks({ readyMs: 9000, first: `${first}\n${guidance}`, help, afterEsc: `${first}\n${guidance}` });
    expect(checks.find((c) => c.id === 'help-closes')!.pass).toBe(true);
  });

  test('error text anywhere fails the session', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help: `${help}\nTypeError: x is undefined`, afterEsc: first });
    expect(checks.find((c) => c.id === 'no-error-text')!.pass).toBe(false);
  });

  test('node output includes regress but its pass/flaky/fail/error verdict depends only on TUI sessions', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc: first });
    const regress = { pass: 6, fail: 1, results: Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: 'check', ok: i !== 2, reason: 'measured' })) };
    expect(tuiNodeOutput('abc', [{ checks }], regress)).toMatchObject({ verdict: 'pass', regress, attempts: 1 });
    expect(tuiNodeOutput('abc', [{ checks }, { checks }], { unmeasured: '3분 시간 초과' })).toMatchObject({ verdict: 'flaky', attempts: 2, regress: { unmeasured: '3분 시간 초과' } });
    expect(tuiNodeOutput('abc', [{ checks: [{ id: 'boot', pass: false, detail: 'never ready' }] }], regress).verdict).toBe('fail');
    expect(tuiNodeOutput('abc', [], regress, 'session error').verdict).toBe('error');
  });

  test('worktree regression measurement invokes the real command once with a 3-minute cap and preserves failed checks', () => {
    const results = Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: `check ${i + 1}`, ok: i !== 1, reason: 'measured' }));
    let calls = 0;
    const runner = ((command: string, args: string[], options: { cwd: string; timeout: number }) => {
      calls++;
      expect([command, args, options.cwd, options.timeout]).toEqual(['bun', ['scripts/tui-regress.ts', '--json'], '/isolated/tree', 180_000]);
      return { status: 1, stdout: JSON.stringify({ pass: 6, fail: 1, results }), stderr: '' };
    }) as typeof spawnSync;
    expect(measureTuiRegress('/isolated/tree', runner)).toEqual({ pass: 6, fail: 1, results });
    expect(calls).toBe(1);
    const timedOut = (() => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('3분 시간 초과'), { code: 'ETIMEDOUT' }) })) as unknown as typeof spawnSync;
    expect(measureTuiRegress('/isolated/tree', timedOut)).toEqual({ unmeasured: '3분 시간 초과' });
  });

  test('regressWarning reports ok, failed check ids, or the unmeasured reason without changing TUI verdict', () => {
    const results = Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: `check ${i + 1}`, ok: true, reason: 'passed' }));
    expect(regressWarning({ pass: 7, fail: 0, results })).toEqual({ level: 'ok', line: 'tui-regress: ok — 7 pass · 0 fail' });
    const failed = results.map((r) => ({ ...r, ok: r.id !== 'R2' && r.id !== 'R5' }));
    expect(regressWarning({ pass: 5, fail: 2, results: failed })).toEqual({ level: 'warn', line: 'tui-regress: warn — R2, R5' });
    expect(regressWarning({ unmeasured: '3분 시간 초과' })).toEqual({ level: 'unmeasured', line: 'tui-regress: unmeasured — 3분 시간 초과' });
    expect(tuiVerdict(tuiChecks({ readyMs: 9000, first, help, afterEsc: first }))).toBe('pass');
    expect(parseTuiRegress(JSON.stringify({ pass: 5, fail: 2, results: failed }) + '\n')).toEqual({ pass: 5, fail: 2, results: failed });
    expect(parseTuiRegress(JSON.stringify({ pass: 5, fail: 2, results: failed }) + '\ntui-regress: pass 5 · fail 2')).toHaveProperty('unmeasured');
    expect(parseTuiRegress('{broken')).toHaveProperty('unmeasured');
  });
});
