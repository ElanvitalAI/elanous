// PS1 — 페르소나 프리셋(MK 문면 · persona-presets/<id>.yaml)을 «내 페르소나»로 만든다.
// 용어: «페르소나»(대표 10-01) — 사용자가 고르고 꾸미는 AI 동료. ⚠️ `SessionSurfaceId`(이름만 Surface 인 캐릭터 축) ·
// `modelTier.profile`(모델 등급 프로필 축)와는 «다른 것»이다 — 여기서 만드는 것은 기존 페르소나 저장소(`resolveStatePersonaDir()`,
// Discord·PWA 가 이미 읽는 `<id>.yaml`)의 한 파일이다. 프리셋 원본은 고치지 않는다.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { resolveRepositoryPersonaDir, resolveStatePersonaDir } from './global-registry.js';
import { parsePersonaYaml } from './loader.js';

export interface PersonaPreset {
  personaId: string;
  displayName: string;
  names: string[];
  role: string;
  title?: string | null;
  oneLine: string;
  voice: { rule: string; examples: string[] };
  tasks: Array<{ when: string; what: string }>;
  tools: Array<{ name: string; from: string; optional?: boolean }>;
  firstQuestions: string[];
  askBefore?: string[];
  doesNot: string[];
  forWhom: string;
}

export interface PresetCommon { loop_start?: string; always_ask?: string[]; memory?: string; title?: string }

/** `persona-presets/` shipped with this package (src/persona → ../../persona-presets). */
export function presetsDir(): string {
  return join(import.meta.dir, '..', '..', 'persona-presets');
}

export function loadPresetIndex(dir = presetsDir()): { order: string[]; common: PresetCommon } {
  const index = parse(readFileSync(join(dir, '_index.yaml'), 'utf8')) as { presets?: string[]; common?: PresetCommon };
  return { order: index.presets ?? [], common: index.common ?? {} };
}

/** Presets in the index order; files not in the index come last (sorted). */
export function loadPresets(dir = presetsDir()): PersonaPreset[] {
  if (!existsSync(dir)) return [];
  const { order } = loadPresetIndex(dir);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).map((f) => f.slice(0, -5));
  const ids = [...order.filter((id) => files.includes(id)), ...files.filter((id) => !order.includes(id)).sort()];
  return ids.map((id) => parse(readFileSync(join(dir, `${id}.yaml`), 'utf8')) as PersonaPreset);
}

/** Find by id or by any of its names (case-insensitive). */
export function findPreset(presets: readonly PersonaPreset[], query: string): PersonaPreset | undefined {
  const q = query.trim().toLowerCase();
  return presets.find((p) => p.personaId === q) ?? presets.find((p) => p.names.some((n) => n.toLowerCase() === q) || p.role === query.trim());
}

/** The persona's working instructions, assembled from the preset (and the shared rules). */
export function presetSystemPrompt(p: PersonaPreset, common: PresetCommon, name: string): string {
  const lines = [
    `너는 «${name}», ${p.role}다. ${p.oneLine}`,
    '',
    `말투: ${p.voice.rule}`,
    ...p.voice.examples.map((e) => `  예) ${e}`),
    '',
    '맡은 일:',
    ...p.tasks.map((t) => `- ${t.when}: ${t.what}`),
    '',
    `처음 만나면 묻는다: ${p.firstQuestions.join(' / ')}`,
    `먼저 확인을 받는다: ${[...(p.askBefore ?? []), ...(common.always_ask ?? [])].join(' · ')}`,
    '하지 않는다:',
    ...p.doesNot.map((d) => `- ${d}`),
  ];
  if (common.loop_start) lines.push('', `시작 방식: ${common.loop_start}`);
  return lines.join('\n');
}

