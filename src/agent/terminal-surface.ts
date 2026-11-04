// PLAN-multi-surface-pty-shell M1 — shared terminal-surface layer.
//
// Telegram proved four surface adapters are what turn "PtyShell is
// exposed" into "PtyShell actually works as a mission surface":
//   ① budgetGrant     — the tool loop earns extra rounds ONLY while a
//                       PtyShell-family tool is being dispatched.
//   ② cancel→PTY      — aborting the turn kills non-detached headless
//                       PTYs (detached ones survive by design).
//   ③ _imageFile      — a tool result carrying an `_imageFile` pointer
//                       (e.g. PtyShellScreenshot) is delivered through
//                       the surface's FileSink as an inline image; the
//                       LLM sees only the text output.
//   ④ discipline      — the [터미널 미션 규율] system-prompt block that
//                       keeps multi-step missions in ONE PtyShell
//                       session instead of scattered Bash calls.
//
// This module is the single source for all four, in the same spirit as
// `core-tools.ts` for the L2 tool catalog: a self-turn assembler passes
// its base pieces through `buildTerminalCapableTurn` and gets the
// terminal-capable versions back. Surface-agnostic and headless — no
// telegram / discord / dashboard imports (the FileSink seam carries the
// per-surface image channel).

import type { LLMOpts, LLMToolSpec } from '../llm.js';
import type { FileSink } from '../channel/file-sink.js';
import { PTY_SHELL_TOOL_NAMES } from '../boot/daemon-tools/pty-shell.js';
import { killNonDetached as killNonDetachedPty } from '../pty-shell/registry.js';
import { getCurrentPtyId } from './pty-identity.js';

/** ① Conditional tool-budget grant for driving a headless terminal /
 *  coding agent. Keeps the tight per-family cap for ordinary turns
 *  (codex's re-read pathology brake stays intact) while spawn→snapshot→
 *  send→poll loops earn extra rounds up to the ceiling. Activates ONLY
 *  when one of these tools is actually dispatched (llm.ts budgetGrant
 *  hook). Applies across providers. */
export const PTY_BUDGET_GRANT: NonNullable<LLMOpts['budgetGrant']> = {
  tools: PTY_SHELL_TOOL_NAMES,
  perCall: 6,
  ceiling: 60,
};

/** ④ Surface-agnostic terminal mission discipline (extracted verbatim
 *  from the telegram agent's elanousSelfAccessPrompt, 2026-07-12). Joined
 *  into the system prompt of every terminal-capable self turn. */
export const TERMINAL_MISSION_DISCIPLINE = [
  '[터미널 미션 규율]',
  '- 여러 단계가 얽힌 터미널/빌드/실행/설치 미션은 흩어진 Bash 호출로 쪼개지 말고 "하나의 PtyShell',
  '  세션"에서 처리하라: PtyShellStart 로 셸을 한 번 열고(cd 로 작업폴더 이동) → 파일 작성·설치·',
  '  서버 기동·테스트를 모두 그 세션에서 → PtyShellPoll/PtyShellSnapshot 으로 결과를 눈으로 확인하며',
  '  진행. 관측·취소·화면캡처가 되는 하나의 흐름이 된다. 거대한 Bash 한 방 스크립트로 흩뿌리지 마라.',
  '- Bash 는 진짜 단발성 한 줄(ls·cat·quick check)에만. 지속/인터랙티브/서버/watch/화면 필요 시 PtyShell.',
  '- "화면 보여줘·캡처·스크린샷·show" 요청은 PtyShellScreenshot 으로 그 세션 화면을 PNG 이미지로 첨부하라',
  '  (텍스트 파일 저장이나 chafa 같은 ad-hoc 뷰어로 대체하지 마라 — 사용자는 이미지를 원한다).',
  '- 미션이 끝나면 중간 로그·스크립트를 그대로 나열하지 말고, 결과를 한 번에 정리한 요약 하나로 답하라.',
].join('\n');

