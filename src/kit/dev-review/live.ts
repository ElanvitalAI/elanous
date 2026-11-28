// DEV-REVIEW-COMMON — the live host of the three review units: the board ports (checklist · ledger), the criterion author
// (the judge's own LLM route), the PR facts of a first pregate, and the two hand-path doors:
//   `eln work next` claim → startCellReviewDetached (spawn and return · never blocks the hand) → `eln work review cell <id>`
//   graphs/triggers/dev-review-post-impl.yaml (first pregate receipt) → `eln work review scan` → post-impl@1 per new PR
// 세 얼굴: 관측 = <stateRoot>/dev-review/ledger.jsonl ⊕ debug 'dev-review' · 판단 근거 = src/kit/dev-review (judge kit) ·
//          수복과 인계 = written/strengthened criterion · FU cells · one evidence line; any port failure is a ledger row, never a stop.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { getElanousConfigDirOverride } from '../../elanous-config-dir.js';
import { PROVIDERS, streamLLM } from '../../llm.js';
import { activeBoardVersion } from '../../ops-dashboard/current-version.js';
import { addItem, listChecklist, setItemIfSnapshot } from '../../release-loop/checklist.js';
import { HQ_REPO_DIR } from '../../release-loop/green-triage.js';
import { prCellBinding } from '../../land-graph/cell-link.js';
import { pregateLane, scanPregateLane } from '../../loop-agent/bodies/run-lifecycle-shared.js';
import { judgeLlmRoute, readJudgeLlmPolicy } from '../requirement-judge/index.js';
import {
  createDevReviewHandlers, loadDevReviewPolicy, reviewUnitPath,
  type CellReviewResult, type DevReviewLedgerRow, type DevReviewPolicy, type DevReviewPorts, type FuCell, type PostImplResult, type PreImplResult,
} from './index.js';

const ledgerPath = (policy: DevReviewPolicy, root = effectiveInstanceRoot()): string => join(root, policy.ledgerFile);
export function readDevReviewLedger(policy: DevReviewPolicy, root = effectiveInstanceRoot()): DevReviewLedgerRow[] {
  const p = ledgerPath(policy, root);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').flatMap(l => { try { return l.trim() ? [JSON.parse(l) as DevReviewLedgerRow] : []; } catch { return []; } });
}

/** The board ports on the real checklist of `version` (snapshot-guarded writes, the judge butler's FU shape). */
export function liveDevReviewPorts(version: string, opts: { write: boolean; policy: DevReviewPolicy; root?: string }): DevReviewPorts {
  const root = opts.root ?? effectiveInstanceRoot();
  const by = opts.policy.cellReview.writer;
  const item = (id: string) => listChecklist(version).items.find(i => i.id === id);
  return {
    write: opts.write,
    now: () => new Date(),
    writeCriterion: (cell, before, after) => {
      const i = item(cell);
      if (!i || (i.doneCriterion ?? '').trim() !== before.trim()) return false;
      try {
        setItemIfSnapshot(version, cell, { doneCriterion: after }, by, { title: i.title, status: i.status, evidence: i.evidence ?? '', ...(i.doneCriterion ? { doneCriterion: i.doneCriterion } : {}) });
        return true;
      } catch { return false; }
    },
    addFollowUp: (fu: FuCell, priority) => {
      if (item(fu.id)) return 'exists';
      try { addItem(version, { id: fu.id, title: fu.title, priority: priority as 'P2', source: 'dev-review · DEV-REVIEW-COMMON (edge → FU before the sign)' }); return 'added'; } catch { return 'failed'; }
    },
    appendEvidence: (cell, line) => {
      const i = item(cell);
      if (!i) return false;
      if ((i.evidence ?? '').split('\n').includes(line)) return true;
      try { setItemIfSnapshot(version, cell, { evidence: i.evidence ? `${i.evidence}\n${line}` : line }, by, { title: i.title, status: i.status, evidence: i.evidence ?? '' }); return true; } catch { return false; }
    },
    record: (row) => {
      const p = ledgerPath(opts.policy, root);
      try { mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, `${JSON.stringify({ ...row, version })}\n`); } catch { /* observation */ }
      debug.log('dev-review', `${row.unit}.${row.outcome}`, { ...row, version });
    },
  };
}

