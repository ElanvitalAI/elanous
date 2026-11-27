// 감시자의 감시 (watchers-check) — LOOP-AGENT v2 body (SUPERVISOR-REVIVE-1127 · L0 OP).
//
// S: the trigger graph watchers-check (graphs/triggers/watchers-check.yaml → src/cli/watch-cli.ts runWatchCheck) judged only
//    the 4 watchers that happened to beat (release-graph-tick · res-patrol · trigger-tick · itself) and could only card
//    CLAUDE-OP (≥100 unread) — a supervisor that never beat was invisible, and a DEAD one stayed dead.
// C: every LOOP-AGENT v2 card now owes a `loop:<id>` beat (runtime beatName); a card with no beat at all is a missing
//    supervisor, not «nothing to see».
// A: 세 얼굴 —
//   관측 = the beats ledger (`{stateRoot}/watchers/beats.jsonl`, src/kit/heartbeat/index.ts readBeats) judged by judgeWatchers
//          (DEAD > 2× cadence · BROKEN 3 errored beats · BLIND source moved past the cursor) ⊕ every v2 card
//          (src/loop-agent/card.ts listCards → expected `loop:<id>`) ⊕ the core graph watchers. KPI = expected watchers that
//          are MISSING (never beat) or DEAD/BROKEN/BLIND ⊕ recently-alive (24 h) watchers that went bad. Self excluded.
//          A failing reader → KPI null («모름»).
//   판단 근거 = the card · restart map: `loop:<id>` → `eln loop agent <id> tick` · `trigger-tick` → `eln loop trigger tick` ·
//          a registered trigger graph id → `eln loop trigger tick --only <id>`. BROKEN/BLIND are not restart-shaped (the
//          watcher runs but is wrong) — they stay subjects for the owner.
//   수복과 인계 = `restart` fires the supervisor's trigger once (cooldown per target) — nothing to undo (a wake). What a restart
//          does not bring back stays a breach → one card to OP after escalate_after_min.
import type { BodyEnv } from '../registry.js';
import { fileAgentMemory } from '../memory.js';
import type { ActionResult, AgentBody, Observation, PlannedAction, Subject } from '../runtime.js';
import { pv } from '../policy-context.js';
import type { Beat, SourceHead, WatcherVerdict } from '../../kit/heartbeat/index.js';
import { judgeWatchers } from '../../kit/heartbeat/index.js';

export const SELF_BEAT = 'loop:watchers-check';
/** Graph watchers that beat today and must keep beating (census 11-27 §2a). */
export const CORE_WATCHERS: readonly string[] = ['trigger-tick', 'res-patrol', 'release-graph-tick'];
/** A watcher that beat within this window and then went bad counts even when no card expects it. */
export const RECENT_MIN = 24 * 60;

export interface WatchersCheckDeps {
  /** The beats ledger tail (null = unreadable). */
  beats(): Beat[] | null;
  sourceHead: SourceHead;
  /** Ids of every v2 card (null = card dir unreadable). */
  cardIds(): string[] | null;
  /** Registered trigger graph ids (null = registry unreadable → only loop:/trigger-tick restarts). */
  triggerIds(): Set<string> | null;
  /** Fire one elanous command once, detached (e.g. ['loop','agent','x','tick']). */
  fire(argv: readonly string[]): { ok: boolean; line: string };
}

export type WatchStatus = WatcherVerdict['status'] | 'MISSING';
export interface WatchRow { readonly name: string; readonly status: WatchStatus; readonly ageMin: number | null; readonly reason: string; readonly expected: boolean }

/** Pure: expected ∪ recently-alive watchers with their status (self excluded). */
export function watchRows(verdicts: readonly WatcherVerdict[], expected: readonly string[]): WatchRow[] {
  const byName = new Map(verdicts.map(v => [v.name, v]));
  const exp = new Set(expected.filter(n => n !== SELF_BEAT));
  const rows: WatchRow[] = [];
  for (const name of [...exp].sort()) {
    const v = byName.get(name);
    rows.push(v ? { name, status: v.status, ageMin: v.ageMin, reason: v.reason, expected: true } : { name, status: 'MISSING', ageMin: null, reason: 'no beat at all', expected: true });
  }
  for (const v of verdicts) {
    if (exp.has(v.name) || v.name === SELF_BEAT || v.ageMin > pv('recent_min', RECENT_MIN)) continue;
    rows.push({ name: v.name, status: v.status, ageMin: v.ageMin, reason: v.reason, expected: false });
  }
  return rows;
}

