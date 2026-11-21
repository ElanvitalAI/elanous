// els control — the one door every surface walks through (ELS-EXTERNAL-SURFACES §3.1).
// Principal → authorize → classify → (HITL) → audit intent → execute → audit result.
// The transport builds the Principal (CLI = local OS uid · HTTP = PAT · webhook = signing key id · MCP/ACP = session token).
// A tool argument or a typed `--from` never becomes one; `from` is only shown.
// Other actions default deny; authenticated OP/RES-INFRA input has a code default, subject to explicit deny.
// Allow rules are keyed by stable ids. A name in a rule is resolved and pinned to that id the first time the door
// loads it (REVIEW-1 must ③): the pinned list keeps ids, so a rename does not move a permission and a name later
// reused by a new workspace or pane inherits nothing; a name that does not resolve drops the rule until it does.
// A shell pane `do` that cannot be classified is dangerous (fail closed).
// Nothing executes unless its audit intent line was written. The text is stored only as a sha256; the audit ledger's
// reason values never quote the text (REVIEW-1 must ②). The shown `from` is stored the same way — chars and a
// sha256, never the free-input value (a495bddd8d review: audit from).

import { createHash, randomUUID } from 'node:crypto';
import { clean, type QueueAudit } from './core.js';
import { classifyShellArgv, simpleArgv, type AllowShape } from '../security/shell-argv-policy.js';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sameUidSeatBoundary } from './seat-boundary.js';

export const CONTROL_ACTIONS = ['read', 'do', 'input', 'new', 'status', 'list', 'rename', 'move', 'close'] as const;

