import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parsePersonaYaml } from '../persona/loader.js';
import { registerPersonaCommands } from './persona-cli.js';

let root: string;
let previous: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'team-set-'));
  previous = process.env.ELANOUS_PERSONAS_DIR;
  process.env.ELANOUS_PERSONAS_DIR = join(root, 'personas');
});
afterEach(() => {
  if (previous === undefined) delete process.env.ELANOUS_PERSONAS_DIR;
  else process.env.ELANOUS_PERSONAS_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});

const definition = `team-set: launch-team
members:
  - persona: alpha
    title: CTO
    checklistTemplate: Check architecture
    rules: [Review design]
  - persona: beta
    title: CMO
    checklistTemplate: Check copy
    rules: [Review copy]
  - persona: gamma
    title: CXO
    checklistTemplate: Check experience
    rules: [Review accessibility]
handoffs:
  - {from: alpha, to: beta, when: architecture approved}
  - {from: beta, to: gamma, when: copy reviewed}
`;

async function cli(args: string[]): Promise<{ output: string; errors: string; code: number }> {
  const lines: string[] = [], errors: string[] = [];
  const log = console.log, error = console.error, exitCode = process.exitCode;
  console.log = (...values) => { lines.push(values.join(' ')); };
  console.error = (...values) => { errors.push(values.join(' ')); };
  process.exitCode = 0;
  try {
    const program = new Command().name('elanous').exitOverride();
    registerPersonaCommands(program);
    await program.parseAsync(['team-set', ...args], { from: 'user' });
    return { output: lines.join('\n'), errors: errors.join('\n'), code: Number(process.exitCode ?? 0) };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
  }
}

function input(text = definition): string {
  const file = join(root, 'team.yaml');
  writeFileSync(file, text);
  return file;
}
function personaDir(): string { return join(root, 'personas'); }

test('three-member team set installs runtime personas, lists and removes cleanly', async () => {
  const added = await cli(['add', input()]);
  expect(added.code).toBe(0);
  expect(added.output).toContain('launch-team');
  const listed = await cli(['list']);
  expect(listed.code).toBe(0);
  expect(listed.output).toContain('launch-team');
  for (const [id, title, checklist, rule] of [
    ['alpha', 'CTO', 'Check architecture', 'Review design'],
    ['beta', 'CMO', 'Check copy', 'Review copy'],
    ['gamma', 'CXO', 'Check experience', 'Review accessibility'],
  ]) {
    const path = join(personaDir(), `${id}.yaml`);
    const text = readFileSync(path, 'utf8');
    const parsed = parsePersonaYaml(text, path);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.profile.displayName).toContain(title);
      expect(parsed.profile.systemPrompt).toContain(checklist);
      expect(parsed.profile.systemPrompt).toContain(rule);
    }
  }
  const installed = parseYaml(readFileSync(join(personaDir(), '_team-sets', 'launch-team.yaml'), 'utf8')) as { definition: { handoffs: unknown[] } };
  expect(installed.definition.handoffs).toHaveLength(2);
  const removed = await cli(['remove', 'launch-team']);
  expect(removed.code).toBe(0);
  expect((await cli(['list'])).output).toBe('');
  expect(readdirSync(personaDir())).toEqual([]);
});

test('team-set names may use Korean text, and remove accepts that same name', async () => {
  const file = input(definition.replace('launch-team', '출시 팀'));
  expect((await cli(['add', file])).code).toBe(0);
  expect((await cli(['list'])).output).toContain('출시 팀');
  expect((await cli(['remove', '출시 팀'])).code).toBe(0);
  expect(readdirSync(personaDir())).toEqual([]);
});

test('invalid handoff missing member or cycle is rejected before any persona is written', async () => {
  for (const [text, message] of [
    [definition.replace('to: gamma', 'to: nobody'), 'missing member'],
    [definition.replace('handoffs:\n', 'handoffs:\n  - {from: gamma, to: alpha, when: restart}\n'), 'cycle'],
  ]) {
    const result = await cli(['add', input(text)]);
    expect(result.code).toBe(1);
    expect(result.errors).toContain(message);
    expect(existsSync(personaDir())).toBe(false);
  }
});

