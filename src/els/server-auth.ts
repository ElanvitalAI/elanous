// Server-side authorization for the els socket (JUD #39053 ⓒ1: 서버측 판정 이관).
// The decision lives HERE, in the server process. A peer's env self-report (ELANOUS_SEAT) is
// never a principal: the only accepted credential is the pane token this server minted into a
// pane's env at spawn time and recorded in its own ledger. A peer proves which pane it
// descends from by presenting that inherited token and passing the server's live socket-peer
// ancestry and pane-generation check; the token alone does not prove descent. The uid side of
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
 * `child` reads are decided by MUTATING_CHILD_ACTIONS below (tree/summary are reads; status updates state).
 */
export const READ_OPS: ReadonlySet<string> = new Set(['ping', 'auth', 'ls', 'subscribe', 'grep', 'read', 'status']);
/** `child` actions that mutate the tree; tree and summary are reads. */
const MUTATING_CHILD_ACTIONS: ReadonlySet<string> = new Set(['start', 'end', 'pin', 'unpin', 'dismiss', 'progress', 'status']);

export interface PaneRegistration { readonly pane: string; readonly workspace: string; readonly role: 'op' | 'hand'; readonly seat: string | undefined; readonly token: string }
export type PaneProcessBinding = { readonly pid: number; readonly start: string; readonly generation: string };

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

// Role object provenance is server-side only: a pane name can never confer owner authority.
const ownerRoles = new WeakSet<ServerRole>();
export const isServerOwnerRole = (role: ServerRole): boolean => ownerRoles.has(role);

/** The server's own ledger: token → pane record. Tokens are minted at spawn, never chosen by clients. */
export class PaneRegistry {
  private readonly byToken = new Map<string, PaneRegistration>();
  private readonly spawnBindings = new Map<string, { read: () => PaneProcessBinding | undefined; pinned?: PaneProcessBinding; invalid?: boolean }>();
  /** OP #128343(OP 승인 #128469) — 회수된 토큰(닫힌 pane · 스폰 실패)은 입양 재등록이 다시 쓰지 못한다. */
  private readonly revokedTokens = new Set<string>();
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

  /** Bind to the exact PTY adapter returned by this spawn, not a later pane lookup. */
  bindSpawn(token: string, read: () => PaneProcessBinding | undefined): void {
    if (!this.byToken.has(token) || this.spawnBindings.has(token)) throw new Error('invalid pane spawn binding');
    this.spawnBindings.set(token, { read });
  }

  spawnBinding(token: string): PaneProcessBinding | undefined {
    const entry = this.spawnBindings.get(token);
    if (!entry || entry.invalid || !this.byToken.has(token)) return undefined;
    try {
      const current = entry.read();
      if (!current) {
        if (entry.pinned) entry.invalid = true;
        return undefined;
      }
      if (!entry.pinned) entry.pinned = { ...current };
      const pinned = entry.pinned;
      if (pinned.pid !== current.pid || pinned.start !== current.start || pinned.generation !== current.generation) {
        entry.invalid = true;
        return undefined;
      }
      return pinned;
    } catch { entry.invalid = true; return undefined; }
  }

  /** OP #104178 ① — a spawn whose PTY call throws leaves no orphan token in the ledger. */
  forget(token: string): void { this.revokedTokens.add(token); this.byToken.delete(token); this.spawnBindings.delete(token); }

  /** OP #128343(OP 승인 #128469) — 닫힌 pane 의 발급 토큰 회수: 남아 있는 자손도 그 자격을 다시 쓰지 못한다(미지 토큰으로 돌아간다). */
  forgetPane(pane: string): void {
    for (const [token, row] of this.byToken) if (row.pane === pane) this.forget(token);
  }

