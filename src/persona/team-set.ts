import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { resolveRepositoryPersonaDir, resolveStatePersonaDir } from './global-registry.js';
import { parsePersonaYaml } from './loader.js';

interface Member { persona: string; title: string; checklistTemplate: string; rules: string[] }
interface Handoff { from: string; to: string; when: string }
export interface TeamSet { 'team-set': string; members: Member[]; handoffs: Handoff[] }
const idPattern = /^[a-z0-9_][a-z0-9_-]*$/i;
const namePattern = /^[\p{L}\p{N}_][\p{L}\p{N} _-]*$/u;
const mapping = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function readDefinition(text: string): TeamSet {
  const raw: unknown = parse(text);
  if (!mapping(raw) || !nonempty(raw['team-set']) || !namePattern.test(raw['team-set'])) {
    throw new Error('team-set must be a non-empty filesystem-safe name');
  }
  if (!Array.isArray(raw.members) || raw.members.length === 0) throw new Error('members must be a non-empty list');
  const members: Member[] = raw.members.map((item: unknown) => {
    if (!mapping(item) || !nonempty(item.persona) || !idPattern.test(item.persona)
      || !nonempty(item.title) || !nonempty(item.checklistTemplate)
      || !(nonempty(item.rules) || (Array.isArray(item.rules) && item.rules.length > 0 && item.rules.every(nonempty)))) {
      throw new Error('each member requires persona (safe id), title, checklistTemplate and rules');
    }
    return { persona: item.persona, title: item.title, checklistTemplate: item.checklistTemplate,
      rules: typeof item.rules === 'string' ? [item.rules] : item.rules as string[] };
  });
  const ids = new Set(members.map((member) => member.persona));
  if (ids.size !== members.length) throw new Error('duplicate team-set member persona');
  if (!Array.isArray(raw.handoffs)) throw new Error('handoffs must be a list');
  const handoffs: Handoff[] = raw.handoffs.map((item: unknown) => {
    if (!mapping(item) || !nonempty(item.from) || !nonempty(item.to) || !nonempty(item.when)) {
      throw new Error('each handoff requires from, to and when');
    }
    if (!ids.has(item.from) || !ids.has(item.to)) throw new Error(`handoff references missing member: ${item.from} -> ${item.to}`);
    return { from: item.from, to: item.to, when: item.when };
  });
  const edges = new Map(members.map((member) => [member.persona, [] as string[]]));
  for (const edge of handoffs) edges.get(edge.from)!.push(edge.to);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`handoff cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of edges.get(id)!) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return { 'team-set': raw['team-set'], members, handoffs };
}

function store(dir: string): string { return join(dir, '_team-sets'); }
function record(dir: string, name: string): string { return join(store(dir), `${name}.yaml`); }
function memberPath(dir: string, id: string): string { return join(dir, `${id}.yaml`); }

function recordedOwners(dir: string): Map<string, string> {
  const owners = new Map<string, string>();
  if (!existsSync(store(dir))) return owners;
  for (const file of readdirSync(store(dir)).filter((name) => name.endsWith('.yaml'))) {
    const data: unknown = parse(readFileSync(join(store(dir), file), 'utf8'));
    if (!mapping(data) || !mapping(data.definition)) throw new Error(`invalid installed team-set: ${file}`);
    const definition = readDefinition(stringify(data.definition));
    const name = file.slice(0, -'.yaml'.length);
    if (definition['team-set'] !== name) throw new Error(`invalid installed team-set: ${file}`);
    for (const member of definition.members) {
      const previous = owners.get(member.persona);
      if (previous !== undefined) throw new Error(`persona has multiple team-set owners: ${member.persona} (${previous}, ${name})`);
      owners.set(member.persona, name);
    }
  }
  return owners;
}

function occupiedIds(dir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  for (const file of readdirSync(dir).filter((name) => /\.ya?ml$/.test(name))) {
    ids.add(file.replace(/\.ya?ml$/, ''));
    const path = join(dir, file);
    const parsed = parsePersonaYaml(readFileSync(path, 'utf8'), path);
    if (parsed.ok) ids.add(parsed.profile.personaId);
  }
  return ids;
}

export function addTeamSet(file: string, dir = resolveStatePersonaDir()): TeamSet {
  const definition = readDefinition(readFileSync(file, 'utf8'));
  if (existsSync(record(dir, definition['team-set']))) throw new Error(`team-set already exists: ${definition['team-set']}`);
  const occupied = new Set([...occupiedIds(dir), ...occupiedIds(resolveRepositoryPersonaDir()), ...recordedOwners(dir).keys()]);
  for (const member of definition.members) {
    if (occupied.has(member.persona) || existsSync(memberPath(dir, member.persona))) throw new Error(`persona already exists: ${member.persona}`);
  }
  const files = definition.members.map((member) => {
    const yaml = stringify({ personaId: member.persona, displayName: `${member.persona} · ${member.title}`,
      systemPrompt: [`직함: ${member.title}`, `체크리스트 템플릿: ${member.checklistTemplate}`, '규칙:', ...member.rules.map((rule) => `- ${rule}`)].join('\n') }, { lineWidth: 0 });
    const check = parsePersonaYaml(yaml, memberPath(dir, member.persona));
    if (!check.ok) throw new Error(check.error.message);
    return { persona: member.persona, yaml };
  });
  mkdirSync(dir, { recursive: true });
  mkdirSync(store(dir), { recursive: true });
  const created: string[] = [];
  try {
    for (const entry of files) {
      const path = memberPath(dir, entry.persona);
      writeFileSync(path, entry.yaml, { flag: 'wx' });
      created.push(path);
    }
    writeFileSync(record(dir, definition['team-set']), stringify({ definition, files }, { lineWidth: 0 }), { flag: 'wx' });
  } catch (error) {
    for (const path of created) unlinkSync(path);
    throw error;
  }
  return definition;
}

export function listTeamSets(dir = resolveStatePersonaDir()): TeamSet[] {
  if (!existsSync(store(dir))) return [];
  return readdirSync(store(dir)).filter((name) => name.endsWith('.yaml')).sort().map((name) => {
    const data: unknown = parse(readFileSync(join(store(dir), name), 'utf8'));
    if (!mapping(data) || !mapping(data.definition)) throw new Error(`invalid installed team-set: ${name}`);
    return readDefinition(stringify(data.definition));
  });
}

export function removeTeamSet(name: string, dir = resolveStatePersonaDir()): void {
  if (!namePattern.test(name)) throw new Error('invalid team-set name');
  const path = record(dir, name);
  if (!existsSync(path)) throw new Error(`team-set not found: ${name}`);
  const data: unknown = parse(readFileSync(path, 'utf8'));
  if (!mapping(data) || !mapping(data.definition) || !Array.isArray(data.files)) throw new Error(`invalid installed team-set: ${name}`);
  const definition = readDefinition(stringify(data.definition));
  if (definition['team-set'] !== name || data.files.length !== definition.members.length) throw new Error(`invalid installed team-set: ${name}`);
  const owners = recordedOwners(dir);
  const filesToRemove: string[] = [];
  for (let index = 0; index < definition.members.length; index++) {
    const file: unknown = data.files[index];
    const id = definition.members[index]!.persona;
    if (!mapping(file) || file.persona !== id || typeof file.yaml !== 'string') {
      throw new Error(`invalid installed team-set: ${name}`);
    }
    if (owners.get(id) !== name) throw new Error(`persona is not owned by team-set ${name}: ${id}`);
    const personaPath = memberPath(dir, id);
    if (existsSync(personaPath) && readFileSync(personaPath, 'utf8') === file.yaml) {
      filesToRemove.push(personaPath);
    }
  }
  for (const personaPath of filesToRemove) unlinkSync(personaPath);
  unlinkSync(path);
  if (readdirSync(store(dir)).length === 0) rmdirSync(store(dir));
}