/** ASCII id for the profile file: from --name when it is latin, else the preset id; `-2`, `-3`… when taken. */
export function choosePersonaId(preset: PersonaPreset, name: string | undefined, taken: ReadonlySet<string>): string {
  const fromName = name?.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = fromName && /^[a-z0-9]/.test(fromName) ? fromName.slice(0, 32) : preset.personaId;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** The profile YAML written to the persona store (the existing loader reads it; `preset` records where it came from). */
export function presetToProfileYaml(p: PersonaPreset, common: PresetCommon, opts: { personaId: string; name?: string; title?: string }): string {
  const name = opts.name?.trim() || p.names[0] || p.displayName;
  const title = opts.title ?? p.title ?? undefined;
  const profile = {
    personaId: opts.personaId,
    displayName: opts.name?.trim() ? `${opts.name.trim()} · ${p.role}` : p.displayName,
    description: p.oneLine,
    systemPrompt: presetSystemPrompt(p, common, name),
    todo: `${opts.personaId}.todo.jsonl`,
    preset: { id: p.personaId, role: p.role, ...(title ? { title } : {}), tools: p.tools.map((t) => t.name), firstQuestions: p.firstQuestions },
  };
  return `# 프리셋 «${p.personaId}» 에서 만든 페르소나 — elanous persona add (원본: persona-presets/${p.personaId}.yaml)\n${stringify(profile, { lineWidth: 0 })}`;
}

export interface PersonaWriteOptions { dir?: string; dryRun?: boolean }
export interface PersonaWriteResult { personaId: string; displayName: string; path: string; yaml: string; dryRun: boolean }

// Only fields in the runtime persona schema may be edited; provenance (`preset`) is retained, not editable.
const PROFILE_KEYS = new Set([
  'personaId', 'displayName', 'description', 'systemPrompt', 'actionHosts', 'offsiteNavigation',
  'brand', 'models', 'mentionPatterns', 'avatarUrl', 'brandColor', 'browserPort', 'residence', 'capabilities', 'todo',
]);
const NESTED_KEYS: Record<string, readonly string[]> = {
  models: ['primary', 'fallback', 'providers'], 'models.providers': ['ollama', 'openai'],
  'models.providers.ollama': ['model'], 'models.providers.openai': ['model'],
  capabilities: ['core', 'extended', 'evidence'],
};

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class UnknownPersonaSchemaKeyError extends Error {
  constructor(key: string) {
    super(`unknown persona schema key: ${key}`);
    this.name = 'UnknownPersonaSchemaKeyError';
  }
}

function assertSchemaKeys(value: Record<string, unknown>, parent = ''): void {
  const allowed: ReadonlySet<string> = parent ? new Set(NESTED_KEYS[parent] ?? []) : PROFILE_KEYS;
  for (const [key, child] of Object.entries(value)) {
    if (!allowed.has(key)) {
      throw new UnknownPersonaSchemaKeyError(`${parent ? `${parent}.` : ''}${key}`);
    }
    const path = parent ? `${parent}.${key}` : key;
    if (NESTED_KEYS[path] && mapping(child)) assertSchemaKeys(child, path);
  }
}

function storedProfiles(dir: string): Array<{ path: string; data: Record<string, unknown> }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.yaml') && !file.startsWith('_')).map((file) => {
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');
    const checked = parsePersonaYaml(text, path);
    if (!checked.ok) throw new Error(`invalid stored persona ${path}: ${checked.error.message}`);
    const data: unknown = parse(text);
    if (!mapping(data)) throw new Error(`invalid stored persona ${path}`);
    return { path, data };
  });
}

function normalizedName(name: string): string { return name.trim().toLocaleLowerCase(); }
function assertUnusedName(name: string, dir: string, except?: string): void {
  if (!name.trim()) throw new Error('persona name is required');
  const all = [...storedProfiles(dir), ...(dir === resolveRepositoryPersonaDir() ? [] : storedProfiles(resolveRepositoryPersonaDir()))];
  if (all.some(({ path, data }) => path !== except &&
    (normalizedName(String(data.displayName)) === normalizedName(name) || normalizedName(String(data.personaId)) === normalizedName(name)))) {
    throw new Error(`persona name already exists: ${name}`);
  }
}

