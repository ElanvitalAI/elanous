import { afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { registerSimCommands } from './sim-cli.js';
import { listMockDeviceRequests } from '../ux-sim/mock-device-requests.js';

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
  test('sim coverage reports an empty test universe and queues uncovered modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-coverage-cli-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const output: string[] = [];
    const errors: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'coverage', '--json']);

    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ runCount: 0, coverageBasis: 'assembled-device-source-modules' });
    expect(listMockDeviceRequests().length).toBeGreaterThan(0);
  });

  test('runs the introduced-three release failure through the registered CLI and real gate-triage node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-release-introduced-cli-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const output: string[] = [];
    const errors: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'run', 'scenarios/ux-sim/release-introduced-repair.yaml']);
    const result = JSON.parse(output.pop()!) as { pass: boolean; cases: Array<{ id: string; pass: boolean; statePath: string; path: string[]; dispatchedNodes: string[] }> };
    expect(result).toMatchObject({ pass: true, cases: [
      { id: 'introduced-three-gate-regressions-hitl', pass: true },
      { id: 'missing-introduced-identity-stays-unmeasured', pass: true },
      { id: 'absent-introduced-identity-stays-unmeasured', pass: true },
    ] });
    const run = JSON.parse(readFileSync(result.cases[0]!.statePath, 'utf8')) as {
      path: string[]; nodes: Array<{ nodeId: string; output?: string }>;
    };
    const outputFor = (nodeId: string) => JSON.parse(run.nodes.find((node) => node.nodeId === nodeId)!.output!);
    const failureIds = [
      'src/auth/session.test.ts > rejects expired sessions',
      'src/graph/runner.test.ts > preserves failed edge attribution',
      'src/ux-sim/release.test.ts > blocks publish after a gate regression',
    ];
    expect(run.path).toEqual(['version-release', 'traffic-cut-start', 'cutoff', 'export-check', 'pre-gate-join', 'gate',
      'gate-triage', 'traffic-failed-restore', 'failed']);
    expect(result.cases[0]!.dispatchedNodes).toEqual(expect.arrayContaining(['checklist-gate', 'prefetch']));
    expect(outputFor('gate')).toMatchObject({ introduced: failureIds, autoheal: { action: 'hitl', cause: 'true-regression' } });
    expect(outputFor('gate-triage')).toMatchObject({ introduced: failureIds, failureIds,
      prescription: { action: 'repair-card', failureIds } });
    expect(run.path).not.toContain('publish');
    expect(run.path).not.toContain('npm-publish');
    const noIdentityState = JSON.parse(readFileSync(result.cases[1]!.statePath, 'utf8')) as {
      nodes: Array<{ nodeId: string; output?: string }>;
    };
    const noIdentityGate = JSON.parse(noIdentityState.nodes.find((node) => node.nodeId === 'gate')!.output!);
    expect(noIdentityGate).not.toHaveProperty('autoheal');
    const absentIdentityState = JSON.parse(readFileSync(result.cases[2]!.statePath, 'utf8')) as {
      nodes: Array<{ nodeId: string; output?: string }>;
    };
    const absentIdentityGate = JSON.parse(absentIdentityState.nodes.find((node) => node.nodeId === 'gate')!.output!);
    expect(absentIdentityGate).not.toHaveProperty('autoheal');
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test('records and lists mock device requests only inside the isolated test universe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-device-request-cli-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const output: string[] = [];
    const errors: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'devices', 'request', 'SIM-DEVICE-REQUEST-NEXUS', '--boundary', 'catalog request persistence', '--nearest', 'scenario-runner', '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ cellId: 'SIM-DEVICE-REQUEST-NEXUS', state: 'missing' });
    await program.parseAsync(['node', 'test', 'sim', 'devices', '--missing', '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ missing: [{ cellId: 'SIM-DEVICE-REQUEST-NEXUS' }], resolved: [] });
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

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

    writeFileSync(join(created.rootDir, 'state', 'value.json'), '{"value":1}\n', { mode: 0o600 });
    await program.parseAsync(['node', 'test', 'sim', 'world', 'snapshot', 'grid-alpha', '--name', 'checkpoint']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ worldId: 'grid-alpha', snapshotId: 'checkpoint' });
    writeFileSync(join(created.rootDir, 'state', 'value.json'), '{"value":2}\n', { mode: 0o600 });
    await program.parseAsync(['node', 'test', 'sim', 'world', 'restore', 'grid-alpha', 'checkpoint']);
    expect(JSON.parse(output.pop()!)).toEqual({ id: 'grid-alpha', restored: 'checkpoint' });
    expect(readFileSync(join(created.rootDir, 'state', 'value.json'), 'utf8')).toBe('{"value":1}\n');

    await program.parseAsync(['node', 'test', 'sim', 'world', 'list']);
    expect(JSON.parse(output.pop()!)).toHaveLength(1);

    await program.parseAsync(['node', 'test', 'sim', 'world', 'destroy', 'grid-alpha']);
    expect(JSON.parse(output.pop()!)).toEqual({ id: 'grid-alpha', destroyed: true });
    await program.parseAsync(['node', 'test', 'sim', 'world', 'list']);
    expect(JSON.parse(output.pop()!)).toEqual([]);
  });

  test('snapshots, restores, and forks a YAML world through the registered commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-world-cli-yaml-snapshot-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const yamlPath = join(root, 'world.yaml');
    writeFileSync(yamlPath, 'world: yaml-only\ndevices: [fake-clock]\nevents: []\n', { mode: 0o600 });
    const output: string[] = [];
    const errors: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'world', 'create-yaml', yamlPath]);
    const created = JSON.parse(output.pop()!) as { id: string; root: string };
    expect(created.id).toBe('yaml-only');
    expect(created.root).toBe(join(realpathSync(root), 'sim', 'worlds', 'yaml-only'));
    expect(readFileSync(join(created.root, 'world.json'), 'utf8')).toContain('"format": 1');
    await program.parseAsync(['node', 'test', 'sim', 'world', 'snapshot', 'yaml-only', '--name', 'before-change']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ worldId: 'yaml-only', snapshotId: 'before-change' });
    writeFileSync(join(created.root, 'config', 'world.yaml'), 'not a world spec\n', { mode: 0o600 });
    await program.parseAsync(['node', 'test', 'sim', 'world', 'restore', 'yaml-only', 'before-change']);
    expect(JSON.parse(output.pop()!)).toEqual({ id: 'yaml-only', restored: 'before-change' });
    await program.parseAsync(['node', 'test', 'sim', 'world', 'fork', 'yaml-only', 'before-change', 'yaml-copy']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ id: 'yaml-copy' });
    const forkedSpec = JSON.parse(readFileSync(join(realpathSync(root), 'sim', 'worlds', 'yaml-copy', 'config', 'world.yaml'), 'utf8')) as { world: string };
    expect(forkedSpec.world).toBe('yaml-copy');
    await program.parseAsync(['node', 'test', 'sim', 'world', 'destroy-yaml', 'yaml-copy']);
    expect(JSON.parse(output.pop()!)).toEqual({ id: 'yaml-copy', destroyed: true });
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test('forks a format-1 snapshot through the registered command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-world-cli-fork-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const output: string[] = [];
    const errors: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'world', 'create', 'source-world']);
    const source = JSON.parse(output.pop()!) as { rootDir: string };
    writeFileSync(join(source.rootDir, 'state', 'value.json'), '{"value":1}\n', { mode: 0o600 });
    await program.parseAsync(['node', 'test', 'sim', 'world', 'snapshot', 'source-world', '--name', 'fork-point']);
    output.pop();
    await program.parseAsync(['node', 'test', 'sim', 'world', 'fork', 'source-world', 'fork-point', 'forked-world']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ id: 'forked-world' });
    expect(readFileSync(join(realpathSync(root), 'sim', 'worlds', 'forked-world', 'state', 'value.json'), 'utf8')).toBe('{"value":1}\n');
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
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

  test('registers fidelity replay and device-status commands in the isolated test universe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-fidelity-cli-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const fixturePath = join(root, 'recording.json');
    writeFileSync(fixturePath, JSON.stringify({
      version: 1,
      id: 'github-list',
      deviceId: 'fake-github',
      repository: 'acme/widget',
      recordedAt: '2026-11-04T10:00:00.000Z',
      prs: [{ number: 7, title: 'Recorded PR', branch: 'feature/recorded', createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-04T09:00:00.000Z' }],
      calls: [{ args: ['api', '/repos/acme/widget/pulls?state=open'], realResponse: '[{"number":7,"title":"Recorded PR","draft":false,"state":"open","head":{"ref":"feature/recorded","sha":"head7"},"base":{"ref":"main"},"labels":[],"created_at":"2026-11-03T00:00:00.000Z","updated_at":"2026-11-04T09:00:00.000Z","merged_at":null,"body":null,"merge_commit_sha":null}]' }],
    }), { mode: 0o600 });
    const output: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'fidelity', 'compare', fixturePath]);
    expect(JSON.parse(output.pop()!)).toMatchObject({ recordingId: 'github-list', deviceId: 'fake-github', passed: true });
    await program.parseAsync(['node', 'test', 'sim', 'fidelity', 'status', 'fake-github']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ deviceId: 'fake-github', verdict: 'green' });
    expect(process.exitCode).toBe(0);
  });
});
