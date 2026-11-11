import { expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { simCli } from '../src/ux-sim/in-process-cli.js';
import { mockSeatPtySequence } from '../src/ux-sim/mock-seat-pty-sequence.js';
import { createDirtySourceProof, createInstalledPackageFixture } from '../test/package-includes-scenarios-fixture.js';

const REPO = resolve(import.meta.dir, '..');
// Source: test/workflow-templates-packaged.test.ts - bounded package smoke test.
setDefaultTimeout(60_000);

test('isolated package source preserves uncommitted CLI edits and untracked runtime files', () => {
  const proof = createDirtySourceProof();
  try {
    expect(readFileSync(proof.snapshotCliPath, 'utf8')).toBe(proof.expectedCli);
    expect(readFileSync(proof.snapshotScenarioPath, 'utf8')).toBe(proof.expectedScenario);
    expect(proof.expectedScenarios).toEqual(['scenarios/untracked-case.yaml']);
  } finally {
    proof.cleanup();
  }
});

test('a dirty CLI entrypoint is packed and the installed invocation fails', async () => {
  const fixture = createInstalledPackageFixture(REPO, (snapshot) => {
    writeFileSync(join(snapshot, 'bin', 'elanous.mjs'), "throw new Error('dirty package CLI damage');\n");
  });
  try {
    const cli = join(fixture.installedRoot, 'bin', 'elanous.mjs');
    const stateRoot = join(fixture.scratch, 'broken-cli-state');
    const result = await simCli([`--test=${stateRoot}`, 'sim', '--help'], {
      mode: 'spawn',
      entrypoint: cli,
      allowPaths: [['sim']],
      cwd: fixture.installedRoot,
      stateRoot,
      configRoot: fixture.configRoot,
      injectTestFlag: false,
      env: { ELANOUS_BUN: process.execPath, ELANOUS_INSTALL_PREFIX: join(fixture.scratch, 'prefix'), ELANOUS_NO_AUTO_DOCTOR: '1' },
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('dirty package CLI damage');
  } finally {
    fixture.cleanup();
  }
});

test('published package includes scenarios and starts installed sim, graph, and TUI entries', async () => {
  const fixture = createInstalledPackageFixture(REPO);
  const { scratch, installedRoot, configRoot, packedPaths, expectedScenarios } = fixture;
  try {
    expect([...packedPaths].filter((path) => path.startsWith('scenarios/')).sort()).toEqual([...expectedScenarios]);
    expect(packedPaths.has('docs/profiles/solar-only-demo.json')).toBe(true);
    expect(packedPaths.has('scenarios/ux-sim/novice-versioning-scenario.ts')).toBe(true);
    expect(packedPaths.has('scenarios/ux-sim/app-demo-1114.yaml')).toBe(true);
    const cli = join(installedRoot, 'bin', 'elanous.mjs');
    const testStateRoot = join(scratch, 'state');
    const env = { ELANOUS_BUN: process.execPath, ELANOUS_INSTALL_PREFIX: join(scratch, 'prefix'), ELANOUS_NO_AUTO_DOCTOR: '1', ELANOUS_SIM_WORLD_OS_SANDBOXED: '1' };
    const options = { mode: 'spawn' as const, entrypoint: cli, allowPaths: [['sim'], ['graph', 'run']] as const, cwd: installedRoot, stateRoot: testStateRoot, configRoot, injectTestFlag: false, env };
    const simHelp = await simCli([`--test=${testStateRoot}`, 'sim', '--help'], options);
    expect(simHelp.exitCode, simHelp.stderr).toBe(0);
    expect(simHelp.stdout).toContain('sim');
    expect(existsSync(join(installedRoot, 'scenarios', 'ux-sim', 'app-demo-1114.yaml'))).toBe(true);
    const graphHelp = await simCli([`--test=${testStateRoot}`, 'graph', 'run', '--help'], options);
    expect(graphHelp.exitCode, graphHelp.stderr).toBe(0);
    expect(graphHelp.stdout).toContain('graph');

    const tuiRoot = join(scratch, 'tui-state');
    mkdirSync(tuiRoot);
    const config = JSON.stringify({ onboarding: { completed: true }, errorReports: { enabled: false } });
    writeFileSync(join(configRoot, 'config.json'), config);
    writeFileSync(join(tuiRoot, 'config.json'), config);
    const tui = await mockSeatPtySequence({
      executable: process.execPath,
      args: [cli, '--test-state-dir={root}', '--config-dir', configRoot, '--tui', 'next'],
      root: tuiRoot,
      env: { ELANOUS_BUN: process.execPath, ELANOUS_INSTALL_PREFIX: join(scratch, 'prefix'), ELANOUS_NO_AUTO_DOCTOR: '1', ELANOUS_CONFIG_DIR: configRoot },
      ready: { label: 'installed-next-tui', until: (screen) => screen.includes('elanous') && screen.includes('Ctrl+Q ') },
      steps: [{ label: 'installed-next-tui-ready', keys: '', until: (screen) => screen.includes('Ctrl+Q ') }],
    });
    expect(tui.exitCode).toBe(0);
    expect(tui.frames[0]?.screen).toContain('elanous');
    const demo = await simCli([`--test=${testStateRoot}`, 'sim', 'run', 'scenarios/ux-sim/provider-4xx-no-provider.yaml'], options);
    expect(demo.exitCode, demo.stderr).toBe(0);
    const receipt = JSON.parse(demo.stdout) as { pass?: boolean; runEvidence?: { event?: string; persisted?: boolean } };
    expect(receipt.pass).toBe(true);
    expect(receipt.runEvidence).toMatchObject({ event: 'completed', persisted: true });
  } finally { fixture.cleanup(); }
}, 180_000);