function checkedYaml(data: Record<string, unknown>, path: string): { yaml: string; personaId: string; displayName: string } {
  const yaml = stringify(data, { lineWidth: 0 });
  const check = parsePersonaYaml(yaml, path);
  if (!check.ok) throw new Error(`invalid persona: ${check.error.message}`);
  return { yaml, personaId: check.profile.personaId, displayName: check.profile.displayName };
}

/** Write beside the destination, then atomically replace it (or install a new file without overwriting). */
function atomicPersonaWrite(path: string, yaml: string, create: boolean): void {
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temp, yaml, { flag: 'wx' });
    if (create) linkSync(temp, path); // atomic, exclusive: concurrent creations cannot replace a persona
    else renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

/** Edit a stored persona by exact id or display name; dry-run validates but never creates a directory or file. */
export function editPersona(name: string, edits: Record<string, unknown>, opts: PersonaWriteOptions = {}): PersonaWriteResult {
  const dir = opts.dir ?? resolveStatePersonaDir();
  if (!name.trim()) throw new Error('persona name is required');
  if (!mapping(edits)) throw new Error('persona edits must be a mapping');
  assertSchemaKeys(edits);
  const matches = storedProfiles(dir).filter(({ data }) =>
    normalizedName(String(data.personaId)) === normalizedName(name) || normalizedName(String(data.displayName)) === normalizedName(name));
  if (matches.length !== 1) throw new Error(matches.length ? `ambiguous persona name: ${name}` : `persona not found: ${name}`);
  const { path, data } = matches[0]!;
  if (edits.personaId !== undefined && edits.personaId !== data.personaId) throw new Error('personaId cannot be changed');
  const updated = { ...data, ...edits };
  const result = checkedYaml(updated, path);
  assertUnusedName(result.displayName, dir, path);
  if (!opts.dryRun) atomicPersonaWrite(path, result.yaml, false);
  return { ...result, path, dryRun: Boolean(opts.dryRun) };
}

/** Clone a shipped preset into the state persona store under a new, unique display name. */
export function clonePreset(preset: PersonaPreset | string, name: string, opts: PersonaWriteOptions = {}): PersonaWriteResult {
  const source = typeof preset === 'string' ? findPreset(loadPresets(), preset) : preset;
  if (!source) throw new Error(`preset not found: ${preset}`);
  const dir = opts.dir ?? resolveStatePersonaDir();
  assertUnusedName(name, dir);
  const taken = new Set([...storedProfiles(dir), ...storedProfiles(resolveRepositoryPersonaDir())]
    .map(({ data }) => String(data.personaId)));
  const personaId = choosePersonaId(source, name, taken);
  const path = join(dir, `${personaId}.yaml`);
  if (existsSync(path)) throw new Error(`persona already exists: ${personaId}`);
  const generated = presetToProfileYaml(source, loadPresetIndex().common, { personaId, name });
  const raw: unknown = parse(generated);
  if (!mapping(raw)) throw new Error('invalid generated persona');
  const result = checkedYaml(raw, path);
  assertUnusedName(result.displayName, dir);
  if (!opts.dryRun) {
    mkdirSync(dir, { recursive: true });
    atomicPersonaWrite(path, generated, true);
  }
  return { ...result, yaml: generated, path, dryRun: Boolean(opts.dryRun) };
}

/** Short block for `persona show` and `persona list`. */
export function describePreset(p: PersonaPreset): string[] {
  return [
    `${p.displayName} — ${p.role}${p.title ? ` (${p.title})` : ''}`,
    `  ${p.oneLine}`,
    `  누구에게: ${p.forWhom}`,
    `  맡는 일: ${p.tasks.map((t) => `${t.when} ${t.what}`).join(' / ')}`,
    `  쓰는 도구: ${p.tools.map((t) => (t.optional ? `${t.name}(선택 · 따로 설치)` : t.name)).join(', ')}`,
    `  처음 묻는 것: ${p.firstQuestions.join(' / ')}`,
    `  하지 않는 것: ${p.doesNot.join(' / ')}`,
  ];
}
