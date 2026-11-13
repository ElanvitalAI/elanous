import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GraphRunState } from './runner-types.js';
import { KNOWN_ISSUE_ROUTE } from './release-known-issue-waiver.js';

export const T6_PWA_WAIVER = Object.freeze({
  runId: '636f9e96-0aae-4cb0-babd-b509c44e2f34',
  cut: '7d951adb3163ba16a784d5b937d12732ef9be625',
  childRun: '0c489b82-e332-4bb8-b694-46430b94172b',
  documentSha256: 'a800a0b749b930d1da7cfc7eb615d57d60c9c7a5a56c98a046ae5d5180d46122',
  signatureSha256: '7e5272dc48147754b4aca5625615e0d7fcbafacea72a78f08c103d7122335e20',
  pairedLogSha256: '62c15af1642abc87476e6b713e04cc12f1ddae75ff1f04c19a80873004eb8560',
  independentProofSha256: '9cc86c0ee1426d81dfc7c527922e57d6bc50975b5e6ed49599753887131ccd81',
  childStateSha256: 'f691734edf6d24be179fa100284f4ee145ecdd5b588567ecfc1a8182b561b3e4',
  branch: 'pwa',
  join: 'pre-prepare-join',
});

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** A signed child-state SHA covers every byte of the original PWA output, including unlisted fields. */
export function assertPwaOutputBoundToChild(branchOutput: unknown, childStateBytes: Buffer, expectedSha256: string, childRun: string): void {
  if (sha256(childStateBytes) !== expectedSha256) throw new Error('PWA child state SHA differs from JUD proof');
  const child = JSON.parse(childStateBytes.toString()) as GraphRunState;
  if (child.graphId !== KNOWN_ISSUE_ROUTE.graph || child.runId !== childRun || child.status !== 'failed' ||
      child.nodes.find((node) => node.nodeId === T6_PWA_WAIVER.branch)?.output !== branchOutput)
    throw new Error('PWA whole output differs from the signed failed child state');
}

/** Exact one-run OP/JUD disposition. A missing or changed receipt closes the route. */
export function assertSignedT6PwaBranchWaiver(state: GraphRunState, root: string, recorded = false): void {
  const pin = T6_PWA_WAIVER;
  const fanout = state.fanOuts?.['traffic-gate-passed:ok'];
  const branch = fanout?.branches.pwa;
  const cut = JSON.parse(String(state.nodes.find((node) => node.nodeId === KNOWN_ISSUE_ROUTE.cut)?.output ?? '{}')) as { commit?: string };
  if (state.graphId !== KNOWN_ISSUE_ROUTE.graph || state.runId !== pin.runId || (!recorded && state.status !== 'failed') || state.dryRun ||
      (state.input as { version?: string; cutCommit?: string } | undefined)?.version !== '0.3.15' ||
      (state.input as { cutCommit?: string } | undefined)?.cutCommit !== pin.cut || cut.commit !== pin.cut ||
      fanout?.from !== KNOWN_ISSUE_ROUTE.passed || fanout.join !== pin.join ||
      branch?.runId !== pin.childRun || branch.status !== 'failed' ||
      (recorded ? branch.waiver?.verdict !== 'waived' || branch.waiver.decidedBy !== 'OP' ||
        branch.waiver.documentSha256 !== pin.documentSha256 || branch.waiver.signatureSha256 !== pin.signatureSha256 ||
        branch.waiver.pairedLogSha256 !== pin.pairedLogSha256 || branch.waiver.originalStatus !== 'failed' || !branch.waiver.reason
        : branch.waiver !== undefined) ||
      !state.path.includes(pin.join) || (!recorded && state.nodes.find((node) => node.nodeId === pin.join)?.ok !== false) ||
      Object.entries(fanout.branches).some(([id, sibling]) => id !== 'pwa' && sibling.status !== 'done'))
    throw new Error('PWA known-issue waiver requires the exact failed T6 fan-out run, child, and cut');
  let output: { outcome?: string; verdict?: string; commit?: string; withCostly?: boolean; cells?: Array<{ id?: string; final?: string; reruns?: string[] }> };
  try { output = JSON.parse(String(branch.output)); } catch { throw new Error('PWA known-issue waiver requires the saved failed PWA output'); }
  const cells = output.cells ?? [];
  const expectedPassed = ['T1', 'T1b', 'T4a', 'T5', 'T5b', 'C2a', 'C2b'];
  if (output.outcome !== 'fail' || output.verdict !== 'fail' || output.commit !== pin.cut || output.withCostly !== false ||
      cells.length !== 10 || new Set(cells.map((cell) => cell.id)).size !== 10 ||
      expectedPassed.some((id) => !cells.some((cell) => cell.id === id && cell.final === 'pass' &&
        (cell as { first?: string }).first === 'pass' && cell.reruns?.length === 0)) ||
      JSON.stringify(output.cells?.filter((cell) => cell.final === 'fail').map((cell) => cell.id).sort()) !== JSON.stringify(['N1', 'N5a', 'N6a']) ||
      output.cells?.filter((cell) => cell.final === 'fail').some((cell) => JSON.stringify(cell.reruns) !== JSON.stringify(['fail', 'fail'])))
    throw new Error('PWA known-issue waiver requires the exact saved failed cells and retries');
  const seatState = root === join(homedir(), '.elanous') ? join(homedir(), 'elanous-hq', 'seat-state') : join(root, 'seat-state');
  const document = readFileSync(join(seatState, 'OP/evidence/20261113/T6-PWA-KNOWN-ISSUE-OP.md'));
  const signature = readFileSync(join(seatState, 'JUD/evidence/doorbell-30984/T6-PWA-JUD-confirmation.json'));
  const paired = readFileSync(join(seatState, 'REL/evidence/T6-PWA-PAIR-0314-1335/paired.log'));
  const proof = readFileSync(join(seatState, 'JUD/evidence/doorbell-30954/independent-pair-proof.json'));
  const childState = readFileSync(join(root, 'graph-runs/release-loop', `${pin.childRun}.json`));
  if (sha256(document) !== pin.documentSha256 || sha256(signature) !== pin.signatureSha256 ||
      sha256(paired) !== pin.pairedLogSha256 || sha256(proof) !== pin.independentProofSha256)
    throw new Error('PWA known-issue OP/JUD document or paired measurement SHA differs');
  const signed = JSON.parse(signature.toString()) as Record<string, unknown>;
  const checkedProof = JSON.parse(proof.toString()) as Record<string, unknown>;
  assertPwaOutputBoundToChild(branch.output, childState, pin.childStateSha256, pin.childRun);
  if (signed.signer !== 'JUD' || signed.authority !== 'OP #30988' || signed.runId !== state.runId ||
      signed.cut !== pin.cut || signed.childRun !== branch.runId || signed.pairedLogSHA256 !== pin.pairedLogSha256 ||
      signed.independentProofSHA256 !== pin.independentProofSha256 ||
      checkedProof.childStateSHA256 !== pin.childStateSha256 || checkedProof.childRun !== pin.childRun ||
      signed.formalPwaVerdict !== 'fail' || signed.costlyMeasured !== false ||
      !Array.isArray(signed.observedNewFailureIds) || signed.observedNewFailureIds.length !== 0)
    throw new Error('PWA known-issue JUD signature does not bind this run, child, cut, and paired failure');
}
