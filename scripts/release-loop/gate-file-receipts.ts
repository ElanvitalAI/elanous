import { createHash } from 'node:crypto';
import { buildClosureGraph, type ClosureTree } from './gate-closure.js';

export interface GateFileReceiptIdentity {
  file: string;
  closureFiles: readonly string[];
  contentHashes: Readonly<Record<string, string>>;
  imageDigest: string;
  /** Why the closure is incomplete. Such receipts are evidence only and are never reusable. */
  opaqueReasons?: readonly string[];
}

export interface GateFileReceipt {
  file: string;
  closureFiles: string[];
  closureDigest: string;
  imageDigest: string;
  key: string;
  /** Commit whose tests were actually measured; immutable when the receipt is carried. */
  sourceHead40: string;
  /** Later commit that reused this measurement without rerunning the test. */
  carriedToHead40?: string;
  outcome: 'pass' | 'fail' | 'error';
  failureIds?: string[];
  errorIds?: string[];
  owner?: string;
  lane?: 'train' | 'cut' | 'isolated-recheck';
  /** Persisted diagnostic for a measured file whose runtime inputs cannot be named statically. */
  opaqueReasons?: string[];
  evidence: unknown;
}

export interface GateFileReceiptEnvelope extends GateFileReceipt {
  recordSha256: string;
}

/** Hash every tracked input reachable from one test, including literal non-code assets; opaque/missing inputs fail closed. */
export function gateFileReceiptIdentityFromClosure(tree: ClosureTree, file: string, imageDigest: string): GateFileReceiptIdentity | null {
  if (!tree.files.includes(file) || !/^sha256:[a-f0-9]{64}$/i.test(imageDigest)) return null;
  const graph = buildClosureGraph(tree);
  const pending = [file];
  const closure = new Set<string>();
  const opaqueReasons = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (closure.has(current)) continue;
    if (!graph.tracked.has(current)) {
      opaqueReasons.add(`${current}: untracked closure input`);
      continue;
    }
    const opaque = graph.opaque.get(current);
    if (opaque) opaqueReasons.add(`${current}: ${opaque}`);
    closure.add(current);
    pending.push(...(graph.forward.get(current) ?? []));
  }
  const contentHashes: Record<string, string> = {};
  for (const path of [...closure].sort()) {
    const content = tree.read(path);
    if (content === undefined) {
      const reason = `${path}: unreadable closure input`;
      opaqueReasons.add(reason);
      contentHashes[path] = createHash('sha256').update(`opaque:${reason}`).digest('hex');
    } else contentHashes[path] = createHash('sha256').update(content).digest('hex');
  }
  return { file, closureFiles: [...closure].sort(), contentHashes, imageDigest,
    ...(opaqueReasons.size ? { opaqueReasons: [...opaqueReasons].sort() } : {}) };
}

export function gateFileReceiptClosureDigest(identity: GateFileReceiptIdentity): string {
  const files = [...new Set(identity.closureFiles)].sort();
  const payload = identity.opaqueReasons?.length
    ? { files: files.map((file) => [file, identity.contentHashes[file]]), opaqueReasons: [...identity.opaqueReasons].sort() }
    : files.map((file) => [file, identity.contentHashes[file]]);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Content address for one test's full import closure and the immutable execution image. */
export function gateFileReceiptKey(identity: GateFileReceiptIdentity): string | null {
  const files = [...new Set(identity.closureFiles)].sort();
  if (!identity.file || !files.includes(identity.file) || !/^sha256:[a-f0-9]{64}$/i.test(identity.imageDigest)) return null;
  if (files.some((file) => !/^[a-f0-9]{64}$/i.test(identity.contentHashes[file] ?? ''))) return null;
  const closureDigest = gateFileReceiptClosureDigest(identity);
  return gateFileReceiptKeyFromClosureDigest(identity.file, closureDigest, identity.imageDigest);
}

export function gateFileReceiptKeyFromClosureDigest(file: string, closureDigest: string, imageDigest: string): string | null {
  if (!file || !/^[a-f0-9]{64}$/i.test(closureDigest) || !/^sha256:[a-f0-9]{64}$/i.test(imageDigest)) return null;
  return createHash('sha256').update(JSON.stringify([file, closureDigest, imageDigest])).digest('hex');
}

function validIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string' && id.trim().length > 0);
}

