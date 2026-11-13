import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { lastJsonObject } from './runner-primitives.js';
import type { GraphRunState } from './runner-types.js';

// OP #30161 and JUD #30176 froze this T6 waiver. The document hash pins the
// adjudication itself; its table hash pins the rows without treating missing
// per-row raw references as measured test passes.
export const T6_WAIVER_DOCUMENT_SHA = 'c9b4e424ffba348f62c390b71d2a6a5450de84022df3972e94271ecc586e4085';
export const T6_WAIVER_TABLE_SHA = '262d180b58343b4abe2c3571dca7b978d9f6b8bf9ac29f7faaf47ab0317fe3a7';
const T6_WAIVER_DOCUMENT = 'JUD/evidence/doorbell-30434/T6-op-waiver-v2-30582.json';
const T6_WAIVER_TABLE = 'JUD/evidence/doorbell-30434/T6-known-issues-v2-final-30564.tsv';
const T6_RAW_SUPPLEMENT = 'JUD-C/evidence/t6-636f9e96/T6-raw-supplement-30163.tsv';
const T6_RAW_SUPPLEMENT_SHA = '8675b67853b0f212af565ccb1bdfc369f2ef1c9df48ef931d6c046d726bae3af';
const T6_POD68_RECEIPT_SHA = 'aa919654258555f6d7d1fb10c28010c46ba4c32e13c36fc2bdd67fa04cc215ea';
const T6_POD68_FINAL_EVENT_SHA = '5e06a5bc1f4b825d91fb79c550a468d3108b5b7ba9872a226b8e880b28abcf91';
const T6_PARENT_RECEIPT_SHAS: Readonly<Record<string, string>> = Object.freeze({
  'pod-29': '631f8023d5b804a6a0c0387baa1a433ae708aafc9e66c9dc15ec0485ae1f27c4',
  'pod-52': '54cdd40b24776640529e7948e4094bf42859b29a1f2e7752528dde9b43f055c6',
});
const T6_PARENT_CHILDREN: Readonly<Record<string, { attempt: string; failures: number }>> = Object.freeze({
  'pod-29': { attempt: 'd6af4b18-cd3a-44b0-97f1-fea553973ee0', failures: 21 },
  'pod-52': { attempt: '8aad2017-4a02-4cb7-8bf1-ec082c7e8afe', failures: 10 },
});
const T6_SWEEP = '9859f332-56f0-4b96-b9fd-fa133f7b9754';
const T6_CUT_IMAGE = 'sha256:d38c19f2eb30e8ffd4dce727e6f4e326bce3c08c882e122e48e0a85c82f6ba5a';
const T6_RAW_RECEIPT_SHAS: Readonly<Record<string, string>> = Object.freeze({
  'pod-8': 'ab4bacb793b7b2e40ce88bad385bc1f5424fe9b0198921ca2cdb569d01c35660',
  'pod-16': '94c6b5bd79a9f04f3af8820dccb7f658bf37aa554734f5bd272c409bab6cc88a',
  'pod-26': 'ae3aa89e21dbf0781422bb2a3c938b1dc9fefc1f5b55d1dfbb04d93dcc09049a',
  'pod-27': 'c436d56bc01cbfa101eb5518339fda34d66fbff0105bbb4cc81f8773dbd739a6',
  'pod-30': '8d01aadc93ae87261b278cbc233d66c9406b7fd0aeded299958d476e303a3fe2',
  'pod-33': '87afa9d820eb673867ecb55e55962ad465120708edc22fd7e5197c6d2d9a685f',
  'pod-50': '597950e6a1069ec31bd18e7df3f3317b0abea3a19e0fc921c7f08890ad088e9b',
  'pod-59': 'c009a96ae270ab91c5ce5beb7153e949c687197259892e1d6b2f571df8633ef8',
  'pod-78': 'dab6428e462fa1fd1f137b8b75e0ad34ed5739856f2b1aadab1a312b93ab9e06',
});
export const KNOWN_ISSUE_ROUTE = Object.freeze({ graph: 'release-loop', approval: 'gate-heal-decision', gate: 'gate', cut: 'version-release', passed: 'traffic-gate-passed', outcome: 'waived-known-issue' });

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export function validateReleaseKnownIssueWaiverApproval(
  state: GraphRunState, documentBytes: Buffer, tableBytes: Buffer, allowRecordedDecision = false,
  pins = { document: T6_WAIVER_DOCUMENT_SHA, table: T6_WAIVER_TABLE_SHA },
): void {
  if (state.graphId !== KNOWN_ISSUE_ROUTE.graph || state.status !== 'awaiting-approval' || state.dryRun ||
      state.pending?.nodeId !== KNOWN_ISSUE_ROUTE.approval ||
      (allowRecordedDecision ? (state.pending.decision !== 'approved' || state.pending.outcome !== 'waived-known-issue' || state.pending.decidedBy !== 'OP')
        : state.pending.decision !== undefined) ||
      state.path.at(-1) !== KNOWN_ISSUE_ROUTE.approval || state.path.length !== state.nodes.length + 1 ||
      state.path.slice(0, -1).some((node, index) => state.nodes[index]?.nodeId !== node))
    throw new Error('known-issue waiver requires the undecided gate-heal-decision on this release run');
  const gateIndex = state.path.indexOf(KNOWN_ISSUE_ROUTE.gate);
  const gate = state.nodes[gateIndex];
  const gateOutput = lastJsonObject(gate?.output);
  const cut = lastJsonObject(state.nodes.find((record) => record.nodeId === KNOWN_ISSUE_ROUTE.cut)?.output)?.commit;
  if (gateIndex < 0 || state.path.lastIndexOf(KNOWN_ISSUE_ROUTE.gate) !== gateIndex || gate?.nodeId !== KNOWN_ISSUE_ROUTE.gate ||
      gate.ok !== false || gate.executed !== true || gate.waiver !== undefined ||
      gateOutput?.outcome !== 'error' || !Array.isArray(gateOutput.introduced) ||
      gateOutput.introduced.length !== 0 || typeof gateOutput.error !== 'string' ||
      !gateOutput.error.includes('HQ shard result batch is incomplete') ||
      typeof cut !== 'string' || !/^[0-9a-f]{40}$/i.test(cut) || gateOutput.commit !== cut)
    throw new Error('known-issue waiver requires the exact unmeasured gate result with introduced 0 and saved cut');
  if (sha256(documentBytes) !== pins.document || sha256(tableBytes) !== pins.table)
    throw new Error('JUD waiver document or frozen table SHA differs');
  const doc = JSON.parse(documentBytes.toString()) as Record<string, any>;
  const input = state.input as Record<string, unknown> | undefined;
  const guard = doc.requiredConsumptionGuard as Record<string, unknown> | undefined;
  if (doc.type !== 'release-gate-known-issue-waiver' || doc.decision !== 'accept-known-issues' ||
      doc.runId !== state.runId || guard?.runId !== state.runId || doc.version !== input?.version ||
      doc.cut !== cut || guard?.cut !== cut || doc.approvedBy !== 'OP via JUD' ||
      guard?.gateOutputIntroduced !== 0 || guard?.mustCheckFinalGateOutput !== true ||
      guard?.tableSHA256 !== pins.table || guard?.judSignedBy !== 'JUD' ||
      typeof guard?.OPApproval !== 'string' || !guard.OPApproval.includes('30582') ||
      guard?.mustIndependentlyEnumerateUnmeasuredFromRaw !== true ||
      doc.judAttestation?.by !== 'JUD' || doc.judAttestation?.tableSHA256 !== pins.table ||
      doc.table?.sha256 !== pins.table || doc.table?.frozen !== true ||
      !Array.isArray(doc.acceptedIssues) || doc.acceptedIssues.length !== doc.table.rows ||
      !Array.isArray(doc.unmeasuredShards))
    throw new Error('JUD waiver is not bound to this run, cut, OP approval, and frozen table');
  const rows = tableBytes.toString().trimEnd().split(/\r?\n/);
  if (rows.length !== doc.table.rows + 1 || rows[0] !== 'shard\tattempt_id\tkind\texact_test\tobserved\tarea\top_disposition\traw_log\tjunit')
    throw new Error('JUD waiver table row count or schema differs');
  const unmeasured = rows.slice(1).flatMap((row) => {
    const cells = row.split('\t');
    if (cells.length < 3) throw new Error('JUD waiver table row is malformed');
    return cells[2] === 'unmeasured' ? [cells[0]!] : [];
  }).sort();
  if (JSON.stringify(unmeasured) !== JSON.stringify([...doc.unmeasuredShards].sort()) ||
      !unmeasured.includes('pod-68'))
    throw new Error('JUD waiver unmeasured shard set differs from the frozen table');
}

