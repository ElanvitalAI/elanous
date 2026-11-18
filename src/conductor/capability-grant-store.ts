// ── T6 (Phase 3 Bundle 1) — Capability grant store + slash handler ──
//
// HANDOFF Phase 3 / ROADMAP §6 T6: "capability grant 명시화". 외부 client
// (codex/cursor/zed via A1) 또는 Discord persona (C series) 에 어떤
// capability 를 grant 했는지 명시적 store 로 관리. slash command 로
// `/grant alice write shell-id-x` 형식으로 추가, `/revoke` 로 제거,
// `/grants` 로 조회.
//
// 모든 변경이 audit log 에 기록 — 보안 + 신뢰 trail.

export type GrantedAction = 'read' | 'write' | 'interrupt' | 'inspect' | 'spawn' | 'close';

export interface CapabilityGrant {
  readonly persona: string;        // "alice" | "codex" | "telegram-bot-user"
  readonly action: GrantedAction;
  readonly shellId?: string;       // 특정 shell 한정. omit 시 전체.
  readonly grantedBy?: string;     // who issued the grant
  readonly grantedAt: string;      // ISO
  /** Optional expiry — ISO timestamp. */
  readonly expiresAt?: string;
  /** Free-form note (한 줄). */
  readonly note?: string;
}

export interface GrantAuditEvent {
  readonly kind: 'granted' | 'revoked' | 'expired';
  readonly grant: CapabilityGrant;
  readonly at: string;
  readonly by?: string;
}

export interface CapabilityGrantStore {
  /** Add a grant — overwrites duplicate (same persona/action/shellId). */
  grant(grant: CapabilityGrant): void;
  /** Remove all grants matching predicate. Returns removed count. */
  revoke(predicate: { persona: string; action?: GrantedAction; shellId?: string; by?: string }): number;
  /** Check if `persona` is granted `action` for optional `shellId`.
   *  Honors expiry and shellId scope. */
  isGranted(persona: string, action: GrantedAction, shellId?: string): boolean;
  /** Preserve the denial cause after the lazy expiry prune. */
  checkGrant(persona: string, action: GrantedAction, shellId?: string):
    | { readonly granted: true }
    | { readonly granted: false; readonly reason: 'expired' | 'revoked' | 'absent'; readonly expiresAt?: string };
  /** Snapshot of all current (unexpired) grants. */
  list(filter?: { persona?: string; action?: GrantedAction; shellId?: string }): readonly CapabilityGrant[];
  /** Audit log — all events since store creation. */
  audit(): readonly GrantAuditEvent[];
  /** Drain expired grants — emits 'expired' audit events. Caller can
   *  invoke periodically or on every isGranted check. Default
   *  isGranted call-side prunes lazily. */
  pruneExpired(now?: number): readonly GrantAuditEvent[];
}

export interface CapabilityGrantStoreOpts {
  /** Test seam — defaults to Date.now / new Date.toISOString. */
  now?: () => Date;
  /** Optional max audit log size (drops oldest beyond). Default 1000. */
  auditCap?: number;
  /** Max recent denial causes kept after audit rotation. Default 10000. */
  denialCap?: number;
  /** Called once per grant, one hour before expiry; defaults to a process warning. */
  onExpiring?: (grant: CapabilityGrant) => void;
}

const DEFAULT_AUDIT_CAP = 1000;
const DEFAULT_DENIAL_CAP = 10_000;

function nowIso(opts: CapabilityGrantStoreOpts): string {
  return (opts.now ? opts.now() : new Date()).toISOString();
}
function nowMs(opts: CapabilityGrantStoreOpts): number {
  return (opts.now ? opts.now() : new Date()).getTime();
}

function grantKey(g: { persona: string; action: GrantedAction; shellId?: string }): string {
  return `${g.persona}::${g.action}::${g.shellId ?? '*'}`;
}

function isExpired(g: CapabilityGrant, now: number): boolean {
  if (!g.expiresAt) return false;
  return new Date(g.expiresAt).getTime() <= now;
}

