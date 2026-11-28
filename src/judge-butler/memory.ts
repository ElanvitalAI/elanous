// 판정 집사 — memory (LOOP-AGENT §1 ③ 기억) ⊕ the body's cursor state ⊕ level (demote / kill switch).
//   cases.jsonl   — every decision and voice turn: {at · kind · subject · why · evidence refs · decidedBy · supervisedBy}
//   lessons.jsonl — a JUD correction of one of its decisions becomes a lesson (and the cell is never auto-signed again this version)
//   state.json    — cursor: signed cells · proposals · freed-hand marks · voice budget · last digest
//   level.json    — live | L1 (rules only, no voice) | shadow (plan, write nothing) | off (kill)
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendAudit, appendAuditLine } from '../kit/audit-ledger/index.js';
import { journalCase } from '../loop-agent/journal.js';

export const BUTLER_ID = 'judge-butler';
export const BUTLER_SEAT = 'JUDGE-BUTLER';
export const BUTLER_SUPERVISOR = 'JUD';
export const BUTLER_LEVELS = ['live', 'L1', 'shadow', 'off'] as const;
export type ButlerLevel = typeof BUTLER_LEVELS[number];
/** Seats that may demote / promote the butler (its L0, HQ, the CEO copy). */
export const BUTLER_DEMOTERS = new Set(['JUD', 'OP', 'CLAUDE-OP', 'CEO']);

export const butlerHome = (stateRoot: string, agent: string = BUTLER_ID): string => join(stateRoot, 'loop-agents', agent);

export interface Case {
  readonly at: string;
  readonly kind: 'spawn' | 'world' | 'reap' | 'route' | 'hand-propose' | 'hand-scale-down' | 'paid-escalate' | 'probe' | 'sign' | 'escalation-withdrawn' | 'e4-run' | 'sim-run' | 'fu-line-fallback' | 'off-target' | 'sign-refused' | 'not-signed' | 'verify-failed' | 'escalate-cell' | 'hold-expire' | 'hold-propose' | 'hold-escalate' | 'hand-freed' | 'hand-answer' | 'hand-escalate' | 'voice' | 'lesson' | 'digest' | 'level';
  readonly subject: string;
  readonly why: string;
  readonly refs?: readonly string[];
  readonly decidedBy: string;
  readonly supervisedBy: string;
  readonly extra?: Record<string, unknown>;
}
export interface Lesson { readonly at: string; readonly cell: string; readonly text: string; readonly from: string }

export interface ButlerState {
  version: string | null;
  /** cell → signed at (this version). */
  signed: Record<string, string>;
  /** cells JUD reversed — never auto-signed again this version. */
  reversed: Record<string, string>;
  /** key → at (proposal · escalation · card keys already sent). */
  sent: Record<string, string>;
  /** hand → hold id it was frozen by on the last tick. */
  frozenLast: Record<string, string>;
  /** voice turn timestamps (ms) in the last hour. */
  voiceTurns: number[];
  lastDigestAt: string | null;
  lastTickAt: string | null;
  /** BUTLER-RESCAN: done-when / security-4 rules version of the last tick. */
  rulesVersion?: string;
  /** BUTLER-RESPECT-VETO: evidence fingerprint at sign time · at veto time (re-sign only when it changes). */
  signedFp?: Record<string, string>;
  vetoFp?: Record<string, string>;
}
export const emptyState = (): ButlerState => ({ version: null, signed: {}, reversed: {}, sent: {}, frozenLast: {}, voiceTurns: [], lastDigestAt: null, lastTickAt: null });

export interface ButlerMemory {
  readonly root: string;
  readState(): ButlerState;
  writeState(s: ButlerState): void;
  appendCase(c: Case): void;
  appendLesson(l: Lesson): void;
  cases(limit?: number): Case[];
  lessons(limit?: number): Lesson[];
  level(): { level: ButlerLevel; by: string; at: string; reason: string };
  setLevel(level: ButlerLevel, by: string, reason: string, now?: Date): void;
}

const readJsonl = <T>(p: string, limit: number): T[] => {
  if (!existsSync(p)) return [];
  const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as T]; } catch { return []; } });
  return rows.slice(-limit);
};

