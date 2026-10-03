// PS1 — 프리셋 → 내 페르소나. 실제 persona-presets/ 여덟 개 전부가 런타임 로더를 통과하고, CLI 가 만든 파일을 레지스트리가 싣는다.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { parsePersonaYaml } from './loader.js';
import { PersonaRegistry } from './registry.js';
import { choosePersonaId, clonePreset, editPersona, findPreset, loadPresetIndex, loadPresets, presetToProfileYaml } from './presets.js';
import { registerPersonaCommands } from '../cli/persona-cli.js';

const dirs: string[] = [];
const envBefore = process.env.ELANOUS_PERSONAS_DIR;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (envBefore === undefined) delete process.env.ELANOUS_PERSONAS_DIR; else process.env.ELANOUS_PERSONAS_DIR = envBefore;
});

describe('PS1 persona presets → my persona', () => {
  const presets = loadPresets();
  const { common } = loadPresetIndex();

  test('reads every preset in the index order', () => {
    expect(presets.map((p) => p.personaId)).toEqual(loadPresetIndex().order);
    expect(presets.length).toBeGreaterThanOrEqual(6);
  });

  test('every preset becomes a profile the runtime loader accepts (and keeps the shared ask-first rules)', () => {
    for (const preset of presets) {
      const yaml = presetToProfileYaml(preset, common, { personaId: preset.personaId });
      const parsed = parsePersonaYaml(yaml, `${preset.personaId}.yaml`);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.profile.displayName).toBe(preset.displayName);
      expect(parsed.profile.systemPrompt).toContain(preset.role);
      for (const rule of common.always_ask ?? []) expect(parsed.profile.systemPrompt).toContain(rule);
      expect(yaml).not.toContain('캐릭터');
    }
  });

  test('find by id, name or role; ids from latin names, preset id for others, never reusing one', () => {
    expect(findPreset(presets, 'mira')?.personaId).toBe('mira');
    expect(findPreset(presets, '하나')?.personaId).toBe('mira');
    expect(findPreset(presets, '마케터')?.personaId).toBe('mira');
    expect(findPreset(presets, 'nope')).toBeUndefined();
    const mira = findPreset(presets, 'mira')!;
    expect(choosePersonaId(mira, 'Hana Kim', new Set())).toBe('hana-kim');
    expect(choosePersonaId(mira, '하나', new Set())).toBe('mira');
    expect(choosePersonaId(mira, undefined, new Set(['mira', 'mira-2']))).toBe('mira-3');
  });

  test('edit validates schema, rejects missing and duplicate names, and preserves provenance on atomic replacement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-edit-')); dirs.push(dir);
    const original = presetToProfileYaml(presets[0]!, common, { personaId: 'trial', name: 'Trial' });
    const path = join(dir, 'trial.yaml');
    writeFileSync(path, original);
    expect(() => editPersona('absent', { description: 'x' }, { dir })).toThrow('persona not found');
    expect(() => editPersona('Trial', { mysterious: 'x' }, { dir })).toThrow('unknown persona schema key');
    expect(() => editPersona('Trial', { brand: 'invalid' }, { dir })).toThrow('invalid persona');
    expect(readFileSync(path, 'utf8')).toBe(original);
    const clone = clonePreset(presets[0]!, 'Another', { dir });
    expect(() => editPersona('Trial', { displayName: 'Another · ' + presets[0]!.role }, { dir })).toThrow('already exists');
    const updated = editPersona('Trial', { description: 'Edited description' }, { dir });
    expect(updated.personaId).toBe('trial');
    expect(parsePersonaYaml(readFileSync(path, 'utf8'), path).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('preset:');
    expect(readFileSync(path, 'utf8')).toContain('Edited description');
    expect(existsSync(clone.path)).toBe(true);
    expect(readdirSync(dir).every((file) => file.endsWith('.yaml'))).toBe(true);
  });

  test('dry-run edit and clone validate without creating or changing files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'persona-dry-')); dirs.push(dir);
    const path = join(dir, 'existing.yaml');
    const original = presetToProfileYaml(presets[0]!, common, { personaId: 'existing', name: 'Existing' });
    writeFileSync(path, original);
    const edit = editPersona('existing', { description: 'Preview' }, { dir, dryRun: true });
    expect(edit.yaml).toContain('Preview');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(() => editPersona('existing', { models: { primary: 123 } }, { dir, dryRun: true })).toThrow('invalid persona');
    const clone = clonePreset('mira', 'Preview Clone', { dir, dryRun: true });
    expect(clone.dryRun).toBe(true);
    expect(existsSync(clone.path)).toBe(false);
    expect(() => clonePreset('mira', 'Existing · ' + presets[0]!.role, { dir })).toThrow('already exists');
    expect(() => clonePreset('missing-preset', 'Unique', { dir })).toThrow('preset not found');
    const absent = join(dir, 'new-store');
    expect(clonePreset('mira', 'Unused Persona', { dir: absent, dryRun: true }).dryRun).toBe(true);
    expect(existsSync(absent)).toBe(false);
    expect(readdirSync(dir)).toEqual(['existing.yaml']);
  });

  test('CLI: add writes one file the persona registry loads; show reads it back; a second add gets a new id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps1-'));
    dirs.push(dir);
    process.env.ELANOUS_PERSONAS_DIR = dir;
    const lines: string[] = [];
    const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    try {
      const run = async (...args: string[]) => { const program = new Command().exitOverride(); registerPersonaCommands(program); await program.parseAsync(['node', 'elanous', 'persona', ...args]); };
      await run('add', 'mira', '--name', '하나', '--title', 'CMO');
      await run('add', '마케터');
      await run('show', '하나');
      await run('list');
    } finally { log.mockRestore(); }
    const registry = new PersonaRegistry();
    const loaded = await registry.loadDir(dir);
    expect([...loaded.profiles.keys()].sort()).toEqual(['mira', 'mira-2']);
    expect(loaded.profiles.get('mira')?.displayName).toBe('하나 · 마케터');
    const screen = lines.join('\n');
    expect(screen).toContain('만들었습니다 — 하나 · 마케터 (id mira · 프리셋 mira)');
    expect(screen).toContain('id mira-2');
    expect(screen).toContain('하나 · 마케터 (CMO)');
    expect(screen).toContain('내 페르소나:');
    expect(readFileSync(join(dir, 'mira.yaml'), 'utf8')).toContain('title: CMO');
  });
});
