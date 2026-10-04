// `elanous persona list|add|edit|show`: 프리셋을 보고, 내 페르소나를 만들고 꾸민다.
// 만든 페르소나는 기존 페르소나 저장소(resolveStatePersonaDir · Discord·PWA 가 읽는 곳)의 `<id>.yaml` 한 파일이다.
import type { Command } from 'commander';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../debug/log.js';
import { parsePersonaYaml } from '../persona/loader.js';
import { resolveRepositoryPersonaDir, resolveStatePersonaDir } from '../persona/global-registry.js';
import { UnknownPersonaSchemaKeyError, choosePersonaId, clonePreset, describePreset, editPersona, findPreset, loadPresetIndex, loadPresets, presetToProfileYaml } from '../persona/presets.js';
import { addTeamSet, listTeamSets, removeTeamSet } from '../persona/team-set.js';
import { validateTeamFile } from '../persona/team.js';
import { runPersonaLoopOnce } from '../seat-loop/seat-loop.js';

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

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function setEdit(edits: Record<string, unknown>, assignment: string): void {
  const equals = assignment.indexOf('=');
  if (equals < 0) throw new Error(`--set requires key=value: ${assignment}`);
  const key = assignment.slice(0, equals);
  const parts = key.split('.');
  if (parts.some((part) => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new UnknownPersonaSchemaKeyError(key);
  }
  const value: unknown = parseYaml(assignment.slice(equals + 1));
  let target = edits;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(target, part)) target[part] = {};
    if (!mapping(target[part])) throw new Error(`--set key conflicts with a scalar: ${key}`);
    target = target[part];
  }
  target[parts.at(-1)!] = value;
}

function editOptions(fromFile: string | undefined, assignments: readonly string[]): Record<string, unknown> {
  const parsed: unknown = fromFile ? parseYaml(readFileSync(fromFile, 'utf8')) : {};
  if (!mapping(parsed)) throw new Error('--from-file must contain a YAML mapping');
  const edits = { ...parsed };
  for (const assignment of assignments) setEdit(edits, assignment);
  return edits;
}

export function registerPersonaCommands(program: Command): void {
  program.command('team').description('Validate a YAML team definition')
    .command('validate <file>').description('Check team schema, persona references and handoff order')
    .action((file: string) => {
      try {
        const definition = validateTeamFile(file);
        console.log(`Valid team ${definition.name}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message.replace(/\s+/g, ' ').trim() : String(error));
        process.exitCode = 2;
      }
    });

  const team = program.command('team-set').description('Install, remove and list persona team sets');
  team.command('add <file>').description('Install a YAML team set').action((file: string) => {
    try { const result = addTeamSet(file); console.log(`Installed team-set ${result['team-set']}`); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  });
  team.command('remove <name>').description('Remove an installed team set').action((name: string) => {
    try { removeTeamSet(name); console.log(`Removed team-set ${name}`); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  });
  team.command('list').description('List installed team sets').action(() => {
    try { for (const item of listTeamSets()) console.log(`${item['team-set']}  ${item.members.map((member) => `${member.persona} (${member.title})`).join(', ')}`); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  });

  const persona = program.command('persona').description('Persona presets — AI coworkers you pick and customise (list · add · edit · show)');

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
        console.log('프리셋 — 골라서 내 페르소나로 만들기: elanous persona add <이름> [--from <프리셋>]');
        const width = Math.max(...presets.map((p) => p.personaId.length));
        for (const p of presets) console.log(`  ${p.personaId.padEnd(width)}  ${p.displayName} — ${p.role} · ${p.oneLine}`);
      }
      const made = mine.filter((p) => p.preset);
      if (made.length) {
        console.log('\n내 페르소나:');
        for (const p of made) console.log(`  ${p.personaId}  ${p.displayName}${p.title ? ` (${p.title})` : ''}  (프리셋 ${p.preset})`);
      }
    });

  persona.command('add <name>')
    .description('Make your own persona from a preset — the preset file is not changed')
    .option('--from <preset>', 'Preset to clone (defaults to the named preset)')
    .option('--name <name>', 'What to call it (default: the preset’s first name)')
    .option('--as <name>', 'Clone this preset under a new, unique name')
    .option('--title <title>', 'Optional title, e.g. CMO')
    .option('--json', 'JSON output')
    .action((query: string, opts: { from?: string; name?: string; as?: string; title?: string; json?: boolean }) => {
      const presets = loadPresets();
      const presetQuery = opts.from ?? query;
      const preset = findPreset(presets, presetQuery);
      if (!preset) {
        console.error(`프리셋 «${presetQuery}» 을 찾지 못했습니다. 있는 것: ${presets.map((p) => p.personaId).join(', ')}`);
        process.exitCode = 1;
        return;
      }
      if (opts.as !== undefined || opts.from !== undefined) {
        try {
          if (opts.from !== undefined && (opts.as !== undefined || opts.name !== undefined || opts.title !== undefined)) throw new Error('--from cannot be combined with --as, --name or --title');
          if (opts.as !== undefined && (opts.name !== undefined || opts.title !== undefined)) throw new Error('--as cannot be combined with --name or --title');
          const result = clonePreset(preset, opts.from !== undefined ? query : opts.as!);
          debug.log('persona.cli', 'cloned', { preset: preset.personaId, personaId: result.personaId });
          if (opts.json) console.log(JSON.stringify({ personaId: result.personaId, displayName: result.displayName, preset: preset.personaId, path: result.path }, null, 2));
          else {
            console.log(`만들었습니다 — ${result.displayName} (id ${result.personaId} · 프리셋 ${preset.personaId})`);
            console.log(`  처음 묻는 것: ${preset.firstQuestions.join(' / ')}`);
            console.log(`  보기: elanous persona show ${result.personaId}`);
          }
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
        }
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

  persona.command('edit <name>')
    .description('Edit a saved persona (schema fields only; the preset source is not changed)')
    .option('--set <key=value>', 'Set a field (repeatable; YAML values)', (value: string, values: string[]) => [...values, value], [] as string[])
    .option('--from-file <path>', 'Load edits from a YAML mapping')
    .option('--dry-run', 'Validate and preview without writing')
    .option('--json', 'JSON output')
    .action((name: string, opts: { set: string[]; fromFile?: string; dryRun?: boolean; json?: boolean }) => {
      try {
        if (!opts.fromFile && !opts.set.length) throw new Error('persona edit requires --set or --from-file');
        const result = editPersona(name, editOptions(opts.fromFile, opts.set), { dryRun: opts.dryRun });
        debug.log('persona.cli', opts.dryRun ? 'edit-dry-run' : 'edited', { personaId: result.personaId });
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(`${opts.dryRun ? '미리 보기' : '수정했습니다'} — ${result.displayName} (id ${result.personaId})`);
          console.log(result.yaml);
          console.log(`  파일: ${result.path}`);
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message.replace(/\s+/g, ' ').trim() : String(err));
        process.exitCode = err instanceof UnknownPersonaSchemaKeyError ? 2 : 1;
      }
    });

  persona.command('loop <name>')
    .description('Shadow-pick one todo for a saved persona without executing it')
    .requiredOption('--once', 'Pick exactly one todo')
    .option('--json', 'JSON output')
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        const entry = await runPersonaLoopOnce(name);
        if (opts.json) console.log(JSON.stringify(entry));
        else console.log(entry.todo ? `그림자 선택 — ${entry.todo.title} (${entry.todo.id})` : '할 일 없음');
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
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