/** The criterion author on the judge's own route (judging.yaml judge_llm · GLM refused there) — or undefined when it may not call. */
export function judgeRouteAuthor(): ((prompt: string) => Promise<string>) | undefined {
  const policy = readJudgeLlmPolicy();
  const route = judgeLlmRoute(policy);
  if (!route.ok) return undefined;
  return async (prompt) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`criterion author timeout ${policy.timeoutMs}ms`)), policy.timeoutMs); });
    try {
      return await Promise.race([streamLLM([{ role: 'user', content: prompt }], () => {}, { model: route.model, provider: PROVIDERS[route.provider]!, reasoningEffort: route.reasoning, usageSite: 'kit:dev-review' }), timeout]);
    } finally { if (timer) clearTimeout(timer); }
  };
}

/** Run one review unit (the same YAML the TA journey calls) on the handler set. */
export async function runReviewUnit(unit: 'cell-review' | 'pre-impl' | 'post-impl', input: Record<string, unknown>, deps: Parameters<typeof createDevReviewHandlers>[0] & { root?: string; runId?: string }): Promise<{ status: string; exit: string | undefined; result: unknown }> {
  const { runGraph } = await import('../../graph-runner/runner.js');
  let last: unknown;
  const handlers = createDevReviewHandlers({ ...deps, ports: { ...deps.ports, record: (row) => { last = row; deps.ports.record(row); } } });
  const state = await runGraph(reviewUnitPath(unit), { input, quiet: true, ...(deps.runId ? { runId: deps.runId } : {}), deps: { ...(deps.root ? { root: deps.root } : {}), inProcessHandlers: handlers } });
  const exit = state.reason ?? state.path[state.path.length - 1];
  // the last handler node's envelope (`{ result, outcome }` serialized by the runner) — terminal gates carry none
  let result: unknown;
  for (const rec of [...state.nodes].reverse()) {
    const raw = rec.output;
    let env: unknown = raw;
    if (typeof raw === 'string') { try { env = JSON.parse(raw); } catch { env = undefined; } }
    if (env && typeof env === 'object' && 'result' in env) { result = (env as { result: unknown }).result; break; }
  }
  return { status: state.status, exit, result: result ?? last };
}

const resultOf = <T>(r: { result: unknown }): T | undefined => r.result as T | undefined;

/** `eln work review cell <id>` — cell-review@1 then pre-impl@1 on the judge's split. Once per cell per criterion text. */
export async function runCellReviewCli(cellId: string, opts: { version?: string; dryRun?: boolean; json?: boolean; force?: boolean }): Promise<number> {
  const { policy, source, error } = loadDevReviewPolicy();
  const version = opts.version ?? activeBoardVersion();
  const cell = listChecklist(version).items.find(i => i.id === cellId);
  if (!cell) { console.error(`work review: no cell ${cellId} in ${version}`); return 2; }
  const ports = liveDevReviewPorts(version, { write: !opts.dryRun, policy });
  const { criterionHash } = await import('./index.js');
  const hash = criterionHash(cell.doneCriterion ?? '');
  // once per (version, cell, criterion text) — a later pre-impl «fu-failed» row re-opens it (the FU is retried on the next claim)
  const rows = readDevReviewLedger(policy).filter(r => r.cell === cellId && r.version === version && r.write === true);
  const lastReview = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.unit === 'cell-review' && (r.beforeHash === hash || r.afterHash === hash)).at(-1);
  const fuFailedAfter = lastReview ? rows.slice(lastReview.i + 1).some(r => r.unit === 'pre-impl' && r.outcome === 'fu-failed') : false;
  const seen = !!lastReview && !fuFailedAfter;
  if (seen && !opts.force) {
    if (opts.json) console.log(JSON.stringify({ cell: cellId, outcome: 'already-reviewed', criterionHash: hash }));
    else console.log(`work review: ${cellId} already reviewed at criterion ${hash} (once per criterion · --force to rerun)`);
    return 0;
  }
  const author = judgeRouteAuthor();
  const cr = await runReviewUnit('cell-review', { cell: { id: cell.id, title: cell.title, ...(cell.body ? { body: cell.body } : {}), ...(cell.doneCriterion ? { doneCriterion: cell.doneCriterion } : {}) }, version },
    { ports, policy, ...(author ? { author } : {}) });
  const review = resultOf<CellReviewResult>(cr);
  const requirements = review && Array.isArray(review.requirements) ? review.requirements : [];
  const pre = requirements.length
    ? await runReviewUnit('pre-impl', { cell: cellId, requirements }, { ports, policy })
    : { status: 'skipped', exit: 'hold', result: undefined };
  const split = resultOf<PreImplResult>(pre);
  const out = { cell: cellId, version, policy: source, ...(error ? { policyError: error } : {}), cellReview: { exit: cr.exit, why: review?.why }, preImpl: { exit: pre.exit, why: split?.why, fus: split?.fus?.map(f => f.id) ?? [] }, write: !opts.dryRun };
  if (opts.json) console.log(JSON.stringify(out));
  else console.log(`work review ${cellId}: cell-review → ${cr.exit}${review?.why ? ` (${review.why})` : ''} · pre-impl → ${pre.exit}${split?.why ? ` (${split.why})` : ''}${opts.dryRun ? ' · dry-run (nothing written)' : ''}`);
  return 0;
}