  /**
   * OP #128343(OP 승인 #128469) — 재기동 입양 재등록: 서버를 재기동하면 이 원장은 비어 있고, 살아남은 홀더의
   * pane 자식은 자기 env 의 서버발급 토큰으로 «els: invalid credential» 로 거부된다. 입양 시 홀더가 증명한
   * 토큰만 원장에 되돌아온다 — 자리·workspace 는 저널 ownerSeat·tabId 에서 복원하고, 회수됐거나 이번
   * 기수에 이미 있는 토큰·pane 과의 충돌은 거부한다. 재등록은 읽기 전용, 발급은 spawn 뿐.
   */
  registerAdopted(entry: { readonly token: string; readonly pane: string; readonly workspace: string; readonly role: PaneRegistration['role']; readonly seat: string | undefined },
    read: () => PaneProcessBinding | undefined): boolean {
    if (!/^[0-9a-f]{48}$/.test(entry.token) || entry.pane === '') return false; // 서버발급 토큰 형태만
    if (this.byToken.has(entry.token) || this.revokedTokens.has(entry.token)) return false; // 충돌 · 회수
    if ([...this.byToken.values()].some((row) => row.pane === entry.pane)) return false; // 같은 pane 의 두 번째 토큰 금지
    this.byToken.set(entry.token, { pane: entry.pane, workspace: entry.workspace, role: entry.role, seat: entry.seat, token: entry.token });
    this.spawnBindings.set(entry.token, { read });
    return true;
  }

  /** A claim is judged ONLY by the ledger — env seat strings are irrelevant by construction. */
  classify(claim: { token?: unknown; pid?: unknown } | undefined): ServerRole {
    const token = typeof claim?.token === 'string' ? claim.token : undefined;
    if (token && this.ownerToken && token === this.ownerToken) {
      const role: ServerRole = this.ownerRegistered
        ? { kind: 'op', pane: 'server-owner' }
        : { kind: 'owner', note: 'server owner terminal — run `els seat set OP` to register the OP seat' };
      ownerRoles.add(role);
      return role;
    }
    const found = token ? this.byToken.get(token) : undefined;
    if (!found) return { kind: 'outsider', note: token ? 'unknown pane token' : 'no pane credential' };
    if (found.role === 'op') return { kind: 'op', pane: found.pane };
    return { kind: 'hand', seat: found.seat ?? 'unknown', workspaces: [found.workspace], pane: found.pane };
  }

  movePanes(panes: readonly string[], workspace: string): void {
    const moved = new Set(panes);
    for (const [token, row] of this.byToken) if (moved.has(row.pane)) this.byToken.set(token, { ...row, workspace });
  }

  entries(): readonly PaneRegistration[] { return [...this.byToken.values()]; }
}

export type AuthVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

/**
 * CEO 11-23 (ELS-ELN-SECURITY-RELAX): reading a pane's screen or status changes nothing, so the HQ observer may read
 * every pane in every space. HQ observer = the OP seat or the journal's HQ coordinator seat, or a seatless pane caller
 * (seat absent or `unknown`, e.g. the eln OP pane opened by `els seat`) that sits in a workspace whose journal coordinator
 * is OP/HQ. A named non-HQ seat (hand, sub-coordinator) keeps its own-pane scope. `read`/`status` use this, and so does
 * non-destructive typing (`hqTypingRequest`, ELS-OP-CROSS-SPACE-SEND).
 */
export function hqReadObserver(seat: string | undefined, callerPane: string | undefined,
  journal: { readonly hqCoordinatorSeat?: string; readonly workspaces: readonly { readonly id: string; readonly coordinatorSeat?: string }[];
    readonly tabs: readonly { readonly id: string; readonly workspaceId: string }[]; readonly panes: readonly { readonly id: string; readonly tabId: string }[] }): boolean {
  const hq = journal.hqCoordinatorSeat;
  const isHq = (name: string | undefined): boolean => name === 'OP' || (!!hq && name === hq);
  if (isHq(seat)) return true;
  if (seat !== undefined && seat !== 'unknown') return false;
  const row = callerPane ? journal.panes.find(p => p.id === callerPane) : undefined;
  const wsId = row && journal.tabs.find(t => t.id === row.tabId)?.workspaceId;
  return isHq(journal.workspaces.find(w => w.id === wsId)?.coordinatorSeat);
}

