#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { registerStandaloneLogSink } from '../../src/domains/standalone-log-sink.js';
import { readGraphContext, finishNode, errorResult, type GraphContext } from './node-verdict.js';
import { waitForRepairPrLanded, type RepairPrLandedEvent } from './repair-pr-landed.js';

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

function sourceFiles(failureIds: readonly string[]): string[] {
  return [...new Set(failureIds.map((id) => id.split(' > ', 1)[0]!.trim()))].sort();
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

function repairInput(context: GraphContext): { version: string; runId: string; commit: string; failureIds: string[] } {
  const input = context.nodeInput;
  if (!input || typeof input.version !== 'string' || input.version !== context.input.version ||
    typeof input.runId !== 'string' || input.runId !== context.runId || typeof input.commit !== 'string' ||
    !/^[0-9a-f]{40}$/i.test(input.commit) || !Array.isArray(input.failureIds) || input.failureIds.length === 0 ||
    !input.failureIds.every((id) => typeof id === 'string' && id.includes(' > ') && id.split(' > ', 1)[0]!.trim())) {
    throw new Error('adaptive gate repair input is missing its run, cut commit, or attributed test IDs');
  }
  return { version: input.version, runId: input.runId, commit: input.commit, failureIds: input.failureIds as string[] };
}

/** Start one real self-implement child for one attributed source file, then wait for that PR's durable landing event. */
export async function runGateRepairNode(context: GraphContext, deps: GateRepairNodeDeps = {}) {
  const { version, runId, commit, failureIds } = repairInput(context);
  const files = sourceFiles(failureIds);
  if (files.length !== 1 || files[0]!.startsWith('/') || files[0]!.split('/').some((part) => part === '..')) {
    throw new Error(`gate repair requires exactly one repository-relative source file; HITL routing needed for: ${files.join(', ') || 'invalid attribution'}`);
  }
  const root = deps.root ?? effectiveInstanceRoot();
  const repairBase = 'main';
  const featureFile = join(root, 'release', 'gate-repairs', runId, `${files[0]!.replaceAll('/', '__')}.md`);
  mkdirSync(join(root, 'release', 'gate-repairs', runId), { recursive: true });
  writeFileSync(featureFile, [
    `# Release gate repair for ${version}`,
    '',
    `Graph run: ${runId}`,
    `Measured cut: ${commit}`,
    `Attributed source file: ${files[0]}`,
    'Introduced failures:',
    ...failureIds.map((id) => `- ${id}`),
    '',
    'Repair only these introduced failures in the attributed file. Preserve unrelated behavior. Run the focused tests for this file. Open a non-draft repair PR against main; do not merge or push directly to main.',
  ].join('\n') + '\n', { mode: 0o600 });

  const child = await (deps.startRepairChild ?? ((path, base) => startSelfImplementChild(path, base, deps.repo ?? process.cwd(), runId, version, files[0]!)))(featureFile, repairBase);
  if (!child.ok || !Number.isSafeInteger(child.prNumber) || !child.prUrl?.endsWith(`/pull/${child.prNumber}`))
    throw new Error('self-implement child did not produce a repair PR identity');
  const inspection = await (deps.inspectRepairPr ?? inspectRepairPr)(child.prNumber!, deps.repo ?? process.cwd());
  validateRepairPrInspection(files[0]!, inspection);
  debug.log('release-loop.gate-repair', 'repair-pr-opened', { version, runId, sourceCommit: commit,
    prNumber: child.prNumber, branch: child.branch ?? null, head: child.checkedHeadCommit ?? null, file: files[0],
    changedFiles: inspection.files, isDraft: inspection.isDraft });

  const landed = await (deps.waitForLanded ?? ((prNumber, eventRoot) => waitForRepairPrLanded(prNumber, { root: eventRoot, repairRunId: runId })))(child.prNumber!, root);
  if (landed.head !== inspection.headRefOid) throw new Error(`repair PR #${child.prNumber} landed head ${landed.head} differs from inspected head ${inspection.headRefOid}`);
  if (landed.prNumber !== child.prNumber || landed.repairRunId !== runId || landed.base !== repairBase) throw new Error('repair PR landing event identity/base mismatch');
  const result = { outcome: 'ok' as const, verdict: 'pass' as const, summary: `repair PR #${child.prNumber} landed; gate will remeasure ${files[0]}`,
    commit: landed.mergeSha, repairPr: child.prNumber, repairHead: landed.head, repairBase: landed.base, failureIds };
  debug.log('release-loop.gate-repair', 'repair-pr-landed', { version, runId, ...result, mergedAt: landed.mergedAt });
  return result;
}

export async function runGateRepairNodeCli(env: NodeJS.ProcessEnv = process.env, deps: GateRepairNodeDeps = {}): Promise<number> {
  let version = '';
  try {
    const context = readGraphContext(env);
    version = context.input.version;
    const result = await runGateRepairNode(context, deps);
    return finishNode('gate-repair', version, result);
  } catch (error) {
    const result = errorResult(error);
    debug.log('release-loop.gate-repair', 'failed', { version, error: result.summary }, { level: 'error' });
    return finishNode('gate-repair', version, result);
  }
}

if (import.meta.main) {
  await registerStandaloneLogSink('release-loop');
  process.exitCode = await runGateRepairNodeCli();
}
