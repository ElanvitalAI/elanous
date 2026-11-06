import { expect, test } from 'bun:test';
import { isReleaseToolingPath } from './resume-release.js';

test('release tooling paths keep the earlier gate verdict; product paths do not', () => {
  for (const p of ['scripts/release-loop/pwa-scenarios-node.ts', 'scripts/release-loop/node-verdict.ts', 'graphs/release/release-loop.yaml', 'docs/conductor/release-loop-agent.md', 'docker/upgrade/upgrade-probe.sh']) {
    expect(isReleaseToolingPath(p)).toBe(true);
  }
  for (const p of ['src/cli/nexus.ts', 'scripts/lib/pwa-scenarios/scenarios.ts', 'package.json', 'bin/elanous.mjs', 'pwa/app/page.tsx', 'docker/sandbox/Dockerfile']) {
    expect(isReleaseToolingPath(p)).toBe(false);
  }
});