/** One loop agent's memory · level (judge-butler by default; the guardian passes { agent: 'guardian', supervisor: 'RES', demoters }). */
export function fileMemory(stateRoot: string, opts: { agent?: string; supervisor?: string; demoters?: ReadonlySet<string> } = {}): ButlerMemory {
  const root = butlerHome(stateRoot, opts.agent ?? BUTLER_ID);
  const demoters = opts.demoters ?? BUTLER_DEMOTERS; const supervisor = opts.supervisor ?? BUTLER_SUPERVISOR;
  const p = (f: string) => join(root, f);
  const ensure = () => mkdirSync(root, { recursive: true });
  return {
    root,
    readState() { try { return { ...emptyState(), ...JSON.parse(readFileSync(p('state.json'), 'utf8')) as Partial<ButlerState> }; } catch { return emptyState(); } },
    writeState(s) { ensure(); writeFileSync(p('state.json.tmp'), JSON.stringify(s, null, 1)); renameSync(p('state.json.tmp'), p('state.json')); },
    appendCase(c) {
      appendAudit(p('cases.jsonl'), 'loop-agent.case/1', { ...c });
      // SUPERVISOR-CORRECTION-JOURNAL: a case whose kind is a correction (policy YAML kind map) is also one journal row.
      journalCase(root, opts.agent ?? BUTLER_ID, c);
    },
    // kit/loop-shell (DUPLICATION-MAP §1-1): ONE lessons format in the shared home — the loop-agent shell's row
    // {id · at · text · pattern · from · status · hits · lastUsedAt · decidedBy · decidedAt}; the butler's cell rides in
    // `pattern: cell:<id>` (and `cell` for older readers). The shell's decay/cap rewrite keeps pattern, so cell survives it.
    // kit/audit-ledger (#40410): the line lands through the one writer (fsync); no schema tag (shell row shape) · never rotated (L-<n> reads the whole file).
    appendLesson(l) {
      const n = readJsonl<{ id?: string }>(p('lessons.jsonl'), 100_000).reduce((m, r) => Math.max(m, Number(/^L-(\d+)$/u.exec(r.id ?? '')?.[1] ?? 0)), 0) + 1;
      appendAuditLine(p('lessons.jsonl'), JSON.stringify({ id: `L-${n}`, at: l.at, text: l.text, pattern: `cell:${l.cell}`, cell: l.cell, from: l.from, status: 'active', hits: 0, lastUsedAt: null, decidedBy: l.from, decidedAt: l.at }), { maxBytes: 0 });
    },
    cases(limit = 200) { return readJsonl<Case>(p('cases.jsonl'), limit); },
    lessons(limit = 50) {
      // both formats: legacy {at, cell, text, from} and the shell row (cell from `pattern: cell:<id>`); decayed/rejected dropped
      return readJsonl<{ at?: string; cell?: string; pattern?: string; text?: string; from?: string; status?: string }>(p('lessons.jsonl'), 100_000)
        .filter(r => !r.status || r.status === 'active')
        .map(r => ({ at: r.at ?? '-', cell: r.cell ?? (r.pattern?.startsWith('cell:') ? r.pattern.slice(5) : r.pattern ?? ''), text: r.text ?? '', from: r.from ?? '?' }))
        .slice(-limit);
    },
    level() {
      try {
        const j = JSON.parse(readFileSync(p('level.json'), 'utf8')) as { level?: string; by?: string; at?: string; reason?: string };
        if ((BUTLER_LEVELS as readonly string[]).includes(String(j.level))) return { level: j.level as ButlerLevel, by: j.by ?? '?', at: j.at ?? '?', reason: j.reason ?? '' };
      } catch { /* default */ }
      return { level: 'live', by: 'default', at: '-', reason: '0.3.38 rollout — live by default (👑 11-27)' };
    },
    setLevel(level, by, reason, now = new Date()) {
      if (!(BUTLER_LEVELS as readonly string[]).includes(level)) throw new Error(`level must be ${BUTLER_LEVELS.join(' | ')}`);
      if (!demoters.has(by.trim().toUpperCase())) throw new Error(`only ${[...demoters].join('/')} may change the ${opts.agent ?? BUTLER_ID} level (got ${by})`);
      ensure();
      writeFileSync(p('level.json'), JSON.stringify({ level, by: by.trim().toUpperCase(), at: now.toISOString(), reason }));
      appendAudit(p('cases.jsonl'), 'loop-agent.case/1', { at: now.toISOString(), kind: 'level', subject: level, why: reason, decidedBy: by.trim().toUpperCase(), supervisedBy: supervisor } satisfies Case);
    },
  };
}
