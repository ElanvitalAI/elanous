// LOOP-AGENT v2 generic shell — memory (LOOP-AGENT §1 ③ 기억 · 대표 11-27 09:2x «자기만의 기억 · 노하우 팩과 기억 장치»).
//
// One home per agent: <stateRoot>/loop-agents/<id>/ (the same folder and file names judge-butler already writes, so its
// cases/lessons/state/level stay where they are):
//   card.md          — the soul as last loaded (written when it changes · human-readable)
//   knowhow/seed.md  — the pack seeded from graphs/loop-agents/<id>/knowhow.md (seat KNOWHOW item format: `## K-<ID>-NNN`)
//   knowhow/learned.md — items added by `eln loop agent <id> knowhow add` or promoted lessons
//   knowhow/meta.json — {version, seedHash, history[]} · every change bumps the version
//   cases.jsonl      — every tick decision · action · voice turn · level/policy change (the audit ledger)
//   lessons.jsonl    — lessons: L0 corrections (active at once) ⊕ outcome candidates (3× same pattern → candidate →
//                      auto-promoted after N h unless the L0 objects · at once when the L0 approves) · cap ⊕ decay
//   state.json       — cursor (KPI history · breach · action cooldowns · sent keys · voice budget · pattern counts)
//   level.json       — live | L1 | shadow | off
//   policy.json      — the bounded policy overlay (card.ts POLICY_KEYS)
//   threads/<key>.jsonl — multi-turn conversation per channel thread
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseKnowhowItems, selectTopK, splitKnowhow, type KnowhowItem } from '../seat-loop/seat-knowhow.js';
import { emptyPolicy, type Policy } from './card.js';

export const AGENT_LEVELS = ['live', 'L1', 'shadow', 'off'] as const;
export type AgentLevel = typeof AGENT_LEVELS[number];

export const agentHome = (stateRoot: string, id: string): string => join(stateRoot, 'loop-agents', id);
/** Knowhow item prefix for an agent: `K-RUN-DOCTOR-001`. */
export const knowhowSeat = (id: string): string => id.toUpperCase();

export interface AgentCase {
  readonly at: string;
  readonly kind: string;
  readonly subject: string;
  readonly why: string;
  readonly refs?: readonly string[];
  readonly decidedBy: string;
  readonly supervisedBy: string;
  readonly extra?: Record<string, unknown>;
}

export type LessonStatus = 'active' | 'candidate' | 'rejected' | 'decayed';
export interface Lesson {
  readonly id: string;
  readonly at: string;
  readonly text: string;
  /** Outcome pattern that produced it (candidates) or the cell/subject of an L0 correction. */
  readonly pattern: string;
  readonly from: string;
  status: LessonStatus;
  hits: number;
  lastUsedAt: string | null;
  decidedBy?: string;
  decidedAt?: string;
}

export interface AgentState {
  lastTickAt: string | null;
  ticks: number;
  lastKpi: number | null;
  kpiOk: boolean | null;
  breachSince: string | null;
  kpiHistory: Array<{ at: string; v: number | null }>;
  /** `${action}:${target}` → last acted at. */
  acted: Record<string, string>;
  /** dedupe keys already posted. */
  sent: Record<string, string>;
  voiceTurns: number[];
  /** outcome pattern → timestamps (ms) within the window. */
  patterns: Record<string, number[]>;
  /** «subject lost»: consecutive ticks whose subject could not be read (KPI unknown and nothing seen) · since when. */
  unknownTicks?: number;
  lostSince?: string | null;
  /** this outage's reattach card already went out (one card per outage · reset when the subject reads again) */
  lostAlerted?: boolean;
  /** SUPERVISOR-JOURNAL-DEFECTS: `${action}:${target}` → consecutive failures · since · parked at (no retry until the re-check). */
  failStreak?: Record<string, { n: number; since: string; parkedAt?: string; last?: string }>;
}
export const emptyAgentState = (): AgentState => ({ lastTickAt: null, ticks: 0, lastKpi: null, kpiOk: null, breachSince: null, kpiHistory: [], acted: {}, sent: {}, voiceTurns: [], patterns: {} });

export interface ThreadTurn { readonly at: string; readonly from: string; readonly text: string; readonly reply: string }
export interface KnowhowMeta { version: number; seedHash: string | null; history: Array<{ at: string; version: number; what: string; by: string }> }

