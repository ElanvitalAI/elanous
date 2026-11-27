/**
 * BULLETIN-NOW-STALE (11-26) — the federal bulletin written by the graph itself, not by an OP turn.
 *
 * S: op-bulletin woke OP (OP→OP request mail) every 15–30 min, but seat-state/OPS/BULLETIN-NOW.md was last written at
 *    11-26 07:09 KST; every window from 11-25 22:09Z ended «goal not met by deadline». Since #40082 (anti-flood F) a
 *    seat's mail to itself is a self-wake: the 7-section bulletin prompt rode the TUI wake scheduler, fired into the held
 *    queue (turn ids `pulse-held-N`) and folded with other held items; when OP did get the turn, the 7-section rewrite
 *    plus six mails was one more LLM chore it skipped. The goal relied on OP choosing to write the file.
 * C: same lesson as the retro loss (trigger-nodes.ts retro-draft): what can be measured must be written by the graph.
 * Q: how does the bulletin exist every window, with OP adding only judgement?
 * A: this node (`cmd:trigger-bulletin-write`, no LLM):
 *    1. measures the facts (phase · landed since the last bulletin · idle seats · OP unread ✋ proxy · why it fired ·
 *       optional declared measure commands);
 *    2. appends the previous BULLETIN-NOW.md to the day's BULLETIN-LOG and writes the new one (atomic rename) with two
 *       empty judgement lines — the goal (file mtime) is met by the graph;
 *    3. live: posts it to every coordinator (conversational space leaders under HQ in the org map — loop-agent seats skipped — or the node's `to` list) with
 *       kind `bulletin` (no expiry · rides the receiver's next idle — directive-expiry.ts · seat-mail-turn-policy.ts);
 *       a retry re-sends only to recipients not yet in the sent ledger;
 *    4. live: queues ONE internal OP turn (retro-turn ledger · not a wake, so no cap/fold) asking only for the two
 *       judgement lines. Shadow writes the file and a receipt of the mails/turn.
 *    Self-contained (facts · post · turn are injectable deps) so op-pulse can host it as a node later (LOOP-AUDIT-APPLY).
 *
 * 세 얼굴: 관측 = the node's JSON line ⊕ `{stateRoot}/loops/op-bulletin.jsonl` (one line per window: sent/failed) ·
 *          판단 근거 = the facts block in the file (each failed probe says «측정 실패») ·
 *          수복과 인계 = a failed post or turn enqueue is a node failure → the registry retries the window; the file is
 *          already written and the retry only sends what is missing.
 */
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendDiverted, type DivertedEntry } from '../msg/diverted-mail.js';
import { expandTemplate, type TriggerRunInput } from './trigger-registry.js';
import { isConversationalSeat, type OrgRole } from '../org/org-map.js';

export interface BulletinNodeContext { graphId?: string; runId?: string; input?: Partial<TriggerRunInput>; nodeInput?: Record<string, unknown> }

/** The facts the graph measures. null = the probe failed (written as «측정 실패»). */
export interface BulletinFacts {
  phase: string | null;
  landedTotal: number | null;
  idleSeats: string[] | null;
  handsUp: number | null;
}

type Exec = (cmd: string[], timeoutMs: number) => { status: number | null; stdout: string; stderr: string };
type Post = (args: string[]) => { status: number | null; stdout: string; stderr: string };

export interface BulletinDeps {
  now?: () => Date;
  facts?: (stateRoot: string) => Promise<BulletinFacts>;
  /** Runs the node's optional declared measure commands. */
  run?: Exec;
  post?: Post;
  enqueueTurn?: (entry: DivertedEntry) => void;
  /** Coordinators to mail when the node input names none. */
  recipients?: () => string[];
}

export const BULLETIN_KIND = 'bulletin';
const DEFAULT_FILE = '{seatState}/OPS/BULLETIN-NOW.md';
const DEFAULT_LOG = '{seatState}/OPS/BULLETIN-LOG-{date}.md';
const JUDGE_BOTTLENECK = '- 병목 판단:';
const JUDGE_ORDER = '- 다음 지시:';
const MEASURE_TIMEOUT_MS = 60_000;
const MEASURE_MAX_LINES = 6;

