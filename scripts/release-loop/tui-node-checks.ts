// Release-loop ⑦ — judge an isolated TUI session from its screen text. Pure: no PTY.
// The screens are what `scripts/tui-sim.ts text <id>` prints.

export interface TuiScreens {
  readyMs: number | null; // null = never became ready
  first: string;          // screen right after boot
  help: string;           // after sending `/help`
  afterEsc: string;       // after pressing Esc
}

export interface TuiCheck { id: string; pass: boolean; detail: string }

const ERROR_TEXT = /\b(TypeError|ReferenceError|SyntaxError|Unhandled|panic|Segmentation fault)\b|Error: /;

export function tuiChecks(s: TuiScreens, readyLimitMs = 60_000): TuiCheck[] {
  const all = [s.first, s.help, s.afterEsc].join('\n');
  return [
    { id: 'boot', pass: s.readyMs !== null && s.readyMs <= readyLimitMs, detail: s.readyMs === null ? 'never ready' : `ready in ${s.readyMs}ms` },
    { id: 'prompt', pass: s.first.includes('❯'), detail: 'input line (❯) on the first screen' },
    { id: 'status-bar', pass: /│.*ctx \d+/.test(s.first), detail: 'status bar with model and ctx' },
    { id: 'help-opens', pass: s.help.includes('help') && s.help.includes('Commands') && s.help.includes('/help'), detail: '/help shows the help overlay' },
    { id: 'help-closes', pass: !s.afterEsc.includes('Commands') && s.afterEsc.includes('❯'), detail: 'Esc closes the overlay' },
    { id: 'no-error-text', pass: !ERROR_TEXT.test(all), detail: 'no error text on any screen' },
  ];
}

export function tuiVerdict(checks: readonly TuiCheck[]): 'pass' | 'fail' {
  return checks.every((c) => c.pass) ? 'pass' : 'fail';
}

/** `tui-sim-node.ts --json` prints the raw result (no `outcome`); `node-verdict.ts tui` adds it. Same rule here so a
 *  prefetched raw result is judged exactly like the wrapped node result: exit 0 with pass|flaky → ok. */
export function withTuiOutcome(status: number | null, data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null;
  const outcome = status === 0 && (data.verdict === 'pass' || data.verdict === 'flaky') ? 'ok' : status === 1 ? 'fail' : 'error';
  return { ...data, outcome };
}

export function reusableTui(data: unknown, commit: string): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value.outcome !== 'ok' || value.commit !== commit || (value.verdict !== 'pass' && value.verdict !== 'flaky')
    || (value.verdict === 'pass' ? value.attempts !== 1 : value.attempts !== 2)
    || !Array.isArray(value.checks) || value.checks.length !== 6) return null;
  const ids = ['boot', 'prompt', 'status-bar', 'help-opens', 'help-closes', 'no-error-text'];
  if (value.checks.some((check: unknown, i: number) => !check || typeof check !== 'object'
    || (check as TuiCheck).id !== ids[i] || (check as TuiCheck).pass !== true
    || typeof (check as TuiCheck).detail !== 'string')) return null;
  if (value.regress === null || typeof value.regress !== 'object' || Array.isArray(value.regress)) return null;
  return value;
}

export type TuiRegress = {
  pass: number;
  fail: number;
  results: Array<{ id: string; title: string; ok: boolean; reason: string }>;
} | { unmeasured: string };

export function validatedTuiRegress(data: unknown): TuiRegress {
  const invalid = { unmeasured: 'tui.regress 결과 없음' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid;
  const value = data as Record<string, unknown>;
  if (typeof value.unmeasured === 'string' && value.unmeasured.trim()) return { unmeasured: value.unmeasured };
  if (!Array.isArray(value.results) || value.results.length !== 7
    || !Number.isInteger(value.pass) || !Number.isInteger(value.fail)
    || (value.pass as number) < 0 || (value.fail as number) < 0
    || (value.pass as number) + (value.fail as number) !== 7
    || value.results.some((r: unknown) => !r || typeof r !== 'object'
      || typeof (r as Record<string, unknown>).id !== 'string'
      || !/^R[1-7]$/.test((r as Record<string, unknown>).id as string)
      || typeof (r as Record<string, unknown>).title !== 'string'
      || typeof (r as Record<string, unknown>).ok !== 'boolean'
      || typeof (r as Record<string, unknown>).reason !== 'string')
    || value.pass !== value.results.filter((r: { ok: boolean }) => r.ok).length
    || value.fail !== value.results.filter((r: { ok: boolean }) => !r.ok).length
    || new Set(value.results.map((r: { id: string }) => r.id)).size !== 7) return invalid;
  return value as { pass: number; fail: number; results: Array<{ id: string; title: string; ok: boolean; reason: string }> };
}

export function parseTuiRegress(stdout: string): TuiRegress {
  const lines = stdout.trim().split('\n');
  if (lines.length !== 1) return { unmeasured: 'JSON 한 줄이 아니다' };
  try { return validatedTuiRegress(JSON.parse(lines[0]!)); }
  catch { return { unmeasured: 'JSON 결과를 읽을 수 없다' }; }
}

export function regressWarning(regress: TuiRegress): { level: 'ok' | 'warn' | 'unmeasured'; line: string } {
  if ('unmeasured' in regress) return { level: 'unmeasured', line: `tui-regress: unmeasured — ${regress.unmeasured}` };
  const failed = regress.results.filter((result) => !result.ok).map((result) => result.id);
  return failed.length
    ? { level: 'warn', line: `tui-regress: warn — ${failed.join(', ')}` }
    : { level: 'ok', line: `tui-regress: ok — ${regress.pass} pass · 0 fail` };
}
