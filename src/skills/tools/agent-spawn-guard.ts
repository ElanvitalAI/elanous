// ── Agent spawn guard (per seat) ──
//
// Incident (OP seat, next TUI): a two-command ledger task (list → bulk move)
// turned into 14 background agents — «verify the verification» spawns, no
// ledger change. The guard sits at the model-facing Agent tool boundary and
// decides each spawn attempt before any child exists:
//
//   reason-required  — every delegation states why it is not done directly.
//   duplicate        — same normalized name, or prompt word-Jaccard ≥ 0.6, as
//                      one running or finished in the last 15 min whose
//                      result has not been consumed yet.
//   verify-chain     — a verify/check/confirm spawn aimed at an agent of the
//                      same goal that is still running.
//   concurrency-cap  — at most 3 agents running per seat in the long lane, 8 in
//                      the short lane (CAPSULE-POOL-SHORT-LANE · lanes count apart).
//                      A coordinator seat (OP · the HQ / space coordinators of the
//                      federation ladder) gets 8 in the long lane (COORD-RIGHTS · CEO 11-27).
//   key-busy         — short lane: one live capsule per subject key.
//
// Short lane (CAPSULE-POOL-SHORT-LANE · 0.3.36): a capsule for one triaged mail
// action — brief + done criteria + token cap, background, ≤10 min. sweep() stops
// a short capsule past its TTL or token cap and reports it once
// (`agent.short-lane` / ttl-killed | token-cap).
//
// Every attempt is logged as `agent.spawn` / `spawn` with
// {seat, name, reason, allowed, rule}. Programmatic callers of
// `dispatchAgent` (research fan-out, workflows, CLI) do not pass through here.

import { debug } from '../../debug/log.js';
import { globalAgentRegistry } from '../../agent/registry.js';
import { globalTaskNotificationQueue } from '../../agent/task-notification.js';
import { formatTokens, type AgentSpend } from '../../tui/chat/tool-activity.js';

export { formatTokens };

export const AGENT_SPAWN_MAX_RUNNING = 3;
/** COORD-RIGHTS (CEO 11-27 08:0x «조율자 권한부터 더 주라»): running long-lane agents per COORDINATOR seat. */
export const AGENT_SPAWN_COORDINATOR_MAX_RUNNING = 8;

/** A coordinator seat: OP, the coordinator role in the seat ledger, or the HQ / a space coordinator of the live federation
 *  ladder. Any lookup failure = not a coordinator (the hand cap applies). */
export function defaultIsCoordinator(seat: string): boolean {
  const id = seat.trim().toUpperCase();
  if (!id) return false;
  if (id === 'OP') return true;
  try {
    const { isCoordinatorSeat } = require('../../seat/seat-role.js') as typeof import('../../seat/seat-role.js');
    if (isCoordinatorSeat(id)) return true;
  } catch { /* ledger unreadable */ }
  try {
    const { loadFederationLadder } = require('../../msg/hand-raise-ladder.js') as typeof import('../../msg/hand-raise-ladder.js');
    const depth = loadFederationLadder().depthOf(id);
    return depth === 1 || depth === 2;   // 1 = HQ · 2 = space coordinator (0 = CEO · 3 = hand)
  } catch { return false; }
}
/** CAPSULE-POOL-SHORT-LANE — running short-lane capsules per seat (counted apart from the long lane's 3). */
export const AGENT_SPAWN_SHORT_LANE_MAX_RUNNING = 8;
/** Short-lane capsule wall-clock limit. */
export const AGENT_SHORT_LANE_TTL_MS = 10 * 60_000;
/** Short-lane capsule token cap (size estimate, ~4 chars per token). */
export const AGENT_SHORT_LANE_TOKEN_CAP = 40_000;
/** Short-lane capsule tool-loop budget. */
export const AGENT_SHORT_LANE_MAX_TURNS = 12;

export type AgentSpawnLane = 'short' | 'long';
export const AGENT_SPAWN_DEDUPE_WINDOW_MS = 15 * 60_000;
export const AGENT_SPAWN_PROMPT_JACCARD = 0.6;
/** Share of the smaller side's content words two spawns must have in common to count as the same goal. */
export const AGENT_SPAWN_SAME_GOAL_OVERLAP = 0.4;

export type AgentSpawnRule = 'reason-required' | 'duplicate' | 'verify-chain' | 'concurrency-cap' | 'key-busy' | 'ok';

