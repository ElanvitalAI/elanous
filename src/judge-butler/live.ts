// 판정 집사 — live I/O: the view from the real ledgers, the ports onto the real doors, the mail voice inbox, the configured LLM.
// Every reader fails open into «unknown» (never «0»): an unknown PR fact keeps the cell unsigned, it never signs it.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readReleaseGraphVersion, resolveCurrentVersion } from '../ops-dashboard/current-version.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { expireDue, readHolds } from '../hold-ledger/hold-ledger.js';
import { appendOnce, loadFederationLadder, openHands } from '../msg/hand-raise-ladder.js';
import { defaultMsgStorePath, openMsgStore, type MsgStore } from '../msg/msg-store.js';
import { addItem, listChecklist, setItemIfSnapshot, type ChecklistItem } from '../release-loop/checklist.js';
import { evidencePrRefs, HQ_REPO_DIR, readGreenTriageSources } from '../release-loop/green-triage.js';
import { readLiveBlocks } from '../fed-observe/sources-live.js';
import type { ButlerPorts, ButlerView, HandIn } from './body.js';
import { inJudgeDomain } from './body.js';
import { collectPrFacts, type CollectorDeps } from './collector.js';
import type { CellIn } from './done-when.js';
import { BUTLER_SEAT, butlerHome, fileMemory } from './memory.js';
import type { VoiceInbox, VoiceLlm, VoiceMessage } from './voice.js';

const refValue = (refs: readonly string[] | undefined, prefix: string): string | undefined => refs?.find(r => r.startsWith(prefix))?.slice(prefix.length);

export interface LiveContext { readonly view: ButlerView; readonly ports: ButlerPorts; readonly inbox: VoiceInbox; readonly store: MsgStore; readonly stateRoot: string; close(): void }

