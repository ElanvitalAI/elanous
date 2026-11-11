import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGraph } from '../../src/graph-runner/runner.js';
import { runGateCutoverSwitch } from './gate-cutover-switch-node.js';
import { buildReleaseRunInput } from './unattended-release.js';

const base = { graphId: 'release-loop', runId: 'same-cut', input: { version: '9.9.9', previousVersion: '9.9.8' },
  outputs: { gate: { outcome: 'ok' } } };

test('cutover decision requires evidence for audit and rejects unknown modes', () => {
  const plugin = JSON.parse(readFileSync(join(import.meta.dir, '../../graphs/release/plugin.json'), 'utf8'));
  expect(plugin.extensions['ai.elanous'].graphManifests['release-loop'].policy).not.toHaveProperty('release.gate.path');
  expect(() => buildReleaseRunInput('9.9.9', { config: { graphCutover: 'audit' } })).toThrow('OP decision evidence');
  expect(() => buildReleaseRunInput('9.9.9', { config: { graphCutover: 'other' as 'audit' } })).toThrow('legacy or audit');
});

test('cutover node defaults to legacy and refuses audit without an OP decision', () => {
  const output: string[] = [];
  const original = console.log;
  console.log = (line: string) => { output.push(line); };
  try {
    expect(runGateCutoverSwitch({ ELANOUS_GRAPH_CONTEXT: JSON.stringify(base) })).toBe(0);
    expect(JSON.parse(output.at(-1)!).outcome).toBe('legacy');
    expect(runGateCutoverSwitch({ ELANOUS_GRAPH_CONTEXT: JSON.stringify({ ...base,
      input: { ...base.input, graphCutover: 'audit' } }) })).toBe(2);
    expect(JSON.parse(output.at(-1)!).outcome).toBe('error');
  } finally { console.log = original; }
});

test('dry-run rejects an audit route without the same OP decision evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release-cutover-dry-'));
  try {
    await expect(runGraph(join(import.meta.dir, '../../graphs/release/release-loop.yaml'), {
      runId: 'missing-audit-evidence', dryRun: true, quiet: true,
      input: { version: '9.9.9', previousVersion: '9.9.8', graphCutover: 'audit' }, deps: { root },
    })).rejects.toThrow('audit route requires OP decision evidence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('same cut takes the declared legacy or audited route', async () => {
  const graph = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  for (const mode of ['legacy', 'audit'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'release-cutover-'));
    try {
      symlinkSync(join(import.meta.dir, '..'), join(root, 'scripts'));
      mkdirSync(join(root, 'release', '9.9.8'), { recursive: true });
      writeFileSync(join(root, 'release', '9.9.8', 'release.json'), JSON.stringify({ version: '9.9.8', publishedAt: 'now' }));
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify({ release: { loop: { gatePodPool: 'fixture-pool', graphCutover: mode,
        graphCutoverEvidenceId: 'OP-shadow-and-hard-rehearsal' } } }));
      const input = buildReleaseRunInput('9.9.9', { ledgerRoot: root, configPath });
      expect(input).toMatchObject({ graphCutover: mode, graphCutoverEvidenceId: 'OP-shadow-and-hard-rehearsal' });
      const state = await runGraph(graph, { runId: `cutover-${mode}`, input, deps: { root,
        runBash: async (command, options) => {
          const context = JSON.parse(readFileSync(options.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { nodeId: string };
          if (context.nodeId !== 'gate-cutover-switch')
            return { exitCode: 0, stdout: `${JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'fixture' })}\n`, stderr: '' };
          const result = spawnSync('/bin/bash', ['-c', command],
            { cwd: root, env: { ...process.env, ...options.env }, encoding: 'utf8' });
          return { exitCode: result.status ?? 2, stdout: result.stdout, stderr: result.stderr };
        } } });
      expect(state.status).toBe('done');
      expect(state.path).toContain('gate-cutover-switch');
      expect(state.path.includes('receipt-audit')).toBe(mode === 'audit');
      expect(state.path).toContain('traffic-gate-passed');
      const logDir = join(root, '.elanous', 'debug');
      expect(existsSync(logDir)).toBe(true);
      const logs = readdirSync(logDir).filter(file => file.endsWith('.log'))
        .map(file => readFileSync(join(logDir, file), 'utf8')).join('\n');
      expect(logs).toContain('release-loop.cutover');
      expect(logs).toContain(`"mode":"${mode}"`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