/** Media type for an image file path by extension. PtyShellScreenshot
 *  emits PNG; jpeg kept for future capture tools. */
function imageMediaType(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/png';
}

/** Dispatcher shape shared by the self-turn assemblers (telegram's
 *  per-turn closure, daemon dispatchers). Extra args beyond (name,
 *  args) — e.g. runCoreTurn's dispatch ctx `{callId, sessionId, …}` —
 *  are surface-specific: the wrapper forwards them verbatim and never
 *  inspects them. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any — passthrough
// variadic: `any[]` is the only shape assignable BOTH from narrower
// dispatchers ((name, args) or (name, args, ctx?: DaemonCtx)) and TO
// consumer contracts (CoreTurnDispatchTool) under strictFunctionTypes.
export type TerminalTurnDispatch = (
  name: string,
  args: Record<string, unknown>,
  ...rest: any[]
) => Promise<unknown>;

export interface TerminalCapableBase {
  /** Tool catalog — passed through verbatim today (every self-turn
   *  surface already inherits the PtyShell specs via its tool builder);
   *  kept in the contract so a surface lacking them can be topped up
   *  here later without changing consumers. */
  specs: LLMToolSpec[];
  /** The surface's fully-assembled dispatcher (delegation branches and
   *  all) — wrapped with the ③ `_imageFile` intercept. */
  dispatch: TerminalTurnDispatch;
  /** System-prompt parts; ④ TERMINAL_MISSION_DISCIPLINE is appended.
   *  Caller joins (telegram uses '\n\n'). */
  systemPromptParts: string[];
  /** llmOpts to receive ① PTY_BUDGET_GRANT. */
  llmOpts?: LLMOpts;
  /** Turn abort signal — ② on first abort, non-detached PTYs die.
   *  Absent ⇒ no cancel wiring (surface has no cancel affordance). */
  signal?: AbortSignal;
  /** Surface image channel for ③. Absent (or without sendImage) ⇒ the
   *  image is dropped and the LLM still gets the text output — unless
   *  `inlineImages` is set. */
  fileSink?: FileSink;
  /** ③ daemon-path variant (PLAN M2): no side-channel sink exists, but
   *  the surface understands the image-bearing result convention
   *  (`{mediaType, dataB64}` — `maybeImageBearingResult` in llm.ts).
   *  When set (and no fileSink handled the image), `_imageFile` results
   *  are converted to inline base64 bytes, so (a) daemon-prompt-turn's
   *  onImageBlock forwards them to PWA/iOS/Android clients, and (b)
   *  vision-capable LLMs can SEE the captured screen. */
  inlineImages?: boolean;
}

const TERMINAL_CAPABLE_TURN_BRAND = Symbol('elanous.terminal-capable-turn');

export interface TerminalCapableTurn {
  specs: LLMToolSpec[];
  dispatch: TerminalTurnDispatch;
  systemPromptParts: string[];
  llmOpts: LLMOpts;
  readonly [TERMINAL_CAPABLE_TURN_BRAND]: true;
}

export function isTerminalCapableTurn(value: {
  specs?: LLMToolSpec[];
  dispatch?: TerminalTurnDispatch;
  systemPromptParts?: string[];
  llmOpts?: LLMOpts;
}): value is TerminalCapableTurn {
  if ((value as { [TERMINAL_CAPABLE_TURN_BRAND]?: true })[TERMINAL_CAPABLE_TURN_BRAND] === true) return true;
  return (value.llmOpts as { [TERMINAL_CAPABLE_TURN_BRAND]?: true } | undefined)?.[TERMINAL_CAPABLE_TURN_BRAND] === true;
}

/** Fold the four terminal adapters onto a self-turn's base pieces.
 *  Call once per turn (the ② abort listener binds to THIS turn's
 *  signal; `{once: true}` keeps repeat aborts inert). */