/**
 * ELS-OP-CROSS-SPACE-SEND (CEO 11-23 relaxed security): the HQ observer (see `hqReadObserver`) may also TYPE a line into
 * any pane in any space, so the OP coordinator can hand work to another seat's tab. Only non-destructive typing counts:
 * `do`, `input-line`, `send`, `send-verified`, and raw `input` bytes that carry no interrupt/escape/EOF/suspend key.
 * `interrupt`, `close`, `snapshot` and everything else keep the own-pane rule (close also keeps its confirmation).
 */
export function hqTypingRequest(request: { readonly op: string; readonly bytes?: unknown }): boolean {
  if (request.op === 'do' || request.op === 'input-line' || request.op === 'send' || request.op === 'send-verified') return true;
  // ESC (also arrow/function-key prefix), ^C, ^D, ^Z, ^\ stay owner-only: they interrupt, end or suspend the pane's process.
  return request.op === 'input' && typeof request.bytes === 'string' && !/[\x03\x04\x1a\x1b\x1c]/.test(request.bytes);
}

/**
 * OP-HANDLES-L2 (TRACE-OP-RESOURCE-OPTIMIZATION-1125 §5: ElsControl send/new refused 12/12 «no rule grants …»).
 * The coordinator grant: the HQ coordinator (the OP seat, the journal's / federation.yaml's HQ coordinator seat, or a
 * seatless pane in an HQ-coordinated workspace — `hqReadObserver`) may `new`, type (`hqTypingRequest`) and `close` on
 * panes owned by a federation seat in every space; a space coordinator gets the same inside the spaces it coordinates.
 * The federation seat set comes from the seat registry ⊕ federation.yaml (never a literal list here). Interrupt and raw
 * control bytes stay owner-only; the OP tab itself still needs a person (authorizeRequest refuses it first).
 */
export interface FederationJournal {
  readonly hqCoordinatorSeat?: string;
  readonly workspaces: readonly { readonly id: string; readonly name: string; readonly coordinatorSeat?: string }[];
  readonly tabs: readonly { readonly id: string; readonly workspaceId: string }[];
  readonly panes: readonly { readonly id: string; readonly tabId: string; readonly ownerSeat?: string }[];
}

export type CoordinatorAuthority =
  | { readonly scope: 'hq'; readonly seat: string }
  | { readonly scope: 'space'; readonly seat: string; readonly workspaceIds: readonly string[] };

/** Who coordinates: HQ (everywhere) or a space coordinator (its own spaces). `declaredHq` = federation.yaml `hq.coordinator`. */
export function coordinatorAuthority(seat: string | undefined, callerPane: string | undefined, journal: FederationJournal, declaredHq?: string): CoordinatorAuthority | undefined {
  const hq = journal.hqCoordinatorSeat ?? declaredHq;
  if (hqReadObserver(seat, callerPane, { ...journal, ...(hq ? { hqCoordinatorSeat: hq } : {}) }))
    return { scope: 'hq', seat: seat && seat !== 'unknown' ? seat : hq ?? 'OP' };
  if (!seat || seat === 'unknown') return undefined;
  const workspaceIds = journal.workspaces.filter(ws => ws.coordinatorSeat === seat).map(ws => ws.id);
  return workspaceIds.length ? { scope: 'space', seat, workspaceIds } : undefined;
}

export interface CoordinatorGrant { readonly allow: true; readonly audit: Record<string, unknown> }

/**
 * The grant for one request, or undefined (the ordinary rules decide). `paneId` resolves a request pane ref (id, name or
 * address) to the journal pane id. Every grant carries its `els.coordinator-grant` audit line — the caller writes it.
 */