/** OP #17 OP-DIRECT-SEAT-INPUT: `input` is the operator's direct line into a seat — these principal ids only. */
const INPUT_SEATS = ['OP', 'RES-INFRA'];
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export const PRINCIPAL_KINDS = ['cli', 'eln', 'http-token', 'webhook', 'mcp-stdio', 'mcp-http', 'acp-session'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** Built by the transport. Never accepted from a tool argument. */
export interface Principal {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly callerPane?: string;
  readonly callerSeat?: string;
  /** ELS-OP-ALLOW-RULE: seat identity the transport vouches for ('OP' or a seat name). The coded default rules key on this. */
  readonly seat?: string;
  /** ELS-OP-ALLOW-RULE: workspaces the transport vouches the seat owns; hand seats may control only these. */
  readonly workspaces?: readonly string[];
}

export interface ControlTarget {
  /** Workspace id the pane belongs to. */
  readonly workspace: string;
  /** Tab id. ELS-DOOR-STRUCT-OPS: tab-scoped structural actions name their tab here. */
  readonly tab?: string;
  /** Pane id. */
  readonly pane: string;
  /** Only a shell pane is danger-classified. An agent pane is typed text, not a shell command. */
  readonly shell: boolean;
  /** SAME-UID-SEAT-ISOLATION: seat that owns this pane, when the transport knows it. Unknown = legacy behavior. */
  readonly ownerSeat?: string;
  /** SAME-UID-SEAT-ISOLATION: other seats the owner explicitly shared this pane with. */
  readonly sharedWith?: readonly string[];
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

/** ELS-DOOR-STRUCT-OPS: the payload a structural action carries — `kind`+`id` name the object, `name` renames, `before` reorders. */
export interface StructPayload {
  readonly kind: 'workspace' | 'tab' | 'pane';
  readonly id: string;
  readonly name?: string;
  readonly before?: string;
}

export interface ControlExecuteInput {
  readonly principal: Principal;
  readonly action: ControlAction;
  readonly target: ControlTarget;
  readonly text?: string;
  /** ELS-DOOR-STRUCT-OPS: rename/move/close payload the executor routes to core. */
  readonly struct?: StructPayload;
  /** ELS-DOOR-STRUCT-OPS: human confirmation marker. `close` demands `true`; anything else is denied. */
  readonly confirm?: boolean;
  /** Forward to core.inputLine for queued delivery lifecycle auditing. */
  readonly queueAudit?: QueueAudit;
  /** The transport's original path (#38453 REVIEW must ④): `/els/v1/send` stays distinguishable from `/els/v1/do`. */
  readonly path?: string;
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
  /** ELS-DOOR-STRUCT-OPS: tab id. `*` or absent = every tab. A present tab id scopes the rule to that tab only. */
  readonly tab?: string;
  readonly actions: readonly ControlAction[];
  readonly seat?: string;
  /** Explicit input deny overrides the code default; omitted means the legacy allow. */
  readonly effect?: 'allow' | 'deny';
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
  /** Server-selected tool do routed through input retains the stricter shell do classifier. */
  readonly inputUsesDoPolicy?: boolean;
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

export type SocketAudit = { readonly peerPid: number | undefined; readonly claimedPid?: number };
const socketAuditFields = (socket: SocketAudit | undefined) => socket ? {
  peerPid: socket.peerPid ?? 'unknown', ...(socket.claimedPid !== undefined ? { claimedPid: socket.claimedPid } : {}),
} : {};

const AUDIT_NAME = 'control-audit.jsonl';
const ALLOW_NAME = 'control-allow.json';

/** #90792 P0 ③ — panes this process is asking a person about, keyed `<stateDir>\u0000<pane>`: while the ask is in
 *  flight, the send family (action `do` — send-text and send-keys at this door) is refused for that pane. The wait
 *  lives in this door (measured: neither core nor the journal records a pending approval), so the guard lives here. */
const PENDING_ASKS = new Set<string>();

/** One allow-list row, or undefined when the row is not a rule or a name in it does not resolve. */
function parseRule(value: unknown, resolve: IdResolver | undefined): AllowRule | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as { principal?: unknown; workspace?: unknown; pane?: unknown; tab?: unknown; actions?: unknown; seat?: unknown; effect?: unknown };
  if (typeof row.principal !== 'string' || typeof row.workspace !== 'string' || typeof row.pane !== 'string') return undefined;
  if (row.tab !== undefined && typeof row.tab !== 'string') return undefined;
  if (!row.principal || !row.workspace || !row.pane) return undefined;
  if (!Array.isArray(row.actions)) return undefined;
  if (row.effect !== undefined && row.effect !== 'allow' && row.effect !== 'deny') return undefined;
  if (row.seat !== undefined && (typeof row.seat !== 'string' || !row.seat)) return undefined;
  const actions = row.actions.filter((action): action is ControlAction =>
    typeof action === 'string' && (CONTROL_ACTIONS as readonly string[]).includes(action));
  if (actions.length !== row.actions.length || actions.length === 0) return undefined;
  const workspace = row.workspace === '*' || !resolve ? row.workspace : resolve.workspace(row.workspace);
  const pane = row.pane === '*' || !resolve ? row.pane : resolve.pane(row.pane);
  if (!workspace || !pane) return undefined;
  return { principal: row.principal, workspace, pane, tab: row.tab, actions, ...(typeof row.seat === 'string' ? { seat: row.seat } : {}), ...(row.effect ? { effect: row.effect } : {}) };
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
 * this run read — a revocation or concurrent edit that lands mid-run is never overwritten. A failed pin or
 * concurrent change denies this entire request: neither an unpinned
 * name nor a stale policy snapshot may be used for authorization.
 */
export function pinAllowList(stateDir: string, resolve?: IdResolver, seams?: { readonly beforePin?: () => void }): readonly AllowRule[] {
  const file = join(stateDir, ALLOW_NAME);
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { rules?: unknown }).rules)) throw new Error('invalid control policy shape');
  const rows: readonly unknown[] = (parsed as { rules: unknown[] }).rules;
  const resolved = rows.map((row) => {
    const shape = parseRule(row, undefined);
    if (!shape) throw new Error('invalid control policy rule');
    const rule = resolve ? parseRule(row, resolve) : shape;
    if (shape.effect === 'deny' && !rule) throw new Error('unresolved control deny');
    return rule;
  });
  const pinned = rows.map((row, index) => {
    const rule = resolved[index];
    if (!rule || !resolve) return row;
    const named = row as { workspace?: string; pane?: string };
    return rule.workspace === named.workspace && rule.pane === named.pane
      ? row
      : { principal: rule.principal, workspace: rule.workspace, pane: rule.pane, actions: rule.actions, ...(rule.tab !== undefined ? { tab: rule.tab } : {}), ...(rule.seat ? { seat: rule.seat } : {}), ...(rule.effect ? { effect: rule.effect } : {}) };
  });
  if (resolve && pinned.some((row, index) => row !== rows[index])) {
    const stash = `${file}.pin.${process.pid}.${Date.now()}`;  // a stash no concurrent pin overwrites
    try {
      seams?.beforePin?.();
      writeFileSync(stash, `${JSON.stringify({ rules: pinned }, null, 2)}\n`, { mode: 0o600 });
      if (readFileSync(file, 'utf8') === raw) renameSync(stash, file);
      else { rmSync(stash, { force: true }); throw new Error('control policy changed during pin'); }
    } catch (error) {
      try { rmSync(stash, { force: true }); } catch { /* the stash never landed */ }
      process.stderr.write(`els: control allow list not pinned: ${error instanceof Error ? error.message : String(error)}\n`);
      throw error; // Neither stale grants nor unpinned denies are safe for this request.
    }
  }
  return resolved.filter((rule): rule is AllowRule => rule !== undefined);
}

