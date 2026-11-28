// JUDGE-SIM-RECEIPT (대표 11-28 15:2x «시뮬레이션 및 우주 합성 이벤트도 초록의 조건으로») — sim world / test-universe synthetic
// event receipts as formal «must met» evidence of the requirement-judge kit.
//
// S: the butler signed on same-head receipt ⊕ focused exit 0 only; a cell whose done criterion is a sim world scene or a
//    synthetic test-universe event was signed without that run (48 of 103 criteria on the 0.3.39 board read that way).
// C: the evidence already exists in two shapes — `eln --test sim world run` writes <root>/sim-world/<runId>/summary.json
//    (SimWorldSummary · per scene × engine × seed verdicts) and `eln release checklist evidence run <cell>` writes the E4 line
//    («E4 test|sim 층 — runId … 칸 <id> … rc 0»). No new format.
// A: graphs/policies/judging.yaml `sim_evidence` decides; this file applies it:
//    · a summary counts for a cell when its runId binds to a bound PR's landed head (src/land-graph/pr-binding.ts
//      receiptNameBindsPrHead «{pr}-{head12}») and for the registered scene ids NAMED in the doneCriterion or the PR body;
//      each named scene needs ≥ min_seeds distinct passing seeds, every engine in `engines`, and 0 non-passing records;
//    · a criterion that names scenes needs those scenes; a criterion that reads as a sim / synthetic event (`markers`) and
//      names none needs the cell's E4 run line — otherwise not green, with the exact run to request.
// SIM-RECEIPT-CARRY (11-28 19:xx · greens 3/h): a receipt measured on an older head of the PR still binds when the carry rule
//    says the PR-own change is the same (`deps.carries` = src/git-smart/delta.ts carryProof — main merges only after it) — the
//    land graph's smart-merge / direct-land merges moved the head and every honest receipt died. A run whose run id binds a
//    PR head is also published to `publish.root` (the one shared receipt root every reader lists), wherever it ran.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { receiptNameBindsPrHead, receiptNameParts } from '../../land-graph/pr-binding.js';
import type { SimWorldSummary } from '../../ux-sim/sim-world/types.js';
import type { BoardEvidence } from './index.js';

export interface SimEvidencePolicy {
  readonly roots: readonly string[];
  readonly runIdBinding: string;
  readonly minSeeds: number;
  readonly engines: readonly string[];
  readonly passVerdicts: readonly string[];
  readonly markers: readonly string[];
  readonly request: { readonly scene: string; readonly e4: string };
  /** SIM-RECEIPT-CARRY: where a PR-bound run's summary.json is copied (one of `roots` · YAML gives its index) · `host` = the
   *  host whose judge reads it — «hq» = the resource-facts HQ host (off that host the copy goes over ssh) · null root = none. */
  readonly publish: { readonly root: string | null; readonly host: string | null };
}
export const DEFAULT_SIM_POLICY: SimEvidencePolicy = {
  roots: ['~/.elanous-test'], runIdBinding: '{pr}-{head12}', minSeeds: 5, engines: ['legacy', 'graph'], passVerdicts: ['pass', 'promoted'],
  markers: ['시뮬', '시험 우주', '합성 사건', '합성 이벤트', '합성 주입', 'sim world', 'synthetic event'],
  request: { scene: 'eln --test sim world run {world} --seed {seed} --engine both --only {scene} --run-id {pr}-{head12}-s{seed}-{scene}', e4: 'eln release checklist evidence run {cell}' },
  publish: { root: null, host: null },
};
const policyFile = fileURLToPath(new URL('../../../graphs/policies/judging.yaml', import.meta.url));
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown, d: readonly string[]): readonly string[] => (Array.isArray(v) && v.length && v.every(x => typeof x === 'string' && x.trim()) ? v as string[] : d);