/** Lessons: at most this many active; unused for DECAY_DAYS → decayed. */
export const LESSON_CAP = 30;
export const LESSON_DECAY_DAYS = 30;
/** Same outcome pattern this many times within PATTERN_WINDOW_DAYS → a candidate lesson. */
export const PATTERN_REPEAT = 3;
export const PATTERN_WINDOW_DAYS = 7;
/** A candidate the L0 did not object to within this many hours is promoted. */
export const PROMOTE_AFTER_H = 12;

/** The one JSONL reader/appender of a loop-agent home (cases · lessons · threads · journal) — a torn line is skipped. */
export const readJsonl = <T>(p: string, limit: number): T[] => {
  if (!existsSync(p)) return [];
  const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as T]; } catch { return []; } });
  return rows.slice(-limit);
};
export const appendJsonl = (p: string, row: unknown): void => { appendFileSync(p, `${JSON.stringify(row)}\n`); };
const atomicWrite = (p: string, text: string): void => { const t = `${p}.${process.pid}.tmp`; writeFileSync(t, text); renameSync(t, p); };
const threadFile = (key: string): string => `${key.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 80) || 'default'}.jsonl`;

export interface AgentMemory {
  readonly id: string;
  readonly root: string;
  readState(): AgentState;
  writeState(s: AgentState): void;
  appendCase(c: AgentCase): void;
  cases(limit?: number): AgentCase[];
  lessons(): Lesson[];
  writeLessons(rows: readonly Lesson[]): void;
  level(): { level: AgentLevel; by: string; at: string; reason: string };
  setLevel(level: AgentLevel, by: string, reason: string, now?: Date): void;
  policy(): Policy;
  writePolicy(p: Policy): void;
  thread(key: string, limit?: number): ThreadTurn[];
  appendThread(key: string, t: ThreadTurn): void;
  threadKeys(): string[];
  knowhow(): { items: KnowhowItem[]; meta: KnowhowMeta; text: string };
  seedKnowhow(seedText: string, now?: Date): boolean;
  addKnowhow(item: { title: string; situation: string; prescription: string; kind?: string; measure?: string }, by: string, now?: Date): string;
  writeCardMd(text: string): void;
}

