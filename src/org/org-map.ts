// Org as config — one declarative map of seats (roles), spaces (leader · advisor · steward) and DUTIES → seat.
// Source: the `org:` section of the workspace declaration (federation.yaml), merged over DEFAULT_ORG, which
// reproduces today's hard-wired organization exactly. Every consumer asks `orgDuty(name)` instead of a literal.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parseDocument } from 'yaml';

// `proxy` (CLAUDE-OP-PROXY-IDENTITY · 11-26): the CEO's proxy — holds no duty; its OP operator authority comes from the
// process-bound grant (src/proxy/proxy-identity.ts), never from this map.
export const ORG_ROLES = ['coo', 'cto', 'cmo', 'cxo', 'leader', 'advisor', 'judge', 'steward', 'hand', 'proxy'] as const;
export type OrgRole = typeof ORG_ROLES[number];

const EXEC: readonly OrgRole[] = ['coo', 'cto', 'cmo', 'cxo', 'leader'];

/**
 * Roles held by loop agents (graph triggers, no conversational inbox) — 대표 11-26: REL and RES became loop agents.
 * Mail meant to be read by a seat (bulletins, digests) skips these seats.
 */
export const LOOP_AGENT_ROLES: readonly OrgRole[] = ['steward'];
/** True when the seat reads mail in a conversation (unknown seats count as conversational). */
export const isConversationalSeat = (org: { seats: Readonly<Record<string, { role: OrgRole }>> }, seat: string): boolean =>
  !LOOP_AGENT_ROLES.includes(org.seats[seat.trim().toUpperCase()]?.role as OrgRole);

/** duty → roles allowed to hold it. */
export const DUTY_ROLES: Readonly<Record<string, readonly OrgRole[]>> = {
  'board': ['coo', 'cto', 'leader'],
  'beacon-watch': ['coo', 'cto', 'leader'],
  'release-supervision': ['steward', 'coo', 'cto', 'leader'],
  'resource-supervision': ['steward', 'coo', 'cto', 'leader'],
  'landing': ['judge', 'steward', 'coo', 'cto', 'leader'],
  // Independent judiciary (11-26): HOLD · disputes · 4 security vetoes · release NO-GO — judge only, escalates OP → CEO.
  'veto': ['judge'],
  'pulse-owner': EXEC,
  'digest-recipient': EXEC,
  'escalation-parent': ['coo', 'cto', 'leader'],
  'trigger-owner': ['coo', 'cto', 'leader'],
  'steward-cards': ['coo', 'cto', 'leader'],
  'brand': ['cmo', 'leader', 'coo'],
  'digital-marketing': ['cmo', 'leader', 'coo'],
  'promotion': ['cmo', 'leader', 'coo'],
  'surface-owner:mobile': ['cxo', 'leader', 'cto'],
  'surface-owner:desktop': ['cxo', 'leader', 'cto'],
  'surface-owner:messenger': ['cxo', 'leader', 'cto'],
  'surface-owner:web': ['cxo', 'leader', 'cto'],
  'surface-contract': ['cxo', 'leader', 'cto'],
};
export type OrgDutyName = keyof typeof DUTY_ROLES & string;

export interface OrgSpace { readonly leader: string; readonly advisor?: string; readonly steward?: string }
export interface OrgMap {
  readonly seats: Readonly<Record<string, { readonly role: OrgRole }>>;
  readonly spaces: Readonly<Record<string, OrgSpace>>;
  readonly duties: Readonly<Record<string, string>>;
}

/** Today's organization (11-25), unchanged: OP = COO runs HQ and holds every HQ duty; REL/RES/JUD hold their kingdoms. */
export const DEFAULT_ORG: OrgMap = {
  seats: {
    OP: { role: 'coo' }, TC: { role: 'cto' }, MK: { role: 'cmo' }, UX: { role: 'cxo' },
    JUD: { role: 'judge' }, REL: { role: 'steward' }, RES: { role: 'steward' }, 'TC-ADV': { role: 'advisor' },
    'CLAUDE-OP': { role: 'proxy' },
  },
  spaces: {
    hq: { leader: 'OP' }, tc: { leader: 'TC', advisor: 'TC-ADV' }, mk: { leader: 'MK' }, ux: { leader: 'UX' },
    judge: { leader: 'JUD' }, release: { leader: 'REL' }, resource: { leader: 'RES' },
  },
  duties: {
    'board': 'OP', 'beacon-watch': 'OP', 'release-supervision': 'REL', 'resource-supervision': 'RES', 'landing': 'JUD', 'veto': 'JUD',
    'pulse-owner': 'OP', 'digest-recipient': 'OP', 'escalation-parent': 'OP', 'trigger-owner': 'OP', 'steward-cards': 'OP',
    'brand': 'MK', 'digital-marketing': 'MK', 'promotion': 'MK',
    'surface-owner:mobile': 'UX', 'surface-owner:desktop': 'UX', 'surface-owner:messenger': 'UX', 'surface-owner:web': 'UX',
    'surface-contract': 'UX',
  },
};

