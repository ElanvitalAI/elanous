// PS1 — 페르소나 프리셋(MK 문면 · persona-presets/<id>.yaml)을 «내 페르소나»로 만든다.
// 용어: «페르소나»(대표 10-01) — 사용자가 고르고 꾸미는 AI 동료. ⚠️ `SessionSurfaceId`(이름만 Surface 인 캐릭터 축) ·
// `modelTier.persona`(모델 등급 축)와는 «다른 것»이다 — 여기서 만드는 것은 기존 페르소나 저장소(`resolveStatePersonaDir()`,
// Discord·PWA 가 이미 읽는 `<id>.yaml`)의 한 파일이다. 프리셋 원본은 고치지 않는다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

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
    preset: { id: p.personaId, role: p.role, ...(title ? { title } : {}), tools: p.tools.map((t) => t.name), firstQuestions: p.firstQuestions },
  };
  return `# 프리셋 «${p.personaId}» 에서 만든 페르소나 — elanous persona add (원본: persona-presets/${p.personaId}.yaml)\n${stringify(profile, { lineWidth: 0 })}`;
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
