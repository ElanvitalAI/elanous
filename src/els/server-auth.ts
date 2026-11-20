// Server-side authorization for the els socket (JUD #39053 ⓒ1: 서버측 판정 이관).
// The decision lives HERE, in the server process. A peer's env self-report (ELANOUS_SEAT) is
// never a principal: the only accepted credential is the pane token this server minted into a
// pane's env at spawn time and recorded in its own ledger. A peer proves which pane it
// descends from by presenting that inherited token (env is inherited by descendants, so
// presenting the token = descent proof; claiming a seat name means nothing). The uid side of
// «peer credentials» is pinned by the socket file's 0600 perms — only this user can connect.
// 같은 uid 의 els 밖 프로세스는 outsider: 읽기 연산만 허용(③).

import { createHash, randomBytes } from 'node:crypto';
import { authorize, defaultDecision, loadAllowList, pinAllowList, type AllowRule, type ControlTarget, type Principal } from './control.js';

export const AUTH_PANE_TOKEN_ENV = 'ELANOUS_ELS_PANE_TOKEN';

/** Mutating ops: an outsider (no pane credential) never reaches these. */
export const AUTH_OWNER_TOKEN_ENV = 'ELANOUS_ELS_OWNER_TOKEN';
/**
 * JUD must ⓒ2-① (OP #104711): reads are an explicit allowlist — anything NOT listed is mutating and
 * must pass the door's adjudication. The old mutating-list missed `input-line` (an outsider could type
 * text into any pane, OP panes included), and any op added later would silently have been a read.
 * `snapshot` shows the same screen as `read` but WRITES an svg under the state dir, so it is mutating (an outsider can never
 * make the owner write files) and judged as the `read` action; `record`
 * taps a pane's live output stream, so it is mutating and judged as `do` (pane credential, own workspace).
 * `child` reads are decided by MUTATING_CHILD_ACTIONS below (status/tree/summary are reads).
 */
export const READ_OPS: ReadonlySet<string> = new Set(['ping', 'auth', 'ls', 'subscribe', 'grep', 'read', 'status']);
/** `child` actions that mutate the tree; the rest (status/tree/summary) are reads. */
const MUTATING_CHILD_ACTIONS: ReadonlySet<string> = new Set(['start', 'end', 'pin', 'unpin', 'dismiss', 'progress']);

export interface PaneRegistration { readonly pane: string; readonly workspace: string; readonly role: 'op' | 'hand'; readonly seat: string | undefined; readonly token: string }

export type ServerRole =
  | { readonly kind: 'op'; readonly pane: string }
  | { readonly kind: 'hand'; readonly seat: string; readonly workspaces: readonly string[]; readonly pane: string }
  | { readonly kind: 'owner'; readonly note: string }
  | { readonly kind: 'outsider'; readonly note: string }
  // JUD #39096 must ⓑ (OP #105050·#105177): a caller with NO pane token whose OS peer identity is
  // verified by the peer 판정 함수 (resolvePeerSeat: ledger + live ancestry, 자기신고 0).
  | { readonly kind: 'peer'; readonly pid: number; readonly pane: string; readonly seat: string; readonly uid: number };

/** JUD #39057 ⓒ1 — the role a new pane inherits from its requester. cwd never decides roles. */
export type SpawnParent = { readonly kind: 'op' } | { readonly kind: 'hand'; readonly seat: string; readonly workspaces: readonly string[] };

/** The server's own ledger: token → pane record. Tokens are minted at spawn, never chosen by clients. */
export class PaneRegistry {
  private readonly byToken = new Map<string, PaneRegistration>();
  private ownerToken: string | undefined;
  private ownerRegistered = false;
  private counter = 0;
  /** The server owner's own in-process credential (minted at serve start into that process env). */
  registerOwner(): { token: string } {
    const token = randomBytes(24).toString('hex');
    this.ownerToken = token;
    return { token };
  }


  /** JUD #39057 ⓒ1 ③ — `els seat set OP`: the server owner's explicit OP registration. */
  registerSeat(seat: string): boolean {
    if (seat !== 'OP') return false;
    this.ownerRegistered = true;
    return true;
  }

