import { tierModel } from '../../src/llm/model-defaults.js';
import { describe, expect, test } from 'bun:test';
import type { spawnSync } from 'node:child_process';
import { measureTuiRegress, tuiNodeOutput } from './tui-sim-node';
import { executeTuiNodeCheck, parseTuiRegress, regressWarning, reusableTui, tuiChecks, tuiVerdict } from './tui-node-checks';

// Screens from a real release-sim session at the 2026-11-22 main (220×60, ELANOUS_DRIVE_TUI=1), abridged to the
// lines the checks read: the declarative footer (STATUSLINE-WIRE; the check's temp-worktree cwd shows its `…/tail`
// form), the startup band on the first screen, and the /help guide that replaces the log — «Commands», a /help row,
// «Keys» — with the input line below. The guide is log content: the after-Esc screen is the guide screen unchanged.
const footer = `Turn idle · Model ${tierModel('best', 'openai-codex')} · Queue 0 · Bg 0 · …/T/tui-node-1Dc7mS/tree · 0.3.33-dev.0 · dev · 261122_1209`;
const first = [
  'elanous',
  '· Chat — ask for anything in plain language',
  '· Commands — /help lists every command',
  'Try typing: what can you do?',
  'Enter send · Esc cancel · Ctrl+Q quit',
  '❯',
  footer,
].join('\n');
const help = [
  'elanous',
  'Commands',
  '/quit · /exit — Quit',
  '/help · /help next — Command and key guide',
  '/new · /clear · /session new — New chat',
  '/model · /provider — fast|normal|deep · /provider alias',
  'Keys',
  'Enter send · Esc cancel · PgUp/PgDn scroll chat · Ctrl+Q quit',
  'Ctrl+\\ toggle · ↑/↓ select · Enter on empty input=attach',
  'PTY detach: Ctrl+\\ then d',
  'Esc returns to input',
  '❯',
  footer,
].join('\n');
// The real after-Esc screen: the guide stays (log content) and the session stays live.
const afterEsc = help;
// esc-alive fixtures (OP #129723): a live session echoes the typed marker on the input line with
// the footer still «Turn idle»; a frozen screen shows no fresh frame (afterMarker == afterEsc).
const marker = 'esc-alive-release-sim';
const afterMarker = help.replace('❯', `❯ ${marker}`);
// The guide with the input line and footer gone — a dead session after Esc.
const deadSession = help.split('\n').filter((line) => line !== '❯' && line !== footer).join('\n');