function matches(pattern: string, value: string): boolean {
  return pattern === '*' || pattern === value;
}
export function inputExplicitlyDenied(rules: readonly AllowRule[], principal: Principal, target: ControlTarget): boolean {
  return rules.some((rule) => rule.effect === 'deny'
    && matches(rule.principal, principal.id) && matches(rule.workspace, target.workspace)
    && matches(rule.pane, target.pane) && rule.actions.includes('input')
    && (rule.tab === undefined || matches(rule.tab, target.tab ?? ''))
    && (rule.seat === undefined || rule.seat === principal.callerSeat));
}

/** Default deny. A rule must name this principal (or `*`), this workspace id, this pane id, and this action. */
export function authorize(rules: readonly AllowRule[], principal: Principal, target: ControlTarget, action: ControlAction): boolean {
  if (!principal.id || !PRINCIPAL_KINDS.includes(principal.kind)) return false;
  return rules.some((rule) =>
    rule.effect !== 'deny' && matches(rule.principal, principal.id)
    && matches(rule.workspace, target.workspace)
    && matches(rule.pane, target.pane)
    && (rule.tab === undefined || (target.tab !== undefined && matches(rule.tab, target.tab)))
    && rule.actions.includes(action));
}

/** ELS-OP-ALLOW-RULE(ELS-OP-SMALLWINS ⑦): actions that destroy or relocate work — they need an explicit human confirmation marker or nothing moves. Guards close/move wherever the vocabulary lands (#39025 짝). */
export const CONFIRM_REQUIRED_ACTIONS: ReadonlySet<string> = new Set(['close', 'move']);

/**
 * ELS-OP-ALLOW-RULE: coded default rules (옵션 0 · 기본 동작). File rules (control-allow.json) stay
 * authoritative; these defaults fill the gap when the file is silent:
 * OP seat → every pane; hand seats → only their own bound workspaces; close/move → human
 * confirmation marker; anything else → deny with audit. Null when the principal carries no seat identity.
 */
