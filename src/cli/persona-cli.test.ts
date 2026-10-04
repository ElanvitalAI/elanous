import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { loadPresets, presetsDir } from '../persona/presets.js';
import { PersonaRegistry } from '../persona/registry.js';
import { registerPersonaCommands } from './persona-cli.js';

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'persona-cli-'));
  previous = process.env.ELANOUS_PERSONAS_DIR;
  process.env.ELANOUS_PERSONAS_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ELANOUS_PERSONAS_DIR;
  else process.env.ELANOUS_PERSONAS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ lines: string[]; errors: string[]; code: number }> {
  const lines: string[] = [], errors: string[] = [];
  const log = console.log, error = console.error, exitCode = process.exitCode;
  console.log = (...values) => { lines.push(values.join(' ')); };
  console.error = (...values) => { errors.push(values.join(' ')); };
  process.exitCode = 0;
  try {
    const program = new Command().name('elanous').exitOverride();
    registerPersonaCommands(program);
    await program.parseAsync(['persona', ...args], { from: 'user' });
    return { lines, errors, code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
  }
}

const preset = loadPresets()[0]!.personaId;

async function add(): Promise<string> {
  const out = await cli(['add', preset, '--as', 'CLI Persona Example', '--json']);
  expect(out.code).toBe(0);
  return (JSON.parse(out.lines[0]!) as { personaId: string }).personaId;
}

test('add --as clones a preset under a unique name while preserving its shipped YAML', async () => {
  const id = await add();
  const stored = parseYaml(readFileSync(join(dir, `${id}.yaml`), 'utf8')) as Record<string, unknown>;
  expect(stored.displayName).toBe(`CLI Persona Example · ${loadPresets()[0]!.role}`);
  expect(stored.preset).toMatchObject({ id: preset });
  const again = await cli(['add', preset, '--as', 'CLI Persona Example']);
  expect(again.code).toBe(1);
  expect(again.errors.join(' ')).toContain('already exists');
  expect(readdirSync(dir)).toEqual([`${id}.yaml`]);
});

test('existing add --name and --title, list and show still work', async () => {
  const created = await cli(['add', preset, '--name', 'Legacy Name', '--title', 'Coordinator', '--json']);
  expect(created.code).toBe(0);
  const { personaId } = JSON.parse(created.lines[0]!) as { personaId: string };
  const stored = parseYaml(readFileSync(join(dir, `${personaId}.yaml`), 'utf8')) as { preset: { title: string } };
  expect(stored.preset.title).toBe('Coordinator');
  const listed = await cli(['list', '--json']);
  expect((JSON.parse(listed.lines[0]!) as { mine: Array<{ personaId: string }> }).mine).toContainEqual(expect.objectContaining({ personaId }));
  const shown = await cli(['show', personaId, '--json']);
  expect(JSON.parse(shown.lines[0]!)).toMatchObject({ kind: 'persona', personaId });
});

test('add <name> --from <preset> then edit --set writes one YAML that the existing loader reads', async () => {
  const source = join(presetsDir(), `${preset}.yaml`);
  const original = readFileSync(source, 'utf8');
  const created = await cli(['add', 'My New Colleague', '--from', preset, '--json']);
  expect(created.code).toBe(0);
  const { personaId, path } = JSON.parse(created.lines[0]!) as { personaId: string; path: string };
  expect(personaId).toBe('my-new-colleague');
  expect(path).toBe(join(dir, `${personaId}.yaml`));
  const before = readFileSync(path, 'utf8');
  const edited = await cli(['edit', personaId, '--set', 'description=From my own file']);
  expect(edited.code).toBe(0);
  expect(readdirSync(dir)).toEqual([`${personaId}.yaml`]);
  const stored = parseYaml(readFileSync(path, 'utf8')) as { preset: { id: string }; description: string };
  expect(stored.preset.id).toBe(preset);
  expect(stored.description).toBe('From my own file');
  expect(readFileSync(source, 'utf8')).toBe(original);
  expect(before).not.toBe(readFileSync(path, 'utf8'));
  const registry = new PersonaRegistry();
  const loaded = await registry.loadDir(dir);
  expect(loaded.errors).toEqual([]);
  expect(loaded.profiles.get(personaId)?.description).toBe('From my own file');
  const duplicate = await cli(['add', 'My New Colleague', '--from', preset]);
  expect(duplicate.code).toBe(1);
  expect(readdirSync(dir)).toEqual([`${personaId}.yaml`]);
});

test('edit rejects unknown schema keys with exit 2 and one reason without writing', async () => {
  const created = await cli(['add', 'Schema Check', '--from', preset, '--json']);
  const { personaId } = JSON.parse(created.lines[0]!) as { personaId: string };
  const path = join(dir, `${personaId}.yaml`);
  const before = readFileSync(path, 'utf8');
  for (const assignment of ['unknownField=yes', 'models.unknownField=yes', '=yes']) {
    const out = await cli(['edit', personaId, '--set', assignment]);
    expect(out.code).toBe(2);
    expect(out.errors).toEqual([`unknown persona schema key: ${assignment.split('=')[0]}`.trim()]);
    expect(out.lines).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
  }
});

test('edit --set is repeatable, accepts nested YAML values, and preserves preset provenance', async () => {
  const id = await add();
  const out = await cli(['edit', id, '--set', 'description=Changed description', '--set', 'models.primary=gpt-example', '--set', 'browserPort=1234', '--json']);
  expect(out.code).toBe(0);
  const data = parseYaml(readFileSync(join(dir, `${id}.yaml`), 'utf8')) as Record<string, unknown>;
  expect(data).toMatchObject({ description: 'Changed description', models: { primary: 'gpt-example' }, browserPort: 1234, preset: { id: preset } });
  expect(JSON.parse(out.lines[0]!)).toMatchObject({ personaId: id, dryRun: false });
});

test('edit --from-file accepts a mapping and --set overrides its fields', async () => {
  const id = await add();
  const input = join(dir, 'changes.yml');
  writeFileSync(input, 'description: From file\nsystemPrompt: A new prompt\n');
  const out = await cli(['edit', id, '--from-file', input, '--set', 'description=From option']);
  expect(out.code).toBe(0);
  const data = parseYaml(readFileSync(join(dir, `${id}.yaml`), 'utf8')) as Record<string, unknown>;
  expect(data.description).toBe('From option');
  expect(data.systemPrompt).toBe('A new prompt');
});

test('edit --dry-run previews without changing the saved persona or preset', async () => {
  const id = await add();
  const path = join(dir, `${id}.yaml`);
  const before = readFileSync(path, 'utf8');
  const out = await cli(['edit', id, '--set', 'description=Preview only', '--dry-run', '--json']);
  expect(out.code).toBe(0);
  expect(JSON.parse(out.lines[0]!)).toMatchObject({ dryRun: true, personaId: id });
  expect(out.lines[0]).toContain('Preview only');
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(readdirSync(dir)).toEqual([`${id}.yaml`]);
});

test('edit rejects missing names, invalid fields, malformed edits and invalid schema without writing', async () => {
  const id = await add();
  const path = join(dir, `${id}.yaml`);
  const before = readFileSync(path, 'utf8');
  for (const [args, code] of [
    [['edit', 'unknown', '--set', 'description=test'], 1],
    [['edit', id, '--set', 'preset.id=other'], 2],
    [['edit', id, '--set', 'browserPort=70000'], 1],
    [['edit', id, '--set', 'not-assignment'], 1],
    [['edit', id, '--set', '__proto__.x=oops'], 2],
    [['edit', id], 1],
  ] as const) {
    const out = await cli([...args]);
    expect(out.code).toBe(code);
    expect(out.errors.length).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
  }
  const file = join(dir, 'invalid.yml');
  writeFileSync(file, '- not a mapping\n');
  const invalid = await cli(['edit', id, '--from-file', file]);
  expect(invalid.code).toBe(1);
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(existsSync(join(dir, 'unknown.yaml'))).toBe(false);
});
