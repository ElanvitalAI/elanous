import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { registerPersonaCommands } from './persona-cli.js';

const example = resolve(import.meta.dir, '../../examples/teams/small-product.yaml');
const original = readFileSync(example, 'utf8');
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function validate(file: string): Promise<{ code: number; output: string[]; errors: string[] }> {
  const output: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  const previous = process.exitCode;
  console.log = (...values) => { output.push(values.join(' ')); };
  console.error = (...values) => { errors.push(values.join(' ')); };
  process.exitCode = 0;
  try {
    const program = new Command().name('elanous').exitOverride();
    registerPersonaCommands(program);
    await program.parseAsync(['team', 'validate', file], { from: 'user' });
    return { code: Number(process.exitCode ?? 0), output, errors };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = previous ?? 0;
  }
}

function fixture(team = original): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'team-validate-'));
  temporary.push(dir);
  const file = join(dir, 'team.yaml');
  writeFileSync(file, team.replaceAll('persona: personas/', `persona: ${resolve(import.meta.dir, '../../examples/teams/personas')}/`));
  return { dir, file };
}

test('real CLI exits 0 with the expected output for the example team', () => {
  const valid = spawnSync(process.execPath, ['bin/elanous.mjs', '--test', 'team', 'validate', example], {
    cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8',
  });
  expect(valid.status).toBe(0);
  expect(valid.stdout.trim()).toBe('Valid team Small product');
});

test('existing team-set add, list and remove commands remain registered separately', () => {
  const program = new Command().name('elanous').exitOverride();
  registerPersonaCommands(program);
  expect(program.commands.find((command) => command.name() === 'team-set')?.commands.map((command) => command.name()))
    .toEqual(['add', 'remove', 'list']);
});

test('shipped small-product team validates its three persona references and checklist handoffs', async () => {
  const before = readFileSync(example, 'utf8');
  expect(await validate(example)).toEqual({ code: 0, output: ['Valid team Small product'], errors: [] });
  expect(readFileSync(example, 'utf8')).toBe(before);
});

test('missing persona is rejected with exit 2 and a reason without writing files', async () => {
  const { dir, file } = fixture(original.replace('personas/backend.yaml', 'personas/nonexistent.yaml'));
  expect(await validate(file)).toEqual({ code: 2, output: [], errors: ['persona not found: ' + resolve(import.meta.dir, '../../examples/teams/personas/nonexistent.yaml') + ' (Backend)'] });
  expect(readdirSync(dir)).toEqual(['team.yaml']);
});

test('cyclic handoffs are rejected with exit 2 and a reason', async () => {
  const { dir, file } = fixture(original.replace('  - {from: Backend, to: QA}', '  - {from: Backend, to: QA}\n  - {from: QA, to: PM}'));
  const result = await validate(file);
  expect(result).toEqual({ code: 2, output: [], errors: ['handoff cycle at PM'] });
  expect(readdirSync(dir)).toEqual(['team.yaml']);
});

test('schema and handoff references reject unknown fields, invalid checklist and missing title', async () => {
  for (const [team, reason] of [
    [original + 'unexpected: ignored\n', 'team.unexpected is not a team schema field'],
    [original.replace('      - Review API and data changes.\n      - Verify error handling.', '      - Review API and data changes.\n      -'), 'team.members[1].checklistTemplate item must be a non-empty string'],
    [original.replace('from: Backend, to: QA', 'from: Backend, to: Missing'), 'handoff references missing title: Backend -> Missing'],
    [original.replace('title: Backend', 'title: Server'), 'persona seat mismatch: ' + resolve(import.meta.dir, '../../examples/teams/personas/backend.yaml') + ' requires seat Server'],
  ]) {
    const { file } = fixture(team);
    expect(await validate(file)).toEqual({ code: 2, output: [], errors: [reason] });
  }
});