export function createCapabilityGrantStore(
  opts: CapabilityGrantStoreOpts = {},
): CapabilityGrantStore {
  const grants = new Map<string, CapabilityGrant>();
  const audit: GrantAuditEvent[] = [];
  // Denial causes must outlive the bounded audit log. Keep only the latest
  // terminal event per grant identity; a new grant clears that identity.
  const denials = new Map<string, { reason: 'expired' | 'revoked'; expiresAt?: string; order: number }>();
  let denialOrder = 0;
  const auditCap = opts.auditCap ?? DEFAULT_AUDIT_CAP;
  const denialCap = opts.denialCap ?? DEFAULT_DENIAL_CAP;
  if (!Number.isSafeInteger(denialCap) || denialCap < 0) throw new RangeError('invalid denialCap');
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const warned = new Set<string>();

  const clearExpiryTimer = (key: string): void => {
    const timer = expiryTimers.get(key);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(key);
    warned.delete(key);
  };

  const scheduleExpiryWarning = (key: string, grant: CapabilityGrant): void => {
    clearExpiryTimer(key);
    if (!grant.expiresAt) return;
    const expiry = new Date(grant.expiresAt).getTime();
    if (!Number.isFinite(expiry) || expiry <= nowMs(opts)) return;
    const warnAt = expiry - 60 * 60 * 1000;
    const emit = (): void => {
      expiryTimers.delete(key);
      if (grants.get(key) !== grant || warned.has(key)) return;
      const current = nowMs(opts);
      if (current >= expiry) return;
      if (current < warnAt) {
        arm();
        return;
      }
      warned.add(key);
      if (opts.onExpiring) opts.onExpiring(grant);
      else process.emitWarning(`capability grant expires within 1 hour: ${JSON.stringify(grant.persona)}/${grant.action}`);
    };
    const arm = (): void => {
      const delay = Math.max(0, Math.min(warnAt - nowMs(opts), 2_147_000_000));
      const timer = setTimeout(emit, delay);
      (timer as { unref?: () => void }).unref?.();
      expiryTimers.set(key, timer);
    };
    if (warnAt <= nowMs(opts)) emit();
    else arm();
  };

  const pushAudit = (event: GrantAuditEvent): void => {
    audit.push(event);
    while (audit.length > auditCap) audit.shift();
  };

  const rememberDenial = (key: string, reason: 'expired' | 'revoked', expiresAt?: string): void => {
    denials.delete(key);
    denials.set(key, { reason, expiresAt, order: ++denialOrder });
    while (denials.size > denialCap) denials.delete(denials.keys().next().value!);
  };

  const lazyPrune = (): GrantAuditEvent[] => {
    const events: GrantAuditEvent[] = [];
    const now = nowMs(opts);
    for (const [key, g] of grants) {
      if (isExpired(g, now)) {
        clearExpiryTimer(key);
        grants.delete(key);
        rememberDenial(key, 'expired', g.expiresAt);
        const ev: GrantAuditEvent = { kind: 'expired', grant: g, at: nowIso(opts) };
        pushAudit(ev);
        events.push(ev);
      }
    }
    return events;
  };

  return {
    grant(grant) {
      const key = grantKey(grant);
      grants.set(key, grant);
      denials.delete(key);
      pushAudit({ kind: 'granted', grant, at: nowIso(opts), by: grant.grantedBy });
      scheduleExpiryWarning(key, grant);
    },
    revoke(predicate) {
      let count = 0;
      for (const [key, g] of grants) {
        if (g.persona !== predicate.persona) continue;
        if (predicate.action && g.action !== predicate.action) continue;
        if (predicate.shellId && g.shellId !== predicate.shellId) continue;
        clearExpiryTimer(key);
        grants.delete(key);
        rememberDenial(key, 'revoked');
        count += 1;
        pushAudit({ kind: 'revoked', grant: g, at: nowIso(opts), by: predicate.by });
      }
      return count;
    },
    isGranted(persona, action, shellId) {
      lazyPrune();
      const exactKey = grantKey({ persona, action, shellId });
      return grants.has(exactKey) || Boolean(shellId && grants.has(grantKey({ persona, action })));
    },
    checkGrant(persona, action, shellId) {
      lazyPrune();
      // Try exact match first (shellId-scoped), then global.
      const exactKey = grantKey({ persona, action, shellId });
      if (grants.has(exactKey)) return { granted: true };
      if (shellId) {
        const globalKey = grantKey({ persona, action });
        if (grants.has(globalKey)) return { granted: true };
      }
      const keys = new Set([exactKey, ...(shellId ? [grantKey({ persona, action })] : [])]);
      const latest = [...keys].map((key) => denials.get(key)).filter((value) => value !== undefined)
        .sort((a, b) => b.order - a.order)[0];
      if (latest) return latest.reason === 'expired'
        ? { granted: false, reason: 'expired', expiresAt: latest.expiresAt }
        : { granted: false, reason: 'revoked' };
      return { granted: false, reason: 'absent' };
    },
    list(filter) {
      lazyPrune();
      const out: CapabilityGrant[] = [];
      for (const g of grants.values()) {
        if (filter?.persona && g.persona !== filter.persona) continue;
        if (filter?.action && g.action !== filter.action) continue;
        if (filter?.shellId && g.shellId !== filter.shellId) continue;
        out.push(g);
      }
      return out;
    },
    audit() {
      return audit.slice();
    },
    pruneExpired(now) {
      // Honor explicit override for test determinism.
      const _ms = now ?? nowMs(opts);
      const events: GrantAuditEvent[] = [];
      for (const [key, g] of grants) {
        if (g.expiresAt && new Date(g.expiresAt).getTime() <= _ms) {
          clearExpiryTimer(key);
          grants.delete(key);
          rememberDenial(key, 'expired', g.expiresAt);
          const ev: GrantAuditEvent = { kind: 'expired', grant: g, at: nowIso(opts) };
          pushAudit(ev);
          events.push(ev);
        }
      }
      return events;
    },
  };
}

