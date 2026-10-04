import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { parsePersonaYaml } from './loader.js';

export interface TeamMember {
  persona: string;
  title: string;
  checklistTemplate: string[];
}

export interface TeamHandoff {
  from: string;
  to: string;
}

export interface TeamDefinition {
  name: string;
  members: TeamMember[];
  handoffs: TeamHandoff[];
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, required: readonly string[], label: string): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key)) throw new Error(`${label}.${key} is not a team schema field`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

/** Read-only validation: resolve persona paths relative to the team file, not the caller's cwd. */
export function validateTeamFile(file: string): TeamDefinition {
  const document = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`invalid team YAML: ${document.errors[0]!.message}`);
  const raw: unknown = document.toJS();
  if (!mapping(raw)) throw new Error('team must be a YAML mapping');
  fields(raw, ['name', 'members', 'handoffs'], 'team');
  const name = text(raw.name, 'team.name');
  if (!Array.isArray(raw.members) || raw.members.length === 0) {
    throw new Error('team.members must be a non-empty list');
  }
  const titles = new Set<string>();
  const personaIds = new Set<string>();
  const members: TeamMember[] = raw.members.map((item: unknown, index: number) => {
    const label = `team.members[${index}]`;
    if (!mapping(item)) throw new Error(`${label} must be a mapping`);
    fields(item, ['persona', 'title', 'checklistTemplate'], label);
    const persona = text(item.persona, `${label}.persona`);
    const title = text(item.title, `${label}.title`);
    if (titles.has(title)) throw new Error(`duplicate team title: ${title}`);
    titles.add(title);
    if (!Array.isArray(item.checklistTemplate) || item.checklistTemplate.length === 0) {
      throw new Error(`${label}.checklistTemplate must be a non-empty list of strings`);
    }
    const checklistTemplate = item.checklistTemplate.map((entry: unknown) => text(entry, `${label}.checklistTemplate item`));
    const personaPath = resolve(dirname(file), persona);
    let yaml: string;
    try {
      yaml = readFileSync(personaPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`persona not found: ${persona} (${title})`);
      throw error;
    }
    const parsed = parsePersonaYaml(yaml, personaPath);
    if (!parsed.ok) throw new Error(`invalid persona ${persona}: ${parsed.error.message}`);
    if (parsed.profile.seat !== title) throw new Error(`persona seat mismatch: ${persona} requires seat ${title}`);
    if (personaIds.has(parsed.profile.personaId)) throw new Error(`duplicate personaId: ${parsed.profile.personaId}`);
    personaIds.add(parsed.profile.personaId);
    return { persona, title, checklistTemplate };
  });
  if (!Array.isArray(raw.handoffs)) throw new Error('team.handoffs must be a list');
  const handoffs: TeamHandoff[] = raw.handoffs.map((item: unknown, index: number) => {
    const label = `team.handoffs[${index}]`;
    if (!mapping(item)) throw new Error(`${label} must be a mapping`);
    fields(item, ['from', 'to'], label);
    const from = text(item.from, `${label}.from`);
    const to = text(item.to, `${label}.to`);
    if (!titles.has(from) || !titles.has(to)) throw new Error(`handoff references missing title: ${from} -> ${to}`);
    return { from, to };
  });
  const edges = new Map([...titles].map((title) => [title, [] as string[]]));
  for (const { from, to } of handoffs) edges.get(from)!.push(to);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (title: string): void => {
    if (visiting.has(title)) throw new Error(`handoff cycle at ${title}`);
    if (visited.has(title)) return;
    visiting.add(title);
    for (const next of edges.get(title)!) visit(next);
    visiting.delete(title);
    visited.add(title);
  };
  for (const title of titles) visit(title);
  return { name, members, handoffs };
}
