import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defaultMsgStorePath, openMsgStoreReadOnly, type Message } from '../msg/msg-store.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { countsAsReal, runtimeUniverse } from '../provenance/provenance.js';
import type { GraphRunState } from './runner-types.js';
import { assertPwaOutputBoundToChild } from './release-pwa-known-issue.js';
import { loadReleaseGraphManifest } from './release-graph-manifest.js';

/** OP #32150: the policy is the sole fixed SHA. Mail rows bind each fresh packet. */
export const PWA_POLICY_SHA256 = '993f59774d1df1653afcb1e1da135d802571caeab5729e9940131a8e9d2ce261';
const SHA = /^[a-f0-9]{64}$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const CUT = /^[a-f0-9]{40}$/;
const MAIL_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function bytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('PWA packet evidence must be a regular file');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function validRelativeEvidence(path: unknown, seat: 'REL' | 'JUD'): path is string {
  return typeof path === 'string' && path.startsWith(`${seat}/evidence/`)
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'
      && /^[A-Za-z0-9._-]+$/.test(part));
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Resolve release identities from the declared plugin graph, not a parallel list in this verifier. */
function pwaRoute() {
  const manifest = loadReleaseGraphManifest(join(import.meta.dir, '../../graphs/release/plugin.json'));
  const graph = parseYaml(manifest.graphSources[0] ?? '') as {
    graph_id?: string; entry_node?: string;
    edges?: Array<{ from?: string; on?: string; branches?: { ok?: string[] }; join?: string }>;
  };
  const edges = graph.edges?.filter(edge => edge.on === 'outcome' && edge.branches?.ok?.includes('pwa')) ?? [];
  const edge = edges[0];
  if (graph.graph_id !== manifest.schema.graphId || !graph.entry_node
    || !manifest.nodeIds.includes(graph.entry_node) || edges.length !== 1 || !edge?.from || !edge.join
    || !Array.isArray(edge.branches?.ok) || edge.branches.ok.length < 2
    || new Set(edge.branches.ok).size !== edge.branches.ok.length
    || !edge.branches.ok.every(node => manifest.nodeIds.includes(node))
    || !manifest.nodeIds.includes(edge.from) || !manifest.nodeIds.includes(edge.join))
    throw new Error('PWA release route unavailable from declared graph');
  return { graphId: manifest.schema.graphId, cutNode: graph.entry_node,
    from: edge.from, join: edge.join, siblings: edge.branches.ok.filter(node => node !== 'pwa') };
}

export interface PwaMailPacket {
  schemaVersion: 1;
  runId: string;
  version: string;
  cut: string;
  childRun: string;
  childStateSha256: string;
  policySha256: string;
  issuedAt: string;
  expiresAt: string;
  pairedLog: { path: string; sha256: string };
  independentProof: { path: string; sha256: string };
}
export interface PwaMailPin {
  schemaVersion: 1;
  packetSha256: string;
  judMessageId: number;
  opMessageId: number;
  judMessageSha256: string;
  opMessageSha256: string;
}

/** The immutable row includes an explicit null for ordinary operational mail. */
export function pwaMailRowSha256(message: Message): string {
  if (!Number.isSafeInteger(message.id) || message.id < 1
    || [message.from, message.to, message.kind, message.body, message.createdAt].some(value => typeof value !== 'string'))
    throw new Error('invalid PWA mail row');
  return sha256(Buffer.from(JSON.stringify([message.id, message.from, message.to,
    message.kind, message.body, message.createdAt, message.provenance ?? null]), 'utf8'));
}

export function isOperationalPwaMailSource(root: string, effectiveRoot: string, prodRoot: string,
  dbPath: string, injectedLookup: boolean, universe: 'prod' | 'test' | 'sim'): boolean {
  return !injectedLookup && universe === 'prod' && root === prodRoot && effectiveRoot === prodRoot
    && dbPath === join(prodRoot, 'msg', 'messages.db');
}

export function pwaMailPaths(root: string, version: string, runId: string, packetSha256: string) {
  if (!VERSION.test(version) || !RUN.test(runId) || !SHA.test(packetSha256)) throw new Error('invalid PWA packet identity');
  const directory = join(root, 'release', version, 'pwa-known-issue', runId);
  return { pin: join(directory, 'pin.json'), packet: join(directory, `${packetSha256}.json`) };
}