export function coordinatorGrant(authority: CoordinatorAuthority | undefined,
  request: { readonly op: string; readonly pane?: string; readonly tab?: string; readonly ws?: string; readonly bytes?: unknown },
  journal: FederationJournal, federationSeats: ReadonlySet<string>, paneId: (ref: string) => string | undefined = ref => ref): CoordinatorGrant | undefined {
  if (!authority) return undefined;
  const inScope = (workspaceId: string | undefined): boolean => !!workspaceId
    && journal.workspaces.some(ws => ws.id === workspaceId)
    && (authority.scope === 'hq' || authority.workspaceIds.includes(workspaceId));
  const federated = (owner: string | undefined): boolean => !!owner && owner !== 'unknown' && federationSeats.has(owner.toUpperCase());
  const audit = (target: Record<string, unknown>): CoordinatorGrant => ({ allow: true,
    audit: { ts: new Date().toISOString(), event: 'els.coordinator-grant', scope: authority.scope, seat: authority.seat, op: request.op, ...target, result: 'allowed' } });
  const workspaceOfTab = (tab: string | undefined) => journal.tabs.find(t => t.id === tab)?.workspaceId;
  if (request.op === 'new') {
    const ws = journal.workspaces.find(row => row.id === request.ws || row.name === request.ws);
    return ws && inScope(ws.id) ? audit({ workspace: ws.name }) : undefined;
  }
  if (hqTypingRequest(request) || request.op === 'close') {
    const id = typeof request.pane === 'string' ? paneId(request.pane) : undefined;
    const row = id ? journal.panes.find(p => p.id === id) : undefined;
    if (!row || !federated(row.ownerSeat) || !inScope(workspaceOfTab(row.tabId))) return undefined;
    // Closing the HQ coordinator's own pane stays a person's call.
    if (request.op === 'close' && (row.ownerSeat === 'OP' || row.ownerSeat === journal.hqCoordinatorSeat)) return undefined;
    return audit({ pane: row.id, owner: row.ownerSeat });
  }
  if (request.op === 'close-tab') {
    const panes = journal.panes.filter(p => p.tabId === request.tab);
    if (!panes.length || !inScope(workspaceOfTab(request.tab)) || !panes.every(p => federated(p.ownerSeat))) return undefined;
    if (panes.some(p => p.ownerSeat === 'OP' || p.ownerSeat === journal.hqCoordinatorSeat)) return undefined;
    return audit({ tab: request.tab, owners: [...new Set(panes.map(p => p.ownerSeat))] });
  }
  return undefined;
}

/** Assignment is server journal state; a claimed seat, cwd or request tag is never authority. */
export function coordinatorTabScope(role: ServerRole, request: { readonly op: string; readonly ws?: string; readonly kind?: string; readonly id?: string; readonly before?: string },
  journal: { readonly hqCoordinatorSeat?: string; readonly workspaces: readonly { readonly id: string; readonly name: string; readonly coordinatorSeat?: string }[]; readonly tabs: readonly { readonly id: string; readonly workspaceId: string }[] }): AuthVerdict | undefined {
  if (role.kind !== 'hand' && role.kind !== 'peer') return undefined;
  if (!role.seat || role.seat === 'unknown' || role.seat === 'OP') return undefined;
  // OP-HANDLES-L2: the HQ coordinator seat is not confined to the one space it also coordinates.
  if (journal.hqCoordinatorSeat && role.seat === journal.hqCoordinatorSeat) return undefined;
  const spaces = journal.workspaces.filter(ws => ws.coordinatorSeat === role.seat);
  if (!spaces.length) return undefined;
  if (request.op !== 'new' && !(request.op === 'reorder' && request.kind === 'tab')) return undefined;
  const own = spaces.length === 1 ? spaces[0] : undefined;
  const tab = (id: string | undefined) => journal.tabs.find(row => row.id === id);
  const valid = !!own && (request.op === 'new'
    ? journal.workspaces.find(ws => ws.id === request.ws || ws.name === request.ws)?.id === own.id
    : tab(request.id)?.workspaceId === own.id &&
      (request.before === undefined || request.before === '' || request.before === 'end' || tab(request.before)?.workspaceId === own.id));
  return valid ? { allow: true } : { allow: false, reason: `els: ${request.op} denied — coordinator is restricted to its assigned workspace` };
}

/** Server-resolved tab target. Seats come from server-minted pane registrations, never from cwd or request fields. */
export interface TabCloseScope {
  readonly tabId: string;
  readonly workspace: string;
  readonly ownerSeats: readonly (string | null)[];
  /** ELS-OP-CLOSE-TAB: the tab holds the OP coordinator's own pane (registered OP pane or a pane seated OP). */
  readonly opTab?: boolean;
  /** For the close log: the tab's label and pane count. */
  readonly label?: string;
  readonly paneCount?: number;
}

