// The outside clock of the trigger registry tick (LOOP-AGENTS-AS-PLUGINS P1 · 대표 11-28 15:3x «감독자들이 다 도는지»).
//
// S: every loop agent — the guardian, watchers-check and the supervisors they watch — is fired by ONE crontab entry,
//    `eln loop trigger tick` (*/2). The registry owns «a registered agent stopped → refire every window → retry the missed
//    goal → one exception card to the owner». Four copies of that ladder were removed in the same change.
// C: nothing inside the registry can notice the registry tick itself stopping (a crontab line lost on reinstall, a broken
//    bun path, cron not running after sleep): every watcher that could notice is fired by that very tick. (A tick that runs
//    but errors still beats — with `err` — and is watchers-check's BROKEN for its owner, not this clock's.)
// A: one outside clock on a process that already stays up — the nexus daemon (launchd KeepAlive) — riding the 5-minute
//    schedule catch-up sweep it already runs. Per sweep: the `trigger-tick` beat (written only by a full pass) older than
//    stale_after_min while the tick's schedule entry is enabled → run that entry's own command once per wake_every_min;
//    still stale card_after_min after it first went stale → ONE card to the owner per card_every_h; fresh again → forget.
//    Numbers: graphs/policies/trigger-clock.yaml. Hosts without the schedule entry are skipped (the clock never starts a
//    registry that was not installed there).
//
// 세 얼굴: 관측 = the beats ledger (trigger-tick) ⊕ the schedule registry row ⊕ `<stateRoot>/loops/trigger-clock/state.json` /
//          판단 근거 = graphs/policies/trigger-clock.yaml / 수복과 인계 = the entry's own command (same as cron runs) once per
//          window → one owner card when that does not bring it back · every reader fails open (no beat file = stale only
//          when the registry db exists).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { debug } from '../debug/log.js';

export interface TriggerClockPolicy { readonly staleAfterMin: number; readonly wakeEveryMin: number; readonly cardAfterMin: number; readonly cardEveryH: number; readonly owner: string }
export const triggerClockPolicyPath = (root = resolve(import.meta.dir, '../..')): string => join(root, 'graphs', 'policies', 'trigger-clock.yaml');

/** Pure: the pack text → policy. Throws on a missing / non-positive key (a malformed pack is never a silent default). */
export function parseTriggerClockPolicy(text: string): TriggerClockPolicy {
  const y = (parse(text) ?? {}) as { version?: unknown; clock?: Record<string, unknown> };
  if (y.version !== 1) throw new Error('trigger-clock policy: version must be 1');
  const num = (k: string): number => {
    const v = y.clock?.[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`trigger-clock policy: clock.${k} must be a positive number`);
    return v;
  };
  const owner = typeof y.clock?.owner === 'string' ? y.clock.owner.toUpperCase() : '';
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/u.test(owner)) throw new Error('trigger-clock policy: clock.owner must be a seat id');
  return { staleAfterMin: num('stale_after_min'), wakeEveryMin: num('wake_every_min'), cardAfterMin: num('card_after_min'), cardEveryH: num('card_every_h'), owner };
}

export interface TriggerClockState { readonly staleSince: string | null; readonly lastWakeAt: string | null; readonly lastCardAt: string | null }
const EMPTY: TriggerClockState = { staleSince: null, lastWakeAt: null, lastCardAt: null };

export interface TriggerClockPorts {
  readonly now: Date;
  /** the last full-pass `trigger-tick` beat · null = never beat · undefined = ledger unreadable */
  lastTickAt(): string | null | undefined;
  /** the tick's schedule entry is installed and enabled on this host (else the clock is not this host's) */
  installed(): boolean;
  /** the registry db exists (a never-beating tick on a fresh host is only stale when there is a registry to tick) */
  hasRegistry(): boolean;
  wake(): Promise<{ ok: boolean; line: string }>;
  card(owner: string, body: string): Promise<string | null>;
  readState(): TriggerClockState;
  writeState(s: TriggerClockState): void;
}
export type TriggerClockStatus = 'not-installed' | 'unknown' | 'ok' | 'recovered' | 'stale' | 'woke' | 'carded';
export interface TriggerClockResult { readonly status: TriggerClockStatus; readonly line: string; readonly woke: boolean; readonly carded: string | null }

// 출처: one minute in ms (a time unit, not a tuning bound)
const MIN = 60_000;