export function buildTerminalCapableTurn(base: TerminalCapableBase): TerminalCapableTurn {
  // ② /cancel — Bash children die via the signal threaded into
  // dispatchBash; PtyShell PTYs are persistent (they'd outlive the
  // turn), so kill the non-detached ones here. Detached PTYs survive.
  if (base.signal) {
    base.signal.addEventListener('abort', () => {
      try { killNonDetachedPty(); } catch { /* best-effort */ }
    }, { once: true });
  }

  // ③ Inline-image delivery — a tool (e.g. PtyShellScreenshot) may
  // return an `_imageFile` pointer. When the surface can render inline
  // images, attach it and hand the LLM back just the text `output` so
  // its context isn't polluted with the image path. Fail-soft: any
  // read/send error just drops the image.
  const dispatch: TerminalTurnDispatch = async (name, args, ...rest) => {
    const result = await base.dispatch(name, args, ...rest);
    if (result && typeof result === 'object' && '_imageFile' in result) {
      const r = result as { output?: string; _imageFile?: string; _imageCaption?: string };
      if (r._imageFile && base.fileSink?.sendImage) {
        try {
          const { readFileSync } = await import('node:fs');
          base.fileSink.sendImage(readFileSync(r._imageFile), r._imageCaption ? { caption: r._imageCaption } : undefined);
        } catch { /* drop image, keep text */ }
      } else if (r._imageFile && base.inlineImages) {
        // Daemon-path delivery: inline the bytes per the image-bearing
        // convention instead of a side-channel send.
        try {
          const { readFileSync } = await import('node:fs');
          return {
            output: r.output ?? 'Screen captured.',
            mediaType: imageMediaType(r._imageFile),
            dataB64: readFileSync(r._imageFile).toString('base64'),
          };
        } catch { /* fall through to text-only */ }
      }
      return { output: r.output ?? 'Screen captured.' };
    }
    return result;
  };

  const llmOpts = {
    ...(base.llmOpts ?? {}),
    budgetGrant: PTY_BUDGET_GRANT,
    [TERMINAL_CAPABLE_TURN_BRAND]: true,
  };
  return {
    specs: base.specs,
    dispatch,
    systemPromptParts: [...base.systemPromptParts, TERMINAL_MISSION_DISCIPLINE],
    llmOpts, // ①
    [TERMINAL_CAPABLE_TURN_BRAND]: true,
  };
}

// ---------------------------------------------------------------------------
// ⑤ TUI self-nest guard (TUI-NO-SELF-NEST · #27)
//
// A TUI turn already runs INSIDE a PTY owned by the outer TUI (the seat
// shell). Spawning `eln` / `elanous` again from there nests a second TUI in
// the same terminal: the two alt-screens and input loops overwrite each other
// and the operator loses the seat ("screens fighting"). The guard refuses
// exactly that one command shape and answers with guidance; every other
// command (bash, `eln pty list`, `eln msg post`, …) keeps its current
// behaviour, and the existing harness-write-boundary ledger path is
// untouched — the reject is returned in the same `{ output }` envelope the
// PtyShell dispatch already uses (precedent: skills/tools/pty.ts
// dispatchPtyShellSend's reject-with-guidance).
// ---------------------------------------------------------------------------

/** Stable marker the reject message starts with — tests and the operator
 *  read this; changing it is a behaviour change, not a wording tweak. */
export const TUI_SELF_NEST_REJECT_MARKER = '[TUI 자기중첩 거부]';

/** Binaries that ARE the elanous TUI (or its launcher). */
const ELANOUS_TUI_BINARIES = new Set(['eln', 'elanous']);

/** Subcommands that open an interactive TUI surface. A bare invocation
 *  (`eln`) is the default TUI. Anything else keeps running as-is. */
const ELANOUS_TUI_SUBCOMMANDS = new Set(['', 'tui', 'chat', 'dashboard', 'nexus']);