/** Join the journal's exact tab/pane ids to the server's token ledger. An absent or mixed registration has no owner. */
export function resolveTabCloseScope(
  listed: { readonly workspaces: readonly { readonly id: string; readonly name: string }[];
    readonly tabs: readonly { readonly id: string; readonly workspaceId: string; readonly label?: string }[];
    readonly panes: readonly { readonly pane: string; readonly tab: string; readonly seat?: string | null }[] },
  registrations: readonly PaneRegistration[],
  tabId: string,
): TabCloseScope | undefined {
  const tab = listed.tabs.find((row) => row.id === tabId);
  const workspace = tab && listed.workspaces.find((row) => row.id === tab.workspaceId)?.name;
  if (!tab || !workspace) return undefined;
  const rows = listed.panes.filter((row) => row.tab === tab.id);
  const ownerSeats = rows.map((row) => {
    const owners = registrations.filter((entry) => entry.pane === row.pane && entry.workspace === workspace);
    const seats = new Set(owners.map((entry) => entry.seat));
    return owners.length && seats.size === 1 ? owners[0]!.seat ?? null : null;
  });
  const opTab = rows.some((row) => row.seat === 'OP'
    || registrations.some((entry) => entry.pane === row.pane && (entry.role === 'op' || entry.seat === 'OP')));
  return { tabId: tab.id, workspace, ownerSeats, opTab, ...(tab.label ? { label: tab.label } : {}), paneCount: rows.length };
}

// Payload fields (text/pattern/from) ride along so callers pass real op shapes; the door itself never reads them.
interface RequestShape { readonly op: string; readonly kind?: string; readonly id?: string; readonly pane?: string; readonly tab?: string; readonly ws?: string; readonly at?: { readonly ws: string }; readonly action?: string; readonly seat?: string; readonly runtime?: unknown; readonly text?: string; readonly pattern?: string; readonly from?: string; readonly confirmed?: boolean; readonly bytes?: unknown }

/** op → control door action vocabulary (control.ts CONTROL_ACTIONS). */
function doorAction(op: string): 'read' | 'do' | 'input' | 'new' | 'close' | 'move' | undefined {
  switch (op) {
    case 'do': case 'build': case 'child': case 'record': return 'do';
    case 'snapshot': return 'read'; // same screen as `read`, but it writes a file: mutating at the door, judged with `read`'s rules
    case 'send': case 'send-verified': case 'attach': case 'input': case 'input-line': case 'interrupt': case 'resize': return 'input';
    case 'new': return 'new';
    case 'close': case 'close-workspace': case 'close-tab': return 'close';
    default: return undefined; // `reorder` is a workspace-less UI-order action: any pane role may do it.
  }
}

export function isMutating(request: RequestShape): boolean {
  if (request.op === 'child') return MUTATING_CHILD_ACTIONS.has(String(request.action));
  return !READ_OPS.has(request.op);
}

