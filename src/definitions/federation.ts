// Federation bundle v1: a portable, offline declaration; it does not grant authority or start services.
// This is distinct from the existing workspace federation.yaml (which has no apiVersion).
export const FEDERATION_API_VERSION = 'elanous/federation-bundle@1';
type Row = Record<string, unknown>;
export interface FederationIssue { path: string; message: string }
const row = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const edgeTypes = ['supervises', 'delegates', 'escalates', 'hands-off', 'subscribes'];

/** Pure relationship lint. Paths are relative to the YAML root for source-line mapping. */
export function lintFederation(input: unknown): FederationIssue[] {
  const errors: FederationIssue[] = [];
  const bad = (path: string, message: string) => errors.push({ path, message });
  const keys = (v: Row, allowed: string[], path: string) => Object.keys(v).forEach(k => { if (!allowed.includes(k)) bad(path ? `${path}.${k}` : k, `unknown key ${k}`); });
  const strings = (v: unknown, path: string): string[] => {
    if (!Array.isArray(v)) { bad(path, 'must be a list'); return []; }
    const out: string[] = []; const seen = new Set<string>();
    v.forEach((x, i) => { if (!nonempty(x)) bad(`${path}.${i}`, 'must be a nonempty string'); else if (seen.has(x)) bad(`${path}.${i}`, `duplicate ${x}`); else { seen.add(x); out.push(x); } });
    return out;
  };
  if (!row(input)) return [{ path: '', message: 'bundle must be a mapping' }];
  keys(input, ['apiVersion', 'members', 'bindings', 'edges', 'routes', 'rooms', 'policies', 'budget', 'rails'], '');
  if (input.apiVersion !== FEDERATION_API_VERSION) bad('apiVersion', 'unsupported federation bundle version');
  const members = new Map<string, { provides: string[]; requires: string[] }>();
  if (!row(input.members) || Object.keys(input.members).length === 0) bad('members', 'members must be a nonempty mapping');
  else for (const [id, value] of Object.entries(input.members)) {
    const p = `members.${id}`;
    if (!nonempty(id) || !row(value)) { bad(p, 'member must be a mapping'); continue; }
    keys(value, ['package', 'plane', 'manifest'], p);
    if (!nonempty(value.package) || !/^.+@[^@\s]+$/.test(value.package)) bad(`${p}.package`, 'package must include @version');
    if (!nonempty(value.plane)) bad(`${p}.plane`, 'plane is required');
    let provides: string[] = [], requires: string[] = [];
    if (!row(value.manifest)) bad(`${p}.manifest`, 'manifest is required');
    else {
      keys(value.manifest, ['provides', 'requires'], `${p}.manifest`);
      for (const side of ['provides', 'requires'] as const) {
        const part = value.manifest[side];
        if (!row(part)) { bad(`${p}.manifest.${side}`, `${side}.duties is required`); continue; }
        keys(part, ['duties'], `${p}.manifest.${side}`);
        const values = strings(part.duties, `${p}.manifest.${side}.duties`);
        if (side === 'provides') provides = values; else requires = values;
      }
    }
    members.set(id, { provides, requires });
  }
  const bindings = new Map<string, string>();
  if (!row(input.bindings)) bad('bindings', 'bindings must be a duty to member mapping');
  else for (const [duty, target] of Object.entries(input.bindings)) {
    const p = `bindings.${duty}`;
    if (!nonempty(duty) || !nonempty(target)) { bad(p, 'binding needs a duty and member'); continue; }
    const member = members.get(target);
    if (!member) bad(p, `unknown member ${target}`);
    else if (!member.provides.includes(duty)) bad(p, `${target} does not provide duty ${duty}`);
    else bindings.set(duty, target);
  }
  for (const [id, member] of members) for (const duty of member.requires) if (!bindings.has(duty)) bad(`members.${id}.manifest.requires.duties`, `unbound duty ${duty}`);
  const edges: { type: string; from: string; to: string }[] = [];
  if (!Array.isArray(input.edges)) bad('edges', 'edges must be a list');
  else input.edges.forEach((v, i) => {
    const p = `edges.${i}`;
    if (!row(v)) { bad(p, 'edge must be a mapping'); return; }
    keys(v, ['type', 'from', 'to'], p);
    if (!nonempty(v.type) || !edgeTypes.includes(v.type)) bad(`${p}.type`, 'unknown edge type');
    if (!nonempty(v.from) || !members.has(v.from)) bad(`${p}.from`, `unknown member ${String(v.from)}`);
    if (!nonempty(v.to) || !members.has(v.to)) bad(`${p}.to`, `unknown member ${String(v.to)}`);
    if (nonempty(v.type) && edgeTypes.includes(v.type) && nonempty(v.from) && members.has(v.from) && nonempty(v.to) && members.has(v.to)) edges.push({ type: v.type, from: v.from, to: v.to });
  });
  // Both kinds must be acyclic: a supervision loop has no root; escalation must terminate.
  for (const type of ['supervises', 'escalates']) {
    const visiting = new Set<string>(), visited = new Set<string>();
    const walk = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const edge of edges) if (edge.type === type && edge.from === id && walk(edge.to)) return true;
      visiting.delete(id); visited.add(id); return false;
    };
    for (const id of members.keys()) if (walk(id)) { bad('edges', `${type} cycle`); break; }
  }
  if (!Array.isArray(input.routes)) bad('routes', 'routes must be a list');
  else input.routes.forEach((v, i) => {
    const p = `routes.${i}`;
    if (!row(v)) { bad(p, 'route must be a mapping'); return; }
    keys(v, ['kind', 'from', 'to'], p);
    if (!['mail', 'raci'].includes(String(v.kind))) bad(`${p}.kind`, 'route kind must be mail or raci');
    for (const k of ['from', 'to'] as const) if (!nonempty(v[k]) || !members.has(v[k] as string)) bad(`${p}.${k}`, `unknown member ${String(v[k])}`);
  });
  // A requiring L0 member needs an explicit escalation edge; all escalations terminate by acyclicity.
  for (const [id] of members) {
    const original = row(input.members) ? input.members[id] : undefined;
    if (row(original) && original.plane === 'L0' && !edges.some(e => e.type === 'escalates' && e.from === id)) bad(`members.${id}.plane`, `L0 member ${id} has no escalation path`);
  }
  for (const k of ['rooms', 'policies', 'budget', 'rails'] as const) if (input[k] !== undefined && !row(input[k])) bad(k, `${k} must be a mapping`);
  return errors;
}
