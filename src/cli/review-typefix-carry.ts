import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as ts from 'typescript';
import { debug } from '../debug/log.js';
import { logsDbPath, LogStore } from '../mss/logging/log-store.js';
import { gateReceiptRegistryPathForRepo } from '../self-implement/train-gate-remote.js';
import { gateReceiptSelfKey, loadGateReceipts } from '../self-implement/gate-receipt-registry.js';
import { parseReviewResultOutput } from '../task-agent/review-result-capture.js';

export const TYPEFIX_CARRY_MAX_FILES = 5;
export const TYPEFIX_CARRY_MAX_LINES = 40;
const SHA40 = /^[a-f0-9]{40}$/iu;

type VerdictName = 'pass' | 'warn';
export interface TypefixDriftReceipt { pr: number; head: string; verdict: 'drift' }
export interface TypefixRepairRun { runId: string; fromHead: string; newHead: string; baseSha: string }
export interface TypefixGateReceipt { headCommit: string; baseCommit: string; key: string; typecheck: 'PASS' | 'FAIL'; prTests: 'PASS' | 'FAIL' }
export interface TypefixDeltaFile { path: string; status: 'modified' | 'added' | 'removed' | 'renamed'; binary: boolean; added: number; removed: number; assertionChanged: boolean }
export interface TypefixCommit { sha: string; parents: string[]; kind: 'main-merge' | 'repair' | 'other' }
export interface TypefixCarryMeasurement {
  commits: TypefixCommit[];
  mergeCommit: string | null;
  mergeParent2IsOriginMainAncestor: boolean | null;
  repairCommit: string;
  delta: TypefixDeltaFile[];
  originalPrFiles: string[];
  virtualSources: Record<string, string>;
  newSources: Record<string, string>;
  gateReceipt: TypefixGateReceipt;
  requiredBase: string;
}
export interface ProveTypefixCarryInput {
  pr: number;
  fromHead: string;
  newHead: string;
  fromReview: string;
  fromReviewSha256: string;
  fromReviewVerdict: VerdictName;
  fromReviewMustFix: unknown[];
  driftReceipt: TypefixDriftReceipt | null;
  repairRun: TypefixRepairRun | null;
}
export interface TypefixCarryReceipt {
  pr: number;
  headCommit: string;
  reviewed: true;
  verdict: VerdictName;
  mustFix: [];
  reviewer: 'typefix-carry';
  carry: {
    fromHead: string;
    fromReview: string;
    fromReviewSha256: string;
    driftReceipt: TypefixDriftReceipt;
    repairRunId: string;
    mergeCommit: string | null;
    gateReceipt: Pick<TypefixGateReceipt, 'headCommit' | 'baseCommit' | 'key'>;
    erasedJsSha256: Record<string, string>;
    delta: { files: string[]; added: number; removed: number };
  };
}
export type TypefixCarryProof = { ok: true; receipt: TypefixCarryReceipt } | { ok: false; reason: string };
export interface TypefixCarryDeps {
  readReview(path: string): string | null;
  validatePriorVerdict(input: ProveTypefixCarryInput, review: unknown): boolean | null;
  measure(input: ProveTypefixCarryInput): TypefixCarryMeasurement | null;
  transpile(source: string, file: string): string | null;
  log?(event: 'typefix-carry-accepted' | 'typefix-carry-refused', fields: Record<string, unknown>): void;
}

export interface TypefixCarryContextOptions {
  cwd: string;
  remote: string;
  branch: string;
  reviewResultsDir: string;
  /** Only test seams; production reads the established read-only log and gate-receipt stores. */
  readEvents?: () => readonly { category: string; event: string; data: unknown }[];
  readGateReceipts?: () => Readonly<Record<string, {
    key: string; headCommit: string; baseCommit: string; verdict: string; checks: readonly string[];
  }>>;
}

function productionEvents(): readonly { category: string; event: string; data: unknown }[] {
  if (!existsSync(logsDbPath())) return [];
  const store = LogStore.openReadOnly(logsDbPath());
  try {
    return store.queryAll({ exactCategories: ['pr.land'], events: ['drift-classified', 'drift-repair-launched', 'drift-repair-landed'] })
      .map((row) => ({ category: row.category, event: row.event, data: row.data ? JSON.parse(row.data) as unknown : null }));
  } finally { store.close(); }
}