/** Interpreter wrappers that can launch the TUI entry file. */
const ELANOUS_LAUNCHER_BINARIES = new Set(['bun', 'node', 'bunx']);

const ELANOUS_ENTRY_FILES = new Set(['elanous', 'elanous.mjs', 'elanous.cjs']);

/** Global flags that consume the NEXT token as their value — without this
 *  list `eln --config-dir /tmp/x dashboard` would read `/tmp/x` as the
 *  subcommand. */
const VALUE_TAKING_FLAGS = new Set([
  '--config-dir',
  '--state-dir',
  '--cwd',
  '--role-llm',
  '--child-llm-provider',
  '--child-llm-model',
  '--model',
  '--provider',
  '--seat',
  '--name',
  '--session',
  '--since',
  '--grep',
]);

/** Flags that only ask for information (version / help). A call carrying one
 *  of these never opens an interactive surface, so it is NOT a TUI launch:
 *  refusing `eln --version` or `eln chat --help` inside a TUI would break a
 *  non-interactive command — a false positive is an accident, not a guard. */
const INFORMATIONAL_FLAGS = new Set(['--help', '-h', '--version', '-V']);

function basenameOf(token: string): string {
  const parts = token.split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

export type TuiCommandKind = 'elanous-tui-launch' | 'other';

export interface TuiLaunchLook {
  kind: TuiCommandKind;
  /** Subcommand that opened the TUI ('' for a bare `eln`). */
  subcommand: string | null;
}

/** Pure classifier: is this argv an elanous/eln TUI launch?
 *
 *  Accepts the direct form (`eln`, `/usr/local/bin/eln chat`) and the
 *  interpreter form (`bun bin/elanous.mjs dashboard`). Leading flags are
 *  skipped, but a flag's VALUE is never mistaken for the subcommand — an
 *  unknown shape simply classifies as `other` (a false negative is safe;
 *  a false positive would break unrelated commands). A call carrying an
 *  informational flag (`--version` / `--help` / `-h` / `-V`) is `other` too,
 *  whether the flag sits alone (`eln --version`) or after a TUI subcommand
 *  (`eln chat --help`): it prints and exits, it never opens the surface. */
export function classifyTuiLaunch(argv: readonly string[]): TuiLaunchLook {
  if (argv.length === 0) return { kind: 'other', subcommand: null };
  const head = basenameOf(argv[0] ?? '');

  let rest: string[];
  if (ELANOUS_TUI_BINARIES.has(head)) {
    rest = argv.slice(1);
  } else if (ELANOUS_LAUNCHER_BINARIES.has(head)) {
    const entryIdx = argv.findIndex((tok, i) => i > 0 && ELANOUS_ENTRY_FILES.has(basenameOf(tok)));
    if (entryIdx === -1) return { kind: 'other', subcommand: null };
    rest = argv.slice(entryIdx + 1);
  } else {
    return { kind: 'other', subcommand: null };
  }

  const sub = firstPositional(rest);
  if (!ELANOUS_TUI_SUBCOMMANDS.has(sub)) return { kind: 'other', subcommand: sub };
  // 정보성 플래그가 붙은 호출(`eln --version`·`eln --help`·`eln chat --help`)은
  // 기동이 아니라 출력 요청이다 — 대화형 표면을 열지 않으므로 `other` 로 보낸다.
  if (asksForInformation(rest)) return { kind: 'other', subcommand: sub === '' ? null : sub };
  return { kind: 'elanous-tui-launch', subcommand: sub };
}

/** True when the tokens ask for version/help output. The value of a
 *  value-taking flag is skipped so `--grep --help` stays a value. */
function asksForInformation(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (VALUE_TAKING_FLAGS.has(token)) {
      i += 1;
      continue;
    }
    if (INFORMATIONAL_FLAGS.has(token)) return true;
  }
  return false;
}

