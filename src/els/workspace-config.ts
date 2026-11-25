// Declarative workspace v1: validation is deliberately side-effect free. Metadata is not authorization.
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import { parseSpaceLead, type SpaceLeadDecl } from '../seat/space-lead.js';

export interface SeatConfig {
  readonly id: string; readonly role?: string; readonly description?: string;
  readonly runtime: string; readonly provider?: string; readonly model?: string; readonly profile?: string;
  readonly host: string; readonly cwd: string; readonly title: string;
  readonly tags: string[]; readonly capabilities: string[]; readonly languages: string[];
  readonly max_parallel: number; readonly remote: { readonly allowed: boolean; readonly hosts?: string[] };
  /** SPACE-ADVISOR — the coordinator this seat serves (role `advisor` requires it · must be a space coordinator). */
  readonly parent?: string;
}
export interface WorkspaceConfig {
  readonly version: 1; readonly root: string;
  readonly hq?: { readonly coordinator: string; readonly authorityLocation?: string };
  readonly hosts: Record<string, { ssh: string }>;
  readonly seats: Record<string, SeatConfig>;
  /** `lead` (SPACE-LEAD-HUMAN) — who leads the space: a tab (`llm`, the default) or a person (`human`). */
  readonly spaces: Record<string, { coordinator: string; seats: string[]; description?: string; lead?: SpaceLeadDecl }>;
}
type Row = Record<string, unknown>;
const record = (x: unknown): x is Row => !!x && typeof x === 'object' && !Array.isArray(x);
const runtime = ['eln', 'codex', 'claude', 'grok', 'shell'];
const seatKeys = ['role','description','runtime','provider','model','profile','host','cwd','title','tags','capabilities','languages','max_parallel','remote','parent'];
const roleKeys = ['description','runtime','provider','model','profile','capabilities','languages','max_parallel','remote'];
const secretKey = /^(token|password|secret|api_key)$/i;
const secretValue = /(?:sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]+|xox[baprs]-[a-zA-Z0-9-]+|-----BEGIN|(?:^|\s)[A-Za-z0-9+/]{40,}={0,2}(?:$|\s))/;

