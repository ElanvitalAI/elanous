// WORLD-REGISTRY control — OP / the guardian set an actor's state through the ledger where a control path exists
// (CEO 11-27 «자원에 대한 통제력이 없다»). Audited (one `world-control` line per act, applied · refused · failed),
// reversible (every applied act names its undo), and never a delete (retire=never).
//   loop     pause  → `eln loop trigger demote <id> --yes` (live → shadow, legacy path first) · resume → `eln loop trigger promote <id>`
//            demote → `eln loop demote <id> --to L1|shadow|off` (loop agents: judge-butler · guardian …)
//   launchd  pause  → `launchctl bootout gui/<uid>/<label>` · resume → `launchctl bootstrap gui/<uid> <plist>` — elanous-owned labels only
//   cron     pause  → `elanous schedule disable <id>` · resume → `elanous schedule enable <id>` (the schedule CRUD comments the line)
//   anything else → refused «no control path» (the row still says who owns it).
// Remote hosts run the same command over `ssh <host>` (login shell, so the host's installed `elanous` is on PATH).
import { spawnSync } from 'node:child_process';
import type { WorldActorEvent, WorldControlAction, WorldControlEvent } from './world-ledger-events.js';
import type { DeclaredState, WorldActor } from './world-types.js';

/** Who may control any actor: the guardian (write owner), its L0 RES, OP, the Claude OP coach and the CEO. */
export const WORLD_CONTROLLERS = ['loop:guardian', 'guardian', 'RES', 'OP', 'CLAUDE-OP', 'CEO'] as const;
/** launchd labels elanous owns — the only ones the ledger may boot out/in. */
export const ELANOUS_LABEL = /^(?:com|ai|dev)\.elanous\.[A-Za-z0-9._-]+$/u;
export const LOOP_DEMOTE_LEVELS = ['L1', 'shadow', 'off'] as const;

export function mayControl(by: string, actor: Pick<WorldActor, 'owner'>): boolean {
  const who = by.trim().toUpperCase();
  if ((WORLD_CONTROLLERS as readonly string[]).some(c => c.toUpperCase() === who)) return true;
  return !!actor.owner && actor.owner.toUpperCase() === who;
}

export interface ControlPlan { readonly ok: true; readonly argv: string[]; readonly host: string | null; readonly declaredState: DeclaredState; readonly undo: string }
export interface ControlRefusal { readonly ok: false; readonly why: string }

const labelOf = (id: string) => /^launchd:(.+)@[^@]+$/u.exec(id)?.[1] ?? null;
const cronIdOf = (id: string) => /^cron:([0-9a-f]{12})@[^@]+$/u.exec(id)?.[1] ?? null;
const loopIdOf = (id: string) => /^loop:([A-Za-z0-9][\w.-]{0,127})$/u.exec(id)?.[1] ?? null;