export function loadSimEvidencePolicy(path: string = policyFile): SimEvidencePolicy {
  try {
    const y: unknown = parse(readFileSync(path, 'utf8'));
    const s = isRecord(y) && isRecord(y.sim_evidence) ? y.sim_evidence : null;
    if (!s) return DEFAULT_SIM_POLICY;
    const req = isRecord(s.request) ? s.request : {};
    const pub = isRecord(s.publish) ? s.publish : {};
    const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const roots = strings(s.roots, DEFAULT_SIM_POLICY.roots);
    const pubRoot = typeof pub.root === 'number' && Number.isInteger(pub.root) ? roots.at(pub.root) ?? null : text(pub.root);
    return {
      roots,
      runIdBinding: typeof s.run_id_binding === 'string' && s.run_id_binding.includes('{pr}') && s.run_id_binding.includes('{head12}') ? s.run_id_binding : DEFAULT_SIM_POLICY.runIdBinding,
      minSeeds: typeof s.min_seeds === 'number' && Number.isInteger(s.min_seeds) && s.min_seeds >= 1 ? s.min_seeds : DEFAULT_SIM_POLICY.minSeeds,
      engines: strings(s.engines, DEFAULT_SIM_POLICY.engines),
      passVerdicts: strings(s.pass_verdicts, DEFAULT_SIM_POLICY.passVerdicts),
      markers: strings(s.markers, DEFAULT_SIM_POLICY.markers),
      request: { scene: typeof req.scene === 'string' ? req.scene : DEFAULT_SIM_POLICY.request.scene, e4: typeof req.e4 === 'string' ? req.e4 : DEFAULT_SIM_POLICY.request.e4 },
      publish: { root: pubRoot, host: text(pub.host) },
    };
  } catch { return DEFAULT_SIM_POLICY; }
}

let sceneIndexMemo: ReadonlyMap<string, string> | null = null;
/** Registered scene id → world, from the world packs (src/ux-sim/worlds/sim-world-<world>.yaml · the kernel's own loader). */
export function simSceneIndex(): ReadonlyMap<string, string> {
  if (sceneIndexMemo) return sceneIndexMemo;
  const out = new Map<string, string>();
  try {
    // deferred: the kernel module is only needed to read the packs
    const kernel = require('../../ux-sim/sim-world/kernel.js') as typeof import('../../ux-sim/sim-world/kernel.js');
    const { SIM_WORLD_IDS } = require('../../ux-sim/sim-world/types.js') as typeof import('../../ux-sim/sim-world/types.js');
    for (const world of SIM_WORLD_IDS) {
      try { for (const row of kernel.loadSimWorldPack(world, kernel.SIM_WORLD_PACK_ROOT).scenarios) out.set(row.id, world); } catch { /* a pack absent on this checkout */ }
    }
  } catch { /* no kernel → no registered scenes */ }
  sceneIndexMemo = out;
  return out;
}

/** The registered scene ids that appear as whole tokens in `text` (registry ∩ text · no pattern guessing). */
export function scenesNamed(text: string, index: ReadonlyMap<string, string>): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const id of index.keys()) {
    let at = text.indexOf(id);
    while (at >= 0) {
      const before = text[at - 1] ?? ' '; const after = text[at + id.length] ?? ' ';
      if (!/[A-Za-z0-9_-]/u.test(before) && !/[A-Za-z0-9_-]/u.test(after)) { out.push(id); break; }
      at = text.indexOf(id, at + 1);
    }
  }
  return out.sort();
}

export interface SimSummaryIn { readonly runId: string; readonly summary: Pick<SimWorldSummary, 'scenarios'> & Partial<SimWorldSummary> }
const expand = (root: string): string => (root.startsWith('~/') ? join(homedir(), root.slice(2)) : root);
/** SUPERVISORS-EXECUTE-NOT-PROPOSE: the test universe a self-run writes into — the first sim_evidence root (resolved), so the
 *  reader below finds its summaries. */
export const simEvidenceRunRoot = (policy: SimEvidencePolicy = loadSimEvidencePolicy()): string => expand(policy.roots[0] ?? DEFAULT_SIM_POLICY.roots[0]!);