const up = (s: string) => s.trim().toUpperCase();
const rec = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Pure: merge a raw `org:` section over the defaults. `null` removes a seat/space. Unknown roles/duties → errors. */
export function mergeOrg(raw: unknown, base: OrgMap = DEFAULT_ORG): { org: OrgMap; errors: string[] } {
  const errors: string[] = [];
  const seats: Record<string, { role: OrgRole }> = { ...base.seats };
  const spaces: Record<string, OrgSpace> = { ...base.spaces };
  const duties: Record<string, string> = { ...base.duties };
  if (raw !== undefined && raw !== null && !rec(raw)) errors.push('org must be an object');
  const r = rec(raw) ? raw : {};
  for (const [id, v] of Object.entries(rec(r.seats) ? r.seats : {})) {
    if (v === null) { delete seats[up(id)]; continue; }
    const role = rec(v) ? v.role : v;
    if (typeof role !== 'string' || !(ORG_ROLES as readonly string[]).includes(role)) { errors.push(`org.seats.${id}: unknown role ${JSON.stringify(role)}`); continue; }
    seats[up(id)] = { role: role as OrgRole };
  }
  for (const [name, v] of Object.entries(rec(r.spaces) ? r.spaces : {})) {
    if (v === null) { delete spaces[name]; continue; }
    if (!rec(v) || typeof v.leader !== 'string') { errors.push(`org.spaces.${name}: leader required`); continue; }
    spaces[name] = { leader: up(v.leader), ...(typeof v.advisor === 'string' ? { advisor: up(v.advisor) } : {}), ...(typeof v.steward === 'string' ? { steward: up(v.steward) } : {}) };
  }
  for (const [duty, v] of Object.entries(rec(r.duties) ? r.duties : {})) {
    if (!Object.hasOwn(DUTY_ROLES, duty)) { errors.push(`org.duties.${duty}: unknown duty`); continue; }
    if (typeof v !== 'string') { errors.push(`org.duties.${duty}: seat required`); continue; }
    duties[duty] = up(v);
  }
  return { org: { seats, spaces, duties }, errors };
}

/** Parent on the ✋ ladder: HQ (escalation-parent) → CEO · space leader → HQ · advisor/steward/member → its space leader. */
export function orgParentOf(org: OrgMap, seat: string): string {
  const s = up(seat);
  const hq = org.duties['escalation-parent'] ?? 'OP';
  if (s === 'CEO' || s === hq) return 'CEO';
  for (const space of Object.values(org.spaces)) if (space.leader === s) return hq;
  for (const space of Object.values(org.spaces)) if (space.advisor === s || space.steward === s) return space.leader;
  return hq;
}

/** Pure: every invariant a move must keep. Empty = valid. */
export function validateOrg(org: OrgMap): string[] {
  const errs: string[] = [];
  const has = (s: string) => Object.hasOwn(org.seats, s);
  for (const duty of Object.keys(DUTY_ROLES)) {
    const seat = org.duties[duty];
    if (!seat) { errs.push(`orphan duty ${duty}: no seat`); continue; }
    if (!has(seat)) { errs.push(`duty ${duty} → ${seat}: seat does not exist`); continue; }
    const role = org.seats[seat]!.role;
    if (!DUTY_ROLES[duty]!.includes(role)) errs.push(`duty ${duty} → ${seat}: role ${role} not allowed (${DUTY_ROLES[duty]!.join('|')})`);
  }
  for (const [name, sp] of Object.entries(org.spaces)) for (const k of ['leader', 'advisor', 'steward'] as const) {
    const s = sp[k];
    if (s && !has(s)) errs.push(`space ${name}.${k} → ${s}: seat does not exist`);
  }
  for (const [name, sp] of Object.entries(org.spaces)) for (const k of ['advisor', 'steward'] as const)
    if (sp[k] && sp[k] === sp.leader) errs.push(`ladder cycle: space ${name}.${k} ${sp[k]} would be its own parent`);
  const placed = new Set(Object.values(org.spaces).flatMap(sp => [sp.leader, sp.advisor, sp.steward].filter(Boolean) as string[]));
  for (const seat of new Set(Object.values(org.duties))) if (!placed.has(seat)) errs.push(`duty holder ${seat} is in no space (orphan)`);
  for (const seat of [...Object.keys(org.seats), ...placed]) {
    let cur = seat; const seen = new Set<string>();
    while (cur !== 'CEO') { if (seen.has(cur)) { errs.push(`ladder cycle at ${seat}: ${[...seen].join('→')}`); break; } seen.add(cur); cur = orgParentOf(org, cur); }
  }
  return [...new Set(errs)];
}