export function fileAgentMemory(stateRoot: string, id: string, supervisor: string): AgentMemory {
  const root = agentHome(stateRoot, id);
  const p = (f: string) => join(root, f);
  const ensure = (sub = '') => mkdirSync(sub ? p(sub) : root, { recursive: true });
  const readMeta = (): KnowhowMeta => { try { return { version: 0, seedHash: null, history: [], ...JSON.parse(readFileSync(p('knowhow/meta.json'), 'utf8')) as Partial<KnowhowMeta> }; } catch { return { version: 0, seedHash: null, history: [] }; } };
  const writeMeta = (m: KnowhowMeta) => { ensure('knowhow'); m.history = m.history.slice(-50); atomicWrite(p('knowhow/meta.json'), JSON.stringify(m, null, 1)); };
  const seat = knowhowSeat(id);
  const mem: AgentMemory = {
    id, root,
    readState() { try { return { ...emptyAgentState(), ...JSON.parse(readFileSync(p('state.json'), 'utf8')) as Partial<AgentState> }; } catch { return emptyAgentState(); } },
    writeState(s) { ensure(); s.kpiHistory = s.kpiHistory.slice(-96); atomicWrite(p('state.json'), JSON.stringify(s, null, 1)); },
    appendCase(c) { ensure(); appendFileSync(p('cases.jsonl'), `${JSON.stringify(c)}\n`); },
    cases(limit = 200) { return readJsonl<AgentCase>(p('cases.jsonl'), limit); },
    lessons() {
      // judge-butler's legacy rows {at, cell, text, from} read as active L0 lessons.
      return readJsonl<Partial<Lesson> & { cell?: string }>(p('lessons.jsonl'), 500).map((l, i) => ({
        id: l.id ?? `L-${i + 1}`, at: l.at ?? '-', text: l.text ?? '', pattern: l.pattern ?? l.cell ?? '', from: l.from ?? '?',
        status: (l.status ?? 'active') as LessonStatus, hits: l.hits ?? 0, lastUsedAt: l.lastUsedAt ?? null,
        ...(l.decidedBy ? { decidedBy: l.decidedBy } : {}), ...(l.decidedAt ? { decidedAt: l.decidedAt } : {}),
      }));
    },
    writeLessons(rows) { ensure(); atomicWrite(p('lessons.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); },
    level() {
      try {
        const j = JSON.parse(readFileSync(p('level.json'), 'utf8')) as { level?: string; by?: string; at?: string; reason?: string };
        if ((AGENT_LEVELS as readonly string[]).includes(String(j.level))) return { level: j.level as AgentLevel, by: j.by ?? '?', at: j.at ?? '?', reason: j.reason ?? '' };
      } catch { /* default */ }
      return { level: 'live', by: 'default', at: '-', reason: 'v2 default — live (SUPERVISOR-REVIVE-1127)' };
    },
    setLevel(level, by, reason, now = new Date()) {
      if (!(AGENT_LEVELS as readonly string[]).includes(level)) throw new Error(`level must be ${AGENT_LEVELS.join(' | ')}`);
      ensure();
      writeFileSync(p('level.json'), JSON.stringify({ level, by: by.trim().toUpperCase(), at: now.toISOString(), reason }));
      mem.appendCase({ at: now.toISOString(), kind: 'level', subject: level, why: reason, decidedBy: by.trim().toUpperCase(), supervisedBy: supervisor });
    },
    policy() { try { return { ...emptyPolicy(), ...JSON.parse(readFileSync(p('policy.json'), 'utf8')) as Partial<Policy> }; } catch { return emptyPolicy(); } },
    writePolicy(pol) { ensure(); atomicWrite(p('policy.json'), JSON.stringify(pol, null, 1)); },
    thread(key, limit = 8) { return readJsonl<ThreadTurn>(p(join('threads', threadFile(key))), limit); },
    appendThread(key, t) { ensure('threads'); appendFileSync(p(join('threads', threadFile(key))), `${JSON.stringify(t)}\n`); },
    threadKeys() { try { return readdirSync(p('threads')).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)); } catch { return []; } },
    knowhow() {
      const parts = ['knowhow/seed.md', 'knowhow/learned.md'].map(f => (existsSync(p(f)) ? readFileSync(p(f), 'utf8') : ''));
      const text = parts.filter(Boolean).join('\n\n');
      return { items: parseKnowhowItems(text, seat), meta: readMeta(), text };
    },
    seedKnowhow(seedText, now = new Date()) {
      const hash = createHash('sha256').update(seedText).digest('hex').slice(0, 16);
      const meta = readMeta();
      if (meta.seedHash === hash && existsSync(p('knowhow/seed.md'))) return false;
      ensure('knowhow'); atomicWrite(p('knowhow/seed.md'), seedText);
      meta.version += 1; meta.seedHash = hash; meta.history.push({ at: now.toISOString(), version: meta.version, what: `seed ${hash}`, by: 'repo' });
      writeMeta(meta);
      return true;
    },
    addKnowhow(item, by, now = new Date()) {
      ensure('knowhow');
      const all = mem.knowhow();
      const nums = [...all.text.matchAll(new RegExp(`^##\\s+K-${seat}-(\\d+)`, 'gmu'))].map(m => Number(m[1]));
      const n = String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
      const kid = `K-${seat}-${n}`;
      const day = now.toISOString().slice(0, 10);
      const block = [`## ${kid} ${item.title.replace(/\n/gu, ' ').slice(0, 120)} (${day})`, `- 상황: ${item.situation.replace(/\n/gu, ' ')}`, `- 처방(힐링): ${item.prescription.replace(/\n/gu, ' ')}`,
        `- 재는 명령: ${item.measure?.trim() || '(없음)'}`, `- 종류: ${item.kind ?? 'heuristic'}`, `- 검증: ${day} 참 (${by})`, `- 출처: ${by} · 상태: active`, ''].join('\n');
      appendFileSync(p('knowhow/learned.md'), `${existsSync(p('knowhow/learned.md')) ? '\n' : ''}${block}`);
      const meta = readMeta(); meta.version += 1; meta.history.push({ at: now.toISOString(), version: meta.version, what: `add ${kid}`, by }); writeMeta(meta);
      return kid;
    },
    writeCardMd(text) {
      ensure();
      const cur = existsSync(p('card.md')) ? readFileSync(p('card.md'), 'utf8') : null;
      if (cur !== text) atomicWrite(p('card.md'), text);
    },
  };
  return mem;
}

// ── self-learning (outcome lessons) ─────────────────────────────────────────────────────────────────────────────────
/** Count one outcome pattern; returns true when it just reached PATTERN_REPEAT inside the window. Mutates `state`. */
export function notePattern(state: AgentState, pattern: string, nowMs: number): boolean {
  const win = PATTERN_WINDOW_DAYS * 86_400_000;
  const xs = (state.patterns[pattern] ?? []).filter(t => nowMs - t < win);
  xs.push(nowMs);
  state.patterns[pattern] = xs.slice(-20);
  // drop stale patterns so the state does not grow without bound
  for (const [k, v] of Object.entries(state.patterns)) if (!v.some(t => nowMs - t < win)) delete state.patterns[k];
  return xs.length === PATTERN_REPEAT;
}

const nextLessonId = (rows: readonly Lesson[]): string => `L-${rows.reduce((m, r) => Math.max(m, Number(/^L-(\d+)$/u.exec(r.id)?.[1] ?? 0)), 0) + 1}`;

/** A candidate from a repeated outcome (no duplicate for a pattern that already has a non-rejected lesson). */
export function addCandidate(mem: AgentMemory, pattern: string, text: string, now: Date): Lesson | null {
  const rows = mem.lessons();
  if (rows.some(r => r.pattern === pattern && r.status !== 'rejected' && r.status !== 'decayed')) return null;
  const l: Lesson = { id: nextLessonId(rows), at: now.toISOString(), text: text.slice(0, 400), pattern, from: 'outcome', status: 'candidate', hits: 0, lastUsedAt: null };
  mem.writeLessons([...rows, l]);
  return l;
}

/** An L0 correction / an operator-written lesson: active at once. */
export function addLesson(mem: AgentMemory, text: string, pattern: string, from: string, now: Date): Lesson {
  const rows = mem.lessons();
  const l: Lesson = { id: nextLessonId(rows), at: now.toISOString(), text: text.slice(0, 400), pattern, from: from.toUpperCase(), status: 'active', hits: 0, lastUsedAt: null, decidedBy: from.toUpperCase(), decidedAt: now.toISOString() };
  mem.writeLessons(enforceCap([...rows, l], now));
  return l;
}

export function decideLesson(mem: AgentMemory, id: string, approve: boolean, by: string, now: Date): Lesson | null {
  const rows = mem.lessons();
  const l = rows.find(r => r.id === id.trim().toUpperCase());
  if (!l || l.status !== 'candidate') return null;
  l.status = approve ? 'active' : 'rejected'; l.decidedBy = by.toUpperCase(); l.decidedAt = now.toISOString();
  mem.writeLessons(enforceCap(rows, now));
  return l;
}

/** Candidates older than PROMOTE_AFTER_H → active (silence = consent of the L0) · unused active lessons decay · cap. */
export function maintainLessons(mem: AgentMemory, now: Date, promoteAfterH = PROMOTE_AFTER_H): { promoted: Lesson[]; decayed: Lesson[] } {
  const rows = mem.lessons();
  const promoted: Lesson[] = []; const decayed: Lesson[] = [];
  for (const l of rows) {
    if (l.status === 'candidate' && now.getTime() - Date.parse(l.at) >= promoteAfterH * 3_600_000) {
      l.status = 'active'; l.decidedBy = 'silence'; l.decidedAt = now.toISOString(); promoted.push(l);
    } else if (l.status === 'active') {
      const last = Date.parse(l.lastUsedAt ?? l.decidedAt ?? l.at);
      if (Number.isFinite(last) && now.getTime() - last > LESSON_DECAY_DAYS * 86_400_000) { l.status = 'decayed'; decayed.push(l); }
    }
  }
  const overCap = rows.filter(r => r.status === 'active').length > LESSON_CAP;
  const capped = enforceCap(rows, now);
  if (promoted.length || decayed.length || overCap || capped.length !== rows.length) mem.writeLessons(capped);
  return { promoted, decayed };
}

/** Keep at most LESSON_CAP active lessons: the least used / oldest decay first. Rejected/decayed beyond 100 rows are dropped. */
export function enforceCap(rows: Lesson[], _now: Date): Lesson[] {
  const active = rows.filter(r => r.status === 'active');
  if (active.length > LESSON_CAP) {
    const score = (l: Lesson) => l.hits * 1e13 + Date.parse(l.lastUsedAt ?? l.decidedAt ?? l.at);
    for (const l of [...active].sort((a, b) => score(a) - score(b)).slice(0, active.length - LESSON_CAP)) l.status = 'decayed';
  }
  const dead = rows.filter(r => r.status === 'rejected' || r.status === 'decayed');
  const dropDead = new Set(dead.slice(0, Math.max(0, dead.length - 100)));
  return rows.filter(r => !dropDead.has(r));
}

// ── recall (bounded) ────────────────────────────────────────────────────────────────────────────────────────────────
export const RECALL_BUDGET_CHARS = 6_000;
export interface Recall { readonly text: string; readonly knowhow: string[]; readonly lessons: string[]; readonly cases: number; readonly chars: number }

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(t => t.length > 1));
const overlap = (a: Set<string>, text: string): number => { let n = 0; for (const t of tokens(text)) if (a.has(t)) n += 1; return n; };

