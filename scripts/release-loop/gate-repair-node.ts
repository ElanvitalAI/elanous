#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPAWN_SYNC_MAX_BUFFER } from '../../src/util/spawn-sync-output.js';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { readGraphContext, finishNode, errorResult, type GraphContext } from './node-verdict.js';
import { RepairLandingRecoveryExhaustedError, waitForRepairPrLanded, type RepairPrLandedEvent } from './repair-pr-landed.js';
import { attributeReleaseFailures, type ReleaseFailureAttribution } from '../../src/release-loop/release-failure-attribution.js';

export interface RepairChildResult {
  ok: boolean;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  checkedHeadCommit?: string;
  stage?: string;
}

export interface GateRepairNodeDeps {
  root?: string;
  repo?: string;
  startRepairChild?: (featureFile: string, base: string) => Promise<RepairChildResult>;
  inspectRepairPr?: (prNumber: number, repo: string) => Promise<RepairPrInspection>;
  waitForLanded?: (prNumber: number, root: string) => Promise<RepairPrLandedEvent>;
  recoverLanded?: (prNumber: number, runId: string, root: string) => Promise<RepairPrLandedEvent | undefined>;
  recoveryIntervalMs?: number;
  isAncestor?: (ancestor: string, descendant: string, repo: string) => boolean;
  refreshMainlineHead?: (repo: string) => string;
  attributeFailures?: typeof attributeReleaseFailures;
}

interface RepairAttributionEvidence {
  readonly failureId: string;
  readonly sourceFiles: readonly string[];
  readonly unresolvedImports: readonly string[];
}

interface RepairBisectFinding {
  readonly file: string;
  readonly firstFailingCommit: string;
}

export function repairLandingEventFromGhJson(raw: string, prNumber: number, runId: string): RepairPrLandedEvent | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('GitHub landing recovery query returned invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub landing recovery query returned a non-object');
  const pr = value as Record<string, unknown>;
  if (typeof pr.title !== 'string' || !pr.title.startsWith(`RLA-GATE-REPAIR ${runId} `))
    throw new Error('GitHub landing recovery PR title/run identity mismatch');
  if (pr.state === 'CLOSED') throw new Error('repair PR was closed without a confirmed merge');
  if (pr.state === 'OPEN') return undefined;
  if (pr.state !== 'MERGED') throw new Error(`GitHub landing recovery returned unknown PR state: ${String(pr.state)}`);
  const mergeSha = pr.mergeCommit && typeof pr.mergeCommit === 'object'
    ? (pr.mergeCommit as Record<string, unknown>).oid : undefined;
  if (typeof pr.headRefOid !== 'string' || !/^[0-9a-f]{40}$/i.test(pr.headRefOid) || pr.baseRefName !== 'main'
    || typeof mergeSha !== 'string' || !/^[0-9a-f]{40}$/i.test(mergeSha)
    || typeof pr.mergedAt !== 'string' || !Number.isFinite(Date.parse(pr.mergedAt))) {
    throw new Error('merged repair PR is missing its head, main base, merge SHA, or merge time');
  }
  return { schema: 1, prNumber, repairRunId: runId, head: pr.headRefOid, mergeSha, base: 'main', mergedAt: pr.mergedAt };
}

