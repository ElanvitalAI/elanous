import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClosureGraph, type ClosureTree } from './gate-closure.js';

export interface SweepCertificate {
  schema: 1;
  sourceCommit: string;
  imageDigest: string;
  fileKeys: Record<string, string | null>;
  sweepConcurrency: number;
  measuredAt: number;
  maxAgeMs: number | null;
  maxDirtyRatio: number | null;
  thresholdSource: string | null;
  recordSha256: string;
}

export interface SweepPlan {
  mode: 'incremental' | 'full';
  reason?: 'invalid-certificate' | 'image-changed' | 'certificate-stale' | 'dirty-ratio' | 'concurrency-changed' | 'policy-unmeasured';
  dirtyFiles: string[];
  removedFiles: string[];
  dirtyRatio: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function canonicalFileKeys(input: Readonly<Record<string, string | null>>): Record<string, string | null> {
  const entries = Object.entries(input).sort(([a], [b]) => comparePaths(a, b));
  if (entries.some(([file, key]) => !file || file.startsWith('/') || file.split('/').some((part) => part === '.' || part === '..')
    || (key !== null && !/^[a-f0-9]{64}$/i.test(key)))) {
    throw new Error('invalid sweep certificate file key');
  }
  if (new Set(entries.map(([file]) => file)).size !== entries.length) throw new Error('duplicate sweep certificate file');
  return Object.fromEntries(entries);
}

/** Build closure/image keys; an incomplete or opaque closure is retained as null so it is always rerun. */
export function gateSweepFileKeys(tree: ClosureTree, files: readonly string[], imageDigest: string): Record<string, string | null> {
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageDigest)) throw new Error('invalid sweep image digest');
  // Graph discovery and content hashing must observe one immutable tip. A mutable reader can otherwise
  // add an import between these phases: the source hash changes but the newly reachable dependency is omitted.
  const snapshot = new Map<string, string | undefined>();
  const readSnapshot = (path: string): string | undefined => {
    if (!snapshot.has(path)) snapshot.set(path, tree.read(path));
    return snapshot.get(path);
  };
  const snapshotTree: ClosureTree = { ...tree, read: readSnapshot };
  const graph = buildClosureGraph(snapshotTree);
  const entries: Array<[string, string | null]> = [];
  for (const file of [...new Set(files)].sort(comparePaths)) {
    const pending = [file];
    const closure = new Set<string>();
    let opaque = false;
    while (pending.length) {
      const current = pending.pop()!;
      if (closure.has(current)) continue;
      if (!graph.tracked.has(current) || graph.opaque.has(current)) { opaque = true; break; }
      closure.add(current);
      pending.push(...(graph.forward.get(current) ?? []));
    }
    if (!opaque && closure.size) {
      const contentHashes: Array<[string, string]> = [];
      for (const path of [...closure].sort()) {
        const content = readSnapshot(path);
        if (content === undefined) { opaque = true; break; }
        contentHashes.push([path, sha256(content)]);
      }
      if (!opaque) {
        const closureDigest = sha256(JSON.stringify(contentHashes));
        entries.push([file, sha256(JSON.stringify([file, closureDigest, imageDigest]))]);
        continue;
      }
    }
    entries.push([file, null]);
  }
  // Object.fromEntries defines even magic names such as "__proto__" as own data keys.
  return Object.fromEntries(entries);
}

export function createSweepCertificateForRun(input: {
  sourceCommit: string;
  imageDigest: string;
  tree: ClosureTree;
  expectedFiles: readonly string[];
  measuredFiles: readonly string[];
  runSucceeded: boolean;
  requestedConcurrency: number;
  observedConcurrency: number;
  measuredAt: number;
}): SweepCertificate | null {
  const expected = [...input.expectedFiles].sort(comparePaths);
  const measured = [...input.measuredFiles].sort(comparePaths);
  if (!input.runSucceeded || new Set(expected).size !== expected.length || JSON.stringify(expected) !== JSON.stringify(measured)
    || input.requestedConcurrency !== input.observedConcurrency) return null;
  return createSweepCertificate({
    sourceCommit: input.sourceCommit,
    imageDigest: input.imageDigest,
    expectedFiles: expected,
    measuredFileKeys: gateSweepFileKeys(input.tree, expected, input.imageDigest),
    requestedConcurrency: input.requestedConcurrency,
    observedConcurrency: input.observedConcurrency,
    measuredAt: input.measuredAt,
    runSucceeded: true,
    maxAgeMs: null,
    maxDirtyRatio: null,
    thresholdSource: null,
  });
}

export type SweepCertificateRecordResult = { readonly status: 'written'; readonly path: string }
  | { readonly status: 'skipped'; readonly reason: 'root-missing' | 'not-full-sweep' | 'measurement-incomplete' };