/** What every decision and voice turn loads: knowhow top-k ⊕ relevant active lessons ⊕ recent cases — whole items only, ≤ budget.
 *  Marks the lessons it used (hits · lastUsedAt) so unused ones decay. */
export function recall(mem: AgentMemory, query: string, now: Date, opts: { budget?: number; k?: number; cases?: number; mark?: boolean } = {}): Recall {
  const budget = opts.budget ?? RECALL_BUDGET_CHARS; const k = opts.k ?? 5;
  const q = tokens(query);
  const { items } = mem.knowhow();
  const split = splitKnowhow(items, now);
  const kh = selectTopK([...split.facts, ...split.refs], query, k).map(i => i.text);
  const rows = mem.lessons();
  const active = rows.filter(r => r.status === 'active');
  const ranked = [...active].map((l, i) => ({ l, s: overlap(q, `${l.text} ${l.pattern}`), i })).sort((a, b) => b.s - a.s || b.i - a.i).slice(0, k).map(x => x.l);
  const recent = mem.cases(12).reverse();
  const out: string[] = []; let used = 0; const usedKh: string[] = []; const usedLessons: Lesson[] = []; let usedCases = 0;
  const push = (s: string): boolean => { if (used + s.length + 1 > budget) return false; out.push(s); used += s.length + 1; return true; };
  if (kh.length) push('## 노하우 팩');
  for (const t of kh) if (push(t)) usedKh.push(t.split('\n')[0]!);
  if (ranked.length) push('## 교훈');
  for (const l of ranked) if (push(`- ${l.id} [${l.from}] ${l.text}`)) usedLessons.push(l);
  if (recent.length) push('## 최근 사건');
  for (const c of recent) if (push(`- ${c.at.slice(5, 16)} ${c.kind} ${c.subject} — ${c.why.slice(0, 140)}`)) usedCases += 1;
  if (opts.mark !== false && usedLessons.length) {
    for (const l of usedLessons) { l.hits += 1; l.lastUsedAt = now.toISOString(); }
    mem.writeLessons(rows);
  }
  return { text: out.join('\n'), knowhow: usedKh, lessons: usedLessons.map(l => l.id), cases: usedCases, chars: used };
}