function reusableReceiptShape(receipt: GateFileReceipt): boolean {
  return typeof receipt.sourceHead40 === 'string' && /^[a-f0-9]{40}$/i.test(receipt.sourceHead40)
    && (receipt.carriedToHead40 === undefined || (typeof receipt.carriedToHead40 === 'string' && /^[a-f0-9]{40}$/i.test(receipt.carriedToHead40)))
    && (receipt.lane === undefined || ['train', 'cut', 'isolated-recheck'].includes(receipt.lane))
    && (receipt.opaqueReasons === undefined || (Array.isArray(receipt.opaqueReasons)
      && receipt.opaqueReasons.length > 0 && receipt.opaqueReasons.every((reason) => typeof reason === 'string' && !!reason.trim())))
    && !!receipt.key && !!receipt.file && Array.isArray(receipt.closureFiles) && receipt.closureFiles.includes(receipt.file)
    && /^sha256:[a-f0-9]{64}$/i.test(receipt.imageDigest)
    && receipt.key === gateFileReceiptKeyFromClosureDigest(receipt.file, receipt.closureDigest, receipt.imageDigest)
    && (receipt.outcome === 'pass' || (typeof receipt.owner === 'string' && !!receipt.owner.trim()
      && receipt.outcome === 'fail' && validIds(receipt.failureIds))
      || (typeof receipt.owner === 'string' && !!receipt.owner.trim() && receipt.outcome === 'error' && validIds(receipt.errorIds)))
    && ['pass', 'fail', 'error'].includes(receipt.outcome);
}