export function assertReleaseKnownIssueWaiverApproval(state: GraphRunState, root: string, allowRecordedDecision = false): void {
  // Isolated --test universes may carry fixture evidence under their own root.
  // The live instance reads the pinned JUD adjudication from the HQ seat state.
  const evidenceRoot = root === join(homedir(), '.elanous')
    ? join(homedir(), 'elanous-hq', 'seat-state') : join(root, 'seat-state');
  const document = readFileSync(join(evidenceRoot, T6_WAIVER_DOCUMENT));
  const doc = JSON.parse(document.toString()) as { unmeasuredShards: string[] };
  const table = readFileSync(join(evidenceRoot, T6_WAIVER_TABLE));
  validateReleaseKnownIssueWaiverApproval(state, document, table, allowRecordedDecision);
  assertT6RawUnmeasuredEvidence(state, root, evidenceRoot, doc.unmeasuredShards, table);
}

function assertT6RawUnmeasuredEvidence(state: GraphRunState, root: string, evidenceRoot: string, expected: string[], table: Buffer): void {
  const rawBase = join(root, 'release/0.3.15/gate-logs');
  const supplement = readFileSync(join(evidenceRoot, T6_RAW_SUPPLEMENT));
  if (sha256(supplement) !== T6_RAW_SUPPLEMENT_SHA) throw new Error('T6 raw supplement SHA differs');
  const lines = supplement.toString().trimEnd().split(/\r?\n/);
  if (lines[0] !== 'table_row\tshard\tattempt_id\texact_test\treference\tsha256\tstatus\tnote')
    throw new Error('T6 raw supplement schema differs');
  const cut = lastJsonObject(state.nodes.find((record) => record.nodeId === KNOWN_ISSUE_ROUTE.cut)?.output)?.commit;
  const corroborated = lines.slice(1).flatMap((line) => {
    const cells = line.split('\t');
    if (cells[6] !== 'unmeasured-receipt') return [];
    const shard = cells[1]!;
    if (!/^pod-(?:[0-9]|[1-7][0-9])$/.test(shard) || !cells[4]?.endsWith(`/release/0.3.15/gate-logs/cut/${shard}.log`) ||
        !/^[0-9a-f]{64}$/.test(cells[5] ?? '') || sha256(readFileSync(join(rawBase, 'cut', `${shard}.log`))) !== cells[5])
      throw new Error('T6 unmeasured raw log reference or SHA differs');
    const receipt = readFileSync(join(rawBase, 'cut', `${shard}.json`));
    const details = JSON.parse(receipt.toString()) as Record<string, unknown>;
    if (sha256(receipt) !== T6_RAW_RECEIPT_SHAS[shard] || details.sweepId !== T6_SWEEP || details.commit !== cut ||
        typeof details.runKey !== 'string' || !/^[0-9a-f]{64}$/.test(details.runKey) ||
        typeof details.attemptId !== 'string' || !/^[0-9a-f-]{36}$/.test(details.attemptId) ||
        !Array.isArray(details.files) || details.files.length === 0)
      throw new Error('T6 unmeasured cut receipt identity differs');
    return [shard];
  });
  const receipt = readFileSync(join(rawBase, 'cut/pod-68.json'));
  if (sha256(receipt) !== T6_POD68_RECEIPT_SHA) throw new Error('T6 pod-68 receipt SHA differs');
  const pod68 = JSON.parse(receipt.toString()) as Record<string, unknown>;
  if (pod68.sweepId !== T6_SWEEP || pod68.commit !== cut || pod68.attemptId !== 'ae583281-fa15-4046-8ab3-a89e0249ef19' ||
      pod68.jobName !== 'gate-195d3960-0ce7-43a4-9f1a-7f0c4b2be876' || pod68.rc !== null ||
      pod68.jobFailed !== true || pod68.completed !== true || !Array.isArray(pod68.files) || pod68.files.length !== 98)
    throw new Error('T6 pod-68 receipt does not prove the incomplete cut attempt');
  const ledger = readFileSync(join(rawBase, 'shard-ledger.jsonl'), 'utf8');
  const lastByShard = new Map<string, { line: string; event: Record<string, unknown> }>();
  for (const line of ledger.trimEnd().split(/\r?\n/)) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.runId !== state.runId || event.invocationId !== T6_SWEEP || event.phase !== 'cut') continue;
    if (typeof event.shardId !== 'string' || event.commit !== cut)
      throw new Error('T6 cut ledger lineage differs');
    lastByShard.set(event.shardId, { line, event });
  }
  const parentEntries = [...lastByShard].filter(([shard]) => /^pod-(?:[0-9]|[1-7][0-9])$/.test(shard));
  if (parentEntries.length !== 80 || parentEntries.some(([, { event }]) =>
    (event.state !== 'done' && event.state !== 'failed') ||
    (event.attribution !== 'complete' && event.attribution !== 'unmeasured')))
    throw new Error('T6 cut ledger has missing or nonterminal parent shards');
  const actualUnmeasured = parentEntries.filter(([, { event }]) => event.attribution === 'unmeasured')
    .map(([shard]) => shard).sort();
  if (JSON.stringify(actualUnmeasured) !== JSON.stringify([...expected].sort()))
    throw new Error('T6 final ledger unmeasured set differs from the signed JUD waiver');
  const final = lastByShard.get('pod-68')?.line;
  const finalEvent = lastByShard.get('pod-68')?.event;
  if (!final || sha256(final) !== T6_POD68_FINAL_EVENT_SHA || finalEvent?.state !== 'failed' ||
      finalEvent.stopReason !== 'image-pin-mismatch' || finalEvent.attemptId !== pod68.attemptId || finalEvent.commit !== cut)
    throw new Error('T6 pod-68 final ledger event differs');
  const corroboratedSet = [...corroborated, 'pod-68'].sort();
  if (new Set(corroboratedSet).size !== corroboratedSet.length ||
      corroboratedSet.some((shard) => !actualUnmeasured.includes(shard)))
    throw new Error('T6 raw supplement differs from the final ledger');
  for (const [parent, child] of Object.entries(T6_PARENT_CHILDREN)) {
    const receipt = readFileSync(join(rawBase, 'cut', `${parent}.json`));
    const details = JSON.parse(receipt.toString()) as Record<string, unknown>;
    const parentEvent = lastByShard.get(parent)?.event;
    const childEvent = lastByShard.get(`${parent}-n`)?.event;
    const childFailureIds = Array.isArray(childEvent?.failureIds) ? childEvent.failureIds as string[] : undefined;
    const tableRows = table.toString().trimEnd().split(/\r?\n/).slice(1).map((line) => line.split('\t'));
    const parentRow = tableRows.find((cells) => cells[0] === parent && cells[2] === 'unmeasured');
    const namedFailures = tableRows.filter((cells) => cells[0]?.startsWith(`${parent}-`) && cells[2] === 'fail')
      .map((cells) => cells[3]);
    if (sha256(receipt) !== T6_PARENT_RECEIPT_SHAS[parent] || details.sweepId !== T6_SWEEP ||
        details.commit !== cut || parentRow?.[1] !== details.attemptId ||
        parentEvent?.state !== 'done' || parentEvent.attribution !== 'unmeasured' ||
        parentEvent.fail !== child.failures || childEvent?.state !== 'done' ||
        childEvent.attribution !== 'complete' || childEvent.attemptId !== child.attempt ||
        childEvent.fail !== child.failures || !childFailureIds ||
        new Set(childFailureIds).size !== child.failures ||
        namedFailures.length !== child.failures || new Set(namedFailures).size !== child.failures ||
        namedFailures.some((name) => !childFailureIds.includes(name ?? '')) ||
        childEvent.imageDigest !== T6_CUT_IMAGE || childEvent.measuredImageDigest !== T6_CUT_IMAGE ||
        parentEvent.imageDigest !== T6_CUT_IMAGE || parentEvent.measuredImageDigest !== T6_CUT_IMAGE)
      throw new Error('T6 parent and child attribution proof differs');
  }
}