// ── Slash command handler ───────────────────────────────────────────

export interface GrantSlashHandlerDeps {
  store: CapabilityGrantStore;
  /** ISO timestamp source for audit events. Defaults to nowIso. */
  now?: () => string;
}

export interface GrantSlashCommand {
  /** Subcommand: grant | revoke | list. */
  readonly verb: 'grant' | 'revoke' | 'list';
  readonly persona?: string;
  readonly action?: GrantedAction;
  readonly shellId?: string;
  readonly note?: string;
  readonly expiresAt?: string;
  readonly by?: string;
}

export interface GrantSlashResult {
  readonly ok: boolean;
  readonly message: string;
  readonly grants?: readonly CapabilityGrant[];
}

const VALID_ACTIONS: ReadonlySet<GrantedAction> = new Set([
  'read', 'write', 'interrupt', 'inspect', 'spawn', 'close',
]);

/**
 * Parse + execute a `/grant ...` / `/revoke ...` / `/grants` slash.
 *
 * Examples:
 *   /grant alice write
 *   /grant codex spawn shell-abc
 *   /grant bob read --expires 2026-06-01T00:00:00Z --note "QA review"
 *   /revoke alice write
 *   /revoke alice
 *   /grants
 *   /grants alice
 */
export function executeGrantSlash(
  cmd: GrantSlashCommand,
  deps: GrantSlashHandlerDeps,
): GrantSlashResult {
  const now = deps.now ?? (() => new Date().toISOString());

  switch (cmd.verb) {
    case 'grant': {
      if (!cmd.persona) return { ok: false, message: 'grant: persona 가 필요합니다 (예: /grant alice write)' };
      if (!cmd.action || !VALID_ACTIONS.has(cmd.action)) {
        return { ok: false, message: `grant: action 이 잘못됨 — 가능: ${Array.from(VALID_ACTIONS).join(', ')}` };
      }
      const grant: CapabilityGrant = {
        persona: cmd.persona,
        action: cmd.action,
        ...(cmd.shellId !== undefined ? { shellId: cmd.shellId } : {}),
        ...(cmd.note !== undefined ? { note: cmd.note } : {}),
        ...(cmd.expiresAt !== undefined ? { expiresAt: cmd.expiresAt } : {}),
        ...(cmd.by !== undefined ? { grantedBy: cmd.by } : {}),
        grantedAt: now(),
      };
      deps.store.grant(grant);
      const scope = grant.shellId ? ` for ${grant.shellId}` : '';
      const expiry = grant.expiresAt ? ` until ${grant.expiresAt}` : '';
      return { ok: true, message: `granted ${grant.persona} ${grant.action}${scope}${expiry}` };
    }
    case 'revoke': {
      if (!cmd.persona) return { ok: false, message: 'revoke: persona 가 필요합니다' };
      const removed = deps.store.revoke({
        persona: cmd.persona,
        ...(cmd.action !== undefined ? { action: cmd.action } : {}),
        ...(cmd.shellId !== undefined ? { shellId: cmd.shellId } : {}),
        ...(cmd.by !== undefined ? { by: cmd.by } : {}),
      });
      if (removed === 0) return { ok: false, message: `revoke: ${cmd.persona} 의 매칭 grant 없음` };
      return { ok: true, message: `revoked ${removed} grant(s) for ${cmd.persona}` };
    }
    case 'list': {
      const filter: { persona?: string; action?: GrantedAction; shellId?: string } = {};
      if (cmd.persona !== undefined) filter.persona = cmd.persona;
      if (cmd.action !== undefined) filter.action = cmd.action;
      if (cmd.shellId !== undefined) filter.shellId = cmd.shellId;
      const list = deps.store.list(filter);
      if (list.length === 0) return { ok: true, message: '현재 grant 가 없습니다.', grants: [] };
      const lines = list.map((g) => {
        const scope = g.shellId ? `[${g.shellId}]` : '[*]';
        const exp = g.expiresAt ? ` (expires ${g.expiresAt})` : '';
        return `  ${g.persona} · ${g.action} · ${scope}${exp}`;
      });
      return { ok: true, message: `${list.length} grant(s):\n${lines.join('\n')}`, grants: list };
    }
  }
}