export interface AgentSpawnAttempt {
  seat: string;
  name: string;
  prompt: string;
  reason: string;
  /** Default long. */
  lane?: AgentSpawnLane;
  /** Short lane: the subject key (PR · cell · thread) — one live capsule per key. */
  key?: string;
}

export interface AgentSpawnDecision {
  allowed: boolean;
  rule: AgentSpawnRule;
  /** Refusal text for the tool error; empty when allowed. */
  message: string;
}

interface Entry {
  id: number;
  seat: string;
  /** The parent conversation this spawn serves — the «current goal» whose spend is totalled. */
  goal: string;
  name: string;
  prompt: string;
  startedAt: number;
  taskId?: string;
  /** Set when the dispatch settled without a live background task. */
  settledAt?: number;
  consumed: boolean;
  /** agent.abandoned already logged for this entry. */
  abandoned?: boolean;
  lane: AgentSpawnLane;
  key?: string;
  /** Short lane: stopped by sweep (TTL or token cap) — reported once. */
  stopped?: 'ttl-killed' | 'token-cap';
}

/** What the guard needs to know about a registry task. `tokens` is the child's conversation size so far. */
export type TaskStateLookup = (taskId: string) => { state: string; finishedAt?: number; tokens?: number } | undefined;

/** Token estimate for a registry task: its conversation and result text at ~4 characters per token.
 *  Providers do not report per-child usage on the agent event stream, so this is a size estimate. */
export function estimateTaskTokens(task: { messages?: ReadonlyArray<{ content: unknown }>; prompt?: string; result?: string }): number {
  let chars = (task.prompt?.length ?? 0) + (task.result?.length ?? 0);
  for (const message of task.messages ?? []) chars += typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content ?? '').length;
  return Math.ceil(chars / 4);
}


export type AbandonReason = 'superseded' | 'never-consumed';

const TERMINAL = new Set(['done', 'error', 'aborted']);

/** Lowercased letter/digit words. */
export function spawnWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 0);
}

export function normalizeSpawnName(name: string): string {
  return spawnWords(name).join(' ');
}