/** A packet/pin is untrusted until both immutable OP/JUD mail rows and original raw bytes agree. */
export function assertPwaMailWaiver(
  state: GraphRunState, root: string, recorded: boolean,
  getMessage?: (id: number) => Message | null,
): Pick<PwaMailPin, 'packetSha256' | 'judMessageSha256'> & { pairedLogSha256: string } {
  const route = pwaRoute();
  if (state.graphId !== route.graphId || state.dryRun || !RUN.test(state.runId)
    || (!recorded && state.status !== 'failed')) throw new Error('PWA mail waiver requires a failed release run');
  const version = (state.input as { version?: unknown } | undefined)?.version;
  const cutNode = state.nodes.find(node => node.nodeId === route.cutNode);
  let cut: unknown;
  try { cut = JSON.parse(String(cutNode?.output ?? '{}')).commit; } catch { /* invalid source */ }
  const inputCut = (state.input as { cutCommit?: unknown } | undefined)?.cutCommit;
  if (typeof version !== 'string' || !VERSION.test(version) || version !== '0.3.15'
    || typeof cut !== 'string' || !CUT.test(cut)
    || (inputCut !== undefined && inputCut !== cut))
    throw new Error('PWA mail waiver run version or cut unavailable');
  const fanout = state.fanOuts?.[`${route.from}:ok`];
  const branch = fanout?.branches.pwa;
  if (fanout?.from !== route.from || fanout.join !== route.join
    || branch?.status !== 'failed' || !RUN.test(branch.runId)
    || !state.path.includes(route.join)
    || (!recorded && state.nodes.find(node => node.nodeId === route.join)?.ok !== false)
    || route.siblings.some(id => fanout.branches[id]?.status !== 'done')
    || Object.keys(fanout.branches).some(id => id !== 'pwa' && !route.siblings.includes(id)))
    throw new Error('PWA mail waiver requires the saved failed fan-out');
  const directory = join(root, 'release', version, 'pwa-known-issue', state.runId);
  const pinValue: unknown = JSON.parse(bytes(join(directory, 'pin.json')).toString('utf8'));
  if (!object(pinValue) || pinValue.schemaVersion !== 1 || typeof pinValue.packetSha256 !== 'string'
    || !SHA.test(pinValue.packetSha256) || !Number.isSafeInteger(pinValue.judMessageId)
    || !Number.isSafeInteger(pinValue.opMessageId) || (pinValue.judMessageId as number) < 1
    || (pinValue.opMessageId as number) <= (pinValue.judMessageId as number)
    || typeof pinValue.judMessageSha256 !== 'string' || !SHA.test(pinValue.judMessageSha256)
    || typeof pinValue.opMessageSha256 !== 'string' || !SHA.test(pinValue.opMessageSha256))
    throw new Error('PWA mail pin invalid');
  const pin = pinValue as unknown as PwaMailPin;
  const paths = pwaMailPaths(root, version, state.runId, pin.packetSha256);
  const packetBytes = bytes(paths.packet);
  if (sha256(packetBytes) !== pin.packetSha256) throw new Error('PWA packet SHA differs');
  const packetValue: unknown = JSON.parse(packetBytes.toString('utf8'));
  if (!object(packetValue) || packetValue.schemaVersion !== 1
    || packetValue.runId !== state.runId || packetValue.version !== version || packetValue.cut !== cut
    || packetValue.childRun !== branch.runId || packetValue.policySha256 !== PWA_POLICY_SHA256
    || typeof packetValue.childStateSha256 !== 'string' || !SHA.test(packetValue.childStateSha256)
    || typeof packetValue.issuedAt !== 'string' || typeof packetValue.expiresAt !== 'string'
    || !object(packetValue.pairedLog) || !object(packetValue.independentProof)
    || !validRelativeEvidence(packetValue.pairedLog.path, 'REL')
    || !validRelativeEvidence(packetValue.independentProof.path, 'JUD')
    || typeof packetValue.pairedLog.sha256 !== 'string' || !SHA.test(packetValue.pairedLog.sha256)
    || typeof packetValue.independentProof.sha256 !== 'string' || !SHA.test(packetValue.independentProof.sha256))
    throw new Error('PWA packet identity or evidence invalid');
  const packet = packetValue as unknown as PwaMailPacket;
  const now = Date.now(), issued = Date.parse(packet.issuedAt), expires = Date.parse(packet.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now || expires <= issued)
    throw new Error('PWA packet expired or future');
  const prodRoot = prodInstanceRoot();
  const seatState = root === prodRoot ? join(prodRoot, '..', 'elanous-hq', 'seat-state') : join(root, 'seat-state');
  const paired = bytes(join(seatState, packet.pairedLog.path));
  const proofBytes = bytes(join(seatState, packet.independentProof.path));
  if (sha256(paired) !== packet.pairedLog.sha256 || sha256(proofBytes) !== packet.independentProof.sha256)
    throw new Error('PWA paired raw or independent proof SHA differs');
  const proof: unknown = JSON.parse(proofBytes.toString('utf8'));
  if (!object(proof) || proof.runId !== state.runId || proof.cut !== cut || proof.childRun !== branch.runId
    || proof.childStateSha256 !== packet.childStateSha256 || proof.pairedLogSha256 !== packet.pairedLog.sha256
    || !Array.isArray(proof.observedNewFailureIds) || proof.observedNewFailureIds.length !== 0)
    throw new Error('PWA independent proof does not bind this run or paired raw');
  assertPwaOutputBoundToChild(branch.output, bytes(join(root, 'graph-runs', route.graphId, `${branch.runId}.json`)),
    packet.childStateSha256, branch.runId);
  let output: { outcome?: string; verdict?: string; commit?: string; withCostly?: boolean; cells?: Array<{ id?: string; first?: string; final?: string; reruns?: string[] }> };
  try { output = JSON.parse(String(branch.output)); } catch { throw new Error('PWA original output unavailable'); }
  const cells = output.cells ?? [];
  const passed = ['T1', 'T1b', 'T4a', 'T5', 'T5b', 'C2a', 'C2b'];
  if (output.outcome !== 'fail' || output.verdict !== 'fail' || output.commit !== cut || output.withCostly !== false
    || cells.length !== 10 || new Set(cells.map(cell => cell.id)).size !== 10
    || passed.some(id => !cells.some(cell => cell.id === id && cell.first === 'pass' && cell.final === 'pass' && cell.reruns?.length === 0))
    || JSON.stringify(cells.filter(cell => cell.final === 'fail').map(cell => cell.id).sort()) !== JSON.stringify(['N1', 'N5a', 'N6a'])
    || cells.filter(cell => cell.final === 'fail').some(cell => JSON.stringify(cell.reruns) !== JSON.stringify(['fail', 'fail'])))
    throw new Error('PWA original failure cells differ');
  const operationalMail = isOperationalPwaMailSource(root, effectiveInstanceRoot(), prodRoot,
    defaultMsgStorePath(), getMessage !== undefined, runtimeUniverse());
  const verify = (lookup: (id: number) => Message | null) => {
    const jud = lookup(pin.judMessageId), op = lookup(pin.opMessageId);
    if (!jud || !op || jud.id !== pin.judMessageId || op.id !== pin.opMessageId
      || jud.from !== 'JUD' || op.from !== 'OP' || jud.to !== 'REL' || op.to !== 'REL'
      || jud.kind !== 'coord' || op.kind !== 'coord'
      || (jud.provenance == null ? !operationalMail : !countsAsReal(jud.provenance))
      || (op.provenance == null ? !operationalMail : !countsAsReal(op.provenance))
      || pwaMailRowSha256(jud) !== pin.judMessageSha256 || pwaMailRowSha256(op) !== pin.opMessageSha256
      || jud.body !== `DISPOSITION-ATTEST ${pin.packetSha256} ${PWA_POLICY_SHA256} ${state.runId}`
      || op.body !== `DISPOSITION-APPROVE ${pin.packetSha256}`
      || !MAIL_TIME.test(jud.createdAt) || !MAIL_TIME.test(op.createdAt)
      || Date.parse(jud.createdAt) < issued || Date.parse(jud.createdAt) > Date.parse(op.createdAt)
      || Date.parse(op.createdAt) >= expires || !Number.isFinite(Date.parse(jud.createdAt))
      || !Number.isFinite(Date.parse(op.createdAt))) throw new Error('PWA OP/JUD durable mail proof invalid');
  };
  if (getMessage) {
    if (runtimeUniverse() === 'prod') throw new Error('PWA mail proof requires operational ledger ID lookup');
    verify(getMessage);
  }
  else {
    if (!operationalMail) throw new Error('PWA mail proof requires operational ledger ID lookup');
    const store = openMsgStoreReadOnly(defaultMsgStorePath());
    try { verify(id => store.getMessage(id)); } finally { store.close(); }
  }
  if (recorded) {
    if (branch.waiver?.verdict !== 'waived' || branch.waiver.decidedBy !== 'OP'
      || branch.waiver.documentSha256 !== pin.packetSha256
      || branch.waiver.signatureSha256 !== pin.judMessageSha256
      || branch.waiver.pairedLogSha256 !== packet.pairedLog.sha256
      || branch.waiver.originalStatus !== 'failed' || !branch.waiver.reason)
      throw new Error('PWA saved waiver differs from actual mail proof');
  } else if (branch.waiver !== undefined) throw new Error('PWA waiver already recorded');
  return { packetSha256: pin.packetSha256, judMessageSha256: pin.judMessageSha256,
    pairedLogSha256: packet.pairedLog.sha256 };
}