/** One sweep. Never throws (a failing port is a line, not a crash of the nexus timer). */
export async function runTriggerClock(policy: TriggerClockPolicy, p: TriggerClockPorts): Promise<TriggerClockResult> {
  const out = (status: TriggerClockStatus, line: string, woke = false, carded: string | null = null): TriggerClockResult => ({ status, line, woke, carded });
  try {
    if (!p.installed()) return out('not-installed', 'trigger tick schedule entry not installed on this host');
    const last = p.lastTickAt();
    if (last === undefined) return out('unknown', 'beats ledger unreadable');
    if (last === null && !p.hasRegistry()) return out('ok', 'no registry yet');
    const nowMs = p.now.getTime(); const at = p.now.toISOString();
    const ageMin = last === null ? Infinity : (nowMs - Date.parse(last)) / MIN;
    const st = p.readState();
    if (ageMin < policy.staleAfterMin) {
      if (st.staleSince) { p.writeState(EMPTY); return out('recovered', `trigger-tick beat ${Math.round(ageMin)}m ago · stale since ${st.staleSince} recovered`); }
      return out('ok', `trigger-tick beat ${Math.round(ageMin)}m ago`);
    }
    const staleSince = st.staleSince ?? at;
    const ago = last === null ? 'never beat' : `last beat ${Math.round(ageMin)}m ago`;
    let next: TriggerClockState = { ...st, staleSince };
    let woke = false; let line = `trigger-tick ${ago}`;
    if (!st.lastWakeAt || nowMs - Date.parse(st.lastWakeAt) >= policy.wakeEveryMin * MIN) {
      next = { ...next, lastWakeAt: at };
      p.writeState(next); // the mark first: a wake that hangs is not repeated by the next sweep inside the window
      const w = await p.wake();
      woke = w.ok; line += ` · ran the schedule entry once (${w.line})`;
    }
    let carded: string | null = null;
    if (nowMs - Date.parse(staleSince) >= policy.cardAfterMin * MIN && (!st.lastCardAt || nowMs - Date.parse(st.lastCardAt) >= policy.cardEveryH * 60 * MIN)) {
      carded = await p.card(policy.owner, `[trigger-clock · 레지스트리 틱 멈춤] eln loop trigger tick: ${ago} (stale since ${staleSince}). 바깥 시계(nexus)가 스케줄 항목을 ${policy.wakeEveryMin}분마다 한 번씩 돌렸지만 돌아오지 않는다 — 모든 루프 에이전트(수호자·감독자)가 이 틱으로 돈다. 확인: crontab 의 elanous-loop=graph-trigger-tick 줄 · eln loop trigger tick --json 오류 · bun 경로.`);
      if (carded !== null) { next = { ...next, lastCardAt: at }; line += ` · card ${carded}`; }
    }
    p.writeState(next);
    return out(carded ? 'carded' : woke ? 'woke' : 'stale', line, woke, carded);
  } catch (e) {
    return out('unknown', `trigger-clock failed — ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
  }
}

// ── live ports (the nexus sweep) ─────────────────────────────────────────────────────────────────────────────────────
export const triggerClockStatePath = (stateRoot: string): string => join(stateRoot, 'loops', 'trigger-clock', 'state.json');

/** The nexus 5-min sweep calls this (src/nexus/index.ts · next to the schedule catch-up). Fail-open. */
export async function sweepTriggerClock(o: { stateRoot: string; schedules: ReadonlyArray<{ enabled: number | boolean; command: string | null; raw: string | null }>;
  spawn(command: string): Promise<{ code: number; error?: string }>; now?: Date }): Promise<TriggerClockResult> {
  const { TRIGGER_TICK_MARKER } = await import('./trigger-cli.js');
  const entry = o.schedules.find(j => !!j.enabled && `${j.command ?? ''} ${j.raw ?? ''}`.includes(TRIGGER_TICK_MARKER)) ?? null;
  let policy: TriggerClockPolicy;
  try { policy = parseTriggerClockPolicy(readFileSync(triggerClockPolicyPath(), 'utf8')); }
  catch (e) { return { status: 'unknown', line: `trigger-clock policy unreadable — ${e instanceof Error ? e.message : String(e)}`, woke: false, carded: null }; }
  const statePath = triggerClockStatePath(o.stateRoot);
  const r = await runTriggerClock(policy, {
    now: o.now ?? new Date(),
    installed: () => entry !== null,
    hasRegistry: () => existsSync(join(o.stateRoot, 'graph-trigger-registry.db')),
    lastTickAt: () => {
      try {
        const hb = require('../kit/heartbeat/index.js') as typeof import('../kit/heartbeat/index.js');
        const beats = hb.readBeats(hb.beatLedgerPath(o.stateRoot)).filter(b => b.name === 'trigger-tick' && b.kind !== 'loop-signal');
        return beats.length ? beats[beats.length - 1]!.at : null;
      } catch { return undefined; }
    },
    wake: async () => {
      const command = (entry!.command ?? '').includes(TRIGGER_TICK_MARKER) ? entry!.command! : (entry!.raw ?? '').replace(/^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+/u, '');
      const r = await o.spawn(command);
      return { ok: r.code === 0, line: `rc=${r.code}${r.error ? ` ${r.error.slice(0, 80)}` : ''}` };
    },
    card: async (owner, body) => {
      try {
        const { openMsgStore } = await import('../msg/msg-store.js');
        const store = openMsgStore(join(o.stateRoot, 'msg', 'messages.db'));
        try { return `msg#${store.post({ from: 'trigger-clock', to: owner, kind: 'request', body } as Parameters<typeof store.post>[0]).id}`; } finally { store.close(); }
      } catch { return null; }
    },
    readState: () => { try { const j = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<TriggerClockState>; return { ...EMPTY, ...j }; } catch { return EMPTY; } },
    writeState: (s) => { try { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(`${statePath}.${process.pid}.tmp`, JSON.stringify(s)); renameSync(`${statePath}.${process.pid}.tmp`, statePath); } catch { /* fail-open: the next sweep re-derives */ } },
  });
  if (r.status !== 'ok' && r.status !== 'not-installed') debug.log('loops.trigger-clock', r.status, { line: r.line, woke: r.woke, carded: r.carded });
  return r;
}