  /** Adds the server-minted pane token to a spawn env and records the registration. The parent role comes in as a direct argument (JUD #39071) — no queue. */
  registerSpawn(env: Readonly<Record<string, string>>, _cwd: string, parent?: SpawnParent): Readonly<Record<string, string>> {
    const token = randomBytes(24).toString('hex');
    const pane = env.ELANOUS_ELS_PANE ?? '';
    const workspace = env.ELANOUS_ELS_WS ?? '';
    // Journal replay: a pane respawning with its prior token keeps its prior role.
    const prior = typeof env[AUTH_PANE_TOKEN_ENV] === 'string' ? this.byToken.get(env[AUTH_PANE_TOKEN_ENV] as string) : undefined;
    const role: PaneRegistration['role'] = parent ? (parent.kind === 'op' ? 'op' : 'hand') : prior ? prior.role : 'hand';
    const seat = parent && parent.kind === 'hand' ? parent.seat : prior ? prior.seat : undefined;
    this.byToken.set(token, { pane, workspace, role, seat, token });
    // A child pane never inherits the owner token: only the serve process holds it.
    const { [AUTH_PANE_TOKEN_ENV]: _p, [AUTH_OWNER_TOKEN_ENV]: _o, ...rest } = env;
    return { ...rest, [AUTH_PANE_TOKEN_ENV]: token };
  }

  /** OP #104178 ① — a spawn whose PTY call throws leaves no orphan token in the ledger. */
  forget(token: string): void { this.byToken.delete(token); }

  /** A claim is judged ONLY by the ledger — env seat strings are irrelevant by construction. */
  classify(claim: { token?: unknown; pid?: unknown } | undefined): ServerRole {
    const token = typeof claim?.token === 'string' ? claim.token : undefined;
    if (token && this.ownerToken && token === this.ownerToken)
      return this.ownerRegistered
        ? { kind: 'op', pane: 'server-owner' }
        : { kind: 'owner', note: 'server owner terminal — run `els seat set OP` to register the OP seat' };
    const found = token ? this.byToken.get(token) : undefined;
    if (!found) return { kind: 'outsider', note: token ? 'unknown pane token' : 'no pane credential' };
    if (found.role === 'op') return { kind: 'op', pane: found.pane };
    return { kind: 'hand', seat: found.seat ?? 'unknown', workspaces: [found.workspace], pane: found.pane };
  }

  entries(): readonly PaneRegistration[] { return [...this.byToken.values()]; }
}

export type AuthVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

// Payload fields (text/pattern/from) ride along so callers pass real op shapes; the door itself never reads them.
interface RequestShape { readonly op: string; readonly pane?: string; readonly ws?: string; readonly at?: { readonly ws: string }; readonly action?: string; readonly seat?: string; readonly text?: string; readonly pattern?: string; readonly from?: string }

/** op → control door action vocabulary (control.ts CONTROL_ACTIONS). */
function doorAction(op: string): 'read' | 'do' | 'input' | 'new' | 'close' | 'move' | undefined {
  switch (op) {
    case 'do': case 'build': case 'child': case 'record': return 'do';
    case 'snapshot': return 'read'; // same screen as `read`, but it writes a file: mutating at the door, judged with `read`'s rules
    case 'send': case 'send-verified': case 'attach': case 'input': case 'input-line': case 'resize': return 'input';
    case 'new': return 'new';
    case 'close': case 'close-workspace': return 'close';
    default: return undefined; // `reorder` is a workspace-less UI-order action: any pane role may do it.
  }
}

export function isMutating(request: RequestShape): boolean {
  if (request.op === 'child') return MUTATING_CHILD_ACTIONS.has(String(request.action));
  return !READ_OPS.has(request.op);
}