/** The one command that wakes this watcher, or null when no restart door is known. */
export function restartArgv(name: string, cards: ReadonlySet<string>, triggers: ReadonlySet<string> | null): string[] | null {
  const loop = /^loop:([a-z][a-z0-9-]{0,62})$/u.exec(name);
  if (loop) return cards.has(loop[1]!) ? ['loop', 'agent', loop[1]!, 'tick'] : null;
  if (name === 'trigger-tick') return ['loop', 'trigger', 'tick'];
  if (triggers?.has(name)) return ['loop', 'trigger', 'tick', '--only', name];
  return null;
}

export function createBody(env: BodyEnv, deps: WatchersCheckDeps = liveDeps(env.stateRoot)): AgentBody {
  let restartable = new Map<string, string[]>();

  const observe = (ctx: { now: Date }): Observation => {
    const beats = deps.beats(); const ids = deps.cardIds();
    if (beats === null || ids === null) {
      restartable = new Map();
      return { kpi: null, subjects: [], facts: [beats === null ? 'beats 원장 읽기 실패 → 모름' : 'loop-agent 카드 목록 읽기 실패 → 모름'] };
    }
    const cards = new Set(ids); const triggers = deps.triggerIds();
    const expected = [...CORE_WATCHERS, ...ids.map(id => `loop:${id}`)];
    const rows = watchRows(judgeWatchers(beats, ctx.now, deps.sourceHead), expected);
    const bad = rows.filter(r => r.status !== 'OK');
    restartable = new Map();
    for (const r of bad) {
      if (r.status !== 'DEAD' && r.status !== 'MISSING') continue;
      const argv = restartArgv(r.name, cards, triggers);
      if (argv) restartable.set(r.name, argv);
    }
    const subjects: Subject[] = bad.map(r => ({ id: r.name, kind: `watcher-${r.status.toLowerCase()}`,
      summary: `${r.status} · ${r.reason}${r.expected ? '' : ' · (카드 밖 · 24h 안에 살아 있었음)'}${restartable.has(r.name) ? ` · 재기동: eln ${restartable.get(r.name)!.join(' ')}` : r.status === 'DEAD' || r.status === 'MISSING' ? ' · 재기동 문 없음' : ' · 주인이 고칠 것'}`,
      ...(r.ageMin !== null ? { ageMin: r.ageMin } : {}) }));
    const count = (s: WatchStatus) => bad.filter(r => r.status === s).length;
    const facts = [
      `감시 대상 ${rows.length}(카드 ${ids.length} · 핵심 ${CORE_WATCHERS.length}) · 정상 ${rows.length - bad.length}`,
      `결손 ${bad.length}: MISSING ${count('MISSING')} · DEAD ${count('DEAD')} · BROKEN ${count('BROKEN')} · BLIND ${count('BLIND')}`,
      ...(triggers === null ? ['트리거 레지스트리 읽기 실패 → loop:·trigger-tick 만 재기동 가능'] : []),
    ];
    const patterns = bad.filter(r => r.status === 'DEAD').map(r => ({ key: `dead:${r.name}`,
      lesson: `${r.name} 가 일주일에 3번 DEAD 가 됐다 — 깨워도 다시 멈춘다. 재기동보다 그 루프의 트리거(조건·cron)나 몸의 예외를 주인이 먼저 본다.` }));
    return { kpi: bad.length, subjects, facts, patterns };
  };

  // Only an explicitly supervisor-verified, recalled lesson can narrow a restart. It cannot grant a right or name a new target.
  // Exact grammar avoids turning arbitrary natural-language memory or auto-promoted outcomes into executable policy.
  const plan: AgentBody['plan'] = (obs, ctx): PlannedAction[] => {
    const recalled = new Set(ctx.recall?.lessons ?? []);
    const held = new Map<string, string>();
    for (const lesson of fileAgentMemory(env.stateRoot, env.card.id, env.card.supervisor).lessons()) {
      if (!recalled.has(lesson.id) || lesson.status !== 'active' || lesson.decidedBy !== env.card.supervisor.toUpperCase()) continue;
      const match = /^watchers-check:hold-restart:(loop:[a-z][a-z0-9-]{0,62})$/u.exec(lesson.text);
      if (match) held.set(match[1]!, lesson.id);
    }
    const mem = fileAgentMemory(env.stateRoot, env.card.id, env.card.supervisor);
    for (const s of obs.subjects) {
      const lesson = held.get(s.id);
      if (lesson && restartable.has(s.id)) mem.appendCase({ at: ctx.now.toISOString(), kind: 'lesson-hold', subject: s.id, why: `restart held by verified lesson ${lesson}`, decidedBy: env.card.address, supervisedBy: env.card.supervisor, extra: { lesson, level: ctx.level } });
    }
    return obs.subjects.filter(s => restartable.has(s.id) && !held.has(s.id))
      .map(s => ({ action: 'restart', target: s.id, why: s.summary.slice(0, 120) }));
  };

  const actions: AgentBody['actions'] = {
    restart: {
      describe: '죽었거나(DEAD) heartbeat 가 한 번도 없는(MISSING) 감독자의 트리거를 한 번 쏜다(eln loop agent <id> tick · eln loop trigger tick --only <id>) — 되돌릴 것 없음(깨움)',
      run(target): ActionResult {
        const argv = restartable.get(target);
        if (!argv) return { ok: false, line: `${target}: 방금 관측에서 DEAD/MISSING 이고 재기동 문이 있는 감독자가 아니다` };
        const r = deps.fire(argv);
        return { ok: r.ok, line: `${target}: ${r.line}`, ref: `beat:${target}`, ...(r.ok ? { undo: '없음 — 트리거를 한 번 쏜 것뿐(상태 변화 없음) · 다음 beat 로 확인' } : {}) };
      },
    },
  };
  return { observe, plan, actions };
}