/** Live reader: <root>/sim-world/<runId>/summary.json for runIds shaped like a PR-head binding («<digits>-<hex12>…»). */
export function readSimSummaries(policy: SimEvidencePolicy = loadSimEvidencePolicy()): SimSummaryIn[] {
  const out: SimSummaryIn[] = [];
  for (const root of policy.roots) {
    const dir = join(expand(root), 'sim-world');
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const runId of names) {
      if (!/^\d+-[0-9a-f]{12}/iu.test(runId)) continue;
      try {
        const summary = JSON.parse(readFileSync(join(dir, runId, 'summary.json'), 'utf8')) as SimSummaryIn['summary'];
        if (Array.isArray(summary?.scenarios)) out.push({ runId, summary });
      } catch { /* unreadable summary = not evidence */ }
    }
  }
  return out;
}

export interface SimPrIn { readonly pr: number; readonly head: string | null; /** registered scene ids its body names (collector) */ readonly scenes?: readonly string[] }
export interface SimEvidenceInput { readonly cellId: string; readonly criterion: string; /** the cell's E4 run line (done-when simEvidenceLine) */ readonly e4Line: string | null; readonly prs: readonly SimPrIn[] }
export type SimEvidenceResult =
  | { readonly need: 'none' }
  | { readonly need: 'met'; readonly rows: BoardEvidence[]; readonly note: string }
  | { readonly need: 'missing'; readonly why: string; readonly request: string;
      /** SUPERVISORS-EXECUTE-NOT-PROPOSE: the runs that would close it — scenes (world · scene) bound to the PR head the runIds
       *  must carry · absent = the cell's own E4 run (`request.e4`). */
      readonly runs?: { readonly pr: number; readonly head: string; readonly scenes: ReadonlyArray<{ readonly world: string; readonly scene: string }> } };

/** SIM-RECEIPT-CARRY: may a receipt measured on `receiptHead` (12 hex · from its run id) stand for PR `pr`'s landed `head`?
 *  The live port is src/git-smart/delta.ts carryProofAt — ancestor · only merge commits after it · PR-own lines identical. */
export type SimCarry = (receiptHead: string, pr: number, head: string) => { readonly ok: boolean; readonly reason?: string };