const fail = (what: string): string => `(측정 실패 · ${what})`;
const safeWindow = (w: string): string => w.replace(/[^\w.-]/g, '_');

/** The judgement-turn prompt: two lines only, under the facts this window wrote. */
export function bulletinTurnPrompt(file: string, marker: string): string {
  return [
    `[bulletin · graph] 연방 공보 사실 부분을 ${file} 에 새로 썼다(${marker}) · 조율자 우편도 이미 나갔다.`,
    `맨 아래 «${JUDGE_BOTTLENECK}» 와 «${JUDGE_ORDER}» 두 줄의 빈칸만 채워라(각 1줄 · 위 실측 숫자를 근거로).`,
    '다른 일은 이 턴에서 하지 않는다 — 파일을 고친 뒤 원래 일로 돌아간다.',
  ].join('\n');
}

function strList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim().toUpperCase());
  return out.length ? [...new Set(out)] : null;
}

/**
 * Coordinators = leaders of every space under HQ that read mail in a conversation (today: TC MK UX JUD). Loop-agent
 * seats (role steward · REL RES, 대표 11-26) have no conversational inbox and are skipped.
 */
export function orgCoordinators(org: { seats: Readonly<Record<string, { role: OrgRole }>>; spaces: Readonly<Record<string, { leader: string }>>; duties: Readonly<Record<string, string>> }): string[] {
  const hq = (org.duties['escalation-parent'] ?? 'OP').toUpperCase();
  return [...new Set(Object.values(org.spaces).map((s) => s.leader.toUpperCase()).filter((s) => s !== hq && isConversationalSeat(org, s)))];
}

function defaultRecipients(): string[] {
  const { loadOrgMap } = require('../org/org-map.js') as typeof import('../org/org-map.js');
  return orgCoordinators(loadOrgMap().org);
}

async function defaultFacts(stateRoot: string): Promise<BulletinFacts> {
  const { defaultConditionProbes } = await import('./trigger-conditions.js');
  const p = defaultConditionProbes();
  const settle = async <T>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };
  let phase: string | null = null;
  try {
    const state = JSON.parse(readFileSync(join(stateRoot, 'loops', 'op-pulse-state.json'), 'utf8')) as { lastPhase?: unknown };
    phase = typeof state.lastPhase === 'string' ? state.lastPhase : null;
  } catch { phase = null; }
  return {
    phase,
    landedTotal: await settle(() => p.landedCount()),
    idleSeats: await settle(async () => (await p.idleSeats()).map((s) => s.seat.toUpperCase()).sort()),
    handsUp: await settle(() => p.handsUpCount()),
  };
}

const defaultExec: Exec = (cmd, timeoutMs) => {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? r.error?.message ?? '') };
};

const defaultPost: Post = (args) => {
  const { spawnElanousSync } = require('../instance/spawn-elanous.js') as typeof import('../instance/spawn-elanous.js');
  const r = spawnElanousSync(args, { encoding: 'utf8' });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
};

interface BulletinState { window?: string; landedTotal?: number }
function readState(path: string): BulletinState {
  try { return JSON.parse(readFileSync(path, 'utf8')) as BulletinState; } catch { return {}; }
}

/** Recipients already mailed for this window (the sent ledger) — a retry only sends the rest. */
function sentFor(ledger: string, window: string): Set<string> {
  if (!existsSync(ledger)) return new Set();
  const sent = new Set<string>();
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line) as { window?: string; sent?: string[] }; if (row.window === window) for (const s of row.sent ?? []) sent.add(s); } catch { /* skip */ }
  }
  return sent;
}