/** Split shell command text without treating quoted operators as syntax. This is
 *  an accident guard, not a shell interpreter: unsupported expansions fail
 *  closed and dynamic evaluation is rejected. Redirection operands are skipped so `> eln`
 *  cannot look like a command. */
const SHELL_PARSE_UNCERTAIN = '__ELANOUS_SHELL_PARSE_UNCERTAIN__';

function shellCommandSegments(line: string, depth = 0): string[][] {
  if (depth > 4) return [[SHELL_PARSE_UNCERTAIN]];
  // Command substitution and heredoc expansion are intentionally unsupported.
  // Treat them as uncertain instead of pretending their contents were checked.
  const segments: string[][] = [];
  const appendBacktickScript = (start: number): number | null => {
    let end = start + 1;
    let script = '';
    for (; end < line.length; end += 1) {
      const c = line[end]!;
      if (c === '`') {
        segments.push(...shellCommandSegments(script, depth + 1));
        return end;
      }
      if (c === '\\' && end + 1 < line.length) script += line[++end]!;
      else script += c;
    }
    return null;
  };
  let segment: string[] = [];
  let word = '';
  let hasWord = false;
  let quote: "'" | '"' | null = null;
  const heredocs: Array<{ delimiter: string; stripTabs: boolean; quoted: boolean }> = [];
  const flushWord = () => {
    if (hasWord) segment.push(word);
    word = '';
    hasWord = false;
  };
  const flushSegment = () => {
    flushWord();
    if (segment.length) segments.push(segment);
    segment = [];
  };
  const skipWord = (start: number): { end: number; value: string; quoted: boolean; hasCommandSubstitution: boolean } => {
    let value = '';
    let quoted = false;
    let hasCommandSubstitution = false;
    let q: "'" | '"' | null = null;
    let i = start;
    for (; i < line.length; i += 1) {
      const c = line[i]!;
      if (q === "'") { if (c === "'") q = null; else value += c; continue; }
      if (q === '"') {
        if (c === '"') { q = null; continue; }
        if (c === '\\' && i + 1 < line.length) { value += line[++i]!; continue; }
        if (c === '`') hasCommandSubstitution = true;
        if (c === '$' && line[i + 1] === '(') hasCommandSubstitution = true;
        value += c; continue;
      }
      if (c === "'" || c === '"') { q = c; quoted = true; continue; }
      if (c === '\\' && i + 1 < line.length) { quoted = true; value += line[++i]!; continue; }
      if (c === '`') hasCommandSubstitution = true;
      if (c === '$' && line[i + 1] === '(') hasCommandSubstitution = true;
      if (/\s/.test(c) || ';|&()<>'.includes(c)) break;
      value += c;
    }
    return { end: i, value, quoted, hasCommandSubstitution };
  };

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      hasWord = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') { quote = null; hasWord = true; continue; }
      if (c === '`') {
        const end = appendBacktickScript(i);
        if (end !== null) { i = end; hasWord = true; continue; }
        return [[SHELL_PARSE_UNCERTAIN]];
      }
      if (c === '$' && line[i + 1] === '(') return [[SHELL_PARSE_UNCERTAIN]];
      if (c === '\\' && i + 1 < line.length && '"\\$`'.includes(line[i + 1]!)) { word += line[++i]!; hasWord = true; continue; }
      word += c; hasWord = true; continue;
    }
    if (c === '`') {
      const end = appendBacktickScript(i);
      if (end !== null) { i = end; continue; }
      return [[SHELL_PARSE_UNCERTAIN]];
    }
    if (c === '$' && line[i + 1] === '(') return [[SHELL_PARSE_UNCERTAIN]];
    if (c === '\\' && i + 1 < line.length) {
      if (line[i + 1] === '\n') { i += 1; continue; }
      word += line[++i]!; hasWord = true; continue;
    }
    if (c === "'" || c === '"') { quote = c; hasWord = true; continue; }
    if (c === '#' && !hasWord) {
      while (i + 1 < line.length && line[i + 1] !== '\n') i += 1;
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && line[i + 1] === '>')) {
      if (/^\d+$/.test(word)) { word = ''; hasWord = false; }
      else flushWord();
      const start = i;
      while (i + 1 < line.length && '<>&'.includes(line[i + 1]!)) i += 1;
      const operator = line.slice(start, i + 1);
      const stripTabs = operator === '<<' && line[i + 1] === '-';
      if (stripTabs) i += 1;
      while (i + 1 < line.length && /[ \t]/.test(line[i + 1]!)) i += 1;
      const target = skipWord(i + 1);
      // Redirection operands are not commands, but backtick substitution in
      // one executes a command while resolving the destination. `skipWord`
      // intentionally does not parse shell expansions, so fail closed here.
      if (target.hasCommandSubstitution) segments.push([SHELL_PARSE_UNCERTAIN]);
      if (operator === '<<' && target.value) heredocs.push({ delimiter: target.value, stripTabs, quoted: target.quoted });
      i = target.end - 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (c === '\n' && heredocs.length) {
        flushSegment();
        let cursor = i + 1;
        for (const doc of heredocs.splice(0)) {
          while (cursor < line.length) {
            const end = line.indexOf('\n', cursor);
            const bodyLine = line.slice(cursor, end < 0 ? line.length : end);
            if (!doc.quoted && /`|\$\(/.test(bodyLine)) segments.push([SHELL_PARSE_UNCERTAIN]);
            const compare = doc.stripTabs ? bodyLine.replace(/^\t+/, '') : bodyLine;
            cursor = end < 0 ? line.length : end + 1;
            if (compare === doc.delimiter) break;
          }
        }
        i = cursor - 1;
      } else if (c === '\n') flushSegment();
      else flushWord();
      continue;
    }
    if (';|&()'.includes(c)) {
      flushSegment();
      if ((c === '&' || c === '|') && line[i + 1] === c) i += 1;
      continue;
    }
    word += c;
    hasWord = true;
  }
  flushSegment();
  return segments;
}

const SELF_NEST_WRAPPERS = new Set(['exec', 'command', 'nohup', 'time', 'nice', 'builtin', 'sudo']);
const SELF_NEST_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
// These wrappers can execute a nested command, but their command boundary is
// not modeled here. Refuse them rather than guessing whether they launch TUI.
const UNSUPPORTED_EXEC_WRAPPERS = new Set(['watch', 'xargs', 'tmux', 'screen']);
const SAFE_LITERAL_COMMANDS = new Set(['echo', 'printf', 'cat', 'pwd', 'ls', 'test', 'true', 'false', 'grep', 'rg', 'head', 'tail', 'sed', 'awk', 'cut', 'wc', 'stat']);
const TUI_COMMAND_MARKER = /(?:^|[\s/=@])(?:eln|elanous)(?=$|[\s/.-])/i;
const SHELL_CONTROL_WORDS = new Set(['!', 'if', 'then', 'elif', 'while', 'until', 'do', 'for', 'select', 'case', 'in', 'function', '{', '}']);
// This allowlist is intentionally limited to wrappers whose command boundary
// is parsed below. It does not model watch/xargs/tmux/screen or custom launchers.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function segmentStartsTui(tokens: readonly string[], depth = 0): boolean {
  if (tokens.includes(SHELL_PARSE_UNCERTAIN)) return true;
  if (depth > 4) return true;
  if (tokens.length === 0) return false;
  let start = 0;
  // Shell control words/operators may prefix a command segment (e.g. `! eln`
  // or `then eln`). They are not executable names; continue to the command.
  while (start < tokens.length && SHELL_CONTROL_WORDS.has(tokens[start]!)) start += 1;
  while (start < tokens.length && ENV_ASSIGNMENT.test(tokens[start]!)) start += 1;
  const command = tokens[start];
  if (!command) return false;
  const name = basenameOf(command);
  const rest = tokens.slice(start + 1);

  if (UNSUPPORTED_EXEC_WRAPPERS.has(name)) return true;
  if (name === 'eval' || name === 'ssh' || name === 'setsid') return true;
  if (name === 'find' && rest.some((token) => token === '-exec' || token === '-execdir')) return true;

  if (name === 'env') {
    let i = 0;
    while (i < rest.length) {
      const token = rest[i]!;
      if (token === '--') { i += 1; break; }
      if (token === '-S' || token === '--split-string') return rest[i + 1] !== undefined && shellCommandSegments(rest[i + 1]!, depth + 1).some((s) => segmentStartsTui(s, depth + 1));
      if (token.startsWith('--split-string=')) return shellCommandSegments(token.slice('--split-string='.length), depth + 1).some((s) => segmentStartsTui(s, depth + 1));
      if (token === '-u' || token === '--unset' || token === '-C' || token === '--chdir') { i += 2; continue; }
      if (token.startsWith('-') || ENV_ASSIGNMENT.test(token)) { i += 1; continue; }
      break;
    }
    return segmentStartsTui(rest.slice(i), depth + 1);
  }

  if (SELF_NEST_SHELLS.has(name)) {
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i]!;
      if (token === '--command' || token === '-c' || /^-[A-Za-z]*c[A-Za-z]*$/.test(token)) {
        const script = rest[i + 1];
        return script !== undefined && shellCommandSegments(script, depth + 1).some((s) => segmentStartsTui(s, depth + 1));
      }
      if (token === '--') break;
    }
    return false;
  }

  if (SELF_NEST_WRAPPERS.has(name)) {
    if (name === 'command' && ['-v', '-V', '--help'].includes(rest[0] ?? '')) return false;
    let i = 0;
    while (i < rest.length && rest[i]!.startsWith('-')) {
      const option = rest[i]!;
      if (option === '--') { i += 1; break; }
      const takesValue = (name === 'sudo' && ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-T', '--command-timeout', '-D', '--chdir'].includes(option))
        || (name === 'nice' && ['-n', '--adjustment'].includes(option))
        || (name === 'time' && ['-o', '--output', '-f', '--format'].includes(option));
      i += takesValue ? 2 : 1;
    }
    return segmentStartsTui(rest.slice(i), depth + 1);
  }

  if (name === 'npx' || name === 'bunx') {
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i] ?? '';
      if (token.startsWith('--call=') || token.startsWith('-c=')) {
        const inline = token.slice(token.indexOf('=') + 1);
        return shellCommandSegments(inline, depth + 1).some((s) => segmentStartsTui(s, depth + 1));
      }
      if (['-c', '--call'].includes(token)) {
        return rest[i + 1] !== undefined && shellCommandSegments(rest[i + 1]!, depth + 1).some((s) => segmentStartsTui(s, depth + 1));
      }
    }
  }
  if (classifyTuiLaunch(tokens.slice(start)).kind === 'elanous-tui-launch') return true;
  // Unknown commands carrying a TUI marker may be custom launch wrappers.
  // Known literal/inspection commands keep their ordinary arguments harmless.
  return !asksForInformation(rest) && !SAFE_LITERAL_COMMANDS.has(name) && rest.some((token) => TUI_COMMAND_MARKER.test(token));
}

function commandHasTuiLaunch(argv: readonly string[]): boolean {
  if (classifyTuiLaunch(argv).kind === 'elanous-tui-launch') return true;
  const command = argv[0] ?? '';
  if (/[\s;&|()<>`]/.test(command) && shellCommandSegments(command).some((segment) => segmentStartsTui(segment))) return true;
  return segmentStartsTui(argv);
}

/** First non-flag token, skipping the value of a value-taking flag. */
function firstPositional(tokens: readonly string[]): string {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token.startsWith('-')) {
      if (VALUE_TAKING_FLAGS.has(token)) i += 1;
      continue;
    }
    return token;
  }
  return '';
}