describe('release-loop TUI node checks', () => {
  test('executable check invokes screen node and rejects help text without captured screens', async () => {
    const commit = 'a'.repeat(40);
    const calls: string[][] = [];
    const command = async (_cmd: string, args: string[], _cwd: string) => {
      calls.push(args);
      return { rc: 0, output: 'Usage: --help' };
    };
    expect(await executeTuiNodeCheck(commit, '/repo', command)).toMatchObject({ outcome: 'unmeasured' });
    expect(calls).toEqual([['scripts/release-loop/tui-sim-node.ts', '--commit', commit, '--json']]);
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc, marker, afterMarker });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 0, output: JSON.stringify({ commit, verdict: 'pass', attempts: 1, checks, regress: { unmeasured: 'no regress' } }) }))).toMatchObject({ outcome: 'ok' });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 0, output: JSON.stringify({ commit, verdict: 'pass', attempts: 1, checks: checks.map((check) => ({ id: check.id, pass: true })) }) }))).toMatchObject({ outcome: 'unmeasured' });
    const broken = tuiChecks({ readyMs: 9000, first, help, afterEsc: deadSession, marker, afterMarker: deadSession });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 1, output: JSON.stringify({ commit, verdict: 'fail', attempts: 2, checks: broken }) }))).toMatchObject({ outcome: 'fail', detail: expect.stringContaining('help-closes') });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 1, output: '{}' }))).toMatchObject({ outcome: 'unmeasured' });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 1, output: JSON.stringify({ commit: 'other', verdict: 'fail', attempts: 2, checks: broken }) }))).toMatchObject({ outcome: 'unmeasured' });
    expect(await executeTuiNodeCheck(commit, '/repo', async () => ({ rc: 1, output: JSON.stringify({ commit, verdict: 'fail', attempts: 2, checks: broken.slice(1) }) }))).toMatchObject({ outcome: 'unmeasured' });
  });
  test('a healthy session passes every check', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc, marker, afterMarker });
    expect(checks.filter((c) => !c.pass)).toEqual([]);
    expect(tuiVerdict(checks)).toBe('pass');
  });

  test('cached TUI requires matching commit and complete passing checks', () => {
    const commit = 'a'.repeat(40);
    const value = { ...tuiNodeOutput(commit, [{ checks: tuiChecks({ readyMs: 9000, first, help, afterEsc, marker, afterMarker }) }], { unmeasured: 'not run' }), outcome: 'ok' };
    expect(reusableTui(value, commit)).toEqual(value);
    expect(reusableTui(value, 'b'.repeat(40))).toBeNull();
    expect(reusableTui({ ...value, checks: value.checks.slice(1) }, commit)).toBeNull();
    expect(reusableTui({ ...value, outcome: 'fail' }, commit)).toBeNull();
  });

  test('never ready → boot fails', () => {
    const checks = tuiChecks({ readyMs: null, first: '', help: '', afterEsc: '', marker: '', afterMarker: '' });
    expect(checks.find((c) => c.id === 'boot')!.pass).toBe(false);
    expect(tuiVerdict(checks)).toBe('fail');
  });

  test('input line and footer gone after Esc → help-closes fails', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc: deadSession, marker, afterMarker: deadSession });
    expect(checks.find((c) => c.id === 'help-closes')!.pass).toBe(false);
  });

  test('the guide is log content — it stays after Esc and help-closes still passes', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc, marker, afterMarker });
    expect(checks.find((c) => c.id === 'help-closes')!.pass).toBe(true);
  });

  test('a live session echoes the esc-alive marker on the input line with a «Turn idle» footer (OP #129723)', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc, marker, afterMarker });
    expect(checks.find((c) => c.id === 'esc-alive')!.pass).toBe(true);
  });

  test('a frozen screen shows no fresh frame — esc-alive fails while the screen remainder still passes (OP #129723)', () => {
    // A stopped TUI redraws nothing: the marker typed after Esc never echoes, so afterMarker == afterEsc
    // (node-b isolation probe: frozen 2/2 passed help-closes with the marker never shown; live 2/2 showed it).
    const frozen = tuiChecks({ readyMs: 9000, first, help, afterEsc, marker, afterMarker: afterEsc });
    expect(frozen.find((c) => c.id === 'help-closes')!.pass).toBe(true); // the hole the remainder check cannot close alone
    expect(frozen.find((c) => c.id === 'esc-alive')!.pass).toBe(false);
  });

  test('the startup band alone does not count as the /help guide (help-opens fails when /help drew nothing)', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help: first, afterEsc: first, marker, afterMarker });
    expect(checks.find((c) => c.id === 'help-opens')!.pass).toBe(false);
  });

  test('the pre-STATUSLINE-WIRE footer (│ … ctx 0) fails status-bar', () => {
    const legacy = '❯ /command, or type a question\n 📁 elan/monad-agent  │ ⌥ main │ some-model │ ctx 0 │ 🖥 mbp';
    const checks = tuiChecks({ readyMs: 9000, first: legacy, help, afterEsc, marker, afterMarker });
    expect(checks.find((c) => c.id === 'status-bar')!.pass).toBe(false);
  });

  test('error text anywhere fails the session', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help: `${help}\nTypeError: x is undefined`, afterEsc: first, marker, afterMarker });
    expect(checks.find((c) => c.id === 'no-error-text')!.pass).toBe(false);
  });

  test('node output includes regress but its pass/flaky/fail/error verdict depends only on TUI sessions', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc, marker, afterMarker });
    const regress = { pass: 6, fail: 1, results: Array.from({ length: 7 }, (_, i) => ({ id: `R${i + 1}`, title: 'check', ok: i !== 2, reason: 'measured' })) };
    expect(tuiNodeOutput('abc', [{ checks }], regress)).toMatchObject({ verdict: 'pass', regress, attempts: 1,
      summary: 'TUI pass: basic 7/7 · regress 6 pass / 1 fail (R3)' });
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
    expect(tuiVerdict(tuiChecks({ readyMs: 9000, first, help, afterEsc, marker, afterMarker }))).toBe('pass');
    expect(parseTuiRegress(JSON.stringify({ pass: 5, fail: 2, results: failed }) + '\n')).toEqual({ pass: 5, fail: 2, results: failed });
    expect(parseTuiRegress(JSON.stringify({ pass: 5, fail: 2, results: failed }) + '\ntui-regress: pass 5 · fail 2')).toHaveProperty('unmeasured');
    expect(parseTuiRegress('{broken')).toHaveProperty('unmeasured');
  });
});