/** Record only a complete successful sweep; partial/radius runs can never replace its baseline. */
export function recordSweepCertificateForRun(input: {
  root?: string;
  fullSweep: boolean;
  sourceCommit: string;
  imageDigest: string;
  tree: ClosureTree;
  expectedFiles: readonly string[];
  measuredFiles: readonly string[];
  runSucceeded: boolean;
  requestedConcurrency: number;
  observedConcurrency: number;
  measuredAt: number;
}): SweepCertificateRecordResult {
  if (!input.root) return { status: 'skipped', reason: 'root-missing' };
  if (!input.fullSweep) return { status: 'skipped', reason: 'not-full-sweep' };
  if (!input.runSucceeded || !/^[a-f0-9]{40}$/i.test(input.sourceCommit)
    || !/^sha256:[a-f0-9]{64}$/i.test(input.imageDigest)) return { status: 'skipped', reason: 'measurement-incomplete' };
  const certificate = createSweepCertificateForRun(input);
  if (!certificate) return { status: 'skipped', reason: 'measurement-incomplete' };
  return { status: 'written', path: writeSweepCertificate(input.root, certificate) };
}

function certificateBody(input: Omit<SweepCertificate, 'recordSha256'>): string {
  return JSON.stringify({
    schema: input.schema,
    sourceCommit: input.sourceCommit.toLowerCase(),
    imageDigest: input.imageDigest,
    fileKeys: canonicalFileKeys(input.fileKeys),
    sweepConcurrency: input.sweepConcurrency,
    measuredAt: input.measuredAt,
    maxAgeMs: input.maxAgeMs,
    maxDirtyRatio: input.maxDirtyRatio,
    thresholdSource: input.thresholdSource,
  });
}

export function createSweepCertificate(input: Omit<SweepCertificate, 'schema' | 'recordSha256' | 'fileKeys' | 'sweepConcurrency' | 'maxAgeMs' | 'maxDirtyRatio' | 'thresholdSource'> & {
  expectedFiles: readonly string[];
  measuredFileKeys: Readonly<Record<string, string | null>>;
  requestedConcurrency: number;
  observedConcurrency: number;
  runSucceeded: boolean;
  maxAgeMs?: number | null;
  maxDirtyRatio?: number | null;
  thresholdSource?: string | null;
}): SweepCertificate {
  if (!input.runSucceeded) throw new Error('sweep run did not succeed');
  if (!/^[a-f0-9]{40}$/i.test(input.sourceCommit)) throw new Error('invalid sweep source commit');
  if (!/^sha256:[a-f0-9]{64}$/i.test(input.imageDigest)) throw new Error('invalid sweep image digest');
  if (!Number.isSafeInteger(input.requestedConcurrency) || input.requestedConcurrency < 1
    || input.observedConcurrency !== input.requestedConcurrency) throw new Error('sweep concurrency does not match measurement');
  const fileKeys = canonicalFileKeys(input.measuredFileKeys);
  const expectedFiles = [...new Set(input.expectedFiles)].sort(comparePaths);
  const measuredFiles = Object.keys(fileKeys).sort(comparePaths);
  if (expectedFiles.length !== input.expectedFiles.length || JSON.stringify(expectedFiles) !== JSON.stringify(measuredFiles)) {
    throw new Error('sweep measurement does not cover the complete test inventory');
  }
  if (!Number.isFinite(input.measuredAt)) throw new Error('invalid sweep measurement time');
  const policyAbsent = input.maxAgeMs == null && input.maxDirtyRatio == null && input.thresholdSource == null;
  const policyComplete = Number.isFinite(input.maxAgeMs) && input.maxAgeMs! > 0
    && Number.isFinite(input.maxDirtyRatio) && input.maxDirtyRatio! >= 0 && input.maxDirtyRatio! <= 1
    && !!input.thresholdSource?.trim();
  if (!policyAbsent && !policyComplete) throw new Error('invalid measured sweep policy');
  const body = {
    schema: 1 as const,
    sourceCommit: input.sourceCommit.toLowerCase(),
    imageDigest: input.imageDigest,
    fileKeys,
    sweepConcurrency: input.requestedConcurrency,
    measuredAt: input.measuredAt,
    maxAgeMs: policyAbsent ? null : input.maxAgeMs!,
    maxDirtyRatio: policyAbsent ? null : input.maxDirtyRatio!,
    thresholdSource: policyAbsent ? null : input.thresholdSource!,
  };
  return { ...body, recordSha256: sha256(certificateBody(body)) };
}

