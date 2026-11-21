// ── Per-command parallel isolation for Bash tool calls (JUD #39447 HOLD #122147) ──
//
// The native-tool-catalog `supportsParallel=true` flag on Bash
// (CAPSULE-A2 §3.6 C3 :805 detach axis) is an opt-in, never a blanket
// licence. A Bash call is only parallel-safe when a static, deliberately
// conservative pass proves its command cannot mutate anything; one
// write/mutating command in a batch pins the WHOLE batch to
// original-order sequential dispatch (see parallel-dispatch.ts).
//
// 3rd HOLD (hold-39447-833c524ba42c.json · OP #123504): the pass is a
// POSITIVE allow-list. Default serial. Only (head + verified argument
// form) pairs from READ_ONLY_HEAD_FLAG_FORMS may fan out, and because the
// token split below is raw whitespace — NOT parsed shell words — every
// syntax the split cannot verify (quotes, variables, command
// substitution, globs, brace/paren expansion, any redirection, including
// the `2>&1` descriptor dup) degrades to serial before the per-head
// forms are even checked. Unknown flags on an allow-listed head are
// equally unverifiable ⇒ serial.
//
// Long detached monitors (`sleep N; echo DONE` probes) stay read-only and
// keep fanning out — that is the C3-TRIO detach contract.

export type BashIsolationKind = 'read-only' | 'mutating';

export interface BashCommandIsolation {
  readonly kind: BashIsolationKind;
  readonly reason: string;
}

/**
 * Verified-argument-form gate for one allow-listed head. Tokens are raw
 * whitespace splits; a token starting with `-` must match the head's known
 * read-only flag forms (short cluster or long `--flag[=value]`), anything
 * else is an unverifiable flag ⇒ serial. Plain non-dash tokens are inert
 * operands (patterns/paths) for these read-only heads. `sleep` demands
 * numeric durations only; `echo` allows only its newline/escape flags.
 */
type ArgumentFormGate = (tokens: readonly string[]) => string | null;

/** Flags (after one `-`) that keep each head read-only; long forms allow `=value`. */
function flagForms(head: string, short: RegExp, long: RegExp[] = []): ArgumentFormGate {
  return (tokens) => {
    for (const token of tokens) {
      if (token === '--') continue;
      if (token.startsWith('-')) {
        const ok = token.startsWith('--') ? long.some((re) => re.test(token)) : short.test(token);
        if (!ok) return `${head} unverified argument form: ${token}`;
      }
    }
    return null;
  };
}

function numericOnly(head: string): ArgumentFormGate {
  return (tokens) => {
    for (const token of tokens) {
      if (!/^\d+(?:\.\d+)?$/.test(token)) return `${head} non-numeric duration: ${token}`;
    }
    return null;
  };
}

function echoForms(): ArgumentFormGate {
  return (tokens) => {
    for (const token of tokens) {
      if (token.startsWith('-') && !/^(?:-n|-e|-E|--)$/.test(token)) return `echo unverified argument form: ${token}`;
    }
    return null;
  };
}

/**
 * The positive allow-list (JUD 3rd HOLD · OP #123504): default serial, and a
 * Bash segment may fan out ONLY with one of these heads AND its verified
 * argument forms. Absent from this map ⇒ mutating (conservative). sort
 * (`-o/--output` writes), find (`-exec/-ok/-delete/-fprint*` act), env (a
 * trailing command runs), and every other head are intentionally OUT.
 */
const READ_ONLY_HEAD_FLAG_FORMS: ReadonlyMap<string, ArgumentFormGate> = new Map([
  ['cat', flagForms('cat', /^-[nbseStTuvA]+$/)],
  ['head', flagForms('head', /^-(?:[qc]|[nc]\d*|\d+)$/)],
  ['tail', flagForms('tail', /^-(?:[qc]|[nc]\d*|\d+)$/)],
  ['wc', flagForms('wc', /^-[clmw]+$/)],
  ['ls', flagForms('ls', /^-[1aAdFfGhHilLpQrRsStTuUwx]+$/, [/^--(?:color|sort|time|time-style|hide|quote-style)(?:=.*)?$/, /^--(?:group-directories-first|literal|escape)$/])],
  ['grep', flagForms('grep', /^-(?:[ivnrREFwxcLlqshoaIbPefzGKU]+|[mABC]\d+)$/, [/^--(?:include|exclude|exclude-dir|color)(?:=.*)?$/])],
  // 4th HOLD(OP #123678): rg removed — external settings (RIPGREP_CONFIG_PATH) and the
  // executable's provenance are not guaranteed by the command line, so rg stays serial.
  ['sleep', numericOnly('sleep')],
  ['echo', echoForms()],
]);

/**
 * Classify one Bash command string for parallel isolation. Conservative by
 * construction: `read-only` requires every shell segment to carry an
 * allow-listed head with verified argument forms and nothing the raw
 * whitespace split cannot verify.
 */
export function classifyBashCommand(command: string): BashCommandIsolation {
  if (command.trim().length === 0) return { kind: 'mutating', reason: 'empty command' };
  // Raw whitespace tokens are not parsed shell words: quotes, variables,
  // substitution, globs, brace/paren expansion and any redirection (incl.
  // `2>&1`) are unverifiable syntax ⇒ the whole command stays serial.
  const unverifiable = command.match(/['"`$*?[\]{}()<>]/);
  if (unverifiable) return { kind: 'mutating', reason: `unverifiable shell syntax: ${unverifiable[0]}` };
  for (const segment of splitShellSegments(command)) {
    const tokens = segment.trim().split(/\s+/);
    const head = tokens[0] ?? '';
    const verify = READ_ONLY_HEAD_FLAG_FORMS.get(head);
    if (!verify) {
      return { kind: 'mutating', reason: `head not in the positive read-only allow-list: ${head || '(empty segment)'}` };
    }
    const violation = verify(tokens.slice(1));
    if (violation !== null) return { kind: 'mutating', reason: violation };
  }
  return { kind: 'read-only', reason: 'allow-listed heads with verified argument forms' };
}

/** Split on shell control operators (`;`, `&&`, `||`, `|`, `&`, newline). */
function splitShellSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;|&\n])/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}