/** The one rule set: reuse the door's defaultDecision + allow-list file so client and server cannot drift. */
export function authorizeRequest(role: ServerRole, request: RequestShape, workspace: string | undefined, rules: readonly AllowRule[] | undefined, tabScope?: TabCloseScope, acting = false, granted = false): AuthVerdict {
  // `acting` is computed by the server from its verified role and the current baton, never from a request.
  const actingOp = acting && (role.kind === 'hand' || role.kind === 'peer');
  // A server-minted OP pane may attempt registration only with a runtime claim;
  // registerSeatRuntime independently verifies the actual OS ancestry and publishes its token.
  if (request.op === 'seat-set') {
    return ownerRoles.has(role) || (role.kind === 'op' && request.seat === 'OP' && request.runtime != null)
      ? { allow: true }
      : { allow: false, reason: `els: seat-set denied — only the server owner may register the OP seat (${role.kind === 'hand' ? `hand seat ${role.seat}` : role.kind === 'peer' ? `peer seat ${role.seat}` : role.kind === 'op' ? `OP pane ${role.pane}` : role.note})` };
  }
  // CEO 11-23 15:3x «심한 보안 장치 다 완화 · 사람도 똑같이 막힌다»(ELS-ELN-SECURITY-RELAX): the server socket is
  // same-uid only, so a caller outside any pane (the person's own terminal, or an advisor like Claude OP) is the operator —
  // every op is allowed and still audited. Pane roles (op/hand/peer) keep their scopes below.
  // ELS-OP-CLOSE-TAB (대표 11-24): closing the OP coordinator's own tab is the one close that still needs a person's yes —
  // for every caller, the owner terminal and same-UID operators included.
  if (request.op === 'close-tab' && request.confirmed !== true && tabScope?.opTab)
    return { allow: false, reason: 'els: close-tab denied — the OP tab itself is closed only with a person\'s confirmation' };
  // ELS-HERDR-CLI-PARITY ② (tab-close bisect 11-24 · 첫 적록 809b57f70c #39938): a tab no seat owns — a
  // plain scratch tab — is closed unconfirmed by no one, the owner terminal and same-UID operators
  // included: nobody answered a prompt for it. A person confirms it (confirm:true), a coordinator
  // closes a seated tab below, and the OP tab above is refused for every caller, confirmed or not.
  if (request.op === 'close-tab' && request.confirmed !== true && !tabScope?.opTab
    && !tabScope?.ownerSeats.some((seat) => seat))
    return { allow: false, reason: 'els: close-tab denied — a tab no seat owns closes only with confirm:true (a person\'s confirmation)' };
  if (role.kind === 'outsider' || role.kind === 'owner') return { allow: true };
  if (request.op === 'move-tab') return role.kind === 'op' || (role.kind === 'peer' && role.seat === 'OP') || actingOp
    ? { allow: true } : { allow: false, reason: 'els: move-tab denied — OP authority required' };
  // Coordinator assignment is global, never delegated by a workspace allow-list.
  if (request.op === 'coordinator' || request.op === 'coordinator-unset' || request.op === 'hq-coordinator') {
    return role.kind === 'op' || (role.kind === 'peer' && role.seat === 'OP') || actingOp
      ? { allow: true }
      : { allow: false, reason: `els: ${request.op} denied — OP authority required` };
  }
  if (!isMutating(request)) return { allow: true };
  // (11-23 완화) outsider/owner are allowed above — the old outsider/owner new·attach·typing branches are gone.
  // `reorder` changes tab/workspace order in the owner UI: a workspace-less mutation any pane role may do.
  if (request.op === 'reorder') return { allow: true };
  // ELS-BUILD-BADGE: `build` is a pane's report about the TUI running in it — its own pane only (token-bound), never a command
  // to another pane — so it skips the control door, which a person-spawned pane (seat 'unknown') can never pass.
  if (request.op === 'build' && (role.kind === 'hand' || role.kind === 'op') && request.pane === role.pane) return { allow: true };
  // Only workspace rename is mapped; other structural mutations remain fail-closed.
  // The server must resolve the actual target, never a caller-supplied `at` or pane.
  if (request.op === 'rename' && request.kind === 'workspace' && !workspace)
    return { allow: false, reason: 'els: rename denied — workspace target not resolved' };
  const action = request.op === 'rename' && request.kind === 'workspace' ? 'do' : doorAction(request.op);
  if (!action) return { allow: false, reason: `els: ${request.op} is mutating but has no door action mapping` };
  // ELS-OP-CLOSE-TAB (대표 11-24 «보안 기본 완화»): closing a seat tab is a routine coordinator action — the OP pane, a
  // ledger-verified OP peer and the baton's acting OP close a non-OP tab without a person (the OP tab is refused above).
  // OP-HANDLES-L2: `granted` = the server found a coordinator grant (coordinatorGrant) for this exact request.
  const coordinator = role.kind === 'op' || (role.kind === 'peer' && role.seat === 'OP') || actingOp || granted;
  if (request.op === 'close-tab') {
    if (request.confirmed !== true && !coordinator) return { allow: false, reason: 'els: close-tab denied — close needs confirm:true (human confirmation)' };
    if (!tabScope || tabScope.tabId !== request.tab || tabScope.workspace !== workspace || !tabScope.workspace)
      return { allow: false, reason: 'els: close-tab denied — tab identity or workspace changed before authorization' };
    if (!coordinator && (role.kind === 'hand' || role.kind === 'peer')
      && (!tabScope.ownerSeats.length || tabScope.ownerSeats.some((seat) => seat !== role.seat)))
      return { allow: false, reason: 'els: close-tab denied — tab contains another or unverified seat owner' };
  }
  // OP-HANDLES-L2: a coordinator grant covers new / non-destructive typing / close on federation seat panes in scope.
  if (granted && (action === 'new' || action === 'close' || (action === 'input' && hqTypingRequest(request)))) return { allow: true };
  // JUD #39096 ⓑ: a ledger-verified peer seat is a principal — «토큰 역할 ∨ peer seat». The control
  // 문 still makes the final adjudication; the role door only refuses to block the verified peer.
  const principal: Principal = role.kind === 'op'
    ? { id: `els-pane:${role.pane}`, kind: 'eln', seat: 'OP', workspaces: [] }
    : role.kind === 'peer'
      ? { id: `local:${role.uid}`, kind: 'eln', seat: role.seat, workspaces: [] }
      : { id: `els-pane:${role.pane}`, kind: 'eln', seat: role.seat, workspaces: role.workspaces };
  const confirmed = Boolean((request as { confirmed?: boolean }).confirmed);
  const target: ControlTarget = { workspace: workspace ?? '', pane: request.op === 'close-tab' ? tabScope!.tabId : request.pane ?? '', shell: false };
  // The seat on the real principal remains unchanged for audit/rules. Use OP only for
  // this decision, and never bypass the acting seat's close confirmation requirement.
  const decisionPrincipal = actingOp ? { ...principal, seat: 'OP' } : principal;
  if (actingOp && action === 'close' && !confirmed && request.op !== 'close-tab')
    return { allow: false, reason: 'els: close denied — close needs confirm:true (human confirmation)' };
  const decision = defaultDecision(decisionPrincipal, target, action, confirmed);
  const guidance = '; an OP pane is authorized for this request at this gate (other checks may still apply)';
  if (decision) return decision.allow ? { allow: true } : { allow: false, reason: `els: ${request.op} denied — ${decision.reason}${guidance}` };
  if (rules && authorize(rules, principal, target, action)) return { allow: true };
  return { allow: false, reason: `els: ${request.op} denied — no rule grants ${action} to this pane${guidance}` };
}