/** Build an untrusted candidate from the durable repair completion event; proveTypefixCarry re-measures every claim. */
export function buildTypefixCarryCandidate(
  pr: number,
  newHead: string,
  receiptPath: string,
  options: TypefixCarryContextOptions,
): TypefixCarryReceipt | null {
  if (!Number.isSafeInteger(pr) || pr < 1 || !SHA40.test(newHead) || !options.reviewResultsDir
    || resolve(dirname(receiptPath)) !== resolve(options.reviewResultsDir)
    || basename(receiptPath) !== `typefix-carry-${pr}-${newHead.slice(0, 12)}.json`) return null;
  let events: readonly { category: string; event: string; data: unknown }[];
  let gateReceipts: ReturnType<NonNullable<TypefixCarryContextOptions['readGateReceipts']>>;
  try {
    events = (options.readEvents ?? productionEvents)();
    gateReceipts = (options.readGateReceipts ?? (() => productionGateReceipts(options.cwd)))();
  } catch { return null; }
  const rows = events.map((row) => ({ ...row, data: parseReceiptData(row.data) }));
  const landed = rows.find((row) => row.category === 'pr.land' && row.event === 'drift-repair-landed'
    && row.data?.pr === pr && row.data.newHead === newHead);
  const data = landed?.data;
  const runId = data?.runId;
  const fromHead = data?.fromHead;
  const baseSha = data?.baseSha;
  if (typeof runId !== 'string' || !runId || typeof fromHead !== 'string'
    || !SHA40.test(fromHead) || typeof baseSha !== 'string' || !SHA40.test(baseSha)) return null;
  const launched = rows.some((row) => row.category === 'pr.land' && row.event === 'drift-repair-launched'
    && row.data?.pr === pr && row.data.runId === runId && row.data.fromHead === fromHead);
  const drift = rows.some((row) => row.category === 'pr.land' && row.event === 'drift-classified'
    && row.data?.pr === pr && row.data.head === fromHead && row.data.verdict === 'drift');
  if (!launched || !drift) return null;
  const matchingGates = Object.values(gateReceipts).filter((gate) => gate.verdict === 'passed'
    && gate.headCommit.toLowerCase() === newHead.toLowerCase() && gate.baseCommit.toLowerCase() === baseSha.toLowerCase()
    && gateReceiptSelfKey(gate as never) === gate.key && gate.checks.includes(`typecheck@${gate.baseCommit}`)
    && gate.checks.some((check) => /^(?:pr-tests|changed-tests)(?:@|:|$)/u.test(check)));
  if (matchingGates.length !== 1) return null;
  const priorFiles = readdirSync(options.reviewResultsDir).filter((name) => {
    const match = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]*-${pr}-([a-f0-9]{10,40})\\.json$`, 'i').exec(name);
    return Boolean(match && fromHead.toLowerCase().startsWith(match[1]!.toLowerCase()));
  });
  if (priorFiles.length !== 1) return null;
  const fromReview = priorFiles[0]!;
  const priorPath = join(options.reviewResultsDir, fromReview);
  let priorText: string;
  try { priorText = readFileSync(priorPath, 'utf8'); } catch { return null; }
  const prior = parseReviewResultOutput(priorText);
  if (!prior || prior.pr !== pr || prior.head?.toLowerCase() !== fromHead.toLowerCase()
    || prior.reviewed !== true || !['pass', 'warn'].includes(String(prior.verdict)) || prior.mustFix !== 0) return null;
  const gate = matchingGates[0]!;
  return {
    pr, headCommit: newHead, reviewed: true, verdict: prior.verdict as VerdictName, mustFix: [], reviewer: 'typefix-carry',
    carry: {
      fromHead, fromReview, fromReviewSha256: createHash('sha256').update(priorText).digest('hex'),
      driftReceipt: { pr, head: fromHead, verdict: 'drift' }, repairRunId: runId,
      mergeCommit: null, gateReceipt: { headCommit: gate.headCommit, baseCommit: gate.baseCommit, key: gate.key },
      erasedJsSha256: {}, delta: { files: [], added: 0, removed: 0 },
    },
  };
}

function productionGateReceipts(cwd: string) {
  const path = gateReceiptRegistryPathForRepo(cwd);
  return path ? loadGateReceipts(path) : {};
}

function gitOutput(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): string | null {
  const result = spawnSync('git', [...args], { cwd, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 && !result.error ? result.stdout : null;
}

function parseReceiptData(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) as unknown; } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Production evidence loader: all provenance comes from the persisted event/receipt stores and actual Git objects. */
export function loadTypefixCarryContext(
  receipt: TypefixCarryReceipt,
  receiptPath: string,
  options: TypefixCarryContextOptions,
): { input: ProveTypefixCarryInput; deps: TypefixCarryDeps } | null {
  const carry = receipt.carry;
  const fromHead = carry?.fromHead;
  const newHead = receipt.headCommit;
  if (!options.cwd || !options.remote || !options.branch || !options.reviewResultsDir
    || !SHA40.test(fromHead ?? '') || !SHA40.test(newHead ?? '') || resolve(dirname(receiptPath)) !== resolve(options.reviewResultsDir)
    || basename(carry.fromReview) !== carry.fromReview) return null;
  const reviewPath = resolve(options.reviewResultsDir, carry.fromReview);
  const events = (options.readEvents ?? productionEvents)();
  const drift = events.map((row) => ({ row, data: parseReceiptData(row.data) })).find(({ row, data }) => row.category === 'pr.land'
    && row.event === 'drift-classified' && data?.pr === receipt.pr && data.head === fromHead && data.verdict === 'drift')?.data;
  const launched = events.map((row) => ({ row, data: parseReceiptData(row.data) })).find(({ row, data }) => row.category === 'pr.land'
    && row.event === 'drift-repair-launched' && data?.pr === receipt.pr && data.runId === carry.repairRunId)?.data;
  const landed = events.map((row) => ({ row, data: parseReceiptData(row.data) })).find(({ row, data }) => row.category === 'pr.land'
    && row.event === 'drift-repair-landed' && data?.pr === receipt.pr && data.runId === carry.repairRunId)?.data;
  if (!drift || !launched || !landed || launched.fromHead !== fromHead || landed.fromHead !== fromHead
    || landed.newHead !== newHead || typeof landed.baseSha !== 'string' || !SHA40.test(landed.baseSha)) return null;
  const gateReceipts = (options.readGateReceipts ?? (() => productionGateReceipts(options.cwd)))();
  const gate = gateReceipts[carry.gateReceipt.key];
  if (!gate || gateReceiptSelfKey(gate as never) !== gate.key || gate.verdict !== 'passed'
    || gate.headCommit.toLowerCase() !== newHead.toLowerCase() || gate.baseCommit.toLowerCase() !== carry.gateReceipt.baseCommit.toLowerCase()) return null;

  const priorText = (() => { try { return readFileSync(reviewPath, 'utf8'); } catch { return null; } })();
  if (priorText === null) return null;
  const prior = parseReviewResultOutput(priorText);
  if (!prior || prior.pr !== receipt.pr || prior.head?.toLowerCase() !== fromHead.toLowerCase()
    || prior.reviewed !== true || !['pass', 'warn'].includes(String(prior.verdict)) || prior.mustFix !== 0) return null;

  const baseRef = `refs/remotes/${options.remote}/${options.branch}`;
  const mainTip = gitOutput(options.cwd, ['rev-parse', '--verify', baseRef])?.trim();
  if (!mainTip || !SHA40.test(mainTip)) return null;
  const commitsRaw = gitOutput(options.cwd, ['rev-list', '--reverse', '--first-parent', `${fromHead}..${newHead}`])?.trim();
  if (!commitsRaw) return null;
  const commitShas = commitsRaw.split(/\s+/u).filter(Boolean);
  const commits: TypefixCommit[] = [];
  for (const sha of commitShas) {
    const line = gitOutput(options.cwd, ['rev-list', '--parents', '-n', '1', sha])?.trim().split(/\s+/u);
    if (!line || line[0]?.toLowerCase() !== sha.toLowerCase()) return null;
    const parents = line.slice(1);
    commits.push({ sha, parents, kind: parents.length === 2 ? 'main-merge' : sha.toLowerCase() === newHead.toLowerCase() ? 'repair' : 'other' });
  }
  if (!commits.length || commits.at(-1)?.sha.toLowerCase() !== newHead.toLowerCase()) return null;
  const mergeCommits = commits.filter((commit) => commit.parents.length === 2);
  const mergeCommit = mergeCommits.length === 1 ? mergeCommits[0]!.sha : null;
  if (mergeCommits.length > 1) return null;
  const repairCommit = commits.at(-1)!;
  if (repairCommit.kind === 'main-merge' || repairCommit.parents.length !== 1) return null;
  const merge = mergeCommit ? commits.find((commit) => commit.sha.toLowerCase() === mergeCommit.toLowerCase()) : null;
  if (mergeCommit && (!merge || merge.parents[0]?.toLowerCase() !== fromHead.toLowerCase()
    || repairCommit.parents[0]?.toLowerCase() !== mergeCommit.toLowerCase())) return null;
  if (!mergeCommit && (commits.length !== 1 || repairCommit.parents[0]?.toLowerCase() !== fromHead.toLowerCase())) return null;
  const requiredBase = mergeCommit ? merge!.parents[1]! : gate.baseCommit;
  if (!SHA40.test(requiredBase)) return null;
  if (gitOutput(options.cwd, ['merge-base', '--is-ancestor', requiredBase, mainTip]) === null) return null;

  const oldBase = gitOutput(options.cwd, ['merge-base', fromHead, mainTip])?.trim();
  if (!oldBase || !SHA40.test(oldBase)) return null;
  const originalFilesRaw = gitOutput(options.cwd, ['diff', '--name-only', '-z', oldBase, fromHead]);
  if (originalFilesRaw === null) return null;
  const originalPrFiles = originalFilesRaw.split('\0').filter(Boolean);

  const measure = (): TypefixCarryMeasurement | null => {
    const actualTree = gitOutput(options.cwd, ['rev-parse', '--verify', `${newHead}^{tree}`])?.trim();
    if (!actualTree) return null;
    let virtualTree = '';
    let virtualEnv: NodeJS.ProcessEnv | undefined;
    let objectDir: string | undefined;
    if (mergeCommit) {
      const objectPath = gitOutput(options.cwd, ['rev-parse', '--git-path', 'objects'])?.trim();
      if (!objectPath) return null;
      try { objectDir = mkdtempSync(join(tmpdir(), 'elanous-typefix-carry-')); } catch { return null; }
      virtualEnv = { ...process.env, GIT_OBJECT_DIRECTORY: objectDir,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: [resolve(options.cwd, objectPath), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter) };
      const merged = gitOutput(options.cwd, ['merge-tree', '--write-tree', requiredBase, fromHead], virtualEnv);
      virtualTree = merged?.trim() ?? '';
      if (!SHA40.test(virtualTree)) { rmSync(objectDir, { recursive: true, force: true }); return null; }
    } else {
      virtualTree = gitOutput(options.cwd, ['rev-parse', '--verify', `${fromHead}^{tree}`])?.trim() ?? '';
    }
    if (!SHA40.test(virtualTree)) { if (objectDir) rmSync(objectDir, { recursive: true, force: true }); return null; }
    const readObject = (args: readonly string[]) => gitOutput(options.cwd, args, virtualEnv);
    try {
    const names = readObject(['diff', '--name-status', '-z', virtualTree, actualTree]);
    if (names === null) return null;
    const nameFields = names.split('\0').filter(Boolean);
    const delta: TypefixDeltaFile[] = [];
    for (let i = 0; i < nameFields.length;) {
      const statusText = nameFields[i++]!;
      const statusCode = statusText[0];
      const path = statusText.slice(1) || nameFields[i++];
      if (!path || !['M', 'A', 'D', 'R'].includes(statusCode ?? '')) return null;
      const stat = readObject(['diff', '--numstat', virtualTree, actualTree, '--', path]);
      const firstTab = stat?.indexOf('\t') ?? -1;
      const secondTab = stat?.indexOf('\t', firstTab + 1) ?? -1;
      if (firstTab < 0 || secondTab < 0) return null;
      const addedText = stat!.slice(0, firstTab); const removedText = stat!.slice(firstTab + 1, secondTab);
      const binary = addedText === '-' || removedText === '-';
      const added = binary ? 0 : Number(addedText); const removed = binary ? 0 : Number(removedText);
      if (!Number.isSafeInteger(added) || !Number.isSafeInteger(removed) || added < 0 || removed < 0) return null;
      const patch = readObject(['diff', '--unified=0', virtualTree, actualTree, '--', path]);
      if (patch === null) return null;
      const assertionChanged = /^(?:\+|-)\s*(?:expect\s*\(|assert(?:ion)?\b|toMatch(?:Inline)?Snapshot\s*\()/mu.test(patch);
      delta.push({ path, status: statusCode === 'M' ? 'modified' : statusCode === 'A' ? 'added' : statusCode === 'D' ? 'removed' : 'renamed', binary, added, removed, assertionChanged });
    }
    const readTreeFile = (tree: string, path: string): string | null => readObject(['show', `${tree}:${path}`]);
    const virtualSources: Record<string, string> = {}; const newSources: Record<string, string> = {};
    for (const file of delta) {
      const before = readTreeFile(virtualTree, file.path); const after = readTreeFile(actualTree, file.path);
      if (before === null || after === null) return null;
      virtualSources[file.path] = before; newSources[file.path] = after;
    }
    const mergeParent2IsOriginMainAncestor = mergeCommit
      ? gitOutput(options.cwd, ['merge-base', '--is-ancestor', requiredBase, mainTip]) !== null : null;
    const gateChecks = gate.checks;
    const hasTypecheck = gateChecks.includes(`typecheck@${gate.baseCommit}`);
    const hasPrTests = gateChecks.some((check) => /^(?:pr-tests|changed-tests)(?:@|:|$)/u.test(check));
    return {
      commits, mergeCommit, mergeParent2IsOriginMainAncestor,
      repairCommit: repairCommit.sha, delta, originalPrFiles, virtualSources, newSources,
      gateReceipt: { headCommit: gate.headCommit, baseCommit: gate.baseCommit, key: gate.key,
        typecheck: hasTypecheck ? 'PASS' : 'FAIL', prTests: hasPrTests ? 'PASS' : 'FAIL' },
      requiredBase,
    };
    } finally { if (objectDir) rmSync(objectDir, { recursive: true, force: true }); }
  };
  const input: ProveTypefixCarryInput = {
    pr: receipt.pr, fromHead, newHead, fromReview: reviewPath,
    fromReviewSha256: carry.fromReviewSha256, fromReviewVerdict: prior.verdict as VerdictName, fromReviewMustFix: [],
    driftReceipt: drift as unknown as TypefixDriftReceipt,
    repairRun: { runId: carry.repairRunId, fromHead, newHead, baseSha: landed.baseSha },
  };
  const transpile = (source: string, file: string): string | null => {
    try {
      const configPath = ts.findConfigFile(options.cwd, ts.sys.fileExists, 'tsconfig.json');
      if (!configPath) return null;
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (config.error) return null;
      const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
      // transpileModule has no Program/type checker and cannot reproduce decorator metadata
      // derived from imported aliases. Fail closed for projects that request that emit.
      if (parsed.options.emitDecoratorMetadata) return null;
      const result = ts.transpileModule(source, { fileName: file, compilerOptions: parsed.options, reportDiagnostics: true });
      return result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ? null : result.outputText;
    } catch { return null; }
  };
  const deps: TypefixCarryDeps = {
    readReview: (path) => resolve(dirname(path)) === resolve(options.reviewResultsDir) ? priorText : null,
    validatePriorVerdict: (proofInput, value) => {
      const parsed = parseReviewResultOutput(JSON.stringify(value));
      return parsed?.pr === proofInput.pr && parsed.head?.toLowerCase() === proofInput.fromHead.toLowerCase()
        && parsed.reviewed === true && ['pass', 'warn'].includes(String(parsed.verdict)) && parsed.mustFix === 0;
    },
    measure,
    transpile,
  };
  return { input, deps };
}

function refuse(input: ProveTypefixCarryInput, reason: string, deps: TypefixCarryDeps): TypefixCarryProof {
  const fields = { pr: input.pr, fromHead: input.fromHead, newHead: input.newHead, reason };
  if (deps.log) deps.log('typefix-carry-refused', fields);
  else debug.log('pr.land', 'typefix-carry-refused', fields);
  return { ok: false, reason };
}

function normalizeJavaScript(source: string, file: string): string | null {
  try {
    const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JS;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
    const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (!Array.isArray(parseDiagnostics) || parseDiagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return null;
    const printer = ts.createPrinter({ removeComments: false, newLine: ts.NewLineKind.LineFeed });
    return printer.printFile(sourceFile).trim();
  } catch { return null; }
}

export function proveTypefixCarry(input: ProveTypefixCarryInput, deps: TypefixCarryDeps): TypefixCarryProof {
  const reject = (reason: string) => refuse(input, reason, deps);
  if (!input.driftReceipt || input.driftReceipt.pr !== input.pr || typeof input.driftReceipt.head !== 'string'
    || input.driftReceipt.head.toLowerCase() !== input.fromHead.toLowerCase() || input.driftReceipt.verdict !== 'drift') return reject('carry-no-drift-receipt');

  let reviewText: string | null;
  try { reviewText = deps.readReview(input.fromReview); } catch { return reject('carry-unmeasured'); }
  if (reviewText === null) return reject('carry-unmeasured');
  if (createHash('sha256').update(reviewText).digest('hex') !== input.fromReviewSha256.toLowerCase()) return reject('carry-prior-verdict-invalid');
  let review: unknown;
  try { review = JSON.parse(reviewText); } catch { return reject('carry-prior-verdict-invalid'); }
  let prior: boolean | null;
  try { prior = deps.validatePriorVerdict(input, review); } catch { return reject('carry-unmeasured'); }
  if (prior === null) return reject('carry-unmeasured');
  if (!prior || !['pass', 'warn'].includes(input.fromReviewVerdict) || !Array.isArray(input.fromReviewMustFix)
    || input.fromReviewMustFix.length !== 0) return reject('carry-prior-verdict-invalid');
  if (!input.repairRun || input.repairRun.fromHead.toLowerCase() !== input.fromHead.toLowerCase()
    || input.repairRun.newHead.toLowerCase() !== input.newHead.toLowerCase() || !SHA40.test(input.repairRun.baseSha)) return reject('carry-head-chain-broken');

  let measured: TypefixCarryMeasurement | null;
  try { measured = deps.measure(input); } catch { return reject('carry-unmeasured'); }
  if (!measured) return reject('carry-unmeasured');
  if (!Array.isArray(measured.commits) || !Array.isArray(measured.delta) || !Array.isArray(measured.originalPrFiles)
    || !measured.virtualSources || typeof measured.virtualSources !== 'object' || !measured.newSources || typeof measured.newSources !== 'object'
    || typeof measured.repairCommit !== 'string' || typeof measured.requiredBase !== 'string' || !SHA40.test(measured.requiredBase)) return reject('carry-unmeasured');
  const { commits, mergeCommit } = measured;
  if (!Array.isArray(commits) || commits.length < 1 || commits.length > 2
    || commits.some((commit) => !commit || typeof commit.sha !== 'string' || !SHA40.test(commit.sha) || !Array.isArray(commit.parents)
      || commit.parents.some((parent) => typeof parent !== 'string' || !SHA40.test(parent)))
    || commits.filter((commit) => commit.kind === 'main-merge').length > 1
    || commits.some((commit) => commit.kind === 'other')
    || commits.filter((commit) => commit.kind === 'repair').length !== 1
    || commits.at(-1)?.kind !== 'repair' || commits.at(-1)?.sha.toLowerCase() !== input.newHead.toLowerCase()
    || commits.find((commit) => commit.kind === 'repair')?.sha.toLowerCase() !== measured.repairCommit.toLowerCase()) return reject('carry-head-chain-broken');
  if (mergeCommit) {
    const merge = commits.find((commit) => commit.sha.toLowerCase() === mergeCommit.toLowerCase());
    const repairProof = commits.at(-1)!;
    if (!merge || merge.kind !== 'main-merge' || merge.parents.length !== 2 || merge.parents[0]?.toLowerCase() !== input.fromHead.toLowerCase()
      || measured.mergeParent2IsOriginMainAncestor !== true || repairProof.parents.length !== 1
      || repairProof.parents[0]?.toLowerCase() !== merge.sha.toLowerCase()
      || input.repairRun.baseSha.toLowerCase() !== merge.parents[1]?.toLowerCase()) return reject('carry-head-chain-broken');
  } else if (commits.some((commit) => commit.kind === 'main-merge')
    || commits.at(-1)?.parents.length !== 1 || commits.at(-1)?.parents[0]?.toLowerCase() !== input.fromHead.toLowerCase()
    || input.repairRun.baseSha.toLowerCase() !== measured.requiredBase.toLowerCase()) {
    return reject('carry-head-chain-broken');
  }

  const delta = measured.delta;
  if (!Array.isArray(delta) || delta.length === 0 || delta.some((file) => !file || typeof file.path !== 'string'
    || typeof file.binary !== 'boolean' || typeof file.assertionChanged !== 'boolean'
    || !Number.isInteger(file.added) || !Number.isInteger(file.removed) || file.added < 0 || file.removed < 0)) return reject('carry-unmeasured');
  if (delta.some((file) => file.assertionChanged && /\.test\.[^/]+$/iu.test(file.path))) return reject('carry-test-expectation-changed');
  if (delta.some((file) => file.status !== 'modified' || file.binary || !measured.originalPrFiles.includes(file.path))
    || delta.length > TYPEFIX_CARRY_MAX_FILES || delta.reduce((sum, file) => sum + file.added + file.removed, 0) > TYPEFIX_CARRY_MAX_LINES) return reject('carry-shape-outside-bounds');

  const erasedJsSha256: Record<string, string> = {};
  for (const file of delta) {
    if (!/\.tsx?$/iu.test(file.path)) return reject('carry-not-type-erasure-equivalent');
    const before = measured.virtualSources[file.path];
    const after = measured.newSources[file.path];
    if (typeof before !== 'string' || typeof after !== 'string') return reject('carry-unmeasured');
    let beforeJs: string | null;
    let afterJs: string | null;
    try { beforeJs = deps.transpile(before, file.path); afterJs = deps.transpile(after, file.path); }
    catch { return reject('carry-unmeasured'); }
    if (beforeJs === null || afterJs === null) return reject('carry-unmeasured');
    const normalizedBefore = normalizeJavaScript(beforeJs, file.path);
    const normalizedAfter = normalizeJavaScript(afterJs, file.path);
    if (normalizedBefore === null || normalizedAfter === null) return reject('carry-unmeasured');
    if (normalizedBefore !== normalizedAfter) return reject('carry-not-type-erasure-equivalent');
    erasedJsSha256[file.path] = createHash('sha256').update(normalizedAfter).digest('hex');
  }

  const gate = measured.gateReceipt;
  const expectedBase = mergeCommit ? commits.find((commit) => commit.sha.toLowerCase() === mergeCommit.toLowerCase())?.parents[1] : measured.requiredBase;
  if (!gate || gate.headCommit.toLowerCase() !== input.newHead.toLowerCase() || !expectedBase
    || gate.baseCommit.toLowerCase() !== expectedBase.toLowerCase() || gate.typecheck !== 'PASS' || gate.prTests !== 'PASS' || !gate.key) {
    return reject('carry-gate-head-or-base-mismatch');
  }
  const receipt: TypefixCarryReceipt = {
    pr: input.pr, headCommit: input.newHead, reviewed: true, verdict: input.fromReviewVerdict, mustFix: [], reviewer: 'typefix-carry',
    carry: {
      fromHead: input.fromHead, fromReview: basename(input.fromReview), fromReviewSha256: input.fromReviewSha256.toLowerCase(),
      driftReceipt: input.driftReceipt, repairRunId: input.repairRun.runId, mergeCommit,
      gateReceipt: { headCommit: gate.headCommit, baseCommit: gate.baseCommit, key: gate.key }, erasedJsSha256,
      delta: { files: delta.map((file) => file.path), added: delta.reduce((sum, file) => sum + file.added, 0), removed: delta.reduce((sum, file) => sum + file.removed, 0) },
    },
  };
  const fields = { pr: input.pr, fromHead: input.fromHead, newHead: input.newHead, reason: 'type-erasure-equivalent' };
  if (deps.log) deps.log('typefix-carry-accepted', fields);
  else debug.log('pr.land', 'typefix-carry-accepted', fields);
  return { ok: true, receipt };
}

export function writeTypefixCarryReceipt(reviewResultsDir: string, receipt: TypefixCarryReceipt, writeFile = writeFileSync): string {
  if (!Number.isSafeInteger(receipt.pr) || receipt.pr < 1 || !SHA40.test(receipt.headCommit)) throw new Error('invalid-typefix-carry-receipt-identity');
  mkdirSync(reviewResultsDir, { recursive: true });
  const path = join(reviewResultsDir, `typefix-carry-${receipt.pr}-${receipt.headCommit.slice(0, 12)}.json`);
  writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return path;
}
