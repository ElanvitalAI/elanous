// PS1 — 프리셋 → 내 페르소나. 실제 persona-presets/ 여덟 개 전부가 런타임 로더를 통과하고, CLI 가 만든 파일을 레지스트리가 싣는다.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { parsePersonaYaml } from './loader.js';
import { PersonaRegistry } from './registry.js';
import { choosePersonaId, findPreset, loadPresetIndex, loadPresets, presetToProfileYaml } from './presets.js';
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
