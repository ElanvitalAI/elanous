// Release-loop ⑦ — judge an isolated TUI session from its screen text. Pure: no PTY.
// The screens are what `scripts/tui-sim.ts text <id>` prints.

export interface TuiScreens {
  readyMs: number | null; // null = never became ready
  first: string;          // screen right after boot
  help: string;           // after sending `/help`
  afterEsc: string;       // after pressing Esc
  marker: string;      // esc-alive probe: the unique marker the driver types after Esc (OP #129723 / JUD-C #129739)
  afterMarker: string;   // screen after typing the marker — a frozen/dead TUI redraws nothing, so this equals afterEsc
}

export interface TuiCheck { id: string; pass: boolean; detail: string }

const ERROR_TEXT = /\b(TypeError|ReferenceError|SyntaxError|Unhandled|panic|Segmentation fault)\b|Error: /;

// The footer is the declarative status line (STATUSLINE-WIRE · #38163 · src/statusline/next-tui.ts): at the release
// sim's fixed 220 columns it draws `Turn <state> · Model <model> · Queue <n> · Bg <n> · <cwd> · <version> · <channel>
// · <stamp>`, segments joined by STATUSLINE_SEPARATOR ' · ' (a long temp-worktree cwd shows its `…/tail` form).
// The old `│ … ctx <n>` segment is gone — ctx is turn chrome in the chat log now (src/tui/core/render.ts) and the
// product's own PTY test asserts its absence (src/tui/entry-compact-chrome-pty.test.ts).
const STATUS_LINE = /^Turn \S+ · Model \S+ · (?:Steer \d+ · )?Queue \d+ · Bg \d+ · [~/…]\S*/m;

/** The /help route replaces the chat log with the built-in guide (src/tui/entry.ts → buildNextTuiHelpLines,
 *  src/tui/core/registry.ts): «Commands», the command rows (one starts with /help), then «Keys», with the input
 *  line below. The startup band (#26954) already says «Commands — /help lists every command», so a Commands heading
 *  with a /help row and the Keys heading under it is what proves the guide itself replaced the log. */
function helpGuideReplacedLog(screen: string): boolean {
  const lines = screen.split('\n').map((line) => line.trim());
  const commands = lines.indexOf('Commands');
  const keys = lines.indexOf('Keys');
  return commands >= 0 && keys > commands
    && lines.some((line, i) => i > commands && i < keys && line.startsWith('/help'));
}

export function tuiChecks(s: TuiScreens, readyLimitMs = 60_000): TuiCheck[] {
  const all = [s.first, s.help, s.afterEsc, s.afterMarker].join('\n');
  return [
    { id: 'boot', pass: s.readyMs !== null && s.readyMs <= readyLimitMs, detail: s.readyMs === null ? 'never ready' : `ready in ${s.readyMs}ms` },
    { id: 'prompt', pass: s.first.includes('❯'), detail: 'input line (❯) on the first screen' },
    { id: 'status-bar', pass: STATUS_LINE.test(s.first), detail: 'declarative footer: turn · model · counters · cwd' },
    { id: 'help-opens', pass: helpGuideReplacedLog(s.help) && s.help.includes('❯'), detail: '/help replaces the log with the Commands + Keys guide' },
    // The guide is log content, not a modal: Esc does not remove it (entry.ts clears the block on the next submit,
    // never on Esc), so the modal-era «title gone after Esc» conjunct passed vacuously. What Esc must leave behind
    // is a live session: the input line and the footer still drawn.
    { id: 'help-closes', pass: s.afterEsc.includes('❯') && STATUS_LINE.test(s.afterEsc), detail: 'Esc keeps the input line and footer drawn' },
    // OP #129723 / JUD-C #129739 mustFix: the screen remainder alone cannot tell a live session from a frozen
    // one — a SIGSTOPed TUI redraws nothing, so afterEsc == the already-seen /help frame and the remainder
    // still passes. esc-alive types a unique marker AFTER Esc: a live session echoes it on the input line
    // with the footer still «Turn idle»; a frozen or dead screen shows no fresh frame and fails.
    { id: 'esc-alive',
      pass: s.marker.length > 0 && s.afterMarker !== s.afterEsc
        && s.afterMarker.split('\n').some((line) => line.includes('❯') && line.includes(s.marker))
        && /^Turn idle · /m.test(s.afterMarker),
      detail: 'Esc-alive: 고유 마커가 ❯ 줄에 에코되고 «Turn idle» footer 유지 — 정지·종료 화면은 실패' },
    { id: 'no-error-text', pass: !ERROR_TEXT.test(all), detail: 'no error text on any screen' },
  ];
}

export interface ExecutedTuiCheck { outcome: 'ok' | 'fail' | 'unmeasured'; detail: string }

/** Run the screen-based TUI node, not `--help`: the subprocess boots a PTY, captures first/help/Esc screens and judges them. */
export async function executeTuiNodeCheck(commit: string, repo: string,
  command: (cmd: string, args: string[], cwd: string, limitMs?: number) => Promise<{ rc: number; output: string }>): Promise<ExecutedTuiCheck> {
  const run = await command('bun', ['scripts/release-loop/tui-sim-node.ts', '--commit', commit, '--json'], repo, 300_000);
  const line = run.output.split(/\r?\n/).find((text) => text.trim().startsWith('{'));
  let value: Record<string, unknown>;
  try { value = JSON.parse(line ?? '') as Record<string, unknown>; }
  catch { return { outcome: 'unmeasured', detail: `TUI screen result missing (rc=${run.rc})` }; }
  if (run.rc === 0 && reusableTui(withTuiOutcome(run.rc, value), commit))
    return { outcome: 'ok', detail: `TUI screens: ${value.verdict} · 7 checks` };
  const ids = ['boot', 'prompt', 'status-bar', 'help-opens', 'help-closes', 'esc-alive', 'no-error-text'];
  const measuredFailure = run.rc === 1 && value.commit === commit && value.verdict === 'fail' && value.attempts === 2
    && Array.isArray(value.checks) && value.checks.length === ids.length
    && value.checks.every((check: unknown, i: number) => !!check && typeof check === 'object'
      && (check as TuiCheck).id === ids[i] && typeof (check as TuiCheck).pass === 'boolean'
      && typeof (check as TuiCheck).detail === 'string')
    && value.checks.some((check: TuiCheck) => !check.pass);
  const failed = measuredFailure ? (value.checks as TuiCheck[]).filter((check) => !check.pass).map((check) => check.id) : [];
  return { outcome: measuredFailure ? 'fail' : 'unmeasured', detail: `TUI screens: ${failed.join(', ') || String(value.verdict)} (rc=${run.rc})` };
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
    || !Array.isArray(value.checks) || value.checks.length !== 7) return null;
  const ids = ['boot', 'prompt', 'status-bar', 'help-opens', 'help-closes', 'esc-alive', 'no-error-text'];
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
