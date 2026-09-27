import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { machineConfigPath } from '../roles/machine-name.js';
import { readMachineProfile } from '../roles/machine-profile.js';
import { registerMachineCommands } from './machine-cli.js';

test('registered --test CLI sets and shows an isolated profile end-to-end', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-cli-process-'));
  try {
    const env = { ...process.env, NODE_ENV: 'test', ELANOUS_STATE_DIR: root };
    const run = (args: string[]) => spawnSync('bun', ['bin/elanous.mjs', '--test', ...args], { encoding: 'utf8', env });
    const set = run(['machine', 'set', '--id', 'demo', '--duty', 'workstation', '--seat', 'control:1']);
    expect(set.status).toBe(0);
    expect(set.stdout).toContain('demo · workstation · control:1');
    const show = run(['machine', 'show']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain('demo · config · workstation · control:1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('joined machine refuses a different profile id and leaves its join identity intact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-cli-joined-'));
  try {
    mkdirSync(join(root, 'control'));
    writeFileSync(join(root, 'control', 'join.json'), JSON.stringify({ url: 'http://127.0.0.1:31413/', machine: 'node-b', token: 'a'.repeat(64) }), { mode: 0o600 });
    const program = new Command();
    registerMachineCommands(program, root);
    await expect(program.parseAsync(['node', 'elanous', 'machine', 'set', '--id', 'demo', '--duty', 'compute', '--seat', 'control:1']))
      .rejects.toThrow('machine id demo differs from joined machine node-b');
    expect(readMachineProfile(root)).toBeUndefined();
    const original = console.log;
    console.log = () => {};
    try {
      await program.parseAsync(['node', 'elanous', 'machine', 'set', '--id', 'node-b', '--duty', 'compute', '--seat', 'control:1']);
      expect(readMachineProfile(root)).toEqual({ id: 'node-b', duties: ['compute'], seats: { control: { rank: 1 } } });
    } finally { console.log = original; }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('machine set migrates a legacy identifier without losing the previous id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-cli-legacy-'));
  const old = console.log;
  console.log = () => {};
  try {
    mkdirSync(join(root, 'control'));
    writeFileSync(machineConfigPath(root), '{"machine":"mbp"}');
    const program = new Command();
    registerMachineCommands(program, root);
    await program.parseAsync(['node', 'elanous', 'machine', 'set', '--id', 'node-b', '--duty', 'compute', '--duty', 'character', '--seat', 'control:2']);
    expect(readMachineProfile(root)).toEqual({ id: 'node-b', duties: ['compute', 'character'], seats: { control: { rank: 2 } } });
  } finally { console.log = old; rmSync(root, { recursive: true, force: true }); }
});

test('machine set patches only given fields and show reports id, source, duties and ranked seats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-cli-'));
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { output.push(args.join(' ')); };
  const run = async (args: string[]) => {
    const program = new Command();
    registerMachineCommands(program, root);
    await program.parseAsync(['node', 'elanous', 'machine', ...args]);
  };
  try {
    await run(['set', '--id', 'node-b', '--duty', 'compute', '--duty', 'character', '--seat', 'control:2']);
    expect(readMachineProfile(root)).toEqual({ id: 'node-b', duties: ['compute', 'character'], seats: { control: { rank: 2 } } });
    expect(statSync(machineConfigPath(root)).mode & 0o777).toBe(0o600);
    await run(['show', '--json']);
    expect(JSON.parse(output.at(-1)!)).toEqual({ id: 'node-b', source: 'config', duties: ['compute', 'character'], seats: { control: { rank: 2 } } });
    await run(['set', '--duty', 'edge', '--seat', 'bot:3']);
    expect(readMachineProfile(root)).toEqual({ id: 'node-b', duties: ['compute', 'character', 'edge'], seats: { control: { rank: 2 }, bot: { rank: 3 } } });
    await run(['set', '--clear-duties', '--clear-seats']);
    expect(readMachineProfile(root)).toEqual({ id: 'node-b', duties: [], seats: {} });
    await expect(run(['set', '--seat', 'control:100'])).rejects.toThrow('invalid seat');
  } finally { console.log = original; rmSync(root, { recursive: true, force: true }); }
});
