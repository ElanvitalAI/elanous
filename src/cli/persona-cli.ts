// PS1 — `elanous persona list|add|show`: 프리셋(persona-presets/)을 보고, 골라서 «내 페르소나»를 만들고, 만든 것을 본다.
// 만든 페르소나는 기존 페르소나 저장소(resolveStatePersonaDir · Discord·PWA 가 읽는 곳)의 `<id>.yaml` 한 파일이다.
import type { Command } from 'commander';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../debug/log.js';
import { parsePersonaYaml } from '../persona/loader.js';
import { resolveRepositoryPersonaDir, resolveStatePersonaDir } from '../persona/global-registry.js';
import { choosePersonaId, describePreset, findPreset, loadPresetIndex, loadPresets, presetToProfileYaml } from '../persona/presets.js';

interface StoredPersona { personaId: string; displayName: string; description?: string; preset?: string; title?: string; path: string }

/** Personas the person made (state dir), parsed with the same loader the runtime uses. */
export function readStoredPersonas(dir = resolveStatePersonaDir()): StoredPersona[] {
  if (!existsSync(dir)) return [];
  const out: StoredPersona[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml') && !f.startsWith('_')).sort()) {
    const path = join(dir, file);
    const text = readFileSync(path, 'utf8');
    const parsed = parsePersonaYaml(text, path);
    if (!parsed.ok) continue;
    const origin = (parseYaml(text) as { preset?: { id?: unknown; title?: unknown } } | null)?.preset;
    const preset = typeof origin?.id === 'string' ? origin.id : undefined;
    const title = typeof origin?.title === 'string' ? origin.title : undefined;
    out.push({ personaId: parsed.profile.personaId, displayName: parsed.profile.displayName, ...(parsed.profile.description ? { description: parsed.profile.description } : {}), ...(preset ? { preset } : {}), ...(title ? { title } : {}), path });
  }
  return out.sort((a, b) => a.personaId.localeCompare(b.personaId));
}

function takenIds(stateDir: string): Set<string> {
  const ids = new Set(readStoredPersonas(stateDir).map((p) => p.personaId));
  const repo = resolveRepositoryPersonaDir();
  if (existsSync(repo)) for (const f of readdirSync(repo)) if (f.endsWith('.yaml')) ids.add(f.slice(0, -5));
  if (existsSync(stateDir)) for (const f of readdirSync(stateDir)) if (f.endsWith('.yaml')) ids.add(f.slice(0, -5));
  return ids;
}

export function registerPersonaCommands(program: Command): void {
  const persona = program.command('persona').description('Persona presets — AI coworkers you pick and customise (list · add · show)');

  persona.command('list')
    .description('List the persona presets, then the personas you have made')
    .option('--json', 'JSON output')
    .action((opts: { json?: boolean }) => {
      const presets = loadPresets();
      const mine = readStoredPersonas();
      debug.log('persona.cli', 'list', { presets: presets.length, mine: mine.length });
      if (opts.json) { console.log(JSON.stringify({ presets: presets.map((p) => ({ id: p.personaId, displayName: p.displayName, role: p.role, oneLine: p.oneLine })), mine }, null, 2)); return; }
      if (!presets.length) console.log('페르소나 프리셋을 찾지 못했습니다(persona-presets/ 가 이 설치본에 없습니다).');
      else {
        console.log('프리셋 — 골라서 내 페르소나로 만들기: elanous persona add <프리셋> [--name <이름>]');
        const width = Math.max(...presets.map((p) => p.personaId.length));
        for (const p of presets) console.log(`  ${p.personaId.padEnd(width)}  ${p.displayName} — ${p.role} · ${p.oneLine}`);
      }
      const made = mine.filter((p) => p.preset);
      if (made.length) {
        console.log('\n내 페르소나:');
        for (const p of made) console.log(`  ${p.personaId}  ${p.displayName}${p.title ? ` (${p.title})` : ''}  (프리셋 ${p.preset})`);
      }
    });

  persona.command('add <preset>')
    .description('Make your own persona from a preset (id, name or role) — the preset file is not changed')
    .option('--name <name>', 'What to call it (default: the preset’s first name)')
    .option('--title <title>', 'Optional title, e.g. CMO')
    .option('--json', 'JSON output')
    .action((query: string, opts: { name?: string; title?: string; json?: boolean }) => {
      const presets = loadPresets();
      const preset = findPreset(presets, query);
      if (!preset) {
        console.error(`프리셋 «${query}» 을 찾지 못했습니다. 있는 것: ${presets.map((p) => p.personaId).join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const dir = resolveStatePersonaDir();
      const personaId = choosePersonaId(preset, opts.name, takenIds(dir));
      const yaml = presetToProfileYaml(preset, loadPresetIndex().common, { personaId, ...(opts.name ? { name: opts.name } : {}), ...(opts.title ? { title: opts.title } : {}) });
      const path = join(dir, `${personaId}.yaml`);
      // The runtime loader must accept what we write — check before it lands on disk.
      const check = parsePersonaYaml(yaml, path);
      if (!check.ok) { console.error(`만든 페르소나를 읽을 수 없습니다: ${check.error.message}`); process.exitCode = 1; return; }
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, yaml, { flag: 'wx' });
      debug.log('persona.cli', 'added', { preset: preset.personaId, personaId, named: Boolean(opts.name) });
      if (opts.json) { console.log(JSON.stringify({ personaId, displayName: check.profile.displayName, preset: preset.personaId, path }, null, 2)); return; }
      console.log(`만들었습니다 — ${check.profile.displayName} (id ${personaId} · 프리셋 ${preset.personaId})`);
      console.log(`  처음 묻는 것: ${preset.firstQuestions.join(' / ')}`);
      console.log(`  보기: elanous persona show ${personaId}`);
    });

  persona.command('show <name>')
    .description('Show one of your personas (id or name), or a preset')
    .option('--json', 'JSON output')
    .action((query: string, opts: { json?: boolean }) => {
      const q = query.trim().toLowerCase();
      const mine = readStoredPersonas().find((p) => p.personaId === q || p.displayName.toLowerCase().startsWith(q));
      const presets = loadPresets();
      if (mine) {
        const text = readFileSync(mine.path, 'utf8');
        const parsed = parsePersonaYaml(text, mine.path);
        if (opts.json) { console.log(JSON.stringify({ kind: 'persona', ...mine, systemPrompt: parsed.ok ? parsed.profile.systemPrompt : undefined }, null, 2)); return; }
        console.log(`${mine.displayName}${mine.title ? ` (${mine.title})` : ''}  (id ${mine.personaId}${mine.preset ? ` · 프리셋 ${mine.preset}` : ''})`);
        if (mine.description) console.log(`  ${mine.description}`);
        const preset = mine.preset ? presets.find((p) => p.personaId === mine.preset) : undefined;
        if (preset) for (const line of describePreset(preset).slice(2)) console.log(line);
        console.log(`  파일: ${mine.path}`);
        return;
      }
      const preset = findPreset(presets, query);
      if (!preset) { console.error(`«${query}» 페르소나도 프리셋도 없습니다. 목록: elanous persona list`); process.exitCode = 1; return; }
      if (opts.json) { console.log(JSON.stringify({ kind: 'preset', ...preset }, null, 2)); return; }
      console.log('(프리셋 — 아직 만들지 않았습니다. 만들기: elanous persona add ' + preset.personaId + ')');
      for (const line of describePreset(preset)) console.log(line);
    });
}
