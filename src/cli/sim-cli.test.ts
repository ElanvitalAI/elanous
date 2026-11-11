import { afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createUserSimulationEnvironment, registerSimCommands } from './sim-cli.js';
import { listMockDeviceRequests } from '../ux-sim/mock-device-requests.js';
import { createWorld, destroyWorldById, executeWorldScenario, loadWorld } from '../ux-sim/world.js';
import { appendSimWorldWatchEvents } from '../ux-sim/world-watch.js';

const roots: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalExitCode = process.exitCode;
let priorTestRoot: string | undefined;
const credentialEnvKeys = ['OPENAI_API_KEY', 'SSH_PRIVATE_KEY', 'DATABASE_URL', 'REDIS_URL'] as const;
const initialCredentialEnv = Object.fromEntries(credentialEnvKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode ?? 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setTestStateRoot(priorTestRoot ?? null);
  for (const key of credentialEnvKeys) {
    const value = initialCredentialEnv[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('sim world CLI', () => {
  test('user default profiles create a credential-free runner environment', () => {
    priorTestRoot = getTestStateRoot();
    const root = mkdtempSync(join(tmpdir(), 'sim-app-profile-'));
    roots.push(root);
    setTestStateRoot(root);
    const result = createUserSimulationEnvironment([
      { credentials: 'fake-only', network: 'loopback-only', storage: 'temporary' },
    ], { PATH: process.env.PATH, DATABASE_URL: 'postgres://SIM-DB-BOUNDARY-SENTINEL',
      REDIS_URL: 'redis://SIM-REDIS-BOUNDARY-SENTINEL', OPENAI_API_KEY: 'SIM-BOUNDARY-SENTINEL',
      SSH_PRIVATE_KEY: 'SIM-SSH-BOUNDARY-SENTINEL' });
    expect(result).toMatchObject({ PATH: process.env.PATH, ELANOUS_STATE_DIR: root });
    expect(['derived', 'explicit']).toContain(result.ELANOUS_STATE_DIR_SOURCE!);
    expect(result.NODE_ENV).toBe('test');
    expect(result).not.toHaveProperty('OPENAI_API_KEY');
    expect(result).not.toHaveProperty('SSH_PRIVATE_KEY');
    expect(result).not.toHaveProperty('DATABASE_URL');
    expect(result).not.toHaveProperty('REDIS_URL');
  });

  test('sim app lists declarations from app.yaml inside the isolated universe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-app-cli-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const appDir = join(root, 'demo-app');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0
slug: demo-app
title: Demo app
frontend: { kind: static-export }
simulate:
  connectors:
    summarize: { fake: stt, profile: ok }
  scenarios:
    - name: happy path
      steps: [{ action: summarize }]
      expect: [{ event: completed }]
actions:
  summarize: { builtin: summarize, input: { text: text }, output: { text: text } }
`);
    const output: string[] = [];
    const errors: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'app', appDir, '--list', '--json']);
    expect(errors).toEqual([]);
    expect(JSON.parse(output.pop()!)).toMatchObject({ app: 'demo-app', scenarios: [{ name: 'happy path' }],
      deviceProfiles: { summarize: { device: 'SIM-FAKE-PROVIDERS-AV', selectedProfile: 'ok',
        defaultProfile: { credentials: 'fake-only', network: 'loopback-only', storage: 'temporary' } } } });
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

  test('sim app runs the real declared runner behind a mocked OS sandbox boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-app-cli-run-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const appDir = join(root, 'demo-app');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0
slug: demo-app
title: Demo app
frontend: { kind: static-export }
tables:
  notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
roles: { owner: { via: nexus-session } }
rpc:
  addNote:
    sql: INSERT INTO notes (id, title) VALUES (:id, :title)
    params: { id: { type: text }, title: { type: text } }
    allow: [owner]
simulate:
  connectors:
    summarize: { fake: stt, profile: ok }
  scenarios:
    - name: happy-path
      steps: [{ rpc: addNote, as: owner, params: { id: note-1, title: hi } }]
      expect: [{ event: rpc.addNote.completed }, { table: notes, rows: ${['notes'].length} }]
actions:
  summarize: { builtin: summarize, input: { text: text }, output: { text: text } }
`);
    const output: string[] = [];
    const errors: string[] = [];
    const priorEnv = { DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL,
      SSH_PRIVATE_KEY: process.env.SSH_PRIVATE_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    process.env.DATABASE_URL = 'postgres://SIM-DB-BOUNDARY-SENTINEL';
    process.env.REDIS_URL = 'redis://SIM-REDIS-BOUNDARY-SENTINEL';
    process.env.SSH_PRIVATE_KEY = 'SIM-SSH-BOUNDARY-SENTINEL';
    process.env.OPENAI_API_KEY = 'SIM-API-BOUNDARY-SENTINEL';
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    let refusedRunnerCalls = 0;
    const refusedProgram = new Command();
    registerSimCommands(refusedProgram, {
      assertNetworkIsolation() { throw new Error('test sandbox unavailable'); },
      async executeCli() { refusedRunnerCalls++; return { status: 0, stdout: '' }; },
    });
    await refusedProgram.parseAsync(['node', 'test', 'sim', 'app', appDir, '--scenario', 'happy-path', '--json']);
    expect(process.exitCode).toBe(2);
    expect(errors).toEqual(['sim app: test sandbox unavailable']);
    expect(refusedRunnerCalls).toBe(0);
    errors.length = 0;
    process.exitCode = 0;
    const program = new Command();
    const priorSandboxFlag = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
    registerSimCommands(program, {
      assertNetworkIsolation(environment) {
        if (!environment) throw new Error('isolated simulation environment was not provided');
        expect(environment.DATABASE_URL).toBeUndefined();
        expect(environment.REDIS_URL).toBeUndefined();
        expect(environment.SSH_PRIVATE_KEY).toBeUndefined();
        expect(environment.OPENAI_API_KEY).toBeUndefined();
      },
      async executeCli(args) {
        if (args[2] === 'create-yaml') {
          const world = await createWorld(args[3]!);
          return { status: 0, stdout: JSON.stringify({ id: world.id }) };
        }
        if (args[2] === 'run') {
          const oldFlag = process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
          process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = '1';
          try {
            const result = await executeWorldScenario(loadWorld(args[3]!), args[4]!);
            return { status: result.pass ? 0 : 1, stdout: JSON.stringify(result) };
          } finally {
            if (oldFlag === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
            else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = oldFlag;
          }
        }
        if (args[2] === 'destroy') {
          await destroyWorldById(args[3]!);
          return { status: 0, stdout: '' };
        }
        throw new Error(`unexpected simulated app CLI command: ${args.join(' ')}`);
      },
    });

    try {
      await program.parseAsync(['node', 'test', 'sim', 'app', appDir, '--scenario', 'happy-path', '--json']);
    } finally {
      if (priorSandboxFlag === undefined) delete process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED;
      else process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED = priorSandboxFlag;
    }
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
    const printed = JSON.parse(output.pop()!) as { receiptPath: string; passed: boolean;
      scenarios: Array<{ scenario: string; status: string; failedExpectations: string[] }>;
      results: Array<{ events: Array<{ data: { step: string } }>; evidence: { events: string[]; tableRows: Record<string, number> };
        receipts: Array<{ outcome: string }> }> };
    expect(printed).toMatchObject({ passed: true, scenarios: [{ scenario: 'happy-path', status: 'passed', failedExpectations: [] }],
      results: [{ events: [{ data: { step: 'rpc.addNote.completed' } }], evidence: { events: ['rpc.addNote.completed'], tableRows: { notes: ['notes'].length } },
        receipts: [{ outcome: 'passed' }] }] });
    expect(JSON.parse(readFileSync(printed.receiptPath, 'utf8'))).toMatchObject({ app: 'demo-app', passed: true,
      results: [{ events: [{ data: { step: 'rpc.addNote.completed' } }], evidence: { events: ['rpc.addNote.completed'], tableRows: { notes: ['notes'].length } },
        receipts: [{ outcome: 'passed' }] }] });
    expect(process.env.DATABASE_URL).toBe('postgres://SIM-DB-BOUNDARY-SENTINEL');
    expect(process.env.REDIS_URL).toBe('redis://SIM-REDIS-BOUNDARY-SENTINEL');
    expect(process.env.SSH_PRIVATE_KEY).toBe('SIM-SSH-BOUNDARY-SENTINEL');
    expect(process.env.OPENAI_API_KEY).toBe('SIM-API-BOUNDARY-SENTINEL');
    if (priorEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorEnv.DATABASE_URL;
    if (priorEnv.REDIS_URL === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = priorEnv.REDIS_URL;
    if (priorEnv.SSH_PRIVATE_KEY === undefined) delete process.env.SSH_PRIVATE_KEY; else process.env.SSH_PRIVATE_KEY = priorEnv.SSH_PRIVATE_KEY;
    if (priorEnv.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorEnv.OPENAI_API_KEY;
  });

  test('sim suite creates its own isolated root and reports an unconnected real target as unmeasured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-suite-real-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(null);
    const suite = join(root, 'suite');
    mkdirSync(join(suite, 'incident'), { recursive: true });
    writeFileSync(join(suite, 'suite.json'), JSON.stringify({ durationTolerancePercent: 10 })); // Source: suite fixture makes duration policy explicit.
    writeFileSync(join(suite, 'incident', 'world.yaml'), 'world: incident\n');
    writeFileSync(join(suite, 'incident', 'scenario.yaml'), 'world: incident\nsteps: []\n');
    const output: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);
    await program.parseAsync(['node', 'test', 'sim', 'suite', suite, '--target', 'real']);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ scenario: 'incident', field: 'target', actual: 'unmeasured: target runner unavailable' });
    expect(process.exitCode).toBe(1);
    expect(getTestStateRoot()).toBeUndefined();
  });

  test('real suite stays unmeasured when no isolated worker is available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-suite-target-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const suite = join(root, 'suite');
    const caseDir = join(suite, 'incident');
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(suite, 'suite.json'), JSON.stringify({ durationTolerancePercent: 10 })); // Source: regression suite fixture sets its tolerance.
    // Source: minimal parseable world fixture uses the schema's required seed.
    writeFileSync(join(caseDir, 'world.yaml'), 'world: incident\nseed: 1\ndevices: [fake-clock]\nevents: []\n');
    writeFileSync(join(caseDir, 'scenario.yaml'), 'world: incident\nsteps: []\n');
    const output: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);
    await program.parseAsync(['node', 'test', 'sim', 'suite', suite, '--target', 'real', '--update-baseline']);
    expect(output).toEqual([JSON.stringify({ scenario: 'incident', field: 'target', baseline: 'real', actual: 'unmeasured: target runner unavailable' })]);
    expect(process.exitCode).toBe(1);
  });

  test('sim watch streams world observation rows from the isolated test world', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-world-watch-'));
    roots.push(root);
    priorTestRoot = getTestStateRoot();
    setTestStateRoot(root);
    const worldFile = join(root, 'watched-world.yaml');
    writeFileSync(worldFile, 'world: watched-world\ndevices: [fake-clock]\nevents: []\n', { mode: 0o600 });
    const world = await createWorld(worldFile);
    appendSimWorldWatchEvents(world, 'run-watch-1', [
      { event: 'gate-node', verdict: 'passed' },
      { event: 'release-event', verdict: 'injected' },
      { event: 'release-event', verdict: 'injected' },
    ]);
    const output: string[] = [];
    const errors: string[] = [];
    console.log = (...parts: unknown[]) => { output.push(parts.map(String).join(' ')); };
    console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(' ')); };
    process.exitCode = 0;
    const program = new Command();
    registerSimCommands(program);

    await program.parseAsync(['node', 'test', 'sim', 'watch', world.id, '--once']);
    expect(output).toHaveLength(3);
    expect(output[0]).toContain('run-watch-1 · gate-node · passed');
    expect(output[1]).toContain('run-watch-1 · release-event · injected');
    expect(output[2]).toContain('run-watch-1 · release-event · injected');
    expect(new Set(output.map((line) => line.match(/^\[([^\]]+)\]/)?.[1])).size).toBe(3);
    expect(errors).toEqual([]);
    expect(process.exitCode).toBe(0);
  });

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
    const outputFor = (nodeId: string) => JSON.parse([...run.nodes].reverse().find((node) => node.nodeId === nodeId && node.output !== undefined)!.output!);
    const failureIds = [
      'src/auth/session.test.ts > rejects expired sessions',
      'src/graph/runner.test.ts > preserves failed edge attribution',
      'src/ux-sim/release.test.ts > blocks publish after a gate regression',
    ];
    expect(run.path.slice(0, 6)).toEqual(['version-release', 'traffic-cut-start', 'cutoff', 'export-check', 'pre-gate-join', 'gate']);
    expect(run.path[6]).toBe('gate-triage');
    expect(run.path[7]).toMatch(/^gate-repair-[a-f0-9]{12}$/);
    expect(run.path.slice(8)).toEqual(['gate', 'gate-triage', 'traffic-failed-restore', 'failed']);
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
  }, 15_000);

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

  test('validates the self-contained voice-note demo with the same parser used by world creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sim-world-cli-demo-validate-'));
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

    await program.parseAsync(['node', 'test', 'sim', 'world', 'validate',
      join(import.meta.dir, '../../scenarios/ux-sim/app-demo-1114.yaml')]);
    expect(process.exitCode).toBe(0);
    expect(errors).toEqual([]);
    const parsed = JSON.parse(output.pop()!) as { world: string; apps: Array<{ slug: string }> };
    expect(parsed.world).toBe('app-demo-1114');
    expect(parsed.apps.map(app => app.slug)).toEqual(['voice-notes', 'shop-studio']);
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
