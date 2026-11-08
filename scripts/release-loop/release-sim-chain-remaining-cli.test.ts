import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'bun:test';

const scenarioTemplate = 'scenarios/ux-sim/release-sim-chain-remaining.yaml';

test('test-universe release CLI exercises export, incomplete shard, stopped gate, publish and npm boundaries', () => {
  const root = process.cwd();
  // Keep the pinned release command checkout clean: scenario fixtures are already tracked by the repository.
  const scenarioId = 'release-sim-chain-remaining-1108';
  const scenario = scenarioTemplate;
  const stateDir = mkdtempSync(join(tmpdir(), 'release-sim-chain-remaining-'));
  try {
    const stdout = execFileSync('bun', ['bin/elanous.mjs', '--test=' + stateDir, 'sim', 'run', scenario], {
      cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    expect(stdout).toContain(scenarioId);
    expect(stdout).toContain('"pass":true');

    const artifactPath = join(stateDir, 'ux-sim', 'evidence', scenarioId + '.json');
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
      pass: boolean;
      cases: Array<{ id: string; pass: boolean; path: string[]; injectedEvidence?: Record<string, unknown> }>;
    };
    expect(artifact.pass).toBe(true);
    expect(artifact.cases.map(({ id }) => id)).toEqual([
      'export-check-failure-blocks-prepare-and-publish',
      'incomplete-gate-shard-blocks-publish',
      'stopped-gate-waiver-resumes-existing-release-cli',
      'publish-npm-verify-production-entrypoints-with-fake-boundaries',
    ]);
    expect(artifact.cases.every(({ pass }) => pass)).toBe(true);
    expect(artifact.cases[0]?.path).not.toContain('publish');
    expect(artifact.cases[1]?.path).not.toContain('npm-publish');

    const publish = artifact.cases[3]?.injectedEvidence?.npmPublishEvidence as {
      result?: { outcome?: string; npm?: string };
      publishedCommands?: string[];
    } | undefined;
    const verify = artifact.cases[3]?.injectedEvidence?.verifyEvidence as { result?: { outcome?: string } } | undefined;
    expect(publish?.result).toMatchObject({ outcome: 'ok', npm: 'published' });
    expect(publish?.publishedCommands).toHaveLength(1);
    expect(verify?.result).toMatchObject({ outcome: 'ok' });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 180_000);