// ── live loading ─────────────────────────────────────────────────────────────────────────────

export interface OrgDeps { readonly cwd?: string; readonly home?: string; readonly path?: string }

/** The declaration file that holds `org:` (federation.yaml lookup); absent = undefined (defaults apply). */
export function orgFilePath(deps: OrgDeps = {}): string | undefined {
  if (deps.path) return deps.path;
  try {
    const { findWorkspaceFile } = require('../els/workspace-config.js') as typeof import('../els/workspace-config.js');
    return findWorkspaceFile(deps.cwd ?? process.cwd(), deps.home ?? homedir());
  } catch { return undefined; }
}

export function loadOrgMap(deps: OrgDeps = {}): { org: OrgMap; path?: string; errors: string[]; declared: boolean } {
  const path = orgFilePath(deps);
  if (!path || !existsSync(path)) return { org: DEFAULT_ORG, errors: [], declared: false };
  try {
    const raw = parseDocument(readFileSync(path, 'utf8')).toJS() as Record<string, unknown> | null;
    const section = raw?.org;
    const merged = mergeOrg(section);
    return { ...merged, path, declared: section !== undefined && section !== null };
  } catch (e) { return { org: DEFAULT_ORG, path, errors: [`unreadable ${path}: ${(e as Error).message}`], declared: false }; }
}

/** THE resolver: which seat holds `duty` now. Never throws; an unreadable map falls back to today's default. */
export function orgDuty(duty: OrgDutyName | string, deps: OrgDeps = {}): string {
  return loadOrgMap(deps).org.duties[duty] ?? DEFAULT_ORG.duties[duty] ?? 'OP';
}

/** Whether the declaration explicitly assigns `duty` (lets consumers keep older sources' precedence otherwise). */
export function orgDutyDeclared(duty: string, deps: OrgDeps = {}): string | undefined {
  const { path, declared } = loadOrgMap(deps);
  if (!declared || !path) return undefined;
  try {
    const d = (parseDocument(readFileSync(path, 'utf8')).toJS() as { org?: { duties?: Record<string, unknown> } }).org?.duties?.[duty];
    return typeof d === 'string' ? up(d) : undefined;
  } catch { return undefined; }
}

/** Per-duty state (digest cursors, open card index) is keyed by DUTY, never by seat — a move loses nothing. */
export function dutyStatePath(stateRoot: string, duty: string): string { return join(stateRoot, 'org', 'duty-state', `${duty.replace(/[^a-z0-9:-]/gi, '_')}.json`); }

// ── mutations ────────────────────────────────────────────────────────────────────────────────

export type OrgChange =
  | { readonly op: 'move'; readonly duty: string; readonly to: string }
  | { readonly op: 'set-role'; readonly seat: string; readonly role: string }
  | { readonly op: 'add-space'; readonly space: string; readonly leader: string; readonly advisor?: string; readonly steward?: string }
  | { readonly op: 'remove-space'; readonly space: string };