/** Pure: does the cell carry the sim / synthetic-event receipt its criterion asks for? */
export function assessSimEvidence(input: SimEvidenceInput, deps: { summaries: readonly SimSummaryIn[]; index?: ReadonlyMap<string, string>; policy?: SimEvidencePolicy; carries?: SimCarry }): SimEvidenceResult {
  const policy = deps.policy ?? loadSimEvidencePolicy();
  const index = deps.index ?? simSceneIndex();
  const named = [...new Set([...scenesNamed(input.criterion, index), ...input.prs.flatMap(p => (p.scenes ?? []).filter(s => index.has(s)))])].sort();
  const lower = input.criterion.toLowerCase();
  const marker = policy.markers.find(m => lower.includes(m.toLowerCase())) ?? null;
  // a run id of the landed head binds as before · one of an older head of the same PR binds only through the carry rule
  const memo = new Map<string, ReturnType<SimCarry>>();
  const refusedCarry: Array<{ readonly s: SimSummaryIn; readonly head12: string; readonly reason: string }> = [];
  const bound = deps.summaries.flatMap(s => input.prs.flatMap(p => {
    if (receiptNameBindsPrHead(s.runId, p.pr, p.head, policy.runIdBinding)) return [{ ...s, pr: p.pr, head: p.head!, carriedFrom: null as string | null }];
    const parts = receiptNameParts(s.runId, policy.runIdBinding);
    if (!parts || parts.pr !== p.pr || !p.head || !deps.carries) return [];
    const key = `${parts.head12}\0${p.pr}\0${p.head}`;
    if (!memo.has(key)) { let c: ReturnType<SimCarry>; try { c = deps.carries(parts.head12, p.pr, p.head); } catch (e) { c = { ok: false, reason: String(e).slice(0, 120) }; } memo.set(key, c); }
    const c = memo.get(key)!;
    if (c.ok) return [{ ...s, pr: p.pr, head: p.head, carriedFrom: parts.head12 }];
    refusedCarry.push({ s, head12: parts.head12, reason: c.reason ?? 'PR-own change differs' });
    return [];
  }));
  const first = input.prs.find(p => p.head);
  const fill = (t: string, scene: string) => t.replaceAll('{world}', index.get(scene) ?? '<world>').replaceAll('{scene}', scene).replaceAll('{cell}', input.cellId)
    .replaceAll('{pr}', String(first?.pr ?? '<pr>')).replaceAll('{head12}', first?.head?.slice(0, 12) ?? '<head12>').replaceAll('{seed}', '1..' + policy.minSeeds);
  if (named.length) {
    const gaps: string[] = []; const rows: BoardEvidence[] = []; const notes: string[] = [];
    for (const scene of named) {
      const recs = bound.flatMap(b => (b.summary.scenarios ?? []).filter(r => r.scenario === scene).map(r => ({ r, runId: b.runId, carriedFrom: b.carriedFrom })));
      if (!recs.length) {
        const old = refusedCarry.filter(x => (x.s.summary.scenarios ?? []).some(r => r.scenario === scene));
        const why = old.length ? ` · 옛 head ${[...new Set(old.map(x => x.head12))].sort().join('·')} 영수 승계 불가 — ${[...new Set(old.map(x => x.reason))].join(' · ')}` : '';
        gaps.push(`장면 ${scene} 영수 없음(같은 PR head 의 sim world summary${why})`); continue;
      }
      const bad = recs.filter(x => !policy.passVerdicts.includes(x.r.verdict));
      const good = recs.filter(x => policy.passVerdicts.includes(x.r.verdict));
      const seeds = new Set<number>(good.map(x => x.r.seed)); const engines = new Set<string>(good.map(x => x.r.engine));
      const lacking = policy.engines.filter(e => !engines.has(e));
      if (bad.length) { gaps.push(`장면 ${scene} regression ${bad.length} (${[...new Set(bad.map(x => `${x.r.verdict}@${x.r.engine}·s${x.r.seed}`))].slice(0, 3).join(' ')})`); continue; }
      if (seeds.size < policy.minSeeds) { gaps.push(`장면 ${scene} 시드 ${seeds.size}/${policy.minSeeds}`); continue; }
      if (lacking.length) { gaps.push(`장면 ${scene} 엔진 ${lacking.join('·')} 없음`); continue; }
      const runs = [...new Set(recs.map(x => x.runId))].sort();
      rows.push({ id: `SIM-${scene}`, text: JSON.stringify({ scene, world: index.get(scene) ?? null, seeds: [...seeds].sort((a, b) => a - b), engines: [...engines].sort(), regression: 0, runs }) });
      const from = [...new Set(recs.map(x => x.carriedFrom).filter((x): x is string => !!x))].sort();
      notes.push(`${scene} 시드 ${seeds.size}·${[...engines].sort().join('+')}·regression 0${from.length ? ` (승계 ← ${from.join('·')} · PR 고유 변경 동일)` : ''}`);
    }
    if (gaps.length) return { need: 'missing', why: `시뮬 영수 미충족 — ${gaps.join(' · ')}`, request: named.map(s => fill(policy.request.scene, s)).join(' · '),
      ...(first?.head ? { runs: { pr: first.pr, head: first.head, scenes: named.filter(s => index.has(s)).map(scene => ({ world: index.get(scene)!, scene })) } } : {}) };
    return { need: 'met', rows, note: `sim ${notes.join(' / ')}` };
  }
  if (marker) {
    if (input.e4Line) return { need: 'met', rows: [{ id: 'E4-RUN', text: input.e4Line }], note: `E4 합성 사건 영수 (${/runId (\S+)/u.exec(input.e4Line)?.[1] ?? 'evidence-run'} rc 0)` };
    return { need: 'missing', why: `완료조건이 시뮬/합성 사건 꼴(«${marker}») — 같은 칸 E4 실행 영수 또는 장면 id 를 적은 sim world 영수 없음`, request: fill(policy.request.e4, '') };
  }
  return { need: 'none' };
}