/** Pure: the command that carries out `action` on `actor` — or why there is none. `localHost` decides local vs ssh. */
export function planControl(actor: WorldActor, action: WorldControlAction, opts: { to?: string; localHost: string; uid: number; by: string }): ControlPlan | ControlRefusal {
  const host = actor.host && actor.host !== opts.localHost ? actor.host : null;
  if (actor.kind === 'loop') {
    const id = loopIdOf(actor.id);
    if (!id) return { ok: false, why: `not a loop id: ${actor.id}` };
    if (action === 'pause') return { ok: true, argv: ['elanous', 'loop', 'trigger', 'demote', id, '--yes'], host: null, declaredState: 'shadow', undo: `eln world control ${actor.id} resume` };
    if (action === 'resume') return { ok: true, argv: ['elanous', 'loop', 'trigger', 'promote', id, '--reason', 'world control resume'], host: null, declaredState: 'live', undo: `eln world control ${actor.id} pause` };
    const to = opts.to ?? 'L1';
    if (!(LOOP_DEMOTE_LEVELS as readonly string[]).includes(to)) return { ok: false, why: `--to must be ${LOOP_DEMOTE_LEVELS.join(' · ')}` };
    return { ok: true, argv: ['elanous', 'loop', 'demote', id, '--to', to, '--by', opts.by, '--reason', 'world control demote'], host: null,
      declaredState: to === 'off' ? 'off' : 'shadow', undo: `eln loop promote ${id}` };
  }
  if (actor.kind === 'launchd') {
    const label = labelOf(actor.id);
    if (!label || !ELANOUS_LABEL.test(label)) return { ok: false, why: `launchd ${label ?? actor.id} is not elanous-owned — no control path` };
    if (action === 'demote') return { ok: false, why: 'launchd jobs pause/resume only' };
    if (action === 'pause') return { ok: true, argv: ['launchctl', 'bootout', `gui/${opts.uid}/${label}`], host, declaredState: 'off', undo: `eln world control ${actor.id} resume` };
    const plist = typeof actor.meta.plist === 'string' ? actor.meta.plist : null;
    if (!plist) return { ok: false, why: 'no plist path recorded for this job (seen loaded but no LaunchAgents file) — cannot bootstrap' };
    return { ok: true, argv: ['launchctl', 'bootstrap', `gui/${opts.uid}`, plist], host, declaredState: 'live', undo: `eln world control ${actor.id} pause` };
  }
  if (actor.kind === 'cron') {
    const id = cronIdOf(actor.id);
    if (!id) return { ok: false, why: `not a cron id: ${actor.id}` };
    if (action === 'demote') return { ok: false, why: 'cron lines pause/resume only' };
    return { ok: true, argv: ['elanous', 'schedule', action === 'pause' ? 'disable' : 'enable', id, '--json'], host, declaredState: action === 'pause' ? 'off' : 'live',
      undo: `eln world control ${actor.id} ${action === 'pause' ? 'resume' : 'pause'}` };
  }
  return { ok: false, why: `${actor.kind} has no control path through the ledger (owner ${actor.owner ?? 'none'})` };
}

export interface RunResult { readonly ok: boolean; readonly output: string }
export type ControlRunner = (argv: readonly string[], host: string | null) => RunResult;

const shq = (s: string) => `'${s.replace(/'/gu, `'"'"'`)}'`;

export const defaultControlRunner: ControlRunner = (argv, host) => {
  const r = host
    ? spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', host, `$SHELL -lc ${shq(argv.map(shq).join(' '))}`], { encoding: 'utf8', timeout: 60_000 })
    : spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 60_000 });
  if (r.error) return { ok: false, output: r.error.message };
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 1500) };
};

export interface ControlOutcome { readonly lines: Array<WorldControlEvent | WorldActorEvent>; readonly result: WorldControlEvent['result']; readonly detail: string }

/** Decide and (when allowed) carry out one control act; returns the ledger lines to append (audit ⊕ the declaredState it caused). */
export function controlActor(actor: WorldActor | undefined, actorId: string, action: WorldControlAction,
  opts: { by: string; reason: string; to?: string; localHost: string; uid: number; now: Date; run?: ControlRunner }): ControlOutcome {
  const at = opts.now.toISOString();
  const audit = (result: WorldControlEvent['result'], detail: string, undo?: string): WorldControlEvent => ({
    event: 'world-control', at, by: opts.by, actorId, action, ...(opts.to ? { to: opts.to } : {}), reason: opts.reason, result, detail: detail.slice(0, 2000), ...(undo ? { undo } : {}) });
  if (!actor) { const d = `no actor ${actorId}`; return { lines: [audit('refused', d)], result: 'refused', detail: d }; }
  if (!mayControl(opts.by, actor)) { const d = `${opts.by} may not control ${actorId} (owner ${actor.owner ?? 'none'})`; return { lines: [audit('refused', d)], result: 'refused', detail: d }; }
  const plan = planControl(actor, action, opts);
  if (!plan.ok) return { lines: [audit('refused', plan.why)], result: 'refused', detail: plan.why };
  const r = (opts.run ?? defaultControlRunner)(plan.argv, plan.host);
  const cmd = `${plan.host ? `ssh ${plan.host} ` : ''}${plan.argv.join(' ')}`;
  if (!r.ok) { const d = `${cmd} → failed: ${r.output}`; return { lines: [audit('failed', d)], result: 'failed', detail: d }; }
  const d = `${cmd} → ok${r.output ? `: ${r.output.slice(0, 300)}` : ''}`;
  return {
    lines: [audit('applied', d, plan.undo), { event: 'world-actor', at, by: opts.by, actor: { id: actor.id, kind: actor.kind, mode: 'owner', declaredState: plan.declaredState } }],
    result: 'applied', detail: d,
  };
}
