// 착지 집사 — cards (graphs/loop-agents/land-steward/{agent.yaml,soul.md,knowhow.md}) ⊕ memory (LOOP-AGENT §1 ②③). The body and
// the voice are the shared kinds land-graph.tick ⊕ kpi-voice (CODE-BODY-TO-KIND) — this file is only the agent's own file layout.
//   <state>/loop-agents/land-steward/cases.jsonl — every tick summary · voice answer · KPI breach line
//   <state>/loop-agents/land-steward/state.json  — breach cursor (one line per breach key per 30 min)
//   <state>/loop-agents/land-steward/level.json  — live | shadow | off (shadow/off run the plain body · landing never stops)
// Events (lands · refusals · cards) stay in the body's ledger <state>/land-graph/ledger.jsonl — no new ledger for them.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendAudit } from '../kit/audit-ledger/index.js';
import type { LintEnv } from '../loop-agent/v3/agent-yaml.js';
import { loadAgentCards, type AgentTickCards } from '../loop-agent/v3/land-graph-kind.js';

export const STEWARD_ID = 'land-steward';
export const STEWARD_SEAT = 'LAND-STEWARD';
export const STEWARD_SUPERVISOR = 'TC';
export const STEWARD_LEVELS = ['live', 'shadow', 'off'] as const;
export type StewardLevel = typeof STEWARD_LEVELS[number];
/** Seats that may change the level — the CLI binds `--by` to the verified caller first (src/land-steward/cli.ts verifyLevelCaller). */
export const STEWARD_DEMOTERS = new Set(['TC', 'OP', 'CLAUDE-OP']);

/** The cards the land-graph.tick kind runs with (src/loop-agent/v3/land-graph-kind.ts): the linted agent.yaml or `refused`. */
export type StewardCards = AgentTickCards;

export const cardsDir = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'loop-agents', STEWARD_ID);

/** agent.yaml (lint ⊕ strict loader) → the cards · refused / absent → `refused` for the L0 report (the steward stays down). Never throws. */
export function loadCards(dir = cardsDir(), env: LintEnv = {}): StewardCards {
  return loadAgentCards(dir, '착지 집사 (land-steward) — 착지 거절의 최종 주인 · L0 = TC', env);
}

export interface StewardCase { at: string; kind: 'tick' | 'voice' | 'breach' | 'level'; subject: string; why: string; refs?: string[]; extra?: Record<string, unknown> }
export interface StewardState { lastTickAt: string | null; ticks: number; breaches: Record<string, string> }
const emptyState = (): StewardState => ({ lastTickAt: null, ticks: 0, breaches: {} });

export interface StewardMemory {
  readonly root: string;
  readState(): StewardState;
  writeState(s: StewardState): void;
  appendCase(c: StewardCase): void;
  cases(limit?: number): StewardCase[];
  level(): { level: StewardLevel; by: string; at: string; reason: string };
  setLevel(level: StewardLevel, by: string, reason: string, now?: Date): void;
}

export const stewardHome = (stateRoot: string): string => join(stateRoot, 'loop-agents', STEWARD_ID);

export function fileMemory(stateRoot: string): StewardMemory {
  const root = stewardHome(stateRoot);
  const p = (f: string) => join(root, f);
  const ensure = () => mkdirSync(root, { recursive: true });
  return {
    root,
    readState() { try { return { ...emptyState(), ...JSON.parse(readFileSync(p('state.json'), 'utf8')) as Partial<StewardState> }; } catch { return emptyState(); } },
    writeState(s) { ensure(); writeFileSync(p('state.json.tmp'), JSON.stringify(s, null, 1)); renameSync(p('state.json.tmp'), p('state.json')); },
    appendCase(c) { appendAudit(p('cases.jsonl'), 'land-steward.case/1', { ...c }); },
    cases(limit = 200) {
      if (!existsSync(p('cases.jsonl'))) return [];
      return readFileSync(p('cases.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as StewardCase]; } catch { return []; } }).slice(-limit);
    },
    level() {
      try {
        const j = JSON.parse(readFileSync(p('level.json'), 'utf8')) as { level?: string; by?: string; at?: string; reason?: string };
        if ((STEWARD_LEVELS as readonly string[]).includes(String(j.level))) return { level: j.level as StewardLevel, by: j.by ?? '?', at: j.at ?? '?', reason: j.reason ?? '' };
      } catch { /* default */ }
      return { level: 'live', by: 'default', at: '-', reason: 'land-steward rollout — live by default (the body keeps land.graph.mode)' };
    },
    setLevel(level, by, reason, now = new Date()) {
      if (!(STEWARD_LEVELS as readonly string[]).includes(level)) throw new Error(`level must be ${STEWARD_LEVELS.join(' | ')}`);
      const who = by.trim().toUpperCase();
      if (!STEWARD_DEMOTERS.has(who)) throw new Error(`only ${[...STEWARD_DEMOTERS].join('/')} may change the land-steward level (got ${by})`);
      ensure();
      writeFileSync(p('level.json'), JSON.stringify({ level, by: who, at: now.toISOString(), reason }));
      appendAudit(p('cases.jsonl'), 'land-steward.case/1', { at: now.toISOString(), kind: 'level', subject: level, why: `${who}: ${reason}` } satisfies StewardCase);
    },
  };
}
