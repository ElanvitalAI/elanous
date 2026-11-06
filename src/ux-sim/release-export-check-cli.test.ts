import { expect, setDefaultTimeout, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGraph } from '../graph-runner/runner.js';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
const RELEASE_GRAPH = join(REPOSITORY_ROOT, 'graphs/release/release-loop.yaml');
const LEAK_FILE = 'src/ux-sim/scenario.ts';
const LEAK_PHONE = ['010', '1234', '5678'].join('-');

setDefaultTimeout(30 * 60_000);

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('SIM-RELEASE-CHAIN export-check CLI detects a public leak and the real release graph blocks publish', async () => {
  const universe = mkdtempSync(join(tmpdir(), 'sim-release-chain-export-check-'));
  const repo = join(universe, 'repo');
  const redactions = join(universe, 'export-redactions.tsv');
  const version = '0.3.2';
  let exportCliStatus: number | null = null;
  let exportCliTranscript = '';
  const dispatched: string[] = [];

  try {
    // A local shared clone keeps the fixture's leak commit and temporary git worktrees outside the source checkout.
    execFileSync('git', ['clone', '--quiet', '--shared', REPOSITORY_ROOT, repo], { stdio: ['ignore', 'pipe', 'pipe'] });
    git(repo, 'config', 'user.name', 'SIM-RELEASE-CHAIN');
    git(repo, 'config', 'user.email', 'sim-release-chain@example.invalid');
    symlinkSync(join(REPOSITORY_ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir');
    const pwaModules = join(REPOSITORY_ROOT, 'apps/pwa/node_modules');
    if (existsSync(pwaModules)) symlinkSync(pwaModules, join(repo, 'apps/pwa/node_modules'), 'dir');
    const packagePath = join(repo, 'package.json');
    const packageManifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string };
    packageManifest.version = version;
    writeFileSync(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`);
    const leakPath = join(repo, LEAK_FILE);
    const originalSource = readFileSync(leakPath, 'utf8');
    writeFileSync(leakPath, `${originalSource}\n// Contact ${LEAK_PHONE}\n`);
    git(repo, 'add', 'package.json', LEAK_FILE);
    git(repo, 'commit', '-m', 'SIM-RELEASE-CHAIN leak fixture');
    const cutCommit = git(repo, 'rev-parse', 'HEAD');
    expect(git(repo, 'ls-files', LEAK_FILE)).toBe(LEAK_FILE);
    writeFileSync(redactions, '# isolated SIM-RELEASE-CHAIN redaction table\n');
    const leakScan = spawnSync('bun', ['scripts/public-export.ts', '--out', join(universe, 'direct-export')], {
      cwd: repo,
      env: { ...process.env, ELANOUS_EXPORT_REDACTIONS: redactions },
      encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024,
    });
    expect(leakScan.status, `${leakScan.stdout ?? ''}\n${leakScan.stderr ?? ''}`).toBe(1);
    expect(leakScan.stdout).toContain('kr-mobile-phone');
    expect(leakScan.stdout).toContain(LEAK_FILE);

    const runBash = async (command: string, options: { env?: NodeJS.ProcessEnv }) => {
      const contextPath = options.env?.ELANOUS_GRAPH_CONTEXT;
      if (!contextPath) throw new Error('graph runner did not pass the node context');
      const context = JSON.parse(readFileSync(contextPath, 'utf8')) as { nodeId: string };
      dispatched.push(context.nodeId);
      if (context.nodeId === 'export-check') {
        if (command !== 'bun scripts/release-loop/export-check-node.ts') {
          throw new Error(`release graph export-check CLI binding changed: ${command}`);
        }
        const cliContext = JSON.parse(readFileSync(contextPath, 'utf8')) as {
          input?: { version?: string; previousVersion?: string };
          outputs?: Record<string, { outcome?: string; commit?: string }>;
        };
        expect(cliContext.input).toMatchObject({ version, previousVersion: version });
        expect(cliContext.outputs?.['version-release']).toMatchObject({ outcome: 'ok', commit: cutCommit });
        const child = spawnSync('bun', ['scripts/release-loop/export-check-node.ts'], {
          cwd: repo,
          env: { ...options.env, ELANOUS_EXPORT_REDACTIONS: redactions },
          encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024,
        });
        exportCliStatus = child.status;
        exportCliTranscript = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
        return { exitCode: child.status ?? 2, stdout: child.stdout ?? '', stderr: child.stderr ?? child.error?.message ?? '' };
      }
      if (context.nodeId === 'version-release') {
        return { exitCode: 0, stdout: `${JSON.stringify({ outcome: 'ok', version, commit: cutCommit, branch: `release/${version}` })}\n`, stderr: '' };
      }
      // Other release stages are outside this one-node simulation; their command result only advances the real graph.
      return { exitCode: 0, stdout: `${JSON.stringify({ outcome: 'ok', version, nodeId: context.nodeId })}\n`, stderr: '' };
    };

    const state = await runGraph(RELEASE_GRAPH, {
      runId: 'sim-release-chain-export-check-leak-blocks-publish',
      input: { version, previousVersion: version },
      pinChildUniverse: true,
      quiet: true,
      deps: { root: universe, runBash },
    });
    const exportNode = state.nodes.find((node) => node.nodeId === 'export-check');
    const exportOutput = JSON.parse(typeof exportNode?.output === 'string' ? exportNode.output : '{}') as { outcome?: string; step?: string };

    if (exportCliStatus !== 1) throw new Error(`export-check CLI exit status: ${String(exportCliStatus)}`);
    expect(exportCliTranscript).toContain('kr-mobile-phone');
    expect(exportCliTranscript).toContain(LEAK_FILE);
    expect(exportNode).toMatchObject({ executed: true, ok: false });
    expect(exportOutput).toMatchObject({ outcome: 'fail', step: 'export' });
    expect(state.status).toBe('failed');
    expect(state.path).toEqual(['version-release', 'traffic-cut-start', 'cutoff', 'export-check', 'traffic-failed-restore', 'failed']);
    expect(dispatched).toContain('export-check');
    expect(dispatched).not.toContain('gate');
    expect(dispatched).not.toContain('publish');
  } finally {
    rmSync(universe, { recursive: true, force: true });
  }
});