// ── live deps ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function liveDeps(stateRoot: string): WatchersCheckDeps {
  return {
    beats: () => {
      try { const hb = require('../../kit/heartbeat/index.js') as typeof import('../../kit/heartbeat/index.js'); return hb.readBeats(hb.beatLedgerPath(stateRoot)); }
      catch { return null; }
    },
    sourceHead: (source) => {
      try { return (require('../../cli/watch-cli.js') as typeof import('../../cli/watch-cli.js')).defaultSourceHead()(source); } catch { return null; }
    },
    cardIds: () => {
      try {
        const { cards, errors } = (require('../card.js') as typeof import('../card.js')).listCards();
        // a broken v2 card is still a supervisor we expect to beat — keep its directory name
        const broken = errors.flatMap(e => { const m = /loop-agents\/([a-z][a-z0-9-]{0,62})\/goal\.yaml/u.exec(e); return m ? [m[1]!] : []; });
        return [...new Set([...cards.map(c => c.id), ...broken])];
      } catch { return null; }
    },
    triggerIds: () => {
      try {
        const reg = require('../../loops/trigger-registry.js') as typeof import('../../loops/trigger-registry.js');
        const db = reg.openTriggerRegistry(stateRoot);
        try { return new Set(reg.listTriggers(db).map(r => r.graphId)); } finally { db.close(); }
      } catch { return null; }
    },
    fire: (argv) => {
      try {
        const { spawnElanous } = require('../../instance/spawn-elanous.js') as typeof import('../../instance/spawn-elanous.js');
        const child = spawnElanous(argv, { stateDir: stateRoot, detached: true, stdio: 'ignore' });
        child.unref();
        return child.pid ? { ok: true, line: `fired eln ${argv.join(' ')} (pid ${child.pid})` } : { ok: false, line: `eln ${argv.join(' ')} 기동 실패(pid 없음)` };
      } catch (e) { return { ok: false, line: `eln ${argv.join(' ')} 기동 실패 — ${e instanceof Error ? e.message : String(e)}` }; }
    },
  };
}
