import { describe, expect, test } from 'bun:test';
import { tuiChecks, tuiVerdict } from './tui-node-checks';

const first = `─┤ ChatLog ├──\n❯ /command, or type a question\n 📁 elan/monad-agent  │ ⌥ main │ some-model │ ctx 0 │ 🖥 mbp`;
const help = `┌── Dashboard help ──\n│Commands\n│/help  Show help overlay\n${first}`;

describe('release-loop TUI node checks', () => {
  test('a healthy session passes every check', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help, afterEsc: first });
    expect(checks.filter((c) => !c.pass)).toEqual([]);
    expect(tuiVerdict(checks)).toBe('pass');
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

  test('error text anywhere fails the session', () => {
    const checks = tuiChecks({ readyMs: 9000, first, help: `${help}\nTypeError: x is undefined`, afterEsc: first });
    expect(checks.find((c) => c.id === 'no-error-text')!.pass).toBe(false);
  });
});