export function isSweepCertificate(value: unknown): value is SweepCertificate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SweepCertificate>;
  if (candidate.schema !== 1 || typeof candidate.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(candidate.sourceCommit)
    || typeof candidate.imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(candidate.imageDigest)
    || !candidate.fileKeys || typeof candidate.fileKeys !== 'object' || Array.isArray(candidate.fileKeys)
    || !Number.isSafeInteger(candidate.sweepConcurrency) || (candidate.sweepConcurrency ?? 0) < 1
    || !Number.isFinite(candidate.measuredAt)
    || !((candidate.maxAgeMs === null && candidate.maxDirtyRatio === null && candidate.thresholdSource === null)
      || (Number.isFinite(candidate.maxAgeMs) && (candidate.maxAgeMs ?? 0) > 0
        && Number.isFinite(candidate.maxDirtyRatio) && (candidate.maxDirtyRatio ?? -1) >= 0 && (candidate.maxDirtyRatio ?? 2) <= 1
        && typeof candidate.thresholdSource === 'string' && !!candidate.thresholdSource.trim()))
    || typeof candidate.recordSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(candidate.recordSha256)) return false;
  try {
    const body = {
      schema: candidate.schema,
      sourceCommit: candidate.sourceCommit.toLowerCase(),
      imageDigest: candidate.imageDigest,
      fileKeys: canonicalFileKeys(candidate.fileKeys as Record<string, string | null>),
      sweepConcurrency: candidate.sweepConcurrency!, measuredAt: candidate.measuredAt!, maxAgeMs: candidate.maxAgeMs!,
      maxDirtyRatio: candidate.maxDirtyRatio!, thresholdSource: candidate.thresholdSource,
    };
    return sha256(certificateBody(body)) === candidate.recordSha256;
  } catch { return false; }
}

export function calibrateSweepCertificate(certificate: SweepCertificate, policy: {
  maxAgeMs: number;
  maxDirtyRatio: number;
  thresholdSource: string;
}): SweepCertificate {
  if (!isSweepCertificate(certificate)) throw new Error('invalid sweep certificate');
  return createSweepCertificate({
    sourceCommit: certificate.sourceCommit,
    imageDigest: certificate.imageDigest,
    expectedFiles: Object.keys(certificate.fileKeys),
    measuredFileKeys: certificate.fileKeys,
    requestedConcurrency: certificate.sweepConcurrency,
    observedConcurrency: certificate.sweepConcurrency,
    measuredAt: certificate.measuredAt,
    runSucceeded: true,
    ...policy,
  });
}

export function planSweep(input: {
  certificate: unknown;
  currentCommit: string;
  imageDigest: string;
  currentFileKeys: Readonly<Record<string, string | null>>;
  changedFiles: readonly string[];
  sweepConcurrency: number;
  now: number;
}): SweepPlan {
  const full = (reason: NonNullable<SweepPlan['reason']>, removedFiles: string[] = [], dirtyRatio = 1): SweepPlan => ({
    mode: 'full', reason, dirtyFiles: Object.keys(input.currentFileKeys).sort(), removedFiles: [...new Set(removedFiles)].sort(), dirtyRatio,
  });
  if (!isSweepCertificate(input.certificate)) return full('invalid-certificate');
  const cert = input.certificate;
  if (!/^[a-f0-9]{40}$/i.test(input.currentCommit) || !/^sha256:[a-f0-9]{64}$/i.test(input.imageDigest)) throw new Error('invalid current sweep identity');
  if (input.imageDigest !== cert.imageDigest) return full('image-changed');
  if (input.sweepConcurrency !== cert.sweepConcurrency) return full('concurrency-changed');
  if (cert.maxAgeMs === null || cert.maxDirtyRatio === null || cert.thresholdSource === null) return full('policy-unmeasured');
  const age = input.now - cert.measuredAt;
  if (!Number.isFinite(input.now) || age < 0 || age > cert.maxAgeMs) return full('certificate-stale');

  const current = canonicalFileKeys(input.currentFileKeys);
  const changed = new Set(input.changedFiles);
  const removedFiles: string[] = [];
  const hasOwn = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);
  for (const [file, key] of Object.entries(cert.fileKeys)) {
    if (!hasOwn(current, file)) removedFiles.push(file);
    else if (key === null || current[file] === null || current[file] !== key) changed.add(file);
  }
  for (const file of Object.keys(current)) if (!hasOwn(cert.fileKeys, file)) changed.add(file);
  const dirtyFiles = [...changed].filter((file) => hasOwn(current, file)).sort();
  const dirtyRatio = cert.fileKeys && Object.keys(cert.fileKeys).length > 0
    ? (dirtyFiles.length + removedFiles.length) / Object.keys(cert.fileKeys).length : 1;
  if (Object.keys(cert.fileKeys).length === 0 || dirtyRatio > cert.maxDirtyRatio) return full('dirty-ratio', removedFiles, dirtyRatio);
  return { mode: 'incremental', dirtyFiles, removedFiles: removedFiles.sort(), dirtyRatio };
}

export function writeSweepCertificate(root: string, certificate: SweepCertificate): string {
  if (!isSweepCertificate(certificate)) throw new Error('refusing invalid sweep certificate');
  mkdirSync(root, { recursive: true });
  const target = join(root, 'sweep-certificate.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(certificate, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
    return target;
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function readSweepCertificate(root: string): SweepCertificate | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(root, 'sweep-certificate.json'), 'utf8'));
    return isSweepCertificate(value) ? value : null;
  } catch { return null; }
}