/** Pure: apply a change → next map ⊕ the refusal list (validateOrg of the result ⊕ change-local checks). */
export function applyOrgChange(org: OrgMap, change: OrgChange): { next: OrgMap; errors: string[]; from?: string } {
  const errors: string[] = [];
  const seats = { ...org.seats } as Record<string, { role: OrgRole }>;
  const spaces = { ...org.spaces } as Record<string, OrgSpace>;
  const duties = { ...org.duties } as Record<string, string>;
  let from: string | undefined;
  if (change.op === 'move') {
    if (!Object.hasOwn(DUTY_ROLES, change.duty)) errors.push(`unknown duty ${change.duty}`);
    from = duties[change.duty]; duties[change.duty] = up(change.to);
    if (from === up(change.to)) errors.push(`${change.duty} is already held by ${from}`);
  } else if (change.op === 'set-role') {
    if (!(ORG_ROLES as readonly string[]).includes(change.role)) errors.push(`unknown role ${change.role} (${ORG_ROLES.join('|')})`);
    else seats[up(change.seat)] = { role: change.role as OrgRole };
  } else if (change.op === 'add-space') {
    if (Object.hasOwn(spaces, change.space)) errors.push(`space ${change.space} exists`);
    const ids = [change.leader, change.advisor, change.steward].filter(Boolean).map(s => up(s!));
    for (const id of ids) if (!Object.hasOwn(seats, id)) seats[id] = { role: id === up(change.leader) ? 'leader' : id === up(change.advisor ?? '') ? 'advisor' : 'steward' };
    spaces[change.space] = { leader: up(change.leader), ...(change.advisor ? { advisor: up(change.advisor) } : {}), ...(change.steward ? { steward: up(change.steward) } : {}) };
  } else {
    if (!Object.hasOwn(spaces, change.space)) errors.push(`no space ${change.space}`);
    delete spaces[change.space];
  }
  const next = { seats, spaces, duties };
  return { next, errors: [...errors, ...validateOrg(next)], ...(from ? { from } : {}) };
}

/** Write the change into the declaration (comments preserved) — only the `org:` section is touched. */
export function writeOrgChange(path: string, change: OrgChange, next?: OrgMap): void {
  const doc = existsSync(path) ? parseDocument(readFileSync(path, 'utf8')) : parseDocument('version: 1\n');
  if (change.op === 'move') doc.setIn(['org', 'duties', change.duty], up(change.to));
  else if (change.op === 'set-role') doc.setIn(['org', 'seats', up(change.seat), 'role'], change.role);
  else if (change.op === 'add-space') {
    for (const id of [change.leader, change.advisor, change.steward].filter((x): x is string => Boolean(x)).map(up))
      if (next?.seats[id] && !DEFAULT_ORG.seats[id] && !doc.hasIn(['org', 'seats', id])) doc.setIn(['org', 'seats', id, 'role'], next.seats[id]!.role);
    doc.setIn(['org', 'spaces', change.space], { leader: up(change.leader), ...(change.advisor ? { advisor: up(change.advisor) } : {}), ...(change.steward ? { steward: up(change.steward) } : {}) });
  }
  else doc.setIn(['org', 'spaces', change.space], null);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(doc));
}

export function appendOrgAudit(stateRoot: string, row: Record<string, unknown>): string {
  const file = join(stateRoot, 'org', 'audit.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
  return file;
}

// ── views ────────────────────────────────────────────────────────────────────────────────────

export function orgTreeLines(org: OrgMap): string[] {
  const hq = org.duties['escalation-parent'] ?? 'OP';
  const dutiesOf = (s: string) => Object.entries(org.duties).filter(([, v]) => v === s).map(([k]) => k);
  const tag = (s: string) => `${s} (${org.seats[s]?.role ?? '?'})${dutiesOf(s).length ? ` — ${dutiesOf(s).join(', ')}` : ''}`;
  const lines = ['CEO', `└─ ${tag(hq)}  [hq]`];
  const entries = Object.entries(org.spaces).filter(([, sp]) => sp.leader !== hq);
  entries.forEach(([name, sp], i) => {
    const last = i === entries.length - 1;
    lines.push(`   ${last ? '└' : '├'}─ ${name}: ${tag(sp.leader)}`);
    for (const [k, s] of [['advisor', sp.advisor], ['steward', sp.steward]] as const) if (s) lines.push(`   ${last ? ' ' : '│'}    └─ ${k} ${tag(s)}`);
  });
  return lines;
}

export function orgStatusRow(org: OrgMap): string {
  const moved = Object.entries(org.duties).filter(([k, v]) => DEFAULT_ORG.duties[k] !== v).map(([k, v]) => `${k}→${v}`);
  const errs = validateOrg(org);
  return `org · ${Object.keys(org.seats).length} seats · ${Object.keys(org.spaces).length} spaces · ${Object.keys(org.duties).length} duties · ${moved.length ? `moved ${moved.join(' ')}` : 'default'}${errs.length ? ` · ⚠ ${errs.length} invalid` : ''}`;
}