/**
 * SIM-RECEIPT-CARRY: one shared receipt root. A run whose id binds a PR head («<pr>-<head12>…») copies its summary.json to
 * `<publish.root>/sim-world/<runId>/summary.json` — locally when this host is `publish.host` (or none is named), else over
 * ssh to that host — so the judge reads it whichever host or worktree ran it. Never fails the run: returns the line to print.
 */
export function publishSimReceipt(summaryPath: string, runId: string, policy: SimEvidencePolicy = loadSimEvidencePolicy(),
  io: { readonly hqHost?: () => string | null; readonly onPublishHost?: (host: string) => boolean; readonly ssh?: (host: string, remoteCmd: string, input: string) => number } = {}): string | null {
  if (!policy.publish.root || !receiptNameParts(runId, policy.runIdBinding)) return null;
  const host = policy.publish.host === 'hq' ? (io.hqHost ?? hqHostLive)() : policy.publish.host;
  const onHost = !host || (io.onPublishHost ?? onPublishHostLive)(host);
  try {
    if (onHost) {
      const dir = join(expand(policy.publish.root), 'sim-world', runId);
      const to = join(dir, 'summary.json');
      if (resolve(to) === resolve(summaryPath)) return null;
      mkdirSync(dir, { recursive: true });
      copyFileSync(summaryPath, to);
      return `sim receipt published: ${to}`;
    }
    const remoteRoot = policy.publish.root.startsWith('~/') ? `"$HOME"/${shq(policy.publish.root.slice(2))}` : shq(policy.publish.root);
    const remoteDir = `${remoteRoot}/sim-world/${shq(runId)}`;
    const rc = (io.ssh ?? sshLive)(host, `mkdir -p ${remoteDir} && cat > ${remoteDir}/summary.json`, readFileSync(summaryPath, 'utf8'));
    return rc === 0 ? `sim receipt published: ${host}:${policy.publish.root}/sim-world/${runId}/summary.json` : `sim receipt NOT published (ssh ${host} rc ${rc}) — the judge will not see ${runId}`;
  } catch (e) { return `sim receipt NOT published — ${String(e).slice(0, 160)}`; }
}
/** The resource-facts HQ host (src/kit/resource-facts hqHosts) — null when the facts name none (then the copy stays local). */
function hqHostLive(): string | null {
  try { return (require('../resource-facts/route.js') as typeof import('../resource-facts/route.js')).hqHosts()[0] ?? null; } catch { return null; }
}
const shq = (t: string): string => `'${t.replaceAll("'", "'\\''")}'`;
/** This machine is `host` ⇔ `ssh -G <host>` names a hostname that is this machine's hostname or one of its own addresses. */
function onPublishHostLive(host: string): boolean {
  const { hostname, networkInterfaces } = require('node:os') as typeof import('node:os');
  const g = spawnSync('ssh', ['-G', host], { encoding: 'utf8', timeout: 5_000 });
  const target = (g.stdout ?? '').split('\n').find(l => l.startsWith('hostname '))?.slice(9).trim().toLowerCase() ?? host.toLowerCase();
  const me = hostname().toLowerCase();
  if (target === me || target.split('.')[0] === me.split('.')[0]) return true;
  const mine = new Set(Object.values(networkInterfaces()).flatMap(a => a ?? []).map(a => a.address.toLowerCase()));
  if (mine.has(target)) return true;
  const look = spawnSync(process.platform === 'darwin' ? 'dscacheutil' : 'getent', process.platform === 'darwin' ? ['-q', 'host', '-a', 'name', target] : ['ahosts', target], { encoding: 'utf8', timeout: 5_000 });
  const addrs = (look.stdout ?? '').split('\n').map(l => l.replace(/^(ip_address|ipv6_address):\s*/u, '').trim().split(/\s+/u)[0]!.toLowerCase()).filter(Boolean);
  return addrs.some(a => mine.has(a));
}
const sshLive = (host: string, remoteCmd: string, input: string): number =>
  spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remoteCmd], { input, encoding: 'utf8', timeout: 60_000 }).status ?? 1;