export function wordJaccard(a: string, b: string): number {
  const left = new Set(spawnWords(a));
  const right = new Set(spawnWords(b));
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

// Korean attaches case particles to the noun («로스터를», «원장에서»). Dropping one trailing
// particle compares the noun itself; it is grammar, not a list of topics.
const HANGUL_PARTICLE = /(?<=\p{Script=Hangul})(?:에서|으로|에게|까지|부터|을|를|이|가|은|는|의|에|로|와|과|도|만)$/u;
function stem(word: string): string {
  const stripped = word.replace(HANGUL_PARTICLE, '');
  return stripped.length > 0 ? stripped : word;
}

// Verbs that make a spawn a check of other work.
const VERIFY_STEMS = ['verif', 'check', 'confirm', 'validat', 'recheck', 'crosscheck', '검증', '확인', '점검', '재확인'];
function isVerifyWord(word: string): boolean {
  return VERIFY_STEMS.some(prefix => word.startsWith(prefix));
}

export function isVerificationSpawn(name: string, prompt: string): boolean {
  return [...spawnWords(name), ...spawnWords(prompt)].some(isVerifyWord);
}

function contentStems(name: string, prompt: string): Set<string> {
  return new Set([...spawnWords(name), ...spawnWords(prompt)].filter(word => !isVerifyWord(word)).map(stem));
}

/** Same goal: the new spawn names the other agent, or they share enough content words. */
export function sameGoal(next: { name: string; prompt: string }, other: { name: string; prompt: string }): boolean {
  const otherName = normalizeSpawnName(other.name);
  const nextText = normalizeSpawnName(`${next.name} ${next.prompt}`);
  if (otherName.length > 0 && nextText.includes(otherName)) return true;
  const a = contentStems(next.name, next.prompt);
  const b = contentStems(other.name, other.prompt);
  const smaller = Math.min(a.size, b.size);
  if (smaller === 0) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / smaller >= AGENT_SPAWN_SAME_GOAL_OVERLAP;
}

/** A templated fan-out («Investigate A …» / «Investigate B …»): the words only the new prompt has also name the
 *  new spawn, so the prompts differ in exactly the parameter that tells the workers apart. Not a duplicate. */
export function isFanOutSibling(next: { name: string; prompt: string }, other: { prompt: string }): boolean {
  const otherWords = new Set(spawnWords(other.prompt));
  const nameWords = new Set(spawnWords(next.name));
  return spawnWords(next.prompt).some(word => !otherWords.has(word) && nameWords.has(word));
}

/** isFanOutSibling over content words only: a verify verb in the name never makes a check look like a sibling. */
export function isContentFanOutSibling(next: { name: string; prompt: string }, other: { prompt: string }): boolean {
  const otherWords = new Set(spawnWords(other.prompt).map(stem));
  const nameWords = new Set(spawnWords(next.name).filter(word => !isVerifyWord(word)).map(stem));
  return spawnWords(next.prompt).filter(word => !isVerifyWord(word)).map(stem)
    .some(word => !otherWords.has(word) && nameWords.has(word));
}

export interface AgentSpawnGuardOpts {
  now?: () => number;
  taskState?: TaskStateLookup;
  maxRunning?: number;
  /** Long-lane cap for a coordinator seat (default AGENT_SPAWN_COORDINATOR_MAX_RUNNING). */
  maxCoordinatorRunning?: number;
  /** Is this seat a coordinator (default: defaultIsCoordinator). */
  isCoordinator?: (seat: string) => boolean;
  maxShortRunning?: number;
  windowMs?: number;
  shortTtlMs?: number;
  shortTokenCap?: number;
  /** Stop a running task (default: globalAgentRegistry.abort). */
  stopTask?: (taskId: string) => void;
  /** One report per stopped short capsule (default: log only). */
  onShortStopped?: (report: { seat: string; name: string; key?: string; taskId: string; reason: 'ttl-killed' | 'token-cap'; tokens: number; ageMs: number }) => void;
}

export class AgentSpawnGuard {
  private entries: Entry[] = [];
  private nextId = 1;
  private readonly now: () => number;
  private readonly taskState: TaskStateLookup;
  private readonly maxRunning: number;
  private readonly maxCoordinatorRunning: number;
  private readonly isCoordinator: (seat: string) => boolean;
  private readonly maxShortRunning: number;
  private readonly windowMs: number;
  private readonly shortTtlMs: number;
  private readonly shortTokenCap: number;
  private readonly stopTask: (taskId: string) => void;
  private readonly onShortStopped: AgentSpawnGuardOpts['onShortStopped'];

  constructor(opts: AgentSpawnGuardOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.taskState = opts.taskState ?? (taskId => {
      const task = globalAgentRegistry.get(taskId);
      return task ? { state: task.state, finishedAt: task.finishedAt, tokens: estimateTaskTokens(task) } : undefined;
    });
    this.maxRunning = opts.maxRunning ?? AGENT_SPAWN_MAX_RUNNING;
    this.maxCoordinatorRunning = opts.maxCoordinatorRunning ?? AGENT_SPAWN_COORDINATOR_MAX_RUNNING;
    this.isCoordinator = opts.isCoordinator ?? defaultIsCoordinator;
    this.windowMs = opts.windowMs ?? AGENT_SPAWN_DEDUPE_WINDOW_MS;
    this.maxShortRunning = opts.maxShortRunning ?? AGENT_SPAWN_SHORT_LANE_MAX_RUNNING;
    this.shortTtlMs = opts.shortTtlMs ?? AGENT_SHORT_LANE_TTL_MS;
    this.shortTokenCap = opts.shortTokenCap ?? AGENT_SHORT_LANE_TOKEN_CAP;
    this.stopTask = opts.stopTask ?? (taskId => { globalAgentRegistry.abort(taskId); });
    this.onShortStopped = opts.onShortStopped;
  }

  /** Running agents per lane for one seat. */
  runningByLane(seat: string): { short: number; long: number } {
    const live = this.entries.filter(entry => entry.seat === seat && this.running(entry));
    return { short: live.filter(entry => entry.lane === 'short').length, long: live.filter(entry => entry.lane === 'long').length };
  }

  /**
   * Stop short-lane capsules past their TTL or token cap. Each stop is logged and reported exactly once; the
   * capsule's task then ends (aborted) and its result reaches the parent through the usual task notification.
   */
  sweepShortLane(): number {
    const now = this.now();
    let stopped = 0;
    for (const entry of this.entries) {
      if (entry.lane !== 'short' || entry.stopped || !entry.taskId || !this.running(entry)) continue;
      const ageMs = now - entry.startedAt;
      const tokens = this.tokens(entry);
      const reason = ageMs >= this.shortTtlMs ? 'ttl-killed' : tokens >= this.shortTokenCap ? 'token-cap' : null;
      if (reason === null) continue;
      entry.stopped = reason;
      stopped += 1;
      try { this.stopTask(entry.taskId); } catch { /* the report still goes out once */ }
      const report = { seat: entry.seat, name: entry.name.slice(0, 80), ...(entry.key ? { key: entry.key } : {}), taskId: entry.taskId, reason, tokens, ageMs } as const;
      debug.log('agent.short-lane', reason, report, { level: 'warn' });
      try { this.onShortStopped?.(report); } catch { /* reporting never breaks the sweep */ }
    }
    return stopped;
  }

  private running(entry: Entry): boolean {
    if (entry.taskId) {
      const task = this.taskState(entry.taskId);
      if (task) return !TERMINAL.has(task.state);
    }
    return entry.settledAt === undefined;
  }

  private tokens(entry: Entry): number {
    return entry.taskId ? this.taskState(entry.taskId)?.tokens ?? 0 : 0;
  }

  /** Tokens spent by agents this seat spawned for one goal (finished and running, within the guard's memory). */
  goalTokens(seat: string, goal: string): number {
    return this.entries.filter(entry => entry.seat === seat && entry.goal === goal)
      .reduce((sum, entry) => sum + this.tokens(entry), this.retiredGoalTokens.get(`${seat}\u0000${goal}`) ?? 0);
  }

  /** Tokens one spawned task has used so far. */
  taskTokens(taskId: string): number {
    return this.taskState(taskId)?.tokens ?? 0;
  }

  private retiredGoalTokens = new Map<string, number>();

  private abandon(entry: Entry, reason: AbandonReason): void {
    // A short capsule the sweep stopped was already reported once (ttl-killed / token-cap).
    if (entry.abandoned || entry.consumed || entry.stopped) return;
    entry.abandoned = true;
    debug.log('agent.abandoned', 'abandoned', { seat: entry.seat, name: entry.name.slice(0, 80), tokens: this.tokens(entry), reason }, { level: 'warn' });
  }

  private finishedAt(entry: Entry): number | undefined {
    if (entry.taskId) {
      const task = this.taskState(entry.taskId);
      if (task && TERMINAL.has(task.state)) return task.finishedAt ?? entry.settledAt ?? this.now();
    }
    return entry.settledAt;
  }

  /** Decide one attempt and log it. An allowed attempt is recorded; the returned id is fed to settle(). */
  admit(attempt: AgentSpawnAttempt & { goal?: string }): AgentSpawnDecision & { id?: number } {
    this.prune();
    const { superseded, ...decision } = this.decideWithMatch(attempt);
    if (superseded) this.abandon(superseded, 'superseded');
    const lane: AgentSpawnLane = attempt.lane ?? 'long';
    debug.log('agent.spawn', 'spawn', {
      seat: attempt.seat,
      name: attempt.name.slice(0, 80),
      reason: attempt.reason.slice(0, 160),
      allowed: decision.allowed,
      rule: decision.rule,
      lane,
      ...(attempt.key ? { key: attempt.key } : {}),
    }, decision.allowed ? undefined : { level: 'warn' });
    if (!decision.allowed) return decision;
    const id = this.nextId++;
    this.entries.push({ id, seat: attempt.seat, goal: attempt.goal ?? '', name: attempt.name, prompt: attempt.prompt, startedAt: this.now(), consumed: false,
      lane, ...(attempt.key ? { key: attempt.key } : {}) });
    return { ...decision, id };
  }

  decide(attempt: AgentSpawnAttempt): AgentSpawnDecision {
    const { superseded: _superseded, ...decision } = this.decideWithMatch(attempt);
    return decision;
  }

  private decideWithMatch(attempt: AgentSpawnAttempt): AgentSpawnDecision & { superseded?: Entry } {
    if (!attempt.reason.trim()) {
      return {
        allowed: false,
        rule: 'reason-required',
        message: 'NOT SPAWNED — Agent needs `reason`: one line on why this is delegated instead of done directly. If you cannot say why, do it yourself.',
      };
    }
    const now = this.now();
    const seatEntries = this.entries.filter(entry => entry.seat === attempt.seat);
    const name = normalizeSpawnName(attempt.name);
    const lane: AgentSpawnLane = attempt.lane ?? 'long';
    if (lane === 'short' && attempt.key) {
      const busy = seatEntries.find(entry => entry.lane === 'short' && entry.key === attempt.key && this.running(entry));
      if (busy) {
        return {
          allowed: false,
          rule: 'key-busy',
          message: `NOT SPAWNED — a short capsule already works ${attempt.key}: ${busy.name}. Correct it instead: AgentSend(${busy.name}, …).`,
        };
      }
    }
    for (const entry of seatEntries) {
      if (entry.consumed) continue;
      const isRunning = this.running(entry);
      const finished = this.finishedAt(entry);
      if (!isRunning && (finished === undefined || now - finished > this.windowMs)) continue;
      const sameName = name.length > 0 && name === normalizeSpawnName(entry.name);
      if (sameName || (wordJaccard(attempt.prompt, entry.prompt) >= AGENT_SPAWN_PROMPT_JACCARD && !isFanOutSibling(attempt, entry))) {
        return {
          allowed: false,
          rule: 'duplicate',
          message: `NOT SPAWNED — same work already delegated: ${entry.name} — integrate its result, or correct it instead: AgentSend(${entry.name}, …).`,
          superseded: entry,
        };
      }
    }
    const live = seatEntries.filter(entry => this.running(entry));
    if (isVerificationSpawn(attempt.name, attempt.prompt)) {
      // TURN-GIVES-UP-NO-WORK (11-28 test universe): «메모리 회상 검색 조사» beside a running «메모리 생성 저장 조사» was
      // refused as a verify chain only because its prompt said «확인», so the turn lost its second worker and gave up.
      // A spawn whose NAME is a check stays a check. One whose verify verb is only in the prompt is a check only when it
      // is not a fan-out sibling (its name names a part the running agent's prompt never mentions).
      const verifyByName = spawnWords(attempt.name).some(isVerifyWord);
      const target = live.find(entry => sameGoal(attempt, entry) && (verifyByName || !isContentFanOutSibling(attempt, entry)));
      if (target) {
        return {
          allowed: false,
          rule: 'verify-chain',
          message: `NOT SPAWNED — wait for ${target.name}; verify once after. To change its course, correct it instead: AgentSend(${target.name}, …).`,
        };
      }
    }
    const laneLive = live.filter(entry => entry.lane === lane);
    let coordinator = false;
    if (lane === 'long') { try { coordinator = this.isCoordinator(attempt.seat); } catch { coordinator = false; } }
    const cap = lane === 'short' ? this.maxShortRunning : coordinator ? Math.max(this.maxRunning, this.maxCoordinatorRunning) : this.maxRunning;
    if (laneLive.length >= cap) {
      return {
        allowed: false,
        rule: 'concurrency-cap',
        message:
          `NOT SPAWNED — ${laneLive.length} ${lane === 'short' ? 'short-lane capsules' : 'agents'} are already running for this seat (limit ${cap}): ` +
          `${laneLive.map(entry => entry.name).join(', ')}. Wait for one and integrate its result, or do this yourself.`,
      };
    }
    return { allowed: true, rule: 'ok', message: '' };
  }

  /** The dispatch returned. A background task keeps the entry live through its registry state; a foreground
   *  answer is already in the tool result, so it counts as consumed. A spawn the dispatcher refused is dropped. */
  settle(id: number, outcome: { taskId?: string; background?: boolean; spawned: boolean }): void {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return;
    if (!outcome.spawned) {
      this.entries = this.entries.filter(item => item.id !== id);
      return;
    }
    entry.settledAt = this.now();
    if (outcome.taskId) entry.taskId = outcome.taskId;
    if (!(outcome.background && outcome.taskId)) entry.consumed = true;
  }

  /** The parent read this task's result (task-notification drained into a turn, or AgentOutput). */
  markConsumed(taskId: string): void {
    for (const entry of this.entries) if (entry.taskId === taskId) entry.consumed = true;
    this.prune();
  }

  /** Drop entries the rules no longer need. A finished result nobody read within the window is logged as
   *  abandoned (never-consumed) on the way out; its tokens stay in the goal total. */
  prune(): void {
    const now = this.now();
    this.entries = this.entries.filter(entry => {
      if (this.running(entry)) return true;
      const finished = this.finishedAt(entry);
      const keep = finished !== undefined && now - finished <= this.windowMs && !entry.consumed;
      if (keep) return true;
      if (!entry.consumed && finished !== undefined) this.abandon(entry, 'never-consumed');
      const key = `${entry.seat}\u0000${entry.goal}`;
      this.retiredGoalTokens.set(key, (this.retiredGoalTokens.get(key) ?? 0) + this.tokens(entry));
      return false;
    });
  }
}

const SEAT_IN_PATH = /(?:^|\/)seats\/([A-Za-z][A-Za-z0-9_-]{0,63})(?=\/|$)/g;
/** The seat this process works for: explicit env, else the innermost seats/<SEAT> directory, else «local». */
export function currentSeat(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return env.ELANOUS_TRACK?.trim() || env.ELANOUS_SEAT?.trim()
    || [...cwd.matchAll(SEAT_IN_PATH)].at(-1)?.[1]?.toUpperCase() || 'local';
}

let globalGuard: AgentSpawnGuard | undefined;
/** AgentOutput retrieved a finished result: the parent has it now. No-op before the first guarded spawn. */
export function noteAgentResultConsumed(taskId: string): void {
  globalGuard?.markConsumed(taskId);
}
export function globalAgentSpawnGuard(): AgentSpawnGuard {
  if (!globalGuard) {
    const guard = new AgentSpawnGuard();
    globalTaskNotificationQueue.onDrain(items => { for (const item of items) guard.markConsumed(item.taskId); });
    // Finds results nobody read within the window even when no further spawn or drain happens.
    setInterval(() => { guard.sweepShortLane(); guard.prune(); }, 30_000).unref?.();
    globalGuard = guard;
  }
  return globalGuard;
}

/** Tool-boundary wrapper: decide, run, settle. A refusal throws so the tool result carries is_error. */
export async function guardedAgentSpawn<T extends { taskId: string; background?: boolean }>(
  args: Record<string, unknown>,
  run: () => Promise<T>,
  guard: AgentSpawnGuard = globalAgentSpawnGuard(),
  seat: string = currentSeat(),
  goal = '',
): Promise<T & { spend?: AgentSpend }> {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const name = text(args.name) || text(args.description);
  const lane: AgentSpawnLane = args.lane === 'short' ? 'short' : 'long';
  const key = lane === 'short' ? (text(args.key) || name) : '';
  const decision = guard.admit({ seat, goal, name, prompt: text(args.prompt), reason: text(args.reason), lane, ...(key ? { key } : {}) });
  if (!decision.allowed || decision.id === undefined) throw new Error(decision.message);
  const id = decision.id;
  // Short lane: background, a small tool-loop budget, and the brief contract at the head of the prompt.
  if (lane === 'short') Object.assign(args, shortLaneArgs(args, key));
  try {
    const result = await run();
    const refused = result.taskId === 'dedup' || result.taskId === 'background-fanout-limit';
    guard.settle(id, { taskId: result.taskId, background: result.background === true, spawned: !refused });
    if (refused) return result;
    // Structured beside the child's answer (never mixed into it): the Agent row renders it as «3k tok · goal 45k tok».
    const spend: AgentSpend = { tokens: guard.taskTokens(result.taskId), goalTokens: guard.goalTokens(seat, goal) };
    return { ...result, spend };
  } catch (error) {
    guard.settle(id, { spawned: false });
    throw error;
  }
}

/** The short-lane contract the capsule reads first: subject · time and token limits · how to finish. */
export function shortLaneBriefHeader(key: string, ttlMs = AGENT_SHORT_LANE_TTL_MS, tokenCap = AGENT_SHORT_LANE_TOKEN_CAP): string {
  return [
    `Short-lane task for ${key}. Finish within ${Math.round(ttlMs / 60_000)} minutes and about ${Math.round(tokenCap / 1000)}k tokens; you are stopped after that.`,
    'Do only what the brief asks. If you are blocked, stop at once and say why.',
    'Answer with DONE or BLOCKED on the first line, then at most 5 lines of evidence (commands run, ids, links).',
  ].join('\n');
}

/** The args a short-lane spawn runs with (background · capped turns · brief header). */
export function shortLaneArgs(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  const turns = typeof args.max_turns === 'number' && Number.isFinite(args.max_turns) ? Math.min(args.max_turns, AGENT_SHORT_LANE_MAX_TURNS) : AGENT_SHORT_LANE_MAX_TURNS;
  return {
    run_in_background: true,
    max_turns: turns,
    prompt: prompt.startsWith('Short-lane task for ') ? prompt : `${shortLaneBriefHeader(key)}\n\n${prompt}`,
  };
}
