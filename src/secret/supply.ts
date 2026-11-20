/**
 * SECRET-SUPPLY-TARGETS — `eln secret supply <vault item name> --to <pod:Job|ta:card|host:name|config-dir>`.
 * 🔗 설계 = seat-state/OP/orders/LLM-SPEND-POLICY-ONE-SHOT.md «08:1x» · «08:0x».
 *
 * 얇은 한 길: 임대·주입·회수는 전부 기존 길에 위임한다(재구현 0).
 *   - OAuth(codex)  → src/secret/codex-lease.ts  (issueCodexLease · revokeCodexLease · 원장 secret-leases.json)
 *   - 정적 API 키    → src/secret/static-lease.ts (issueStaticLease · revokeStaticLeases · 원장 secret-lease-ledger/static)
 *   - 원격 호스트    → 위 두 길의 host 대상 = 기존 «codex mirror push»/cred-push 갈래를 이 한 길로 흡수(미러 = 임대 사본)
 *   - Pod/TA        → 주입기(podSupply) 이음매. 기본은 미배선 = 거부(fail-closed).
 * 이 모듈이 더하는 것 3가지: ① 대상 꼴 파서 ② 대상별 허용 목록(정책 · 기본 전부 거부) ③ supply 원장(누가·무엇·어디·언제 · 값 0).
 * 금고 쓰기 0 — 읽기+임대만. 값·토큰은 어디에도 싣지 않는다(이름·id·시각·남은 TTL 만).
 */
import { appendFileSync, closeSync, fchmodSync, mkdirSync, openSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';

export const SUPPLY_POLICY_FILE = 'secret-supply-policy.json';
export const SUPPLY_LEDGER_FILE = join('secret-supply-ledger', 'supply.jsonl');
export const SUPPLY_DEFAULT_TTL_MS = 12 * 60 * 60_000;

export type SupplyTargetKind = 'pod' | 'ta' | 'host' | 'config-dir';
export interface SupplyTarget { readonly kind: SupplyTargetKind; readonly name: string }

/** 코드 상수(정책 파일이 어떻게 적혀도 한 번 더 막는다): 이 항목은 host 만 — Pod·TA 금지. */
export const HOST_ONLY_ITEMS: readonly string[] = ['claude-acp'];
/** OAuth 갈래로 가는 이름. 나머지는 정적 키 갈래. */
export const OAUTH_ITEMS: readonly string[] = ['codex'];

export type SupplyRefusal =
  | 'invalid-target' | 'invalid-item' | 'policy-missing' | 'policy-invalid' | 'policy-not-owner'
  | 'item-not-allowed' | 'target-not-allowed' | 'host-only-item' | 'handler-unwired' | 'delegate-refused';

export type SupplyResult =
  | { readonly ok: true; readonly leaseId: string; readonly item: string; readonly target: string; readonly expiresAt: number; readonly via: 'oauth-lease' | 'static-lease' | 'pod' }
  | { readonly ok: false; readonly reason: SupplyRefusal; readonly item: string; readonly target: string; readonly detail: string };

// ── 대상 ────────────────────────────────────────────────────────────────────
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function parseSupplyTarget(raw: string): SupplyTarget | null {
  const t = raw.trim();
  const m = /^(pod|ta|host):(.*)$/.exec(t);
  if (m) return NAME_RE.test(m[2]!) ? { kind: m[1] as SupplyTargetKind, name: m[2]! } : null;
  // 접두어 없는 값 = 경로(config-dir)만. 맨 이름은 모호하므로 거부.
  return /^(\/|~\/)[^\0]+$/.test(t) && !t.includes('..') ? { kind: 'config-dir', name: t } : null;
}
export const targetLabel = (t: SupplyTarget): string => `${t.kind}:${t.name}`;

// ── 정책(허용 목록) — 비밀 0 스키마 · fail-closed · owner 만 ───────────────
export interface SupplyPolicy { readonly allow: ReadonlyArray<{ readonly item: string; readonly targets: readonly string[] }> }

/** 키 모양 거부 — sk-·ghp_·ems_·emt_·eyJ·긴 무작위. */
const SECRET_SHAPE = /(sk-|ghp_|gho_|ems_|emt_|eyJ)|[A-Za-z0-9+/_=-]{40,}/;
const TARGET_SPEC = /^(pod|ta|host|config-dir)(:[A-Za-z0-9][A-Za-z0-9._-]{0,62})?$/;

/** 순수 검증. 하나라도 어긋나면 정책 전체 무효(=전부 거부). */
export function validateSupplyPolicy(raw: unknown): { ok: true; policy: SupplyPolicy } | { ok: false; detail: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, detail: 'not-an-object' };
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some((k) => k !== 'version' && k !== 'allow')) return { ok: false, detail: 'unknown-key' }; // 직렬화 허용 목록
  if (obj.version !== 1 || !Array.isArray(obj.allow)) return { ok: false, detail: 'bad-version-or-allow' };
  const allow: Array<{ item: string; targets: string[] }> = [];
  for (const row of obj.allow) {
    const r = row as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Object.keys(r).some((k) => k !== 'item' && k !== 'targets')) return { ok: false, detail: 'bad-row' };
    if (typeof r.item !== 'string' || !NAME_RE.test(r.item) || SECRET_SHAPE.test(r.item)) return { ok: false, detail: 'bad-item-name' };
    if (!Array.isArray(r.targets) || !r.targets.every((x) => typeof x === 'string' && TARGET_SPEC.test(x) && !SECRET_SHAPE.test(x))) return { ok: false, detail: 'bad-targets' };
    allow.push({ item: r.item, targets: r.targets as string[] });
  }
  return { ok: true, policy: { allow } };
}

