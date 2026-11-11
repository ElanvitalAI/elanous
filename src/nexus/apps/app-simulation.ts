import type { SimReceipt } from '../../ux-sim/sim-receipt.js';

const APP_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface AppSimulationEvent {
  readonly id: string;
  readonly kind: 'app.sim.step';
  readonly appId: string;
  readonly runId: string;
  readonly ts: number;
  readonly data: { readonly step: string; readonly message: string; readonly receiptId: string; readonly path?: string; readonly status?: number; readonly assetCount?: number; readonly artifactSha256?: string };
}

export interface AppSimulationReceipt {
  readonly id: string;
  readonly appId: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly outcome: 'passed' | 'failed';
  readonly summary: string;
  /** Source tree identity at simulation time; absent on legacy receipts, which cannot be promoted. */
  readonly appFingerprint?: string;
  readonly conceptProof?: SimReceipt;
}

export interface AppSimulationSnapshot {
  readonly status: 'passed' | 'failed' | 'not-created' | 'unavailable';
  readonly runId?: string;
  readonly events: readonly AppSimulationEvent[];
  readonly receipts: readonly AppSimulationReceipt[];
}

export interface AppSimulationResult {
  readonly runId: string;
  readonly events: readonly Omit<AppSimulationEvent, 'id'>[];
  readonly receipts: readonly Omit<AppSimulationReceipt, 'createdAt'>[];
}

/** Receipts are newest-first; prefer a current passing proof, otherwise retain the newest proof for fail-closed display. */
export function resolveConceptProofForFingerprint(
  receipts: readonly Pick<AppSimulationReceipt, 'conceptProof'>[],
  currentFingerprint: string,
): SimReceipt | undefined {
  const proofs = receipts.flatMap(receipt => receipt.conceptProof ? [receipt.conceptProof] : []);
  return proofs.find(proof => proof.appFingerprint === currentFingerprint && proof.verdict === 'passed') ?? proofs[0];
}

export function validateAppSimulationResult(value: unknown): AppSimulationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid app simulation result');
  const input = value as Record<string, unknown>;
  if (typeof input.runId !== 'string' || !OPAQUE_ID.test(input.runId)) throw new Error('invalid app simulation run id');
  const runId = input.runId;
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 100) throw new Error('invalid app simulation events');
  const events = input.events.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid app simulation event');
    const event = row as Record<string, unknown>;
    const data = event.data;
    if (event.kind !== 'app.sim.step' || typeof event.appId !== 'string' || !APP_ID.test(event.appId)
      || event.runId !== runId || typeof event.ts !== 'number' || !Number.isSafeInteger(event.ts)
      || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid app simulation event');
    const details = data as Record<string, unknown>;
    // Source: src/ux-sim/world.ts emits namespaced app execution steps such as rpc.addNote.completed.
    if (typeof details.step !== 'string' || !/^[a-z][a-zA-Z0-9-]{0,63}(?:\.[a-zA-Z][a-zA-Z0-9-]{0,63})*$/.test(details.step)
      || typeof details.message !== 'string' || details.message.length > 500
      || typeof details.receiptId !== 'string' || !OPAQUE_ID.test(details.receiptId)) throw new Error('invalid app simulation event data');
    if ((details.path === undefined) !== (details.status === undefined)
      || (details.path !== undefined && (typeof details.path !== 'string' || !/^\/(?:[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)*)?$/.test(details.path)
        || details.path.split('/').some(segment => segment === '.' || segment === '..')))
      || (details.status !== undefined && (typeof details.status !== 'number' || !Number.isSafeInteger(details.status) || details.status < 100 || details.status > 599))) {
      throw new Error('invalid app simulation route evidence');
    }
    if (details.assetCount !== undefined && (typeof details.assetCount !== 'number' || !Number.isSafeInteger(details.assetCount) || details.assetCount < 0)) {
      throw new Error('invalid app simulation asset evidence');
    }
    if (details.artifactSha256 !== undefined && (typeof details.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(details.artifactSha256))) {
      throw new Error('invalid app simulation artifact evidence');
    }
    const routeEvidence: { path?: string; status?: number } = details.path === undefined ? {}
      : { path: details.path as string, status: details.status as number };
    const assetEvidence = details.assetCount === undefined ? {} : { assetCount: details.assetCount as number };
    const artifactEvidence = details.artifactSha256 === undefined ? {} : { artifactSha256: details.artifactSha256 as string };
    return { kind: 'app.sim.step' as const, appId: event.appId, runId, ts: event.ts,
      data: { step: details.step, message: details.message, receiptId: details.receiptId, ...routeEvidence, ...assetEvidence, ...artifactEvidence } };
  });
  if (!Array.isArray(input.receipts) || input.receipts.length < 1 || input.receipts.length > 20) throw new Error('invalid app simulation receipts');
  const receipts = input.receipts.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid app simulation receipt');
    const receipt = row as Record<string, unknown>;
    if (typeof receipt.id !== 'string' || !OPAQUE_ID.test(receipt.id) || typeof receipt.appId !== 'string' || !APP_ID.test(receipt.appId)
      || receipt.runId !== runId || (receipt.outcome !== 'passed' && receipt.outcome !== 'failed')
      || typeof receipt.summary !== 'string' || receipt.summary.length > 240
      || (receipt.appFingerprint !== undefined && (typeof receipt.appFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.appFingerprint)))) throw new Error('invalid app simulation receipt');
    const outcome = receipt.outcome as 'passed' | 'failed';
    return { id: receipt.id, appId: receipt.appId, runId, outcome, summary: receipt.summary as string,
      ...(receipt.appFingerprint === undefined ? {} : { appFingerprint: receipt.appFingerprint as string }) };
  });
  const receiptIds = new Set(receipts.map((receipt) => receipt.id));
  if (events.some((event) => !receiptIds.has(event.data.receiptId) || !receipts.some((receipt) => receipt.id === event.data.receiptId && receipt.appId === event.appId))) {
    throw new Error('app simulation event must reference its app receipt');
  }
  return { runId, events, receipts };
}
