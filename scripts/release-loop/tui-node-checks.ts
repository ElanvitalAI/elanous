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