/** The hand path's claim hook: spawn `eln work review cell <id>` detached and return. Bounded by cell_review.max_block_ms. */
export function startCellReviewDetached(cellId: string, version: string, entry: readonly string[] = [process.execPath, process.argv[1] ?? '']): { started: boolean; why: string } {
  const started = Date.now();
  const { policy } = loadDevReviewPolicy();
  try {
    if (!entry[1] || /\.test\.[cm]?[jt]sx?$/u.test(entry[1])) return { started: false, why: 'no CLI entry to spawn' };
    // the same universe as the claim: an explicit --config-dir (test universe) rides along
    const configDir = getElanousConfigDirOverride();
    const child = spawn(entry[0]!, [...entry.slice(1), ...(configDir ? ['--config-dir', configDir] : []), 'work', 'review', 'cell', cellId, '--version', version], { detached: true, stdio: 'ignore', env: process.env });
    // an async spawn failure (missing executable · EACCES) must never take the claiming process down
    child.on('error', (e) => { debug.log('dev-review', 'claim.spawn-error', { cell: cellId, version, error: e instanceof Error ? e.message : String(e) }); });
    child.unref();
    const ms = Date.now() - started;
    debug.log('dev-review', 'claim.spawned', { cell: cellId, version, pid: child.pid, ms, maxBlockMs: policy.cellReview.maxBlockMs });
    return ms > policy.cellReview.maxBlockMs ? { started: true, why: `spawn took ${ms}ms > max_block_ms ${policy.cellReview.maxBlockMs}` } : { started: true, why: `spawned in ${ms}ms` };
  } catch (e) { return { started: false, why: e instanceof Error ? e.message : String(e) }; }
}

/** The claim hook `eln work next` calls (work-next-cli.ts): a claimed cell (exit 0) starts its review; anything else nothing. */
export function onWorkClaimed(result: { readonly code: number; readonly cell?: { readonly id: string } }, version: string,
  start: (cellId: string, version: string) => { started: boolean; why: string } = startCellReviewDetached): { started: boolean; why: string } | null {
  if (result.code !== 0 || !result.cell) return null;
  try { return start(result.cell.id, version); } catch (e) { return { started: false, why: e instanceof Error ? e.message : String(e) }; }
}

interface PrView { head: string; files: string[]; title: string; body: string; headRef: string }
function ghPrView(pr: number): PrView | null {
  const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'headRefOid,files,title,body,headRefName'], { cwd: HQ_REPO_DIR, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { headRefOid?: string; files?: Array<{ path?: string }>; title?: string; body?: string | null; headRefName?: string };
    return { head: j.headRefOid ?? '', files: (j.files ?? []).map(f => String(f.path ?? '')).filter(Boolean), title: j.title ?? '', body: j.body ?? '', headRef: j.headRefName ?? '' };
  } catch { return null; }
}

/** `eln work review post <pr>` — post-impl@1 on one PR (cell from its «칸:» line / title / branch). */
export async function runPostImplCli(pr: number, opts: { version?: string; dryRun?: boolean; json?: boolean; receipt?: { lane: string; status: string; mode: string | null } }): Promise<{ code: number; outcome?: string }> {
  const { policy } = loadDevReviewPolicy();
  const version = opts.version ?? activeBoardVersion();
  const ports = liveDevReviewPorts(version, { write: !opts.dryRun, policy });
  const view = ghPrView(pr);
  if (!view) {
    // a retry row: the scan orders PRs by attempts, so one failing PR never holds the others' turn
    ports.record({ at: new Date().toISOString(), unit: 'post-impl', cell: '', outcome: 'gh-failed', pr, write: false });
    console.error(`work review post: gh pr view ${pr} failed`); return { code: 2 };
  }
  const items = listChecklist(version).items;
  const b = prCellBinding({ title: view.title, body: view.body, headRef: view.headRef }, items);
  const cellId = b.declared[0] ?? b.title[0] ?? b.branch[0];
  if (!cellId) { ports.record({ at: new Date().toISOString(), unit: 'post-impl', cell: '', outcome: 'no-cell', pr, head: view.head.slice(0, 12), write: !opts.dryRun }); return { code: 0, outcome: 'no-cell' }; }
  const cell = items.find(i => i.id === cellId)!;
  // the judge's evidence shape for an open PR: its files, its body (receipt lines, AUTHOR-PRECHECK), and the first receipt
  const facts = { merged: false, head: view.head, files: view.files, body: view.body.slice(0, 4000), ...(opts.receipt ? { receipt: opts.receipt } : {}) };
  const r = await runReviewUnit('post-impl', { cell: cellId, criterion: cell.doneCriterion ?? '', pr, head: view.head, facts }, { ports, policy });
  const res = resultOf<PostImplResult>(r);
  if (opts.json) console.log(JSON.stringify({ pr, cell: cellId, exit: r.exit, why: res?.why, fus: res?.fus?.map(f => f.id) ?? [] }));
  else console.log(`work review post #${pr} (${cellId}): ${r.exit}${res?.why ? ` — ${res.why}` : ''}`);
  return { code: 0, ...(r.exit ? { outcome: r.exit } : {}) };
}