export function defaultDecision(principal: Principal, target: ControlTarget, action: ControlAction, confirmed: boolean): { readonly allow: boolean; readonly reason: string } | null {
  if (!principal.seat) return null;
  if (CONFIRM_REQUIRED_ACTIONS.has(action) && !confirmed) return { allow: false, reason: `${action} needs confirm:true (human confirmation)` };
  if (principal.seat === 'OP') return { allow: true, reason: 'default rules: OP seat commands all panes' };
  if (principal.seat.startsWith('HAND-')) {
    const own = principal.workspaces ?? [];
    if (!own.includes(target.workspace)) return { allow: false, reason: `default rules: seat ${principal.seat} may control only its own workspaces (target ${target.workspace} not bound)` };
    return { allow: true, reason: `default rules: hand seat ${principal.seat} controls its own workspace ${target.workspace}` };
  }
  return null;
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
/** OP #17 OP-DIRECT-SEAT-INPUT: a shell-pane `input` line is the operator's own typing, not a tool-authored
 * command — the safe-argv allow list never applies. Only the danger table (and shape) gates it, so a plain
 * word reaches the pane and a dangerous line is held for a person. */
export function classifyInputLine(text: string): { readonly dangerous: true; readonly reason: string } | { readonly dangerous: false; readonly reason: 'safe' } {
  const line = text.trim();
  if (!line) return { dangerous: true, reason: 'empty command cannot be classified' };
  if (/[\n\r\u0000]/.test(text)) return { dangerous: true, reason: 'an input line is one line' };
  for (const rule of DANGER) {
    if (rule.re.test(line)) return { dangerous: true, reason: rule.reason };
  }
  return { dangerous: false, reason: 'safe' };
}

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

/** Surfaces that refuse before the door (bad signature, replayed nonce) still write one audit line here. Nothing runs, so best effort. */
export function audit(stateDir: string, entry: Record<string, unknown>): void {
  try {
    defaultAppend(join(stateDir, AUDIT_NAME), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch (error) {
    process.stderr.write(`els: control audit not written: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * #90792 P0 ④ — one audit line per send-family execution that reaches the owner directly over its socket
 * (`els pane send-text` / `send-keys` / `run`, `els send --no-enter`): the same ledger, the same line shape and
 * the same no-raw-text rule as the door's own lines — the text only as its length and its sha256.
 */
export function appendSendAudit(stateDir: string, send: {
  readonly op: 'send' | 'input';
  readonly pane: string;
  readonly text: string;
  readonly exitCode: 0 | 1 | 2;
  readonly workspace?: string;
  readonly socketAudit?: SocketAudit;
}): string | undefined {
  try {
    defaultAppend(join(stateDir, AUDIT_NAME), `${JSON.stringify({
      ts: new Date().toISOString(),
      principal: 'local', kind: 'cli', ...socketAuditFields(send.socketAudit),
      ...(send.workspace ? { workspace: send.workspace } : {}),
      pane: send.pane, action: send.op, chars: send.text.length, sha256: sha256(send.text), at: Date.now(),
      result: send.exitCode === 0 ? 'executed' : 'executor-refused', exitCode: send.exitCode,
    })}\n`);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`els: send audit not written: ${reason}\n`);
    return reason;
  }
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
    async run(input: { readonly principal: Principal; readonly from?: string; readonly action: ControlAction; readonly target: ControlTarget; readonly text?: string; readonly struct?: StructPayload; readonly confirm?: boolean; readonly path?: string; readonly fixedKey?: 'escape'; readonly socketAudit?: SocketAudit }): Promise<ControlOutcome> {
      const text = input.text ?? '';
      // The server-selected interrupt is a raw Escape, whereas normal input is a sanitized line.
      const auditedText = input.fixedKey === 'escape' ? '\x1b' : input.action === 'input' ? clean(text) : text;
      const from = input.from ?? input.principal.id;
      // ELS-DOOR-STRUCT-OPS: close destroys work. It must carry a human confirmation marker; nothing else closes.
      if (input.action === 'close' && input.confirm !== true) {
        const reason = 'close needs confirm:true (human confirmation)';
        audit({ ...socketAuditFields(input.socketAudit), principal: input.principal.id, kind: input.principal.kind, workspace: input.target.workspace, tab: input.target.tab, pane: input.target.pane, action: input.action, result: 'denied', danger: 'n/a', reason, chars: 0, sha256: sha256(''), at: now() });
        return { ok: false, code: 'denied', reason, message: `els close: denied for ${input.principal.id} (${reason})` };
      }
      const base = {
        ...socketAuditFields(input.socketAudit),
        ...(input.action === 'input' ? { requestId: randomUUID() } : {}),
        principal: input.principal.id, kind: input.principal.kind, callerPane: input.principal.callerPane, seat: input.principal.callerSeat, fromChars: from.length, fromSha256: sha256(from),
        workspace: input.target.workspace, pane: input.target.pane, action: input.action,
        chars: auditedText.length, sha256: sha256(auditedText), at: now(),
      };
      let rules: readonly AllowRule[];
      try { rules = pinAllowList(deps.stateDir, deps.resolve); }
      catch {
        const reason = 'control policy unavailable';
        const auditFailure = audit({ ...base, result: 'denied', danger: 'n/a', reason });
        if (auditFailure) return { ok: false, code: 'audit-failed', reason: auditFailure, message: `els ${input.action}: denied; audit not written` };
        return { ok: false, code: 'denied', reason, message: `els ${input.action}: denied (${reason})` };
      }
      if (CONFIRM_REQUIRED_ACTIONS.has(input.action) && input.confirm !== true) {
        const reason = `${input.action} needs confirm:true (human confirmation)`;
        audit({ ...base, result: 'denied', danger: 'n/a', reason });
        return { ok: false, code: 'denied', reason, message: `els ${input.action}: denied for ${input.principal.id} (${reason})` };
      }
      // OP #17: a shell-pane `input` line is danger-gated FIRST (fail closed — a dangerous line is held before
      // any allow question, same gate as `do`); the builtin seat default then decides the rest.
      const inputDanger = input.action === 'input' && input.target.shell
        ? deps.inputUsesDoPolicy ? classifyShell(clean(text)) : classifyInputLine(text)
        : undefined;
      if (inputDanger?.dangerous) {
        if (!deps.hitl) {
          const reason = `${inputDanger.reason}; no person to ask`;
          audit({ ...base, result: 'held', danger: inputDanger.reason, reason });
          const guidance = deps.inputUsesDoPolicy ? '; agent prose is not supported; use eln msg for seat instructions' : '';
          return { ok: false, code: 'held', reason, message: `els input: held, not sent (${inputDanger.reason}; nobody to approve${guidance})` };
        }
        const answer = await deps.hitl({ principal: input.principal, from, action: input.action, target: input.target, text, reason: inputDanger.reason });
        if (answer !== 'approve') {
          const code = answer === 'timeout' ? 'timeout' : 'rejected';
          audit({ ...base, result: code, danger: inputDanger.reason, reason: answer });
          return { ok: false, code, reason: inputDanger.reason, message: `els input: ${answer}, not sent (${inputDanger.reason})` };
        }
      }
      // The socket transport authenticates callerSeat/callerPane, then revalidates at execution.
      // File denies override the built-in input rule; legacy allow rows cannot grant input.
      const principal = input.principal;
      const inputDefault = input.action === 'input' && principal.kind === 'cli'
        && /^local:\d+$/.test(principal.id) && !!principal.callerPane
        && INPUT_SEATS.includes(principal.callerSeat ?? '');
      const inputDenied = input.action === 'input' && inputExplicitlyDenied(rules, principal, input.target);
      const permitted = input.action === 'input' ? inputDefault && !inputDenied
        : authorize(rules, principal, input.target, input.action);
      // ELS-OP-ALLOW-RULE: coded defaults fill the gap when control-allow.json is silent (input keeps its builtin rule).
      const coded = input.action === 'input' ? null : (permitted ? null : defaultDecision(principal, input.target, input.action, input.confirm === true));
      const authorization = input.action === 'input' && inputDefault && !inputDenied ? 'builtin-input' : undefined;
      if (!permitted && !coded?.allow) {
        const reason = input.action === 'input' ? (inputDenied ? 'explicit input deny' : 'not in control-allow.json') : (coded?.reason ?? 'not in control-allow.json');
        const auditFailure = audit({ ...base, result: 'denied', danger: 'n/a', reason });
        if (auditFailure) return { ok: false, code: 'audit-failed', reason: auditFailure, message: `els ${input.action}: denied; audit not written` };
        return { ok: false, code: 'denied', reason, message: `els ${input.action}: denied for ${input.principal.id} (${reason})` };
      }
      // SAME-UID-SEAT-ISOLATION: seats share one UID; a seat may not type into another seat's pane unless shared.
      if (input.action === 'do' || input.action === 'input') {
        const boundary = sameUidSeatBoundary(principal.callerSeat ?? principal.seat, input.target);
        if (!boundary.allow) {
          const auditFailure = audit({ ...base, result: 'denied', danger: 'n/a', reason: boundary.reason });
          if (auditFailure) return { ok: false, code: 'audit-failed', reason: auditFailure, message: `els ${input.action}: denied; audit not written` };
          return { ok: false, code: 'denied', reason: boundary.reason, message: `els ${input.action}: denied for ${input.principal.id} (${boundary.reason})` };
        }
      }
      const refused = deps.guard ? deps.guard(input) : undefined;
      if (refused !== undefined) {
        const auditFailure = audit({ ...base, result: 'denied', danger: 'n/a', reason: refused });
        if (auditFailure) return { ok: false, code: 'audit-failed', reason: auditFailure, message: `els ${input.action}: denied; audit not written` };
        return { ok: false, code: 'denied', reason: refused, message: `els ${input.action}: denied (${refused})` };
      }
      // #90792 P0 ③ — while a person is deciding on this pane, nothing else may type into it: a second send could
      // interleave with the very line the approver is looking at, so the door refuses it (audited as denied) until
      // the ask is answered. Reads stay open — they change nothing.
      const deciding = `${deps.stateDir}\u0000${input.target.pane}`;
      if (input.action === 'do' && PENDING_ASKS.has(deciding)) {
        const reason = 'a person is still deciding on this pane';
        audit({ ...base, result: 'denied', danger: 'n/a', reason });
        return { ok: false, code: 'denied', reason, message: `els ${input.action}: denied (${reason})` };
      }
      // #38453 must ② — /send types machine-assembled text; core.send strips control bytes before the pane
      // sees them, so the door classifies the same cleaned text (the \x15 line-clear bypass dies here) and
      // what a HITL approver sees is what runs. every path (send, do, hook) classifies clean(text) - JUD #110140: the hook used raw text, so a \x01 hid `--output=` from the argv split. The fail-closed one-line rule of #38607 is kept by classifyShell itself.
      const danger = input.action === 'do' && input.target.shell
        ? classifyShell(clean(text))
        : { dangerous: false as const, reason: 'safe' as const };
      if (danger.dangerous) {
        if (!deps.hitl) {
          const reason = `${danger.reason}; no person to ask`;
          audit({ ...base, result: 'held', danger: danger.reason, reason });
          return { ok: false, code: 'held', reason, message: `els do: held, not sent (${danger.reason}; nobody to approve)` };
        }
        // #90792 P0 ③ — from here until the answer, this pane is deciding: any other send to it is refused above.
        PENDING_ASKS.add(deciding);
        let answer: HitlAnswer;
        try { answer = await deps.hitl({ principal: input.principal, from, action: input.action, target: input.target, text, reason: danger.reason }); }
        finally { PENDING_ASKS.delete(deciding); }
        if (answer !== 'approve') {
          const code = answer === 'timeout' ? 'timeout' : 'rejected';
          audit({ ...base, result: code, danger: danger.reason, reason: answer });
          return { ok: false, code, reason: danger.reason, message: `els do: ${answer}, not sent (${danger.reason})` };
        }
      }
      const verdict = danger.dangerous ? 'approved' : 'safe';
      const authorizedBase = authorization ? { ...base, authorization } : base;
      const intentFailed = audit({ ...authorizedBase, result: 'executing', danger: verdict });
      if (intentFailed !== undefined) {
        return { ok: false, code: 'audit-failed', reason: intentFailed, message: `els ${input.action}: not sent (audit not writable: ${intentFailed})` };
      }
      let queueRecorded = false;
      const queueAudit: QueueAudit = (result, reason) => {
        const ok = audit({ ...authorizedBase, at: now(), result, danger: verdict, ...(reason ? { reason } : {}) }) === undefined;
        if (result === 'queued' && ok) queueRecorded = true;
        return ok;
      };
      let done: ControlExecuteResult;
      try {
        done = await deps.execute({ principal: input.principal, action: input.action, target: input.target, ...(text ? { text } : {}), ...(input.struct ? { struct: input.struct } : {}), ...(input.confirm !== undefined ? { confirm: input.confirm } : {}), ...(input.action === 'input' ? { queueAudit } : {}), ...(input.path ? { path: input.path } : {}) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        process.stderr.write(`els: control executor error: ${reason}\n`);
        audit({ ...authorizedBase, result: 'executor-error', danger: verdict, reason: 'executor failed' });
        return { ok: false, code: 'executor-error', reason, message: `els ${input.action}: failed (${reason})` };
      }
      // The core records queued synchronously before publishing the item; otherwise a drain can
      // deliver before the executor returns and the queued record can appear after delivery.
      const resultFailed = done.queued !== undefined && done.exitCode === 0 && queueRecorded
        ? undefined
        : audit({ ...authorizedBase, result: done.exitCode === 0 ? (done.queued !== undefined ? 'queued' : 'executed') : 'executor-refused', danger: verdict, exitCode: done.exitCode, ...(done.queued !== undefined ? { queued: done.queued } : {}) });
      const exitCode = resultFailed !== undefined && done.exitCode === 0 ? 1 : done.exitCode;
      const message = resultFailed !== undefined ? `${done.message} (execution outcome above; audit result not written, do not blindly retry: ${resultFailed})` : done.message;
      return { ok: true, exitCode, message, ...(done.queued !== undefined ? { queued: done.queued } : {}), danger: verdict };
    },
  };
}
