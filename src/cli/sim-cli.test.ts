import { afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { registerSimCommands } from './sim-cli.js';

const roots: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalExitCode = process.exitCode;
let priorTestRoot: string | undefined;

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode ?? 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setTestStateRoot(priorTestRoot ?? null);
});

describe('sim world CLI', () => {
  test('creates, lists, and destroys a world through the registered command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-world-cli-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const output: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'world', 'create', 'grid-alpha']);
    const created = JSON.parse(output.pop()!) as { id: string; rootDir: string };
    expect(created.id).toBe('grid-alpha');
    expect(created.rootDir).toBe(join(realpathSync(root), 'sim', 'worlds', 'grid-alpha'));

    await program.parseAsync(['node', 'test', 'sim', 'world', 'list']);
    expect(JSON.parse(output.pop()!)).toHaveLength(1);

    await program.parseAsync(['node', 'test', 'sim', 'world', 'destroy', 'grid-alpha']);
    expect(JSON.parse(output.pop()!)).toEqual({ id: 'grid-alpha', destroyed: true });
    await program.parseAsync(['node', 'test', 'sim', 'world', 'list']);
    expect(JSON.parse(output.pop()!)).toEqual([]);
  });

  test('reports invalid lifecycle operations without throwing through Commander', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-world-cli-error-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const errors: string[] = [];
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'world', 'create', '../escape']);
    expect(process.exitCode).toBe(2);
    expect(errors[0]).toContain('sim world create: invalid sim world id');
  });
  test('validates a world YAML through the registered command in the isolated test universe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-world-cli-validate-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const yamlPath = join(root, 'world.yaml');
    writeFileSync(yamlPath, 'world: cli-world\ndevices: [fake-clock]\nevents: []\n', { mode: 0o600 });
    const output: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'world', 'validate', yamlPath]);
    expect(JSON.parse(output.pop()!)).toEqual({ world: 'cli-world', seed: 0, devices: ['fake-clock'], events: [] });
  });
});
