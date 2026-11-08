import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReleaseToolingPath, refreshReleaseBranchTip } from './resume-release.js';

test('release tooling paths keep the earlier gate verdict; product paths do not', () => {
  for (const p of ['scripts/release-loop/pwa-scenarios-node.ts', 'scripts/release-loop/node-verdict.ts', 'docs/conductor/release-loop-agent.md', 'docker/upgrade/upgrade-probe.sh']) {
    expect(isReleaseToolingPath(p)).toBe(true);
  }
  for (const p of ['scripts/release-loop/gate-node.ts', 'scripts/release-loop/gate-method.ts',
    'graphs/release/release-loop.yaml', 'graphs/release/recipes.yaml', 'recipes/release-loop.yaml',
    'src/cli/nexus.ts', 'scripts/lib/pwa-scenarios/scenarios.ts', 'package.json', 'bin/elanous.mjs', 'pwa/app/page.tsx', 'docker/sandbox/Dockerfile']) {
    expect(isReleaseToolingPath(p)).toBe(false);
  }
});

test('gate tooling changes force a resume at the first cut consumer', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-resume-gate-tooling-'));
  try {
    const runId = 'gate-tooling-tip';
    const stateDir = join(root, 'graph-runs/release-loop');
    mkdirSync(stateDir, { recursive: true });
    const recorded = 'a'.repeat(40);
    const tip = 'b'.repeat(40);
    writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({
      graphId: 'release-loop', runId, status: 'failed',
      path: ['version-release', 'gate', 'traffic-gate-passed', 'prepare'],
      input: { branchCut: true, version: '0.3.6' },
      nodes: [{ nodeId: 'version-release', ok: true, output: JSON.stringify({
        version: '0.3.6', branch: 'release/0.3.6', commit: recorded,
      }) }],
    }));
    const git = (args: string[]): string => {
      if (args[0] === 'ls-remote') return `${tip}\trefs/heads/release/0.3.6`;
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return tip;
      if (args[0] === 'diff') return 'scripts/release-loop/gate-node.ts';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    expect(() => refreshReleaseBranchTip(runId, { root, repo: root, git, isAncestor: () => true }, 'traffic-gate-passed'))
      .toThrow(/resume at gate or earlier/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
