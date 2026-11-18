// els control — the one door every surface walks through (ELS-EXTERNAL-SURFACES §3.1).
// Principal → authorize → classify → (HITL) → audit intent → execute → audit result.
// The transport builds the Principal (CLI = local OS uid · HTTP = PAT · webhook = signing key id · MCP/ACP = session token).
// A tool argument or a typed `--from` never becomes one; `from` is only shown.
// Default is deny: a missing, empty or broken allow list authorizes nobody.
// Allow rules are keyed by stable ids. A name in a rule is resolved and pinned to that id the first time the door
// loads it (REVIEW-1 must ③): the pinned list keeps ids, so a rename does not move a permission and a name later
// reused by a new workspace or pane inherits nothing; a name that does not resolve drops the rule until it does.
// A shell pane `do` that cannot be classified is dangerous (fail closed).
// Nothing executes unless its audit intent line was written. The text is stored only as a sha256; the audit ledger's
// reason values never quote the text (REVIEW-1 must ②). The shown `from` is stored the same way — chars and a
// sha256, never the free-input value (a495bddd8d review: audit from).

import { createHash } from 'node:crypto';
import { classifyShellArgv, simpleArgv, type AllowShape } from '../security/shell-argv-policy.js';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CONTROL_ACTIONS = ['read', 'do', 'new', 'status', 'list'] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const PRINCIPAL_KINDS = ['cli', 'eln', 'http-token', 'webhook', 'mcp-stdio', 'mcp-http'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** Built by the transport. Never accepted from a tool argument. */
export interface Principal {
  readonly id: string;
  readonly kind: PrincipalKind;
}

export interface ControlTarget {
  /** Workspace id the pane belongs to. */
  readonly workspace: string;
  /** Pane id. */
  readonly pane: string;
  /** Only a shell pane is danger-classified. An agent pane is typed text, not a shell command. */
  readonly shell: boolean;
}

export type HitlAnswer = 'approve' | 'deny' | 'timeout';

export interface HitlRequest {
  readonly principal: Principal;
  readonly from: string;
  readonly action: ControlAction;
  readonly target: ControlTarget;
  readonly text: string;
  readonly reason: string;
}

/** Ask a person. `timeout` and `deny` both mean the line is not sent. */
export type HitlAsk = (request: HitlRequest) => Promise<HitlAnswer>;

export interface ControlExecuteInput {
  readonly principal: Principal;
  readonly action: ControlAction;
  readonly target: ControlTarget;
  readonly text?: string;
}

export interface ControlExecuteResult {
  readonly exitCode: 0 | 1 | 2;
  readonly message: string;
  /** Lines waiting behind a busy pane, when the executor queued instead of sending. */
  readonly queued?: number;
}

export type ControlExecute = (input: ControlExecuteInput) => Promise<ControlExecuteResult>;

export interface AllowRule {
  /** Principal id. `*` matches every id. */
  readonly principal: string;
  /** Workspace id. `*` matches every workspace. */
  readonly workspace: string;
  /** Pane id. `*` matches every pane. */
  readonly pane: string;
  readonly actions: readonly ControlAction[];
}

/** Name-or-id → stable id, from the owner's journal. Unknown = undefined. */
export interface IdResolver {
  readonly workspace: (ref: string) => string | undefined;
  readonly pane: (ref: string) => string | undefined;
}

export interface ControlDeps {
  /** `<state>/els`. The allow list and the audit log live here. */
  readonly stateDir: string;
  readonly execute: ControlExecute;
  /** Required whenever a shell `do` can be dangerous. Absent = danger cannot be approved. */
  readonly hitl?: HitlAsk;
  /** Resolves names in the allow list to ids, pining them back to the file (REVIEW-1 must ③). Absent = ids already. */
  readonly resolve?: IdResolver;
  readonly now?: () => number;
  /** Test seam for the audit file. */
  readonly appendAudit?: (path: string, line: string) => void;
  /** A caller's door-front constraint (optional): when it returns a reason, the door refuses the call
   *  before the executor — audited as `denied` (OP 87743: els_new's exact command allowlist). */
  readonly guard?: (input: ControlExecuteInput) => string | undefined;
}

export type ControlOutcome =
  | { readonly ok: true; readonly exitCode: 0 | 1 | 2; readonly message: string; readonly queued?: number; readonly danger: 'safe' | 'approved' }
  | { readonly ok: false; readonly code: 'denied' | 'held' | 'rejected' | 'timeout' | 'audit-failed' | 'executor-error'; readonly message: string; readonly reason: string };

const AUDIT_NAME = 'control-audit.jsonl';
const ALLOW_NAME = 'control-allow.json';

/** One allow-list row, or undefined when the row is not a rule or a name in it does not resolve. */
function parseRule(value: unknown, resolve: IdResolver | undefined): AllowRule | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as { principal?: unknown; workspace?: unknown; pane?: unknown; actions?: unknown };
  if (typeof row.principal !== 'string' || typeof row.workspace !== 'string' || typeof row.pane !== 'string') return undefined;
  if (!row.principal || !row.workspace || !row.pane) return undefined;
  if (!Array.isArray(row.actions)) return undefined;
  const actions = row.actions.filter((action): action is ControlAction =>
    typeof action === 'string' && (CONTROL_ACTIONS as readonly string[]).includes(action));
  if (actions.length !== row.actions.length || actions.length === 0) return undefined;
  const workspace = row.workspace === '*' || !resolve ? row.workspace : resolve.workspace(row.workspace);
  const pane = row.pane === '*' || !resolve ? row.pane : resolve.pane(row.pane);
  if (!workspace || !pane) return undefined;
  return { principal: row.principal, workspace, pane, actions };
}