function recoverMergedRepairPr(prNumber: number, runId: string, repo: string): Promise<RepairPrLandedEvent | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['pr', 'view', String(prNumber), '--json', 'title,state,headRefOid,baseRefName,mergedAt,mergeCommit'], {
      cwd: repo, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, event?: RepairPrLandedEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(event);
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('GitHub landing recovery query timed out after 30000ms')); }, 30_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) { child.kill('SIGTERM'); finish(new Error('GitHub landing recovery query exceeded 1 MiB output limit')); }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4_000); });
    child.once('error', (error) => finish(new Error(`GitHub landing recovery query could not start: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code !== 0) { finish(new Error(`GitHub landing recovery query failed rc=${code ?? signal}: ${(stderr || stdout).trim()}`)); return; }
      try { finish(undefined, repairLandingEventFromGhJson(stdout, prNumber, runId)); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

export interface RepairPrInspection {
  isDraft: boolean;
  files: string[];
  headRefOid: string;
}

export function validateRepairPrInspection(file: string, inspection: RepairPrInspection): void {
  if (!/^[0-9a-f]{40}$/i.test(inspection.headRefOid)) throw new Error('repair PR inspection omitted a valid head SHA');
  if (inspection.files.length !== 1 || inspection.files[0] !== file) {
    throw new Error(`repair PR must change only attributed file ${file}; found: ${inspection.files.join(', ') || 'none'}`);
  }
  if (inspection.isDraft) throw new Error(`repair PR must be ready before landing-event wait: ${file}`);
}

function failureIdsByFile(failureIds: readonly string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const id of failureIds) {
    const file = id.split(' > ', 1)[0]!.trim();
    const rows = grouped.get(file) ?? [];
    rows.push(id);
    grouped.set(file, rows);
  }
  return grouped;
}

/** Files sharing a failing test are coupled; unstructured attribution is also held for HITL. */
function coupledRepairFiles(grouped: ReadonlyMap<string, readonly string[]>, evidence: readonly RepairAttributionEvidence[] | undefined): Set<string> {
  const sourcesByFailure = new Map<string, Set<string>>();
  const sourcesByTestFile = new Map<string, Set<string>>();
  const evidenceByFailure = new Map((evidence ?? []).map((row) => [row.failureId, row]));
  const closureBySource = new Map<string, Set<string>>();
  const coupled = new Set<string>();
  for (const [sourceFile, attributedIds] of grouped) {
    for (const attributedId of attributedIds) {
      const separator = attributedId.indexOf(' > ');
      if (separator <= 0) { coupled.add(sourceFile); continue; }
      const originalFailureId = attributedId.slice(separator + 3);
      // The nested form is source-file > original-test-file > test name. A plain gate
      // failure ID does not prove source independence and stays on the HITL path.
      if (!originalFailureId.includes(' > ')) { coupled.add(sourceFile); continue; }
      const testFile = originalFailureId.slice(0, originalFailureId.indexOf(' > ')).trim();
      if (!isRepositoryRelativeSourceFile(testFile) || !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(testFile)) {
        coupled.add(sourceFile);
        continue;
      }
      const sources = sourcesByFailure.get(originalFailureId) ?? new Set<string>();
      sources.add(sourceFile);
      sourcesByFailure.set(originalFailureId, sources);
      const testSources = sourcesByTestFile.get(testFile) ?? new Set<string>();
      testSources.add(sourceFile);
      sourcesByTestFile.set(testFile, testSources);
      const measured = evidenceByFailure.get(originalFailureId);
      if (!measured || measured.unresolvedImports.length || !measured.sourceFiles.includes(sourceFile)
        || measured.sourceFiles.some((file) => !isRepositoryRelativeSourceFile(file))) {
        coupled.add(sourceFile);
      } else {
        const closure = closureBySource.get(sourceFile) ?? new Set<string>();
        for (const file of measured.sourceFiles) closure.add(file);
        closureBySource.set(sourceFile, closure);
      }
    }
  }
  for (const sources of sourcesByFailure.values()) {
    if (sources.size > 1) for (const source of sources) coupled.add(source);
  }
  // A test's transitive source closure is the independence evidence. If one test
  // file names multiple repair sources, those repairs are coupled even when the
  // failing test names differ; hold them before starting any child for those files.
  for (const sources of sourcesByTestFile.values()) {
    if (sources.size > 1) for (const source of sources) coupled.add(source);
  }
  // Distinct test names are not enough: measured transitive source closures must
  // also be disjoint before their repair children can run in parallel.
  for (const [sourceFile, closure] of closureBySource) {
    for (const [otherSource, otherClosure] of closureBySource) {
      if (sourceFile === otherSource) continue;
      if ([...closure].some((file) => otherClosure.has(file))) {
        coupled.add(sourceFile);
        coupled.add(otherSource);
      }
    }
  }
  return coupled;
}

function isRepositoryRelativeSourceFile(file: string): boolean {
  return file.length > 0 && !file.startsWith('/') && !file.includes('\\') && !file.includes('\0')
    && file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function startSelfImplementChild(featureFile: string, base: string, repo: string, runId: string, version: string, file: string): Promise<RepairChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawnSync('bun', ['bin/elanous.mjs', 'self', 'implement', '--feature-file', featureFile,
      '--base', base, '--open-pr', '--no-draft', '--json'], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 30 * 60 * 1_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ELANOUS_HARNESS_ENTRANCE: 'daemon-tool' },
    });
    if (child.error) return reject(child.error);
    if (child.status !== 0) return reject(new Error(`self-implement child failed rc=${child.status}: ${(child.stderr || child.stdout).trim().slice(-1200)}`));
    const lines = (child.stdout ?? '').trim().split('\n');
    let result: RepairChildResult | undefined;
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.ok === 'boolean') { result = parsed as unknown as RepairChildResult; break; }
      } catch { /* self-implement can print progress before its final JSON result */ }
    }
    if (!result || result.ok !== true || !Number.isSafeInteger(result.prNumber) || (result.prNumber ?? 0) < 1 ||
      typeof result.prUrl !== 'string' || !result.prUrl.endsWith(`/pull/${result.prNumber}`)) {
      return reject(new Error('self-implement did not return a successful opened repair PR'));
    }
    const title = `RLA-GATE-REPAIR ${runId} ${version}: ${file}`;
    const marked = spawnSync('gh', ['pr', 'edit', String(result.prNumber), '--title', title], {
      cwd: repo, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: process.env,
    });
    if (marked.status !== 0) return reject(new Error(`could not mark repair PR for graph landing events: ${(marked.stderr || marked.stdout || marked.error)?.toString().trim()}`));
    resolve(result);
  });
}

function inspectRepairPr(prNumber: number, repo: string): RepairPrInspection {
  const view = spawnSync('gh', ['pr', 'view', String(prNumber), '--json', 'isDraft,headRefOid,files'], {
    cwd: repo, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: process.env,
  });
  if (view.status !== 0 || view.error) {
    throw new Error(`could not inspect repair PR #${prNumber}: ${(view.stderr || view.stdout || view.error)?.toString().trim()}`);
  }
  let parsed: { isDraft?: unknown; headRefOid?: unknown; files?: unknown };
  try { parsed = JSON.parse(view.stdout) as typeof parsed; }
  catch { throw new Error(`repair PR #${prNumber} returned invalid inspection JSON`); }
  if (typeof parsed.isDraft !== 'boolean' || !Array.isArray(parsed.files) ||
    !parsed.files.every((entry) => typeof entry === 'object' && entry !== null && typeof (entry as { path?: unknown }).path === 'string') ||
    typeof parsed.headRefOid !== 'string' || !/^[0-9a-f]{40}$/i.test(parsed.headRefOid)) {
    throw new Error(`repair PR #${prNumber} inspection omitted isDraft, head, or changed file paths`);
  }
  return { isDraft: parsed.isDraft, headRefOid: parsed.headRefOid, files: parsed.files.map((entry) => (entry as { path: string }).path) };
}

function repairInput(context: GraphContext): { version: string; previousVersion: string; runId: string; commit: string; failureIds: string[];
  independenceEvidence?: RepairAttributionEvidence[]; bisectFindings?: RepairBisectFinding[] } {
  const input = context.nodeInput;
  if (!input || typeof input.version !== 'string' || input.version !== context.input.version ||
    typeof input.runId !== 'string' || input.runId !== context.runId || typeof input.commit !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(input.commit) || !Array.isArray(input.failureIds) || input.failureIds.length === 0 ||
    !input.failureIds.every((id) => typeof id === 'string' && id.includes(' > ') && id.split(' > ', 1)[0]!.trim())) {
    throw new Error('adaptive gate repair input is missing its run, cut commit, or attributed test IDs');
  }
  let independenceEvidence: RepairAttributionEvidence[] | undefined;
  const rawEvidence: unknown = input.independenceEvidence;
  if (rawEvidence !== undefined) {
    if (!Array.isArray(rawEvidence)) throw new Error('adaptive gate repair independence evidence is malformed');
    const rows: RepairAttributionEvidence[] = [];
    for (const value of rawEvidence as unknown[]) {
      if (!value || typeof value !== 'object') throw new Error('adaptive gate repair independence evidence is malformed');
      const row = value as Record<string, unknown>;
      if (typeof row.failureId !== 'string' || !Array.isArray(row.sourceFiles) || !Array.isArray(row.unresolvedImports)
        || !(row.sourceFiles as unknown[]).every((file: unknown) => typeof file === 'string')
        || !(row.unresolvedImports as unknown[]).every((specifier: unknown) => typeof specifier === 'string')) {
        throw new Error('adaptive gate repair independence evidence is malformed');
      }
      rows.push({ failureId: row.failureId, sourceFiles: row.sourceFiles as string[], unresolvedImports: row.unresolvedImports as string[] });
    }
    independenceEvidence = rows;
  }
  let bisectFindings: RepairBisectFinding[] | undefined;
  const rawBisectFindings: unknown = input.bisectFindings;
  if (rawBisectFindings !== undefined) {
    if (!Array.isArray(rawBisectFindings)) throw new Error('adaptive gate repair bisect findings are malformed');
    const rows: RepairBisectFinding[] = [];
    const files = new Set<string>();
    for (const value of rawBisectFindings as unknown[]) {
      if (!value || typeof value !== 'object') throw new Error('adaptive gate repair bisect findings are malformed');
      const row = value as Record<string, unknown>;
      if (typeof row.file !== 'string' || !isRepositoryRelativeSourceFile(row.file)
        || typeof row.firstFailingCommit !== 'string' || !/^[0-9a-f]{40}$/i.test(row.firstFailingCommit)
        || files.has(row.file)) throw new Error('adaptive gate repair bisect findings are malformed');
      files.add(row.file);
      rows.push({ file: row.file, firstFailingCommit: row.firstFailingCommit });
    }
    bisectFindings = rows;
  }
  return { version: input.version, previousVersion: context.input.previousVersion, runId: input.runId, commit: input.commit, failureIds: input.failureIds as string[],
    ...(independenceEvidence ? { independenceEvidence: independenceEvidence as RepairAttributionEvidence[] } : {}),
    ...(bisectFindings ? { bisectFindings } : {}) };
}

function gitIsAncestor(ancestor: string, descendant: string, repo: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repo, encoding: 'utf8', timeout: 30_000, env: process.env, maxBuffer: SPAWN_SYNC_MAX_BUFFER,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`could not verify repair merge ancestry: ${(result.stderr || result.error)?.toString().trim() ?? `git exited ${result.status}`}`);
  }
  return result.status === 0;
}