export type PolicyLoad = { ok: true; policy: SupplyPolicy } | { ok: false; reason: 'policy-missing' | 'policy-invalid' | 'policy-not-owner'; detail: string };

/** owner 소유 · 0600(그룹/타인 쓰기·읽기 0) 파일만 읽는다. 없음/깨짐/남의 파일 = 전부 거부. */
export function loadSupplyPolicy(configDir: string, uid: number | undefined = process.getuid?.()): PolicyLoad {
  const path = join(configDir, SUPPLY_POLICY_FILE);
  if (!existsSync(path)) return { ok: false, reason: 'policy-missing', detail: `${SUPPLY_POLICY_FILE} 없음 — 기본 전부 거부` };
  try {
    const st = statSync(path);
    if ((uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) return { ok: false, reason: 'policy-not-owner', detail: 'owner 소유 0600 파일이어야 한다' };
    const v = validateSupplyPolicy(JSON.parse(readFileSync(path, 'utf8')));
    return v.ok ? v : { ok: false, reason: 'policy-invalid', detail: v.detail };
  } catch {
    return { ok: false, reason: 'policy-invalid', detail: 'unreadable' };
  }
}

/** 허용 판정 — 코드 상수(host-only)가 정책보다 먼저. 정책에 없으면 거부. */
export function checkSupplyAllowed(policy: SupplyPolicy, item: string, target: SupplyTarget):
  { ok: true } | { ok: false; reason: 'host-only-item' | 'item-not-allowed' | 'target-not-allowed' } {
  if (HOST_ONLY_ITEMS.includes(item) && target.kind !== 'host') return { ok: false, reason: 'host-only-item' };
  const rows = policy.allow.filter((r) => r.item === item);
  if (!rows.length) return { ok: false, reason: 'item-not-allowed' };
  const hit = rows.some((r) => r.targets.some((s) => s === target.kind || s === targetLabel(target)));
  return hit ? { ok: true } : { ok: false, reason: 'target-not-allowed' };
}

// ── 원장(값 0) ──────────────────────────────────────────────────────────────
export interface SupplyLedgerRow {
  readonly at: string; readonly who: string; readonly action: 'supply' | 'refused' | 'revoke';
  readonly item: string; readonly target: string; readonly leaseId?: string; readonly via?: string; readonly reason?: string; readonly expiresAt?: string;
}
export function appendSupplyLedger(configDir: string, row: SupplyLedgerRow): void {
  const path = join(configDir, SUPPLY_LEDGER_FILE);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const clean: SupplyLedgerRow = { at: row.at, who: row.who, action: row.action, item: row.item, target: row.target,
    ...(row.leaseId ? { leaseId: row.leaseId } : {}), ...(row.via ? { via: row.via } : {}), ...(row.reason ? { reason: row.reason } : {}), ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}) };
  appendFileSync(path, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
  const fd = openSync(path, 'r'); try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
}
export function readSupplyLedger(configDir: string): SupplyLedgerRow[] {
  try { return readFileSync(join(configDir, SUPPLY_LEDGER_FILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SupplyLedgerRow); } catch { return []; }
}

// ── 위임 이음매 ─────────────────────────────────────────────────────────────
export interface SupplyDelegates {
  /** OAuth(codex) 임대 — 기본 issueCodexLease(host|config-dir). */
  readonly oauthIssue: (to: string, ttlMs: number | undefined) => Promise<{ leaseId: string; expiresAt: number }>;
  /** 정적 키 임대 — 기본 issueStaticLease. 거부 시 reason 문자열. */
  readonly staticIssue: (item: string, to: string, ttlMs: number | undefined) => Promise<{ ok: true; leaseId: string; expiresAt: number } | { ok: false; reason: string }>;
  /** Pod/TA 주입기(Job Secret 마운트·env 이름 / 같은 Pod 경로). 미배선이면 거부. */
  readonly podSupply?: (item: string, target: SupplyTarget, ttlMs: number | undefined) => Promise<{ leaseId: string; expiresAt: number }>;
  readonly oauthRevoke: (leaseId: string) => Promise<boolean>;
  readonly staticRevoke: (leaseId: string) => Promise<boolean>;
}
export interface SupplyDeps {
  readonly configDir: string;
  readonly delegates: SupplyDelegates;
  readonly now?: () => number;
  readonly who?: () => string;
  readonly policy?: () => PolicyLoad;
}

function whoAmI(): string {
  const seat = process.env.ELANOUS_SEAT_ID || process.env.ELN_SEAT;
  try { return seat ? `${userInfo().username}@${seat.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)}` : userInfo().username; } catch { return 'unknown'; }
}

/** 한 길. 순서: 형 검사 → 정책(없으면 거부) → 허용 목록 → 위임 → 원장. 어느 단계든 실패하면 거부 + 원장 한 줄. */
export async function supply(req: { item: string; to: string; ttlMs?: number }, deps: SupplyDeps): Promise<SupplyResult> {
  const nowIso = () => new Date((deps.now ?? Date.now)()).toISOString();
  const who = (deps.who ?? whoAmI)();
  const refuse = (reason: SupplyRefusal, detail: string): SupplyResult => {
    try { appendSupplyLedger(deps.configDir, { at: nowIso(), who, action: 'refused', item: req.item, target: req.to, reason }); } catch { /* 원장 실패가 거부를 뒤집지 않는다 */ }
    return { ok: false, reason, item: req.item, target: req.to, detail };
  };
  if (!NAME_RE.test(req.item)) return refuse('invalid-item', '금고 항목 이름 꼴이 아니다');
  const target = parseSupplyTarget(req.to);
  if (!target) return refuse('invalid-target', 'pod:<Job> | ta:<카드> | host:<이름> | 절대 경로(config-dir)');
  const loaded = (deps.policy ?? (() => loadSupplyPolicy(deps.configDir)))();
  if (!loaded.ok) return refuse(loaded.reason, loaded.detail);
  const allowed = checkSupplyAllowed(loaded.policy, req.item, target);
  if (!allowed.ok) return refuse(allowed.reason, '허용 목록 밖 — fail-closed');

  const label = targetLabel(target);
  try {
    let got: { leaseId: string; expiresAt: number }; let via: 'oauth-lease' | 'static-lease' | 'pod';
    if (target.kind === 'pod' || target.kind === 'ta') {
      if (!deps.delegates.podSupply) return refuse('handler-unwired', 'Pod/TA 주입기 미배선 — 거부');
      got = await deps.delegates.podSupply(req.item, target, req.ttlMs); via = 'pod';
    } else {
      const to = target.name; // host 이름 또는 config-dir 경로 — 위임 길이 자기 허용 검사를 한 번 더 한다
      if (OAUTH_ITEMS.includes(req.item)) { got = await deps.delegates.oauthIssue(to, req.ttlMs); via = 'oauth-lease'; }
      else {
        const r = await deps.delegates.staticIssue(req.item, to, req.ttlMs);
        if (!r.ok) return refuse('delegate-refused', `static-lease: ${r.reason}`);
        got = r; via = 'static-lease';
      }
    }
    appendSupplyLedger(deps.configDir, { at: nowIso(), who, action: 'supply', item: req.item, target: label, leaseId: got.leaseId, via, expiresAt: new Date(got.expiresAt).toISOString() });
    return { ok: true, leaseId: got.leaseId, item: req.item, target: label, expiresAt: got.expiresAt, via };
  } catch (error) {
    // 위임 길의 오류 메시지는 이름 규칙을 지킨 고정 문구만 — 원문은 싣지 않는다.
    return refuse('delegate-refused', error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'delegate failed');
  }
}

export async function revokeSupply(leaseId: string, deps: SupplyDeps): Promise<{ ok: boolean }> {
  const ok = /^[A-Za-z0-9_-]{4,64}$/.test(leaseId) && ((await deps.delegates.staticRevoke(leaseId)) || (await deps.delegates.oauthRevoke(leaseId)));
  try { appendSupplyLedger(deps.configDir, { at: new Date((deps.now ?? Date.now)()).toISOString(), who: (deps.who ?? whoAmI)(), action: 'revoke', item: '-', target: '-', leaseId, ...(ok ? {} : { reason: 'not-found' }) }); } catch { /* */ }
  return { ok };
}

// ── --list : 살아 있는 임대(대상·남은 TTL·자격 이름 · 값 0) ─────────────────
export interface LiveLeaseRow { readonly leaseId: string; readonly item: string; readonly target: string; readonly remainingMs: number }
export function listLiveLeases(
  src: { oauth: ReadonlyArray<{ leaseId: string; account: string; target: string; expiresAt: number; revokedAt?: number }>;
         statics: ReadonlyArray<{ leaseId: string; id: string; target: string; expiresAt: string; revokedAt?: string; revokePending?: boolean }> },
  nowMs: number,
): LiveLeaseRow[] {
  const rows: LiveLeaseRow[] = [];
  for (const r of src.oauth) if (r.revokedAt === undefined && r.expiresAt > nowMs) rows.push({ leaseId: r.leaseId, item: 'codex', target: r.target, remainingMs: r.expiresAt - nowMs });
  for (const r of src.statics) { const e = Date.parse(r.expiresAt); if (!r.revokedAt && !r.revokePending && e > nowMs) rows.push({ leaseId: r.leaseId, item: r.id, target: r.target, remainingMs: e - nowMs }); }
  return rows.sort((a, b) => a.remainingMs - b.remainingMs);
}