/** Read-only grep over one agent's lessons ⊕ knowhow ⊕ cases (for `eln loop agent <id> memory --grep` and `eln self recall`). */
export function grepMemory(mem: AgentMemory, query: string, limit = 10): Array<{ where: 'lesson' | 'knowhow' | 'case'; at: string; text: string; score: number }> {
  const q = tokens(query);
  if (!q.size) return [];
  const hits: Array<{ where: 'lesson' | 'knowhow' | 'case'; at: string; text: string; score: number }> = [];
  for (const l of mem.lessons()) if (l.status === 'active' || l.status === 'candidate') { const s = overlap(q, `${l.text} ${l.pattern}`); if (s) hits.push({ where: 'lesson', at: l.at, text: `${l.id} [${l.status}] ${l.text}`, score: s + 1 }); }
  for (const i of mem.knowhow().items) { const s = overlap(q, i.text); if (s) hits.push({ where: 'knowhow', at: i.verifiedAt?.toISOString() ?? '-', text: i.text.split('\n')[0]!, score: s }); }
  for (const c of mem.cases(500)) { const s = overlap(q, `${c.kind} ${c.subject} ${c.why}`); if (s) hits.push({ where: 'case', at: c.at, text: `${c.kind} ${c.subject} — ${c.why.slice(0, 160)}`, score: s * 0.8 }); }
  return hits.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at)).slice(0, limit);
}

/** Knowhow-only recall (whole items · ≤ budget) — for bespoke agents whose lessons keep their own format (judge-butler). */
export function knowhowFor(mem: AgentMemory, query: string, now: Date, budget = 2_500, k = 4): string {
  const split = splitKnowhow(mem.knowhow().items, now);
  const out: string[] = []; let used = 0;
  for (const it of selectTopK([...split.facts, ...split.refs], query, k)) { if (used + it.text.length + 1 > budget) continue; out.push(it.text); used += it.text.length + 1; }
  return out.join('\n');
}