/** Reuse file receipts independently. Missing or malformed closure/image evidence fails closed per file. */
export function planGateFileReceipts(input: {
  current: readonly GateFileReceiptIdentity[];
  receipts: readonly GateFileReceipt[];
}): { reuse: GateFileReceipt[]; measure: GateFileReceiptIdentity[] } {
  const byFile = new Map<string, GateFileReceipt[]>();
  let malformedReceipt = false;
  for (const value of input.receipts as readonly unknown[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { malformedReceipt = true; continue; }
    const receipt = value as GateFileReceipt;
    if (typeof receipt.file !== 'string') { malformedReceipt = true; continue; }
    byFile.set(receipt.file, [...(byFile.get(receipt.file) ?? []), receipt]);
  }
  const expected = new Set(input.current.map((identity) => identity.file));
  const seenExpected = new Set<string>();
  const duplicateExpected = new Set(input.current.flatMap(({ file }) => {
    if (seenExpected.has(file)) return [file];
    seenExpected.add(file);
    return [];
  }));
  const hasExtraReceipt = malformedReceipt || [...byFile.keys()].some((file) => !expected.has(file));
  const reuse: GateFileReceipt[] = [];
  const measure: GateFileReceiptIdentity[] = [];
  for (const identity of input.current) {
    const key = gateFileReceiptKey(identity);
    const matches = byFile.get(identity.file) ?? [];
    const receipt = matches.length === 1 && reusableReceiptShape(matches[0]!) ? matches[0] : undefined;
    if (!identity.opaqueReasons?.length && !hasExtraReceipt && !duplicateExpected.has(identity.file) && receipt && receipt.key === key && receipt.imageDigest === identity.imageDigest
      && JSON.stringify([...receipt.closureFiles].sort()) === JSON.stringify([...identity.closureFiles].sort())) reuse.push(receipt);
    else measure.push(identity);
  }
  return { reuse, measure };
}

/** Require current identities and one valid, attributable receipt per file before a sweep is complete. */
export function auditGateFileReceiptSet(input: { identities: readonly GateFileReceiptIdentity[]; receipts: readonly GateFileReceipt[] }):
  { ok: true; files: string[] } | { ok: false; reason: string } {
  const expected = input.identities.map(({ file }) => file).sort();
  if (new Set(expected).size !== expected.length) return { ok: false, reason: 'duplicate expected file' };
  for (const value of input.receipts as readonly unknown[]) {
    if (!value || typeof value !== 'object') return { ok: false, reason: 'invalid receipt record' };
    const receipt = value as Partial<GateFileReceipt>;
    if (typeof receipt.file !== 'string' || !Array.isArray(receipt.closureFiles)
      || receipt.closureFiles.some((path) => typeof path !== 'string')
      || (receipt.opaqueReasons !== undefined && (!Array.isArray(receipt.opaqueReasons)
        || receipt.opaqueReasons.some((reason) => typeof reason !== 'string' || !reason.trim())))
      || (receipt.owner !== undefined && typeof receipt.owner !== 'string')
      || (receipt.carriedToHead40 !== undefined && typeof receipt.carriedToHead40 !== 'string')
      || typeof receipt.imageDigest !== 'string' || typeof receipt.sourceHead40 !== 'string'
      || typeof receipt.closureDigest !== 'string' || typeof receipt.key !== 'string') return { ok: false, reason: 'invalid receipt record' };
  }
  const byFile = new Map<string, GateFileReceipt[]>();
  for (const receipt of input.receipts) byFile.set(receipt.file, [...(byFile.get(receipt.file) ?? []), receipt]);
  if (input.receipts.length !== expected.length || [...byFile.keys()].some((file) => !expected.includes(file)))
    return { ok: false, reason: 'receipt inventory mismatch' };
  const identityByFile = new Map(input.identities.map((identity) => [identity.file, identity]));
  for (const file of expected) {
    const rows = byFile.get(file) ?? [];
    if (rows.length !== 1) return { ok: false, reason: `expected one receipt for ${file}, found ${rows.length}` };
    const receipt = rows[0]!;
    const identity = identityByFile.get(file)!;
    const expectedKey = gateFileReceiptKey(identity);
    if (!expectedKey || receipt.key !== expectedKey || receipt.imageDigest !== identity.imageDigest
      || JSON.stringify([...(receipt.opaqueReasons ?? [])].sort()) !== JSON.stringify([...(identity.opaqueReasons ?? [])].sort())
      || JSON.stringify([...receipt.closureFiles].sort()) !== JSON.stringify([...identity.closureFiles].sort()))
      return { ok: false, reason: `receipt identity mismatch for ${file}` };
    if (!receipt.key || receipt.key !== gateFileReceiptKeyFromClosureDigest(receipt.file, receipt.closureDigest, receipt.imageDigest))
      return { ok: false, reason: `invalid content key for ${file}` };
    if (!/^[a-f0-9]{40}$/i.test(receipt.sourceHead40)
      || (receipt.carriedToHead40 !== undefined && !/^[a-f0-9]{40}$/i.test(receipt.carriedToHead40)))
      return { ok: false, reason: `invalid receipt head for ${file}` };
    if (!['pass', 'fail', 'error'].includes(receipt.outcome)
      || (receipt.lane !== undefined && !['train', 'cut', 'isolated-recheck'].includes(receipt.lane)))
      return { ok: false, reason: `invalid receipt outcome or lane for ${file}` };
    if (receipt.outcome !== 'pass' && (!receipt.owner?.trim()
      || (receipt.outcome === 'fail' && !validIds(receipt.failureIds))
      || (receipt.outcome === 'error' && !validIds(receipt.errorIds)))) return { ok: false, reason: `unowned failure receipt for ${file}` };
  }
  return { ok: true, files: expected };
}

/** Move a verified file result to a later head without changing its content-addressed identity. */
export function carryGateFileReceipt(receipt: GateFileReceipt, targetHead40: string): GateFileReceipt {
  if (!/^[a-f0-9]{40}$/i.test(targetHead40)) throw new Error('invalid carried file receipt head');
  return { ...receipt, carriedToHead40: targetHead40 };
}