/** The first-pregate scan (trigger tick): lanes newer than the watermark whose PR has no post-impl row yet → post-impl@1. */
export async function runPostImplScan(opts: { version?: string; dryRun?: boolean; json?: boolean }): Promise<number> {
  const { policy } = loadDevReviewPolicy();
  const root = effectiveInstanceRoot();
  const markPath = join(root, dirname(policy.ledgerFile), 'post-impl-watermark.json');
  let since: number | null = null;
  try { since = (JSON.parse(readFileSync(markPath, 'utf8')) as { sinceMs?: number }).sinceMs ?? null; } catch { since = null; }
  const tickAt = Date.now();
  // the trigger's goal (file-mtime) — rewritten every tick, shadow included (it is not a board write); sinceMs never moves
  const mark = (sinceMs: number) => { try { mkdirSync(dirname(markPath), { recursive: true }); writeFileSync(markPath, JSON.stringify({ sinceMs, lastTickAt: new Date(tickAt).toISOString() })); } catch { /* the goal row names it */ } };
  if (since === null) {
    // watermark = first-scan: history is not a «first pregate»
    mark(tickAt);
    console.log(opts.json ? JSON.stringify({ outcome: 'watermark-set', sinceMs: tickAt }) : `work review scan: watermark set at ${new Date(tickAt).toISOString()} — lanes after it are reviewed`);
    return 0;
  }
  const lanes = [...(scanPregateLane(pregateLane('PREGATE-GREEN'), since) ?? []), ...(scanPregateLane(pregateLane('PREGATE-RED'), since) ?? [])]
    .filter(l => l.pr !== null).sort((a, b) => a.at - b.at);
  // a PR counts as reviewed once a complete, written (non-shadow) post-impl row names it — shadow and incomplete rows do not
  const postRows = readDevReviewLedger(policy, root).filter(r => r.unit === 'post-impl' && typeof r.pr === 'number');
  const done = new Set(postRows.filter(r => r.write === true && r.incomplete !== true && r.outcome !== 'write-failed').map(r => r.pr as number));
  const attempts = new Map<number, number>();
  for (const r of postRows) if (r.outcome === 'gh-failed' || r.outcome === 'write-failed') attempts.set(r.pr as number, (attempts.get(r.pr as number) ?? 0) + 1);
  const first = new Map<number, (typeof lanes)[number]>();
  for (const l of lanes) if (!done.has(l.pr!) && !first.has(l.pr!)) first.set(l.pr!, l);
  // fewest failed attempts first, then the oldest first receipt — a PR that keeps failing never starves the rest
  const picked = [...first.values()].sort((a, b) => (attempts.get(a.pr!) ?? 0) - (attempts.get(b.pr!) ?? 0) || a.at - b.at).slice(0, policy.postImpl.maxPrsPerTick);
  const outcomes: Array<{ pr: number; outcome?: string }> = [];
  for (const l of picked) {
    const r = await runPostImplCli(l.pr!, { ...(opts.version ? { version: opts.version } : {}), ...(opts.dryRun ? { dryRun: true } : {}), receipt: { lane: l.id, status: l.status, mode: l.mode } });
    outcomes.push({ pr: l.pr!, ...(r.outcome ? { outcome: r.outcome } : {}) });
  }
  mark(since);
  if (opts.json) console.log(JSON.stringify({ outcome: 'ok', sinceMs: since, newPrs: first.size, reviewed: outcomes }));
  else console.log(`work review scan: ${first.size} PR(s) with a first pregate since the watermark · reviewed ${outcomes.length}${first.size > outcomes.length ? ` (cap ${policy.postImpl.maxPrsPerTick}/tick · rest next tick)` : ''}`);
  return 0;
}