/** Missing, empty or broken file = nobody. A row that is not a rule, or names what does not exist, is dropped. */
export function loadAllowList(stateDir: string, resolve?: IdResolver): readonly AllowRule[] {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, ALLOW_NAME), 'utf8')) as { rules?: unknown };
    if (!Array.isArray(raw.rules)) return [];
    return raw.rules.flatMap((row) => { const rule = parseRule(row, resolve); return rule ? [rule] : []; });
  } catch { return []; }
}

/**
 * Pins name rules to the ids they resolve to today (REVIEW-1 must ③): the list is rewritten with ids, so a name
 * later reused by a new workspace or pane inherits nothing. A row that does not resolve stays as written — it
 * authorizes nobody until it resolves.
 *
 * a495bddd8d review: the rewrite is a unique stash plus rename, and it lands only when the file is still what
 * this run read — a revocation or concurrent edit that lands mid-run is never overwritten (that run loads the
 * admin's version instead). A pin whose write fails denies its row for this run: an unpinned name must not carry
 * a permission (fail closed).
 */
export function pinAllowList(stateDir: string, resolve?: IdResolver, seams?: { readonly beforePin?: () => void }): readonly AllowRule[] {
  const file = join(stateDir, ALLOW_NAME);
  const current = (): string => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
  const raw = current();
  let rows: readonly unknown[];
  try {
    const parsed = JSON.parse(raw) as { rules?: unknown };
    if (!Array.isArray(parsed.rules)) return [];
    rows = parsed.rules;
  } catch { return []; }
  const pinned = rows.map((row) => {
    const rule = parseRule(row, resolve);
    if (!rule || !resolve) return row;
    const named = row as { workspace?: string; pane?: string };
    return rule.workspace === named.workspace && rule.pane === named.pane
      ? row
      : { principal: rule.principal, workspace: rule.workspace, pane: rule.pane, actions: rule.actions };
  });
  if (resolve && pinned.some((row, index) => row !== rows[index])) {
    const stash = `${file}.pin.${process.pid}.${Date.now()}`;  // a stash no concurrent pin overwrites
    try {
      seams?.beforePin?.();
      writeFileSync(stash, `${JSON.stringify({ rules: pinned }, null, 2)}\n`, { mode: 0o600 });
      if (current() === raw) renameSync(stash, file);
      else { rmSync(stash, { force: true }); return loadAllowList(stateDir, resolve); }  // the file changed under us: keep the admin's version
    } catch (error) {
      try { rmSync(stash, { force: true }); } catch { /* the stash never landed */ }
      process.stderr.write(`els: control allow list not pinned: ${error instanceof Error ? error.message : String(error)}\n`);
      const kept: AllowRule[] = [];
      pinned.forEach((row, index) => { if (row === rows[index]) { const rule = parseRule(row, resolve); if (rule) kept.push(rule); } });
      return kept;
    }
  }
  return pinned.flatMap((row) => { const rule = parseRule(row, resolve); return rule ? [rule] : []; });
}