function measureLines(value: unknown, run: Exec, expand: (s: string) => string): string[] {
  if (!Array.isArray(value)) return [];
  const lines: string[] = [];
  for (const raw of value) {
    const m = raw as { label?: unknown; cmd?: unknown } | null;
    if (!m || typeof m.label !== 'string' || !Array.isArray(m.cmd) || !m.cmd.length || !m.cmd.every((c) => typeof c === 'string')) continue;
    let out: ReturnType<Exec>;
    try { out = run((m.cmd as string[]).map(expand), MEASURE_TIMEOUT_MS); }
    catch (error) { out = { status: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) }; }
    const text = out.stdout.trim().split('\n').filter((l) => l.trim()).slice(0, MEASURE_MAX_LINES);
    if (out.status === 0 && text.length) lines.push(`- ${m.label}: ${text[0]}`, ...text.slice(1).map((l) => `  ${l}`));
    else lines.push(`- ${m.label}: ${fail(`exit ${out.status ?? 'none'} · ${out.stderr.trim().split('\n')[0]?.slice(0, 160) ?? ''}`)}`);
  }
  return lines;
}

export async function bulletinWrite(ctx: BulletinNodeContext, deps: BulletinDeps = {}): Promise<Record<string, unknown>> {
  const input = ctx.input ?? {};
  const node = ctx.nodeInput ?? {};
  const stateRoot = input.vars?.stateRoot ?? process.env.ELANOUS_STATE_DIR ?? effectiveInstanceRoot(); // never process.cwd() (#40570 class)
  const v = { stateRoot, seatState: input.vars?.seatState ?? join(process.env.HOME ?? '', 'elanous-hq', 'seat-state') };
  const now = (deps.now ?? (() => new Date()))();
  const window = input.window ?? now.toISOString();
  const expand = (s: string): string => expandTemplate(s, v, window);
  const file = expand(typeof node.file === 'string' ? node.file : DEFAULT_FILE);
  const log = expand(typeof node.log === 'string' ? node.log : DEFAULT_LOG);
  const from = typeof node.from === 'string' && node.from.trim() ? node.from.trim().toUpperCase() : 'OP';
  const marker = `op-bulletin window=${window}`;
  const statePath = join(stateRoot, 'loops', 'op-bulletin-state.json');
  const ledger = join(stateRoot, 'loops', 'op-bulletin.jsonl');
  const live = input.stage === 'live';

  const already = existsSync(file) && readFileSync(file, 'utf8').includes(`<!-- ${marker} -->`);
  let factsBlock: string[] = [];
  if (!already) {
    let facts: BulletinFacts;
    try { facts = await (deps.facts ?? defaultFacts)(stateRoot); }
    catch { facts = { phase: null, landedTotal: null, idleSeats: null, handsUp: null }; }
    // OP-OBSERVE-LANDED (11-27 22:39): main never has 0 commits — a total ≤ 0 is a broken read, shown as unmeasured. A
    // baseline that is not a real total (the old bug stored 0) or exceeds today's total is no baseline, not «+0».
    if (facts.landedTotal !== null && !(facts.landedTotal > 0)) facts = { ...facts, landedTotal: null };
    const prev = readState(statePath);
    const base = typeof prev.landedTotal === 'number' && prev.landedTotal > 0 && facts.landedTotal !== null && prev.landedTotal <= facts.landedTotal
      ? prev.landedTotal : null;
    const landed = facts.landedTotal === null ? fail('main 커밋 수')
      : base !== null ? `+${facts.landedTotal - base} (직전 공보 ${prev.window ?? '?'} 이후 · main 총 ${facts.landedTotal})`
        : `main 총 ${facts.landedTotal} (직전 공보 기준 없음)`;
    factsBlock = [
      `- 국면: ${facts.phase ?? fail('op-pulse 상태')}`,
      `- 착지: ${landed}`,
      `- 유휴 자리: ${facts.idleSeats === null ? fail('els ls') : facts.idleSeats.length ? `${facts.idleSeats.join(', ')} (${facts.idleSeats.length})` : '없음 (0)'}`,
      `- ✋ OP 미읽음: ${facts.handsUp === null ? fail('우편 원장') : String(facts.handsUp)}`,
      `- 이번 공보 계기: ${input.reason ? input.reason.slice(0, 300) : (input.stage ?? 'manual')}`,
      ...measureLines(node.measures, deps.run ?? defaultExec, expand),
    ];
    const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    const text = [
      `# 연방 공보 · ${clock} (graph ${ctx.graphId ?? '?'} · ${input.stage ?? 'manual'})`, `<!-- ${marker} -->`, '',
      '## 실측 (그래프가 잰 것)', ...factsBlock, '',
      '## OP 판단 (OP 가 한 줄씩)', `${JUDGE_BOTTLENECK} `, `${JUDGE_ORDER} `, '',
    ].join('\n');
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      mkdirSync(dirname(log), { recursive: true });
      appendFileSync(log, `\n\n---\n${readFileSync(file, 'utf8').trimEnd()}\n`);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    if (facts.landedTotal !== null) {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify({ window, landedTotal: facts.landedTotal })}\n`);
    }
  } else {
    const body = readFileSync(file, 'utf8');
    const start = body.indexOf('## 실측');
    const end = body.indexOf('## OP 판단');
    factsBlock = start >= 0 && end > start ? body.slice(start, end).split('\n').slice(1).filter((l) => l.trim()) : [];
  }

  const recipients = strList(node.to) ?? (deps.recipients ?? defaultRecipients)();
  const mailBody = [`[연방 공보 · graph · window ${window}] 사실 부분(OP 판단 2줄은 곧 덧붙임) — 전문: ${file}`, ...factsBlock].join('\n');
  const turn: DivertedEntry = { seat: from, from: `graph:${ctx.graphId ?? 'op-bulletin'}`, kind: BULLETIN_KIND, body: bulletinTurnPrompt(file, marker), at: now.toISOString(), refs: [window] };

  if (!live) {
    const dir = input.shadowDir ?? join(stateRoot, 'loops', 'shadow', ctx.graphId ?? 'op-bulletin');
    mkdirSync(dir, { recursive: true });
    const receipt = join(dir, `${safeWindow(window)}.json`);
    writeFileSync(receipt, `${JSON.stringify({ wrote: file, wouldPost: { from, to: recipients, kind: BULLETIN_KIND }, wouldOpenTurn: turn, runId: ctx.runId, at: now.toISOString() })}\n`);
    return { outcome: 'ok', wrote: !already, file, shadow: true, receipt };
  }

  const done = sentFor(ledger, window);
  const sent: string[] = [];
  const failed: string[] = [];
  const post = deps.post ?? defaultPost;
  for (const to of recipients.filter((r) => !done.has(r))) {
    const r = (() => { try { return post(['msg', 'post', '--from', from, '--to', to, '--kind', BULLETIN_KIND, '--body', mailBody]); }
      catch (error) { return { status: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) }; } })();
    (r.status === 0 ? sent : failed).push(to);
  }
  let turnQueued = done.has(`turn:${from}`);
  let turnError: string | null = null;
  if (!turnQueued) {
    try { (deps.enqueueTurn ?? ((e) => appendDiverted('retro-turn', e)))(turn); turnQueued = true; }
    catch (error) { turnError = error instanceof Error ? error.message : String(error); }
  }
  mkdirSync(dirname(ledger), { recursive: true });
  appendFileSync(ledger, `${JSON.stringify({ window, sent: [...sent, ...(turnQueued && !done.has(`turn:${from}`) ? [`turn:${from}`] : [])], failed, runId: ctx.runId ?? null, at: now.toISOString() })}\n`);
  if (failed.length || turnError) {
    return { outcome: 'fail', wrote: !already, file, sent, failed, error: [failed.length ? `msg post failed for ${failed.join(',')}` : '', turnError ? `turn enqueue failed: ${turnError}` : ''].filter(Boolean).join(' · ') };
  }
  return { outcome: 'ok', wrote: !already, file, shadow: false, sent, turn: 'queued' };
}