export interface TuiNestEnv {
  parentPtyId: string | null;
  nestDepth: number;
}

/** Read "am I already a TUI PTY child?" material from the same sources
 *  src/pty-shell/registry.ts uses for a child's identity:
 *  `ELANOUS_PARENT_PTY_ID` ?? `getCurrentPtyId()`, and `ELANOUS_NEST_DEPTH`. */
export function readTuiNestEnv(env: NodeJS.ProcessEnv = process.env): TuiNestEnv {
  let parentPtyId = env.ELANOUS_PARENT_PTY_ID?.trim() || null;
  if (!parentPtyId) {
    try {
      parentPtyId = getCurrentPtyId() ?? null;
    } catch {
      parentPtyId = null;
    }
  }
  const rawDepth = env.ELANOUS_NEST_DEPTH?.trim();
  const parsedDepth = rawDepth === undefined || rawDepth === '' ? 0 : Number.parseInt(rawDepth, 10);
  const nestDepth = Number.isFinite(parsedDepth) && parsedDepth > 0 ? parsedDepth : 0;
  return { parentPtyId, nestDepth };
}

export type TuiSelfNestReason = 'already-inside-tui';

export interface TuiSelfNestDecision {
  reject: boolean;
  reason: TuiSelfNestReason | null;
  command: TuiCommandKind;
  subcommand: string | null;
  parentPtyId: string | null;
  nestDepth: number;
  /** Reject + guidance text; null when the command is allowed through. */
  output: string | null;
}

