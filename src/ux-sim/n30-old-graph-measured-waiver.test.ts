import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { runReleaseSimRigIfFile } from './release-sim-rig.js';

test('N30 old-graph measured waiver refuses before dispatch and preserves the failed ledger', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'n30-old-graph-waiver-sim-'));
  const previous = getTestStateRoot();
  setTestStateRoot(root);
  try {
    const result = await runReleaseSimRigIfFile('scenarios/ux-sim/n30-old-graph-measured-waiver.yaml');
    expect(result).not.toBeNull();
    if (!result) throw new Error('N30 old-graph scenario was not classified as a release graph');
    if (!result.pass) throw new Error(JSON.stringify({ id: result.cases[0]?.id, checks: result.cases[0]?.checks, refusal: result.cases[0]?.refusal }));
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({
      id: 'old-graph-measured-waiver-stops-before-resume-dispatch',
      status: 'resume-refused',
      checks: { status: true, mustVisit: true, mustNotVisit: true, ledgerEvents: true },
      dispatchedNodes: [],
      injectedEvidence: { oldGraphMissingKnownIssues: true, stateStayedFailedWithoutWaiver: true },
    });
    expect(result.cases[0]?.refusal).toContain('waived node must reach known-issues before publication');
  } finally {
    setTestStateRoot(previous ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
