import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { GraphRunState } from './runner-types.js';
import { validateReleaseKnownIssueWaiverApproval } from './release-known-issue-waiver.js';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const cut = 'a'.repeat(40);
const table = Buffer.from('shard\tattempt_id\tkind\texact_test\tobserved\tarea\top_disposition\traw_log\tjunit\r\n'
  + 'pod-68\tattempt-68\tunmeasured\t\tno final test result\t미측정\tOP known issue\tcut/pod-68.json\t\r\n');
const tableSha = sha(table);
const document = Buffer.from(JSON.stringify({
  type: 'release-gate-known-issue-waiver', decision: 'accept-known-issues', runId: 'run-1', version: '0.3.15', cut,
  approvedBy: 'OP via JUD', table: { sha256: tableSha, rows: 1, frozen: true }, acceptedIssues: [{ id: 'pod-68:attempt-68:unmeasured:1' }],
  unmeasuredShards: ['pod-68'], judAttestation: { by: 'JUD', tableSHA256: tableSha },
  requiredConsumptionGuard: { runId: 'run-1', cut, tableSHA256: tableSha, gateOutputIntroduced: 0,
    mustCheckFinalGateOutput: true, mustIndependentlyEnumerateUnmeasuredFromRaw: true,
    judSignedBy: 'JUD', OPApproval: 'OP30582' },
}));
const pins = { document: sha(document), table: tableSha };
const state = (): GraphRunState => ({
  graphId: 'release-loop', runId: 'run-1', status: 'awaiting-approval', dryRun: false,
  path: ['version-release', 'gate', 'gate-heal-decision'],
  nodes: [
    { nodeId: 'version-release', ok: true, executed: true, exit: 0, output: JSON.stringify({ outcome: 'ok', commit: cut }) },
    { nodeId: 'gate', ok: false, executed: true, exit: 2,
      output: JSON.stringify({ outcome: 'error', commit: cut, introduced: [], error: 'remote gate refused: HQ shard result batch is incomplete (pod-68)' }) },
  ],
  pending: { nodeId: 'gate-heal-decision', message: 'review', since: '2026-11-13T00:00:00Z', inputSha256: 'f'.repeat(64) },
  input: { version: '0.3.15', publishAt: '2026-11-13T05:00:00.000Z' },
  executed: 2, statePath: '/tmp/run-1.json',
}) as GraphRunState;

test('frozen JUD waiver permits only the exact pending run/cut and unmeasured shard set', () => {
  expect(() => validateReleaseKnownIssueWaiverApproval(state(), document, table, false, pins)).not.toThrow();
  const introduced = state();
  introduced.nodes[1]!.output = JSON.stringify({ outcome: 'error', commit: cut,
    introduced: ['new regression'], error: 'remote gate refused: HQ shard result batch is incomplete (pod-68)' });
  expect(() => validateReleaseKnownIssueWaiverApproval(introduced, document, table, false, pins)).toThrow('introduced 0');
  const rejected = state();
  rejected.pending!.decision = 'rejected';
  expect(() => validateReleaseKnownIssueWaiverApproval(rejected, document, table, false, pins)).toThrow('undecided');
  const changedCut = state();
  changedCut.nodes[0]!.output = JSON.stringify({ outcome: 'ok', commit: 'b'.repeat(40) });
  expect(() => validateReleaseKnownIssueWaiverApproval(changedCut, document, table, false, pins)).toThrow('saved cut');
  expect(() => validateReleaseKnownIssueWaiverApproval(state(), document, Buffer.from(table.toString().replace('pod-68', 'pod-67')), false, pins))
    .toThrow('SHA differs');
  const wrongSet = Buffer.from(JSON.stringify({ ...JSON.parse(document.toString()), unmeasuredShards: [] }));
  expect(() => validateReleaseKnownIssueWaiverApproval(state(), wrongSet, table, false,
    { document: sha(wrongSet), table: tableSha })).toThrow('unmeasured shard set');
});