/** The one rule set: reuse the door's defaultDecision + allow-list file so client and server cannot drift. */
export function authorizeRequest(role: ServerRole, request: RequestShape, workspace: string | undefined, rules: readonly AllowRule[] | undefined): AuthVerdict {
  // `els seat set OP` — the owner's explicit OP registration: only the owner credential (or OP) may register.
  if (request.op === 'seat-set') {
    return role.kind === 'owner' || role.kind === 'op'
      ? { allow: true }
      : { allow: false, reason: `els: seat-set denied — only the server owner may register the OP seat (${role.kind === 'hand' ? `hand seat ${role.seat}` : role.kind === 'peer' ? `peer seat ${role.seat}` : role.note})` };
  }
  if (!isMutating(request)) return { allow: true };
  // `new` stays open to any same-uid caller (main #39060 behavior): spawning a pane is not typing
  // into one — the child gets a server-minted token and role 'hand', and the door keeps guarding
  // every other mutating op. JUD #39096 ⓑ: the door must not block the herdr-style OP flow at `new`.
  if ((role.kind === 'outsider' || role.kind === 'owner') && request.op === 'new') return { allow: true };
  // JUD #39096 ⓒ (OP #107371·#107528): typing is default-deny without a token. The owner token
  // types (input-line/input/resize); a no-token outsider may attach (view) but every typing
  // op — input-line AND interactive input/resize — is denied: a setsid/double-fork caller has
  // no resolvable pane ancestor, so ancestor-based triage cannot rescue it; the door refuses.
  if (role.kind === 'owner' && (request.op === 'snapshot' || request.op === 'attach' || request.op === 'input' || request.op === 'resize' || request.op === 'input-line')) {
    return { allow: true };
  }
  if (role.kind === 'outsider' && request.op === 'attach') {
    return { allow: true };
  }
  if (role.kind === 'outsider') return { allow: false, reason: `els: ${request.op} denied — ${role.note}; mutating ops need a pane of this els server (token from its env)` };
  // The owner credential is not OP until it explicitly registers the seat; it cannot mutate anything else.
  if (role.kind === 'owner') return { allow: false, reason: `els: ${request.op} denied — ${role.note}` };
  // `reorder` changes tab/workspace order in the owner UI: a workspace-less mutation any pane role may do.
  if (request.op === 'reorder') return { allow: true };
  // ELS-BUILD-BADGE: `build` is a pane's report about the TUI running in it — its own pane only (token-bound), never a command
  // to another pane — so it skips the control door, which a person-spawned pane (seat 'unknown') can never pass.
  if (request.op === 'build' && (role.kind === 'hand' || role.kind === 'op') && request.pane === role.pane) return { allow: true };
  const action = doorAction(request.op);
  if (!action) return { allow: false, reason: `els: ${request.op} is mutating but has no door action mapping` };
  // JUD #39096 ⓑ: a ledger-verified peer seat is a principal — «토큰 역할 ∨ peer seat». The control
  // 문 still makes the final adjudication; the role door only refuses to block the verified peer.
  const principal: Principal = role.kind === 'op'
    ? { id: `els-pane:${role.pane}`, kind: 'eln', seat: 'OP', workspaces: [] }
    : role.kind === 'peer'
      ? { id: `local:${role.uid}`, kind: 'eln', seat: role.seat, workspaces: [] }
      : { id: `els-pane:${role.pane}`, kind: 'eln', seat: role.seat, workspaces: role.workspaces };
  const confirmed = Boolean((request as { confirmed?: boolean }).confirmed);
  const target: ControlTarget = { workspace: workspace ?? '', pane: request.pane ?? '', shell: false };
  const decision = defaultDecision(principal, target, action, confirmed);
  if (decision) return decision.allow ? { allow: true } : { allow: false, reason: `els: ${request.op} denied — ${decision.reason}` };
  if (rules && authorize(rules, principal, target, action)) return { allow: true };
  return { allow: false, reason: `els: ${request.op} denied — no rule grants ${action} to this pane` };
}

/** Audit line for a denial, in the control-audit.jsonl format (same fields as control.ts). */
export function denialAuditLine(request: RequestShape, role: ServerRole, reason: string, pid: unknown): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    principal: role.kind === 'outsider' || role.kind === 'owner' ? `els-socket:${role.kind}` : role.kind === 'peer' ? `local:${role.uid}` : `els-pane:${role.pane}`,
    kind: 'cli',
    workspace: request.ws ?? request.at?.ws ?? '',
    pane: request.pane ?? '',
    action: request.op,
    result: 'denied',
    reason,
    chars: 0,
    sha256: createHash('sha256').update('').digest('hex'),
    ...(typeof pid === 'number' ? { peerPid: pid } : {}),
  });
}

/** Allow-list loader pinned to one read per state dir (control.ts loadAllowList returns [] when absent). */
export function rulesLoader(stateDir: string): () => AllowRule[] {
  return () => loadAllowList(stateDir) as AllowRule[];
}


/** JUD #39071 — role → spawn parent, as a direct argument. Owner/outsider hands no credentialed parent: registerSpawn fails closed. */
export function spawnParentOf(role: ServerRole): SpawnParent | undefined {
  if (role.kind === 'op') return { kind: 'op' };
  if (role.kind === 'hand') return { kind: 'hand', seat: role.seat, workspaces: role.workspaces };
  // A verified OP peer's child panes inherit the OP role; any other peer seat hands no
  // credentialed parent — registerSpawn fails closed to 'hand'.
  if (role.kind === 'peer' && role.seat === 'OP') return { kind: 'op' };
  return undefined;
}