export function parseWorkspaceConfig(text: string, path: string, home = process.env.HOME ?? '/'): { config?: WorkspaceConfig; errors: string[]; warnings: string[] } {
  const errors: string[] = []; const warnings: string[] = [];
  // Associate parsed objects with syntax nodes; repeated keys in different mappings retain their own location.
  const positions = new WeakMap<object, Map<string, number>>();
  let scope: object | undefined;
  let raw: unknown;
  try {
    if (path.endsWith('.json')) JSON.parse(text); // strict JSON (no comments, trailing commas, or YAML syntax)
    const doc = parseDocument(text, { uniqueKeys: true });
    if (doc.errors.length) throw doc.errors[0];
    raw = doc.toJS({ maxAliasCount: 0 });
    const index = (node: any, value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (isMap(node) && record(value)) {
        const entries = new Map<string, number>(); positions.set(value, entries);
        for (const pair of node.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
          const k = pair.key.value;
          entries.set(k, pair.key.range?.[0] ?? 0);
          index(pair.value, value[k]);
        }
      } else if (isSeq(node) && Array.isArray(value)) node.items.forEach((child, i) => index(child, value[i]));
    };
    index(doc.contents, raw);
  } catch (e) {
    const pos = (e as { pos?: number[] }).pos?.[0] ?? 0;
    return { errors: [`error: ${path}:${text.slice(0, pos).split('\n').length}: invalid syntax`], warnings };
  }
  const location = (key: string, object = scope): string => {
    const offset = object ? positions.get(object)?.get(key) : undefined;
    return `${path}:${text.slice(0, offset ?? 0).split('\n').length}`;
  };
  const bad = (key: string, what: string, object = scope) => errors.push(`error: ${what} (${location(key, object)})`);
  const inspect = (x: unknown, key = ''): void => {
    if (typeof x === 'string' && secretValue.test(x)) bad(key, 'looks like a secret — credentials stay in the credential store');
    if (Array.isArray(x)) x.forEach(v => inspect(v, key));
    else if (record(x)) Object.entries(x).forEach(([k,v]) => { if (secretKey.test(k)) bad(k, 'looks like a secret — credentials stay in the credential store', x); const old = scope; scope = x; inspect(v,k); scope = old; });
  };
  inspect(raw);
  if (!record(raw)) return { errors: [...errors, `error: ${path}: expected object`], warnings };
  const keys = (obj: Row, allowed: string[], ctx: string) => Object.keys(obj).forEach(k => { if (!allowed.includes(k)) bad(k, `unknown key "${k}" in ${ctx}`, obj); });
  scope = raw;
  keys(raw, ['version','root','hosts','roles','seats','spaces','hq','grids','org'], 'workspace');
  for (const k of ['hq', 'grids']) if (raw[k] !== undefined && !record(raw[k])) bad(k, `${k} must be an object`);
  if (raw.version !== 1) bad('version', `unsupported version ${JSON.stringify(raw.version)} (this els reads 1)`);
  const maps: Record<string, Row> = {};
  for (const k of ['hosts','roles','seats','spaces']) { if (raw[k] !== undefined && !record(raw[k])) bad(k, `${k} must be an object`); maps[k] = record(raw[k]) ? raw[k] as Row : {}; }
  const rootBase = dirname(dirname(resolve(path)));
  if (raw.root !== undefined && (typeof raw.root !== 'string' || !raw.root || raw.root.includes('\0'))) bad('root', 'root must be a path');
  const rootText = typeof raw.root === 'string' && raw.root ? raw.root : rootBase;
  const root = resolve(rootBase, rootText === '~' ? home : rootText.startsWith('~/') ? join(home, rootText.slice(2)) : rootText);
  const hosts: Record<string, { ssh: string }> = {};
  for (const [name, value] of Object.entries(maps.hosts!)) {
    scope = maps.hosts;
    if (name === 'default') continue;
    if (name === 'local' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !record(value)) { bad(name, `invalid host ${name}`); continue; }
    scope = value; keys(value, ['ssh'], `hosts.${name}`);
    if (typeof value.ssh !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.ssh)) bad(name, `hosts.${name}.ssh must be an SSH host name`);
    else hosts[name] = { ssh: value.ssh };
  }
  const hostExists = (h: string) => h === 'local' || Object.hasOwn(hosts, h);
  scope = maps.hosts; const defaultHost = maps.hosts!.default ?? 'local';
  if (typeof defaultHost !== 'string' || !hostExists(defaultHost)) bad('default', 'hosts.default must name a host');
  for (const [name, value] of Object.entries(maps.roles!)) { if (!record(value)) bad(name, `roles.${name} must be an object`); else keys(value, roleKeys, `roles.${name}`); }
  const seats: Record<string, SeatConfig> = {};
  for (const [id, value] of Object.entries(maps.seats!)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id) || !record(value)) { bad(id, `invalid seat ${id}`); continue; }
    scope = value; keys(value, seatKeys, `seats.${id}`);
    const role = typeof value.role === 'string' ? value.role : undefined;
    const defaults = role && record(maps.roles![role]) ? maps.roles![role] as Row : {};
    const s: Row = { ...defaults, ...value };
    for (const k of ['role','description','provider','model','profile','title','cwd']) if (s[k] !== undefined && (typeof s[k] !== 'string' || !(s[k] as string).trim() || (s[k] as string).includes('\0'))) bad(k, `seats.${id}.${k} must be a nonempty string`);
    if (s.runtime !== undefined && (typeof s.runtime !== 'string' || !runtime.includes(s.runtime))) bad('runtime', `seats.${id}.runtime must be one of ${runtime.join(', ')}`);
    for (const k of ['tags','languages','capabilities']) if (s[k] !== undefined && (!Array.isArray(s[k]) || !(s[k] as unknown[]).every(v => typeof v === 'string' && (k !== 'capabilities' || /^[a-z][a-z0-9-]{0,39}$/.test(v))))) bad(k, `seats.${id}.${k} must be a valid string array`);
    if (s.max_parallel !== undefined && (!Number.isSafeInteger(s.max_parallel) || (s.max_parallel as number) < 1)) bad('max_parallel', `seats.${id}.max_parallel must be a positive integer`);
    const remote = s.remote === undefined ? {} : s.remote;
    if (!record(remote)) { bad('remote', `seats.${id}.remote must be an object`); continue; }
    keys(remote, ['allowed','hosts'], `seats.${id}.remote`);
    if (remote.allowed !== undefined && typeof remote.allowed !== 'boolean') bad('allowed', `seats.${id}.remote.allowed must be boolean`);
    if (remote.hosts !== undefined && (!Array.isArray(remote.hosts) || !remote.hosts.every(h => typeof h === 'string' && hostExists(h)))) bad('hosts', `seats.${id}.remote.hosts must name declared hosts`);
    const host = typeof s.host === 'string' ? s.host : typeof defaultHost === 'string' ? defaultHost : 'local';
    if (!hostExists(host)) bad('host', `seat ${id} names unknown host ${host}`);
    if (host !== 'local' && remote.allowed !== true) bad('host', `seat ${id} has host ${host} but remote.allowed is false`);
    if (host !== 'local' && Array.isArray(remote.hosts) && !remote.hosts.includes(host)) bad('host', `seat ${id} host ${host} is not allowed by remote.hosts`);
    if (s.parent !== undefined && (typeof s.parent !== 'string' || !s.parent.trim())) bad('parent', `seats.${id}.parent must be a nonempty string`);
    seats[id] = { id, ...(typeof s.parent === 'string' && s.parent.trim() ? { parent: s.parent.trim() } : {}), ...(role ? { role } : {}), ...(typeof s.description === 'string' ? { description: s.description } : {}), runtime: typeof s.runtime === 'string' ? s.runtime : 'eln', ...(typeof s.provider === 'string' ? { provider: s.provider } : {}), ...(typeof s.model === 'string' ? { model: s.model } : {}), ...(typeof s.profile === 'string' ? { profile: s.profile } : {}), host, cwd: typeof s.cwd === 'string' ? (isAbsolute(s.cwd) ? s.cwd : resolve(root, s.cwd)) : join(root, 'seats', id), title: typeof s.title === 'string' ? s.title : id, tags: Array.isArray(s.tags) ? s.tags as string[] : [], capabilities: Array.isArray(s.capabilities) ? s.capabilities as string[] : [], languages: Array.isArray(s.languages) ? s.languages as string[] : [], max_parallel: typeof s.max_parallel === 'number' ? s.max_parallel : 1, remote: { allowed: remote.allowed === true, ...(Array.isArray(remote.hosts) ? { hosts: remote.hosts as string[] } : {}) } };
  }
  const spaces: WorkspaceConfig['spaces'] = {}; const placed = new Map<string, string>();
  for (const [name, value] of Object.entries(maps.spaces!)) {
    if (!name.trim() || !record(value)) { bad(name, `invalid space ${name}`); continue; }
    scope = value; keys(value, ['coordinator','seats','description','lead','kind'], `spaces.${name}`);
    if (value.kind !== undefined && (typeof value.kind !== 'string' || !['direct', 'federation', 'kingdom'].includes(value.kind))) bad('kind', `spaces.${name}.kind must be direct, federation or kingdom`);
    if (record(value.coordinator)) {
      const selector = value.coordinator;
      keys(selector, ['role', 'tag'], `spaces.${name}.coordinator`);
      if ((selector.role !== undefined && typeof selector.role !== 'string') || (selector.tag !== undefined && typeof selector.tag !== 'string') || (!selector.role && !selector.tag)) bad('coordinator', `spaces.${name}.coordinator requires role or tag`);
      else {
        const matched = Object.values(seats).filter(seat => (!selector.role || seat.role === selector.role) && (!selector.tag || seat.tags.includes(selector.tag as string)));
        if (matched.length !== 1) bad('coordinator', `spaces.${name}.coordinator selector must match exactly one seat`);
        else value.coordinator = matched[0]!.id;
      }
    }
    if (typeof value.coordinator !== 'string' || !Object.hasOwn(seats, value.coordinator)) { bad('coordinator', `spaces.${name}.coordinator is not a seat`); continue; }
    if (value.description !== undefined && typeof value.description !== 'string') bad('description', `spaces.${name}.description must be a string`);
    if (value.seats !== undefined && (!Array.isArray(value.seats) || !value.seats.every(x => typeof x === 'string'))) { bad('seats', `spaces.${name}.seats must be an array of seat ids`); continue; }
    const members = [value.coordinator, ...((value.seats ?? []) as string[]).filter(x => x !== value.coordinator)];
    for (const id of members) { if (!Object.hasOwn(seats,id)) bad('seats', `space ${name} references unknown seat ${id}`); else if (placed.has(id)) bad('seats', `seat ${id} is in two spaces: ${placed.get(id)} and ${name}`); else placed.set(id, name); }
    let lead: SpaceLeadDecl | undefined;
    if (value.lead !== undefined) { const parsed = parseSpaceLead(value.lead, `spaces.${name}`); if (parsed.error) bad('lead', parsed.error); else lead = parsed.lead; }
    spaces[name] = { coordinator: value.coordinator, seats: members, ...(typeof value.description === 'string' ? { description: value.description } : {}), ...(lead ? { lead } : {}) };
  }
  let hq: WorkspaceConfig['hq'];
  if (record(raw.hq)) {
    const value = raw.hq; scope = value;
    keys(value, ['coordinator', 'authorityLocation'], 'hq');
    const selector = value.coordinator;
    if (selector === undefined) { /* An empty HQ section remains reserved and does not designate anyone. */ }
    else if (!record(selector)) bad('coordinator', 'hq.coordinator requires a role or tag selector');
    else {
      keys(selector, ['role', 'tag'], 'hq.coordinator');
      if ((selector.role !== undefined && (typeof selector.role !== 'string' || !selector.role.trim())) ||
          (selector.tag !== undefined && (typeof selector.tag !== 'string' || !selector.tag.trim())) || (!selector.role && !selector.tag))
        bad('coordinator', 'hq.coordinator requires a role or tag selector');
      else {
        const matches = Object.values(seats).filter(seat => (!selector.role || seat.role === selector.role) && (!selector.tag || seat.tags.includes(selector.tag as string)));
        if (matches.length !== 1) bad('coordinator', 'hq.coordinator selector must match exactly one seat');
        else if (!placed.has(matches[0]!.id)) bad('coordinator', 'hq.coordinator seat must belong to a space');
        else if (matches[0]!.host !== 'local') bad('coordinator', 'hq.coordinator must be on the local server');
        else hq = { coordinator: matches[0]!.id };
      }
    }
    if (value.authorityLocation !== undefined && (typeof value.authorityLocation !== 'string' || !value.authorityLocation.trim() || value.authorityLocation.includes('\0'))) bad('authorityLocation', 'hq.authorityLocation must be a nonempty string');
    else if (hq && typeof value.authorityLocation === 'string') hq = { ...hq, authorityLocation: value.authorityLocation };
  }
  // SPACE-ADVISOR — an advisor serves exactly one space coordinator (its ladder parent).
  const coordinatorIds = new Set(Object.values(spaces).map((sp) => sp.coordinator));
  for (const seat of Object.values(seats)) {
    if (seat.role === 'advisor' && !seat.parent) { scope = seat as unknown as Row; bad('parent', `seats.${seat.id}.parent is required for role advisor`); }
    else if (seat.parent && !coordinatorIds.has(seat.parent)) { scope = seat as unknown as Row; bad('parent', `seats.${seat.id}.parent must name a space coordinator`); }
  }
  for (const id of Object.keys(seats)) if (!placed.has(id)) warnings.push(`warning: seat ${id} is defined but not placed in any space`);
  return { ...(errors.length ? {} : { config: { version: 1 as const, root, hosts, seats, spaces, ...(hq ? { hq } : {}) } }), errors, warnings };
}

/** Project overrides user; never merge or accept an ambiguous pair. */
export function findWorkspaceFile(cwd: string, home: string): string | undefined {
  for (const dir of [join(cwd, '.elanous'), join(home, '.elanous')]) {
    const paths = ['federation.yaml', 'federation.json', 'workspace.yaml', 'workspace.json'].map(name => join(dir, name)).filter(existsSync);
    if (paths.length > 1) throw new Error(`multiple workspace declarations exist in ${dir} — keep one`);
    if (paths.length) return paths[0];
  }
  return undefined;
}
export function readWorkspaceFile(cwd: string, home: string) {
  const path = findWorkspaceFile(cwd, home);
  if (!path) return { path: undefined, text: '', errors: [], warnings: [], config: { version: 1 as const, root: cwd, hosts: {}, seats: {}, spaces: {} }, defaultSpace: basename(cwd) };
  const text = readFileSync(path, 'utf8');
  return { path, text, ...parseWorkspaceConfig(text, path, home) };
}