function matches(pattern: string, value: string): boolean {
  return pattern === '*' || pattern === value;
}

/** Default deny. A rule must name this principal (or `*`), this workspace id, this pane id, and this action. */
export function authorize(rules: readonly AllowRule[], principal: Principal, target: ControlTarget, action: ControlAction): boolean {
  if (!principal.id || !PRINCIPAL_KINDS.includes(principal.kind)) return false;
  return rules.some((rule) =>
    matches(rule.principal, principal.id)
    && matches(rule.workspace, target.workspace)
    && matches(rule.pane, target.pane)
    && rule.actions.includes(action));
}

interface DangerRule { readonly reason: string; readonly re: RegExp }

// 출처: ELS-EXTERNAL-SURFACES §2 — a shell `do` that matches one of these, or that cannot be classified, is dangerous.
const DANGER: readonly DangerRule[] = [
  { reason: 'recursive rm', re: /\brm\b[^;&|]*\s-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b/ },
  { reason: 'rm of /', re: /\brm\b[^;&|]*\s+\/(?:\s|$)/ },
  { reason: 'git push --force', re: /\bgit\s+push\b[^;&|]*(?:\s-f\b|\s--force\b)(?!-with-lease)/ },
  { reason: 'sudo', re: /\bsudo\b/ },
  { reason: 'doas', re: /\bdoas\b/ },
  { reason: 'pipe into a shell', re: /\b(?:curl|wget)\b[^;&|]*\|\s*(?:ba)?sh\b/ },
  { reason: 'dd onto a device', re: /\bdd\b[^;&|]*\bof=\/dev\// },
  { reason: 'mkfs', re: /\bmkfs(?:\.\S+)?\b/ },
  { reason: 'chmod -R', re: /\bchmod\b[^;&|]*\s-R\b/ },
  { reason: 'redirect overwrite', re: /(?:^|[^>])>(?!>)|(?:^|[^<])>>/ },
];

// Anything that chains, substitutes, expands or redirects is shell syntax this table does not read.
const SHELL_SYNTAX = /[;&|<>`$(){}\\]/;

// 출처: ELS-EXTERNAL-SURFACES §2 · REVIEW-1 must ① — the only commands a shell `do` may run without a person.
// For git, safe is one read-only subcommand whose every argument matches its pattern list (a bare token only where a
// bare token cannot mutate): `git push` is never safe — it mutates the remote; `git branch <name>` creates one.
// #38607 r1 must ⓒ: free `args` tokens are not a blanket shape any more — each command carries only the argument
// shapes that prove it read-only, so `date -s <clock>` (every other setter form too) falls off the list and asks a
// person. Printers keep free tokens (every flag they take reads); `date` lists read-only shapes exactly; the bare
// commands (pwd/whoami/clear/true) take no arguments at all.
const SAFE_ARGS: Readonly<Record<string, readonly RegExp[]>> = {
  echo: [/^[^\s]+$/],
  ls: [/^[^\s]+$/],
  cat: [/^[^\s]+$/],
  head: [/^[^\s]+$/],
  tail: [/^[^\s]+$/],
  wc: [/^[^\s]+$/],
  grep: [/^[^\s]+$/],
  which: [/^[^\s]+$/],
  cd: [/^[^\s]+$/],
  date: [/^-(?:u|R)$/, /^--(?:utc|rfc-2822)$/, /^\+[^\s]+$/],
  pwd: [],
  whoami: [],
  clear: [],
  true: [],
};
interface GitSafety { readonly args: readonly RegExp[]; readonly bare: boolean }
const SAFE_GIT: Readonly<Record<string, GitSafety>> = {
  status: { args: [/^-(?:s|b)$/, /^--(?:short|porcelain|branch)$/], bare: true },
  log: { args: [/^--(?:oneline|graph|decorate|all|stat|follow)$/, /^-[np]\d{1,7}$/, /^-\d{1,7}$/, /^HEAD(?:[~^]\d{1,3})*$/, /^[0-9a-f]{7,40}$/], bare: true },
  diff: { args: [/^--(?:stat|cached|staged|name-only|name-status|quiet|color-words|word-diff)$/, /^-[abcupq]$/, /^HEAD(?:[~^]\d{1,3})*$/, /^[0-9a-f]{7,40}$/], bare: true },
  show: { args: [/^--(?:stat|name-only|name-status|oneline|no-patch|abbrev-commit)$/, /^HEAD(?:[~^]\d{1,3})*$/, /^[0-9a-f]{7,40}$/], bare: true },
  branch: { args: [/^-(?:a|v|r)$/, /^--(?:list|all|remotes|show-current|verbose)$/], bare: false },
  fetch: { args: [/^--(?:all|tags)$/], bare: false },
};

/** 출처: ELN-SEAT-APPROVAL-POLICY r4 «Bloom 5» — 허용 목록은 모듈의 argv 정확 모양 표로 간다. SAFE_ARGS 는
 *  읽기 전용 명령 + 그 인자의 읽기 전용 모양 목록이고, SAFE_GIT 는 하위 명령 리터럴 + 인자 패턴 목록이다. */
const ELS_ALLOW_SHAPES: readonly AllowShape[] = [
  ...Object.entries(SAFE_ARGS).flatMap(([name, args]): readonly AllowShape[] => {
    const shapes: AllowShape[] = [{ id: `safe:${name}`, name: `safe ${name}`, tokens: [{ lit: name }] }];
    if (args.length > 0) {
      shapes.push({
        id: `safe:${name}:args`,
        name: `safe ${name} args`,
        tokens: [{ lit: name }, { rep: 'args', re: new RegExp(`(?:${args.map((re) => re.source).join('|')})`) }],
      });
    }
    return shapes;
  }),
  ...Object.entries(SAFE_GIT).flatMap(([sub, rule]): readonly AllowShape[] => [
    { id: `git:${sub}`, name: `git ${sub}`, tokens: [{ lit: 'git' }, { lit: sub }] },
    { id: `git:${sub}:args`, name: `git ${sub} args`, tokens: [
      { lit: 'git' },
      { lit: sub },
      { rep: 'args', re: new RegExp(`(?:${[...rule.args.map((re) => re.source), ...(rule.bare ? [/^(?!-)[^\s]+$/u.source] : [])].join('|')})`) },
    ] },
  ]),
];

/** A shell line is safe only when no danger rule matches, it has no shell syntax, and its argv is on the allow
 *  list by exact shape (shared module `classifyShellArgv`). The reason never quotes the line: no body in the audit ledger. */
export function classifyShell(text: string): { readonly dangerous: true; readonly reason: string } | { readonly dangerous: false; readonly reason: 'safe' } {
  const line = text.trim();
  if (!line) return { dangerous: true, reason: 'empty command cannot be classified' };
  if (/[\n\r\u0000]/.test(text)) return { dangerous: true, reason: 'a shell do is one line' };
  for (const rule of DANGER) {
    if (rule.re.test(line)) return { dangerous: true, reason: rule.reason };
  }
  if (SHELL_SYNTAX.test(line)) return { dangerous: true, reason: 'shell syntax cannot be classified' };
  const argv = simpleArgv(line);
  if (argv === null || argv.length === 0) return { dangerous: true, reason: 'shell syntax cannot be classified' };
  const decision = classifyShellArgv({ command: text, argv, allow: ELS_ALLOW_SHAPES });
  if (decision.verdict === 'allow') return { dangerous: false, reason: 'safe' };
  if (decision.verdict === 'deny') return { dangerous: true, reason: decision.reason };
  const [command = '', sub = ''] = argv;
  if (command === 'git' && !SAFE_GIT[sub]) return { dangerous: true, reason: 'not on the safe list' };
  return {
    dangerous: true,
    reason: command === 'git' ? 'git arguments not on the safe list'
      : command in SAFE_ARGS ? `${command} arguments not on the safe list`
        : 'not on the safe list',
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function defaultAppend(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, { mode: 0o600 });
}

/**
 * The one door. `execute` runs only after authorize, after HITL when the shell line is dangerous, and after the
 * audit intent line is on disk. Every exit writes an audit line (best effort when nothing runs).
 */
export function createControl(deps: ControlDeps) {
  const now = deps.now ?? Date.now;
  const append = deps.appendAudit ?? defaultAppend;
  const audit = (entry: Record<string, unknown>): string | undefined => {
    try {
      append(join(deps.stateDir, AUDIT_NAME), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
      return undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(`els: control audit not written: ${reason}\n`);
      return reason;
    }
  };
  return {
    async run(input: { readonly principal: Principal; readonly from?: string; readonly action: ControlAction; readonly target: ControlTarget; readonly text?: string }): Promise<ControlOutcome> {
      const text = input.text ?? '';
      const from = input.from ?? input.principal.id;
      const base = {
        principal: input.principal.id, kind: input.principal.kind, fromChars: from.length, fromSha256: sha256(from),
        workspace: input.target.workspace, pane: input.target.pane, action: input.action,
        chars: text.length, sha256: sha256(text), at: now(),
      };
      const rules = pinAllowList(deps.stateDir, deps.resolve);
      if (!authorize(rules, input.principal, input.target, input.action)) {
        const reason = 'not in control-allow.json';
        audit({ ...base, result: 'denied', danger: 'n/a', reason });
        return { ok: false, code: 'denied', reason, message: `els ${input.action}: denied for ${input.principal.id} (not in control-allow.json)` };
      }
      const refused = deps.guard ? deps.guard(input) : undefined;
      if (refused !== undefined) {
        audit({ ...base, result: 'denied', danger: 'n/a', reason: refused });
        return { ok: false, code: 'denied', reason: refused, message: `els ${input.action}: denied (${refused})` };
      }
      const danger = input.action === 'do' && input.target.shell ? classifyShell(text) : { dangerous: false as const, reason: 'safe' as const };
      if (danger.dangerous) {
        if (!deps.hitl) {
          const reason = `${danger.reason}; no person to ask`;
          audit({ ...base, result: 'held', danger: danger.reason, reason });
          return { ok: false, code: 'held', reason, message: `els do: held, not sent (${danger.reason}; nobody to approve)` };
        }
        const answer = await deps.hitl({ principal: input.principal, from, action: input.action, target: input.target, text, reason: danger.reason });
        if (answer !== 'approve') {
          const code = answer === 'timeout' ? 'timeout' : 'rejected';
          audit({ ...base, result: code, danger: danger.reason, reason: answer });
          return { ok: false, code, reason: danger.reason, message: `els do: ${answer}, not sent (${danger.reason})` };
        }
      }
      const verdict = danger.dangerous ? 'approved' : 'safe';
      const intentFailed = audit({ ...base, result: 'executing', danger: verdict });
      if (intentFailed !== undefined) {
        return { ok: false, code: 'audit-failed', reason: intentFailed, message: `els ${input.action}: not sent (audit not writable: ${intentFailed})` };
      }
      let done: ControlExecuteResult;
      try {
        done = await deps.execute({ principal: input.principal, action: input.action, target: input.target, ...(text ? { text } : {}) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`els: control executor error: ${reason}\n`);
        audit({ ...base, result: 'executor-error', danger: verdict, reason: 'executor failed' });
        return { ok: false, code: 'executor-error', reason, message: `els ${input.action}: failed (${reason})` };
      }
      const resultFailed = audit({ ...base, result: done.exitCode === 0 ? 'executed' : 'executor-refused', danger: verdict, exitCode: done.exitCode, ...(done.queued !== undefined ? { queued: done.queued } : {}) });
      const exitCode = resultFailed !== undefined && done.exitCode === 0 ? 1 : done.exitCode;
      const message = resultFailed !== undefined ? `${done.message} (line sent; audit result not written: ${resultFailed})` : done.message;
      return { ok: true, exitCode, message, ...(done.queued !== undefined ? { queued: done.queued } : {}), danger: verdict };
    },
  };
}