export function liveContext(now: Date = new Date()): LiveContext {
  const stateRoot = effectiveInstanceRoot();
  // TARGET-VERSION (11-27 · same class as #40339): the release in play is release.graph.version read from config.json on
  // every call — never the plan/package fallback while the graph target is set — and a published release is never acted on.
  const target = butlerTarget({ hqRoot: join(homedir(), 'elanous-hq') });
  const version = target.version;
  const items = listChecklist(version).items;
  const cells: CellIn[] = items.map(i => ({ id: i.id, title: i.title, status: i.status, ...(i.owner ? { owner: i.owner } : {}), evidence: i.evidence ?? '', updatedAt: i.updatedAt, updatedBy: i.updatedBy }));
  const triage = readGreenTriageSources();
  const lg = require('../land-graph/land-graph.js') as typeof import('../land-graph/land-graph.js');
  const landed = new Map<number, string>();
  for (const r of lg.readLedger(stateRoot)) if (r.event === 'landed' && !r.synthetic) landed.set(r.pr, r.head);
  const landDeps = (require('../cli/land-graph-cli.js') as typeof import('../cli/land-graph-cli.js')).defaultLandDeps();
  const prs = cells.filter(c => c.status === 'yellow').flatMap(c => evidencePrRefs(c.evidence ?? '')).filter(pr => triage.merged.has(pr));
  const collectorDeps: CollectorDeps = {
    merged: triage.merged, landedHead: pr => landed.get(pr) ?? null, cacheDir: butlerHome(stateRoot),
    prMeta: pr => {
      const r = spawnSync('gh', ['pr', 'view', String(pr), '--json', 'headRefOid,files'], { cwd: HQ_REPO_DIR, encoding: 'utf8', timeout: 30_000 });
      if (r.status !== 0) return null;
      const j = JSON.parse(r.stdout) as { headRefOid?: string; files?: Array<{ path?: string }> };
      return { head: j.headRefOid ?? null, files: Array.isArray(j.files) ? j.files.map(f => String(f.path ?? '')).filter(Boolean) : null };
    },
    receipt: (pr, head) => {
      const r = landDeps.receipt(pr, head);
      if (!r) return null;
      const f = landDeps.focused(r);
      const focused = f === 'unreadable' ? (typeof r.focusedExit === 'number' ? { exit: r.focusedExit } : null) : 'swept' in f ? { exit: f.exit } : { pass: f.pass, fail: f.fail };
      // BUTLER-SIGN-MERGED-PATCHID: the land graph's receipt facts go through whole (grade · focused step · baseline · reuse)
      return { head: r.head, dir: r.dir, focusedFiles: r.focused.length, focused,
        ...(r.grade ? { grade: r.grade } : {}), focusedExit: r.focusedExit ?? null,
        ...(r.focusedBaseline ? { focusedBaseline: r.focusedBaseline } : {}), ...(r.reusedFrom ? { reusedFrom: r.reusedFrom } : {}) };
    },
    olderReceiptHead: (pr, head) => landDeps.olderReceiptHead(pr, head),
    security: (pr, head) => landDeps.security(pr, head),
  };
  const prFacts = collectPrFacts(prs, collectorDeps);
  const store = openMsgStore(defaultMsgStorePath());
  const ladder = loadFederationLadder();
  const hands: HandIn[] = openHands(store, { now: now.getTime(), ladder, windowMs: 24 * 3_600_000 }).map(h => ({
    id: h.id, rootId: h.rootId, sender: h.sender, receiver: h.receiver, blockedSeat: h.blockedSeat, cell: refValue(h.refs, 'cell:') ?? h.blockId, reason: h.reason,
    refs: h.refs ?? [], createdAtMs: h.createdAtMs, body: h.body,
  })).filter(h => inJudgeDomain(h) && h.sender.toUpperCase() !== BUTLER_SEAT);
  const view: ButlerView = { now, version, actable: target.actable, targetWhy: target.why, cells, prFacts, holds: readHolds(stateRoot, now), blocks: readLiveBlocks(stateRoot, version, now.getTime() - 60 * 60_000, now.getTime()), hands };
  const memory = fileMemory(stateRoot);
  const post = (key: string, to: string, body: string, kind = 'request'): number | null => {
    const w = appendOnce(store, key, () => ({ from: BUTLER_SEAT, to, body, kind, intent: kind === 'status' || kind === 'info' ? 'info' : 'decision', refs: [key] }));
    return w.fresh ? w.mail.id : null;
  };
  const ports: ButlerPorts = {
    memory, merged: new Set(triage.merged.keys()),
    sign: (cell, evidence, expected, attribution) => { setItemIfSnapshot(version, cell, { status: 'green', evidence }, BUTLER_SEAT, expected as Pick<ChecklistItem, 'title' | 'status' | 'evidence'>, attribution); },
    // fresh receipt / focused / security read right before signing (head ⊕ files come from the merged-PR cache — immutable)
    freshFacts: (cell) => collectPrFacts(evidencePrRefs(cell.evidence ?? ''), collectorDeps),
    readCell: (cell) => { const i = listChecklist(version).items.find(x => x.id === cell); return i ? { id: i.id, title: i.title, status: i.status, evidence: i.evidence ?? '', updatedAt: i.updatedAt, updatedBy: i.updatedBy, ...(i.owner ? { owner: i.owner } : {}) } : null; },
    expireHolds: (by, unlockFacts) => expireDue(stateRoot, { by, unlockFacts }),
    // GREEN-DEFINITION-ONE: one FU cell «<cell>-E4» (P2) — BUTLER-E4-FU-UNOWNED: unowned, so it lands on the board pool
    // (`eln work next`) instead of refilling OP's queue (11-27: +4 OP cells right after cleanup · hands' claims bounced to OP).
    addFollowUp: (id, title) => {
      if (listChecklist(version).items.some(i => i.id === id)) return true;
      try { addItem(version, { id, title, priority: 'P2', source: 'judge-butler · GREEN-DEFINITION-ONE (E4 = FU)' }); return true; } catch { return false; }
    },
    // BUTLER-E4-AUTORUN — the same CLI a person runs (isolated test universe inside), this process's own entry, 10 min cap.
    runEvidence: (cell, v) => {
      const r = spawnSync(process.execPath, [process.argv[1]!, 'release', 'checklist', 'evidence', 'run', cell, '--version', v], { encoding: 'utf8', timeout: 600_000, env: { ...process.env, ELANOUS_TRACK: BUTLER_SEAT } });
      return { rc: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
    },
    post,
    answerHand: (hand, text, owner, deadline, refs) => {
      const w = appendOnce(store, `butler-answer:${hand.id}`, () => ({ from: BUTLER_SEAT, to: hand.blockedSeat, kind: 'reply', intent: 'decision', replyTo: hand.rootId,
        refs: ['hand-outcome:resolve', `hand-of:${hand.rootId}`, `hand-msg:${hand.id}`, `hand-owner:${owner}`, `hand-deadline:${deadline}`, ...refs],
        body: `[✋ RESOLVED · ${BUTLER_SEAT}] owner ${owner} · by ${deadline} · ${text}` }));
      return w.fresh ? w.mail.id : null;
    },
    escalateHand: (hand, to, text) => {
      // the ladder's own key — never two escalations of one ✋ hop
      const w = appendOnce(store, `hand-escalate:${hand.id}`, () => ({ from: BUTLER_SEAT, to, kind: 'request', intent: 'alert',
        refs: [`hand-escalated-from:${hand.id}`, `hand-of:${hand.rootId}`, `block:${hand.cell}`, `reason:${hand.reason || 'judge'}`, `seat:${hand.blockedSeat}`],
        body: `[✋ NEED HUMAN · 판정 집사 → ${to}] ${hand.blockedSeat} #${hand.id} (${hand.cell}): ${text}` }));
      return w.fresh ? w.mail.id : null;
    },
  };
  return { view, ports, inbox: mailVoiceInbox(store), store, stateRoot, close: () => store.close() };
}

/** Voice input adapter — mail. Messages to JUDGE-BUTLER (alias loop:judge-butler) that are not ✋ and not yet answered. */
export function mailVoiceInbox(store: MsgStore, lookbackMs = 24 * 3_600_000): VoiceInbox {
  return {
    pending(nowMs) {
      const rows = store.db.query(`SELECT id, sender, body, created_at, refs_json FROM msg_messages m WHERE recipient = ? AND sender != ? AND created_at >= ?
        AND NOT EXISTS (SELECT 1 FROM msg_messages r WHERE r.sender = ? AND r.reply_to = m.id) ORDER BY id ASC LIMIT 20`)
        .all(BUTLER_SEAT, BUTLER_SEAT, new Date(nowMs - lookbackMs).toISOString(), BUTLER_SEAT) as Array<{ id: number; sender: string; body: string; created_at: string; refs_json: string | null }>;
      return rows.filter(r => !/"block:/u.test(r.refs_json ?? '')).map(r => ({ id: r.id, from: r.sender, body: r.body, at: r.created_at, channel: 'mail' }) satisfies VoiceMessage);
    },
    reply(msg, text, refs) {
      return store.post({ from: BUTLER_SEAT, to: msg.from, body: text, kind: 'reply', replyTo: Number(msg.id), refs: [...refs].slice(0, 12) }).id;
    },
  };
}

/** The federation's configured coordinator LLM (resolveRoleLlm('coordinator') → provider) — one non-tool call. */
/** The federation's configured coordinator LLM — the one loop-agent role LLM (kit/loop-shell role-llm · through streamLLM). */
export function configuredVoiceLlm(maxTokens = 900, site = 'loop-agent:judge-butler'): VoiceLlm | null {
  return (require('../loop-agent/role-llm.js') as typeof import('../loop-agent/role-llm.js')).roleLlm('coordinator', { maxTokens, site });
}

/** The release the butler may act on: `release.graph.version` (config.json, fresh) first; actable only when it is the graph
 *  target and not yet published. `readRaw`/`ledgerRoot` are test seams. */
export function butlerTarget(input: { hqRoot: string; ledgerRoot?: string; readRaw?: () => unknown }): { version: string; source: string; actable: boolean; why: string } {
  const graph = readReleaseGraphVersion(input.readRaw);
  const cur = resolveCurrentVersion({ hqRoot: input.hqRoot, graphVersion: graph, ...(input.ledgerRoot ? { ledgerRoot: input.ledgerRoot } : {}) });
  if (cur.published) return { version: cur.version, source: cur.source, actable: false, why: `${cur.version} is already published` };
  if (cur.source !== 'graph') return { version: cur.version, source: cur.source, actable: false, why: `release.graph.version unset — ${cur.version} comes from the ${cur.source}, not the release graph` };
  return { version: cur.version, source: cur.source, actable: true, why: 'release.graph.version' };
}