test('existing persona or team name is rejected without overwriting, removal preserves edited personas', async () => {
  const existing = join(personaDir(), 'beta.yaml');
  mkdirSync(personaDir());
  writeFileSync(existing, 'personaId: beta\ndisplayName: Existing\n');
  const failed = await cli(['add', input()]);
  expect(failed.code).toBe(1);
  expect(failed.errors).toContain('persona already exists');
  expect(readdirSync(personaDir())).toEqual(['beta.yaml']);
  rmSync(existing);
  expect((await cli(['add', input()])).code).toBe(0);
  const duplicate = await cli(['add', input()]);
  expect(duplicate.code).toBe(1);
  expect(duplicate.errors).toContain('already exists');
  const gamma = join(personaDir(), 'gamma.yaml');
  writeFileSync(gamma, 'personaId: gamma\ndisplayName: Manually edited\n');
  const removal = await cli(['remove', 'launch-team']);
  expect(removal.code).toBe(0);
  expect(readFileSync(gamma, 'utf8')).toBe('personaId: gamma\ndisplayName: Manually edited\n');
  expect(existsSync(join(personaDir(), 'alpha.yaml'))).toBe(false);
  expect(existsSync(join(personaDir(), 'beta.yaml'))).toBe(false);
  expect(existsSync(join(personaDir(), '_team-sets', 'launch-team.yaml'))).toBe(false);
  expect((await cli(['list'])).output).toBe('');
  expect(readdirSync(personaDir())).toEqual(['gamma.yaml']);
});

test('existing underscore-prefixed .yml persona ID rejects installation without creating files', async () => {
  mkdirSync(personaDir());
  const existing = join(personaDir(), '_alpha.yml');
  const contents = 'personaId: _alpha\ndisplayName: Existing\n';
  writeFileSync(existing, contents);
  const result = await cli(['add', input(definition.replaceAll('alpha', '_alpha'))]);
  expect(result.code).toBe(1);
  expect(result.errors).toContain('persona already exists: _alpha');
  expect(readFileSync(existing, 'utf8')).toBe(contents);
  expect(readdirSync(personaDir())).toEqual(['_alpha.yml']);
  expect((await cli(['list'])).output).toBe('');
});

test('installed records reserve missing persona IDs, and removal refuses ambiguous ownership', async () => {
  expect((await cli(['add', input()])).code).toBe(0);
  const betaPath = join(personaDir(), 'beta.yaml');
  const betaContents = readFileSync(betaPath, 'utf8');
  rmSync(betaPath);
  const other = input(`team-set: second-team\nmembers:\n  - persona: beta\n    title: CMO\n    checklistTemplate: Check copy\n    rules: [Review copy]\nhandoffs: []\n`);
  const rejected = await cli(['add', other]);
  expect(rejected.code).toBe(1);
  expect(rejected.errors).toContain('persona already exists: beta');
  expect(existsSync(betaPath)).toBe(false);
  expect((await cli(['list'])).output).toContain('launch-team');
  expect((await cli(['list'])).output).not.toContain('second-team');

  // Simulate a second installed record from an older writer that reused the missing ID.
  const firstRecord = join(personaDir(), '_team-sets', 'launch-team.yaml');
  const secondRecord = join(personaDir(), '_team-sets', 'second-team.yaml');
  const snapshot = parseYaml(readFileSync(firstRecord, 'utf8')) as {
    definition: { 'team-set': string; members: { persona: string }[]; handoffs: unknown[] };
    files: { persona: string; yaml: string }[];
  };
  snapshot.definition['team-set'] = 'second-team';
  snapshot.definition.members = [snapshot.definition.members[1]!];
  snapshot.definition.handoffs = [];
  snapshot.files = [snapshot.files[1]!];
  writeFileSync(secondRecord, stringifyYaml(snapshot));
  writeFileSync(betaPath, betaContents);
  const ambiguous = await cli(['remove', 'launch-team']);
  expect(ambiguous.code).toBe(1);
  expect(ambiguous.errors).toContain('multiple team-set owners: beta');
  expect(readFileSync(betaPath, 'utf8')).toBe(betaContents);
  expect(existsSync(firstRecord)).toBe(true);
  expect(existsSync(secondRecord)).toBe(true);
});

test('remove skips missing personas while cleaning other members and team record', async () => {
  expect((await cli(['add', input()])).code).toBe(0);
  rmSync(join(personaDir(), 'beta.yaml'));
  const removal = await cli(['remove', 'launch-team']);
  expect(removal.code).toBe(0);
  expect((await cli(['list'])).output).toBe('');
  expect(readdirSync(personaDir())).toEqual([]);
});