/** ELS-OP-CLOSE-TAB: the `els.close` record for an allowed tab close — caller, tab label, pane count, confirmation. */
export function closeTabAuditLine(role: ServerRole, scope: TabCloseScope, confirmed: boolean, acting = false): Record<string, unknown> {
  const caller = role.kind === 'outsider' || role.kind === 'owner' ? `els-socket:${role.kind}`
    : role.kind === 'peer' ? `local:${role.uid}(${role.seat})`
      : role.kind === 'op' ? `els-pane:${role.pane}(OP)` : `els-pane:${role.pane}(${role.seat})`;
  return { ts: new Date().toISOString(), event: 'els.close', principal: caller, ...(acting ? { actingOp: true } : {}),
    workspace: scope.workspace, tab: scope.tabId, label: scope.label ?? '', panes: scope.paneCount ?? scope.ownerSeats.length,
    action: 'close-tab', result: 'allowed', confirmed };
}

/** Audit line for a denial, in the control-audit.jsonl format (same fields as control.ts). */
export function denialAuditLine(request: RequestShape, role: ServerRole, reason: string, pid: number | undefined, claimedPid?: number): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    principal: role.kind === 'outsider' || role.kind === 'owner' ? `els-socket:${role.kind}` : role.kind === 'peer' ? `local:${role.uid}` : `els-pane:${role.pane}`,
    kind: 'cli',
    workspace: request.ws ?? request.at?.ws ?? '',
    pane: request.pane ?? request.tab ?? '',
    action: request.op,
    result: 'denied',
    reason,
    chars: 0,
    sha256: createHash('sha256').update('').digest('hex'),
    peerPid: pid ?? 'unknown',
    ...(claimedPid !== undefined ? { claimedPid } : {}),
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