function buildTuiSelfNestGuidance(input: {
  argv: readonly string[];
  parentPtyId: string | null;
  nestDepth: number;
}): string {
  const shown = input.argv.join(' ');
  const identity = [
    input.parentPtyId ? `parent pty ${input.parentPtyId}` : 'parent pty 없음',
    `nest depth ${input.nestDepth}`,
  ].join(' · ');
  return [
    `${TUI_SELF_NEST_REJECT_MARKER} 이미 TUI PTY 안입니다 (${identity}).`,
    `여기서 '${shown}' 를 다시 띄우면 두 TUI 화면·입력 루프가 서로를 덮어써 조작이 불가능해집니다.`,
    '- 이미 열린 TUI 세션에서 계속하세요: elanous pty list → elanous pty snapshot <id> / elanous pty send <id> ...',
    '- 새 TUI 가 정말 필요하면 이 PTY 밖(운영 터미널)에서 기동하세요.',
    '- 도구 세션에서 셸이 필요하면 TUI 가 아니라 일반 셸을 여세요: PtyShellStart { cmd: "bash" }.',
  ].join('\n');
}

/** Pure decision function: reject `eln`/`elanous` TUI launches when this
 *  process already lives inside a TUI PTY (parent pty id or nest depth ≥ 1).
 *  Everything else is allowed through with `reject: false`. */
export function decideTuiSelfNest(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): TuiSelfNestDecision {
  const look = classifyTuiLaunch(argv);
  const tuiLaunch = commandHasTuiLaunch(argv);
  const nest = readTuiNestEnv(env);
  const insideTui = Boolean(nest.parentPtyId) || nest.nestDepth >= 1;
  if (!tuiLaunch || !insideTui) {
    return {
      reject: false,
      reason: null,
      command: tuiLaunch ? 'elanous-tui-launch' : 'other',
      subcommand: look.subcommand,
      parentPtyId: nest.parentPtyId,
      nestDepth: nest.nestDepth,
      output: null,
    };
  }
  return {
    reject: true,
    reason: 'already-inside-tui',
    command: 'elanous-tui-launch',
    subcommand: look.subcommand,
    parentPtyId: nest.parentPtyId,
    nestDepth: nest.nestDepth,
    output: buildTuiSelfNestGuidance({ argv, parentPtyId: nest.parentPtyId, nestDepth: nest.nestDepth }),
  };
}