function fetchMainlineHead(repo: string): string {
  const fetch = spawnSync('git', ['fetch', '--no-tags', 'origin', 'main'], {
    cwd: repo, encoding: 'utf8', timeout: 120_000, env: process.env, maxBuffer: SPAWN_SYNC_MAX_BUFFER,
  });
  if (fetch.error || fetch.status !== 0) {
    throw new Error(`could not refresh origin/main after repair landings: ${(fetch.stderr || fetch.error)?.toString().trim() ?? `git exited ${fetch.status}`}`);
  }
  const resolved = spawnSync('git', ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], {
    cwd: repo, encoding: 'utf8', timeout: 30_000, env: process.env, maxBuffer: SPAWN_SYNC_MAX_BUFFER,
  });
  const head = resolved.stdout.trim();
  if (resolved.error || resolved.status !== 0 || !/^[0-9a-f]{40}$/i.test(head)) {
    throw new Error(`refreshed origin/main did not resolve to a commit: ${(resolved.stderr || resolved.error)?.toString().trim() ?? head}`);
  }
  return head;
}

/** Run independent one-file repair children concurrently; any coupled or incomplete file is returned for HITL. */
export async function runGateRepairNode(context: GraphContext, deps: GateRepairNodeDeps = {}) {
  const { version, previousVersion, runId, commit, failureIds, independenceEvidence: suppliedEvidence, bisectFindings } = repairInput(context);
  const repo = deps.repo ?? process.cwd();
  let attributions: ReleaseFailureAttribution[] = [];
  let attributionError: string | undefined;
  try {
    attributions = (deps.attributeFailures ?? attributeReleaseFailures)({ repo, previousTag: `v${previousVersion}`,
      cutCommit: commit, failureIds });
  } catch (error) { attributionError = error instanceof Error ? error.message : String(error); }
  const attributedFailureIds: string[] = [];
  const attributionHeld: Array<{ file: string; failureIds: string[]; status: 'hitl'; reason: string }> = [];
  const evidence: RepairAttributionEvidence[] = [...(suppliedEvidence ?? [])];
  const causePrsBySource = new Map<string, Set<number>>();
  const uncertainFailureIdsBySource = new Map<string, Set<string>>();
  if (attributionError) {
    for (const failureId of failureIds) attributionHeld.push({ file: '', failureIds: [failureId], status: 'hitl',
      reason: `source attribution unavailable: ${attributionError}` });
  } else {
    for (const attribution of attributions) {
      evidence.push({ failureId: attribution.failureId, sourceFiles: attribution.sourceFiles,
        unresolvedImports: attribution.unresolvedImports });
      if (attribution.confidence !== 'high' || !attribution.sourceFiles.length || !attribution.causePrs.length) {
        attributionHeld.push({ file: attribution.testFile || '(unmeasured source)', failureIds: [attribution.failureId], status: 'hitl',
          reason: `source attribution is ${attribution.confidence}; cause PR is not uniquely measured` });
        for (const sourceFile of attribution.sourceFiles) {
          if (!isRepositoryRelativeSourceFile(sourceFile)) continue;
          const heldIds = uncertainFailureIdsBySource.get(sourceFile) ?? new Set<string>();
          heldIds.add(attribution.failureId);
          uncertainFailureIdsBySource.set(sourceFile, heldIds);
        }
        continue;
      }
      for (const sourceFile of attribution.sourceFiles) {
        if (!isRepositoryRelativeSourceFile(sourceFile)) {
          attributionHeld.push({ file: sourceFile, failureIds: [attribution.failureId], status: 'hitl',
            reason: 'invalid repository-relative source attribution' });
          continue;
        }
        attributedFailureIds.push(`${sourceFile} > ${attribution.failureId}`);
        const causes = causePrsBySource.get(sourceFile) ?? new Set<number>();
        for (const causePr of attribution.causePrs) causes.add(causePr);
        causePrsBySource.set(sourceFile, causes);
      }
    }
  }
  const grouped = failureIdsByFile(attributedFailureIds);
  const files = [...grouped.keys()].sort();
  const coupledFiles = files.length > 1 ? coupledRepairFiles(grouped, evidence) : new Set<string>();
  const ambiguousCauseFiles = new Set(files.filter((file) => (causePrsBySource.get(file)?.size ?? 0) !== 1
    || uncertainFailureIdsBySource.has(file)));
  // Independent siblings may proceed; coupled or unmeasured files are kept off the
  // child path and their HITL rows join the ordinary per-file result below.
  const root = deps.root ?? effectiveInstanceRoot();
  const repairBase = 'main';
  const repairOneFile = async (file: string, fileFailureIds: string[]) => {
    if (!isRepositoryRelativeSourceFile(file)) return { file, failureIds: fileFailureIds, status: 'hitl' as const,
      reason: 'invalid repository-relative source attribution' };
    try {
      const fileKey = createHash('sha256').update(file).digest('hex').slice(0, 12);
      const featureFile = join(root, 'release', 'gate-repairs', runId, `${file.replaceAll('/', '__')}-${fileKey}.md`);
      mkdirSync(join(root, 'release', 'gate-repairs', runId), { recursive: true });
      const causePrs = [...(causePrsBySource.get(file) ?? [])].sort((a, b) => a - b);
      const causeLine = causePrs.length === 1 ? `Attributed cause PR: #${causePrs[0]}`
        : `Attributed cause PRs: ${causePrs.map((number) => `#${number}`).join(', ')}`;
      const bisectFinding = bisectFindings?.find((finding) => finding.file === file);
      writeFileSync(featureFile, [
        `# Release gate repair for ${version}`,
        '',
        `Graph run: ${runId}`,
        `Measured cut: ${commit}`,
        ...(bisectFinding ? [`Bisected first-failing commit: ${bisectFinding.firstFailingCommit}`] : []),
        `Attributed source file: ${file}`,
        causeLine,
        'Introduced failures:',
        ...fileFailureIds.map((id) => `- ${id}`),
        '',
        'Repair only these introduced failures in the attributed file. Preserve unrelated behavior and run the focused tests for this file.',
        'If the repair requires another source file, do not widen this PR; stop and leave these failures for HITL.',
        'Open a non-draft repair PR against main; do not merge or push directly to main.',
      ].join('\n') + '\n', { mode: 0o600 });

      const child = await (deps.startRepairChild ?? ((path, base) => startSelfImplementChild(path, base, repo, runId, version, file)))(featureFile, repairBase);
      if (!child.ok || !Number.isSafeInteger(child.prNumber) || !child.prUrl?.endsWith(`/pull/${child.prNumber}`))
        throw new Error(`self-implement child did not produce a repair PR identity${child.stage ? ` (${child.stage})` : ''}`);
      const inspection = await (deps.inspectRepairPr ?? inspectRepairPr)(child.prNumber!, repo);
      validateRepairPrInspection(file, inspection);
      debug.log('release-loop.gate-repair', 'repair-pr-opened', { version, runId, sourceCommit: commit,
        prNumber: child.prNumber, branch: child.branch ?? null, head: child.checkedHeadCommit ?? null, file,
        changedFiles: inspection.files, isDraft: inspection.isDraft });

      let landed: RepairPrLandedEvent;
      try {
        landed = await (deps.waitForLanded ?? ((prNumber, eventRoot) => waitForRepairPrLanded(prNumber, {
          root: eventRoot, repairRunId: runId, expectedHead: inspection.headRefOid,
          ...(deps.recoveryIntervalMs === undefined ? {} : { recoveryIntervalMs: deps.recoveryIntervalMs }),
          recover: () => (deps.recoverLanded ?? ((number, repairRun) => recoverMergedRepairPr(number, repairRun, repo)))(prNumber, runId, eventRoot),
        })))(child.prNumber!, root);
      } catch (error) {
        if (error instanceof RepairLandingRecoveryExhaustedError) {
          throw new RepairLandingRecoveryExhaustedError(`repair PR #${child.prNumber} run ${runId} inspected head ${inspection.headRefOid}; ${error.message}`);
        }
        throw error;
      }
      if (landed.head !== inspection.headRefOid) throw new Error(`repair PR #${child.prNumber} landed head ${landed.head} differs from inspected head ${inspection.headRefOid}`);
      if (landed.prNumber !== child.prNumber || landed.repairRunId !== runId || landed.base !== repairBase) throw new Error('repair PR landing event identity/base mismatch');
      const result = { file, failureIds: fileFailureIds, status: 'repaired' as const, prNumber: child.prNumber!,
        head: landed.head, mergeSha: landed.mergeSha, mergedAt: landed.mergedAt,
        ...(bisectFinding ? { firstFailingCommit: bisectFinding.firstFailingCommit } : {}) };
      debug.log('release-loop.gate-repair', 'repair-pr-landed', { version, runId, ...result });
      return result;
    } catch (error) {
      if (error instanceof RepairLandingRecoveryExhaustedError) {
        return { file, failureIds: fileFailureIds, status: 'recovery-required' as const, reason: error.message };
      }
      const reason = error instanceof Error ? error.message : String(error);
      debug.log('release-loop.gate-repair', 'repair-file-hitl', { version, runId, file, failureIds: fileFailureIds, reason }, { level: 'warn' });
      return { file, failureIds: fileFailureIds, status: 'hitl' as const, reason };
    }
  };

  const heldRepairs = [...coupledFiles].map((file) => ({ file, failureIds: grouped.get(file)!, status: 'hitl' as const,
    reason: 'multi-file source attribution does not prove independent failing tests; HITL required' }));
  const ambiguousCauseRepairs = [...ambiguousCauseFiles].filter((file) => !coupledFiles.has(file)).map((file) => {
    const uncertainIds = [...(uncertainFailureIdsBySource.get(file) ?? [])];
    const causeCount = causePrsBySource.get(file)?.size ?? 0;
    return { file, failureIds: [...new Set([...grouped.get(file)!, ...uncertainIds])], status: 'hitl' as const,
      reason: uncertainIds.length
        ? 'source file also has incomplete attribution; all related failures require same-run HITL'
        : `source file has ${causeCount} cause PRs; exactly one is required for child repair` };
  });
  const repairCandidates = files.filter((file) => !coupledFiles.has(file) && !ambiguousCauseFiles.has(file));
  const repairRoundLimit = 4;
  const parallelLimit = 2;
  const repairedIndependently: Array<Awaited<ReturnType<typeof repairOneFile>>> = [];
  for (let roundStart = 0; roundStart < repairCandidates.length; roundStart += repairRoundLimit) {
    const roundFiles = repairCandidates.slice(roundStart, roundStart + repairRoundLimit);
    const roundResults: Array<Awaited<ReturnType<typeof repairOneFile>>> = new Array(roundFiles.length);
    let nextRepair = 0;
    await Promise.all(Array.from({ length: Math.min(parallelLimit, roundFiles.length) }, async () => {
      while (true) {
        const index = nextRepair++;
        if (index >= roundFiles.length) return;
        const file = roundFiles[index]!;
        roundResults[index] = await repairOneFile(file, grouped.get(file)!);
      }
    }));
    repairedIndependently.push(...roundResults);
  }
  const repairs = [...heldRepairs, ...ambiguousCauseRepairs, ...repairedIndependently];
  const repaired = repairs.filter((repair) => repair.status === 'repaired');
  const ambiguousSourceFailureIds = new Set(ambiguousCauseRepairs.flatMap(({ failureIds: ids }) => ids));
  const humanRequired = [...repairs.filter((repair) => repair.status === 'hitl'),
    ...attributionHeld.filter(({ failureIds: ids }) => !ids.some((id) => ambiguousSourceFailureIds.has(id)))];
  const ancestor = deps.isAncestor ?? gitIsAncestor;
  const presentOnMainline: typeof repaired = [];
  const absentFromMainline: Array<{ file: string; failureIds: string[]; reason: string }> = [];
  let refreshedMainline: string | undefined;
  if (repaired.length) {
    try {
      refreshedMainline = (deps.refreshMainlineHead ?? fetchMainlineHead)(repo);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      absentFromMainline.push(...repaired.map(({ file, failureIds: ids }) => ({ file, failureIds: ids, reason })));
    }
  }
  if (refreshedMainline) {
    for (const repair of repaired) {
      try {
        if (ancestor(repair.mergeSha, refreshedMainline, repo)) presentOnMainline.push(repair);
        else absentFromMainline.push({ file: repair.file, failureIds: repair.failureIds,
          reason: `repair merge ${repair.mergeSha} is not an ancestor of refreshed origin/main ${refreshedMainline}` });
      } catch (error) {
        absentFromMainline.push({ file: repair.file, failureIds: repair.failureIds,
          reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const allHumanRequired = [
    ...humanRequired.map(({ file, reason, failureIds: ids }) => ({ file, reason, failureIds: ids })),
    ...absentFromMainline,
  ];
  const knownFailureIds = new Set([...failureIds, ...attributions.map(({ failureId }) => failureId)]);
  const unprefixFailureIds = (ids: string[]) => ids.map((id) => {
    const separator = id.indexOf(' > ');
    if (separator <= 0) return id;
    const sourceFile = id.slice(0, separator);
    const originalFailureId = id.slice(separator + 3);
    return grouped.has(sourceFile) && knownFailureIds.has(originalFailureId) ? originalFailureId : id;
  });
  const recoveryRequired = repairs.filter((repair) => repair.status === 'recovery-required');
  if (recoveryRequired.length) {
    const remainingFailureIds = [...new Set([
      ...unprefixFailureIds(recoveryRequired.flatMap(({ failureIds: ids }) => ids)),
      ...unprefixFailureIds(allHumanRequired.flatMap(({ failureIds: ids }) => ids)),
    ])];
    return { outcome: 'recovery-required' as const, verdict: 'fail' as const,
      summary: `${presentOnMainline.length}/${files.length} repair files are verified on refreshed mainline; landing recovery required for ${recoveryRequired.map(({ file, reason }) => `${file}: ${reason}`).join('; ')}`,
      repairedFiles: presentOnMainline.map(({ file }) => file), humanRequired: allHumanRequired,
      remainingFailureIds, repairs };
  }
  if (allHumanRequired.length) {
    const remainingFailureIds = [...new Set(unprefixFailureIds(allHumanRequired.flatMap(({ failureIds: ids }) => ids)))];
    return { outcome: 'fail' as const, verdict: 'fail' as const,
      summary: `${presentOnMainline.length}/${files.length} attributed repair files are verified on refreshed mainline; HITL needed for ${allHumanRequired.map(({ file }) => file).join(', ')}`,
      repairedFiles: presentOnMainline.map(({ file }) => file),
      humanRequired: allHumanRequired,
      remainingFailureIds, repairs };
  }
  return { outcome: 'ok' as const, verdict: 'pass' as const,
    summary: `all ${files.length} attributed gate repair PRs are present on refreshed mainline; gate will remeasure the repaired files`,
    commit: refreshedMainline!, repairedFiles: repaired.map(({ file }) => file), repairs };
}

export async function runGateRepairNodeCli(env: NodeJS.ProcessEnv = process.env, deps: GateRepairNodeDeps = {}): Promise<number> {
  let version = '';
  try {
    const context = readGraphContext(env);
    version = context.input.version;
    const result = await runGateRepairNode(context, deps);
    return finishNode('gate-repair', version, result);
  } catch (error) {
    if (error instanceof RepairLandingRecoveryExhaustedError) {
      const result = { outcome: 'recovery-required' as const, verdict: 'fail' as const, summary: error.message };
      debug.log('release-loop.gate-repair', 'recovery-required', { version, error: result.summary }, { level: 'error' });
      return finishNode('gate-repair', version, result);
    }
    const result = errorResult(error);
    debug.log('release-loop.gate-repair', 'failed', { version, error: result.summary }, { level: 'error' });
    return finishNode('gate-repair', version, result);
  }
}

if (import.meta.main) {
  await registerStandaloneLogSink('release-loop');
  process.exitCode = await runGateRepairNodeCli();
}
