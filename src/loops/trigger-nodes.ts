/**
 * Command nodes for trigger-registry graphs (graphs/triggers/*.yaml). Run by the graph runner as `cmd:` recipes;
 * the run input (window · stage · attempt · vars) and the node input come from $ELANOUS_GRAPH_CONTEXT.
 *
 *   wake        — post one wake request to a seat. Stage `shadow` (or a manual run without a trigger window)
 *                 writes a shadow receipt instead and posts nothing, so shadow runs alongside the legacy path
 *                 without a duplicate effect.
 *   retro-draft — (input `every: hour` = once per clock hour, the op-pulse node) the measured half of a seat retro, done by the graph itself (11-25 OP retro loss: three wake paths
 *                 — watchdog self-mail, CLAUDE-OP mail, this graph's old `wake` — all relied on OP choosing to write the
 *                 file, and the wake path folded or capped them away). Runs the declared measure commands, appends one
 *                 draft section (once per window) to the retro file, then — live only — appends ONE `retro-turn` entry
 *                 the seat's TUI opens as an internal turn (origin retro · not a wake, so no cap/fold) asking only for
 *                 «원인 가설 1줄 + 다음 손잡이 1줄» under the draft. Shadow writes the draft and a receipt of the turn.
 *   bulletin-write — the federal bulletin's facts written by the graph (bulletin-write.ts · BULLETIN-NOW-STALE 11-26):
 *                 BULLETIN-NOW.md rewritten (old one → BULLETIN-LOG) · kind-bulletin mail to every coordinator · ONE
 *                 internal OP turn (retro-turn ledger) for the two judgement lines.
 *   watchers-check — judge every watcher heartbeat (src/kit/heartbeat/index.ts); stage `live` posts one deduped card to
 *                 CLAUDE-OP, other stages judge only.
 *   idle-probe  — decide idle/busy for a seat from the newest mtime of its activity files and append one
 *                 triage ledger line for the window (the idle-triage goal predicate reads that line).
 *
 *   pulse-measure — OP-PULSE measure step (no LLM): phase → rhythm → measure → gaps → forecast → burst entry; writes
 *                 the pulse table/state/ledger and routes `turn` (OP must act) or `green` (heartbeat line only, no turn).
 *   pulse-turn  — deliver the pulse brief as ONE origin-`pulse` internal OP turn via the pulse inbox (live) or a shadow
 *                 receipt (shadow). Not a mail and not a wake — the wake cap never coalesces it.
 *
 * Each prints one JSON line `{ outcome, ... }` the runner routes on.
 */
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnElanousSync } from '../instance/spawn-elanous.js';
import { appendDiverted, type DivertedEntry } from '../msg/diverted-mail.js';
import { expandTemplate, type TriggerRunInput } from './trigger-registry.js';
import { fedStatePath, readFacts } from '../fed-state/ledger.js';
import { classifyTurns, turnOutcomeLines } from './op-turn-outcome.js';
import { enforcePaths, enforceRetroLines } from './op-turn-enforce.js';

interface NodeContext { graphId?: string; runId?: string; input?: Partial<TriggerRunInput>; nodeInput?: Record<string, unknown> }

function readContext(): NodeContext {
  const path = process.env.ELANOUS_GRAPH_CONTEXT;
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as NodeContext;
}

function emit(value: Record<string, unknown>): void { console.log(JSON.stringify(value)); }

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`node input ${name} must be a non-empty string`);
  return value;
}

function vars(input: Partial<TriggerRunInput>): TriggerRunInput['vars'] {
  const stateRoot = input.vars?.stateRoot ?? process.env.ELANOUS_STATE_DIR ?? effectiveInstanceRoot(); // never process.cwd() (#40570 class)
  return { stateRoot, seatState: input.vars?.seatState ?? join(process.env.HOME ?? '', 'elanous-hq', 'seat-state') };
}

export function wake(ctx: NodeContext, deps: { post?: (args: string[]) => { status: number | null; stdout: string; stderr: string } } = {}): Record<string, unknown> {
  const input = ctx.input ?? {};
  const node = ctx.nodeInput ?? {};
  const to = str(node.to, 'to'); const from = str(node.from, 'from'); const kind = typeof node.kind === 'string' ? node.kind : 'request';
  const window = input.window ?? 'manual';
  const why = input.reason ? ` · why: ${input.reason.slice(0, 400)}` : '';
  const body = `${str(node.body, 'body')} [graph ${ctx.graphId ?? '?'} · window ${window} · run ${ctx.runId ?? '?'}${why}]`;
  if (input.stage !== 'live') {
    const dir = input.shadowDir ?? join(vars(input).stateRoot, 'loops', 'shadow', ctx.graphId ?? 'unknown');
    mkdirSync(dir, { recursive: true });
    const receipt = join(dir, `${window.replace(/[^\w.-]/g, '_')}.json`);
    writeFileSync(receipt, `${JSON.stringify({ wouldPost: { from, to, kind, body }, runId: ctx.runId, attempt: input.attempt ?? null, at: new Date().toISOString() })}\n`);
    return { outcome: 'ok', shadow: true, receipt };
  }
  const args = ['msg', 'post', '--from', from, '--to', to, '--kind', kind, '--body', body];
  // spawnElanousSync stamps the child with this run's universe (ELANOUS_STATE_DIR pinned by the runner).
  const result = deps.post ? deps.post(args)
    : (() => { const r = spawnElanousSync(args, { encoding: 'utf8' });
      return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }; })();
  if (result.status !== 0) return { outcome: 'fail', error: `msg post exit ${result.status}: ${result.stderr.trim().slice(0, 300)}` };
  return { outcome: 'ok', shadow: false, posted: { from, to, kind }, stdout: result.stdout.trim().slice(0, 200) };
}

export interface RetroMeasure { label: string; cmd: string[] }
type RunMeasure = (cmd: string[], timeoutMs: number) => { status: number | null; stdout: string; stderr: string };

const RETRO_MEASURE_TIMEOUT_MS = 150_000;
const RETRO_MEASURE_MAX_LINES = 12;
const RETRO_HYPOTHESIS = '- 원인 가설:';
const RETRO_KNOB = '- 다음 손잡이:';

function measures(value: unknown): RetroMeasure[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((m) => {
    const v = m as Partial<RetroMeasure> | null;
    return v && typeof v.label === 'string' && Array.isArray(v.cmd) && v.cmd.length > 0 && v.cmd.every((c) => typeof c === 'string')
      ? [{ label: v.label, cmd: v.cmd as string[] }] : [];
  });
}

const defaultRun: RunMeasure = (cmd, timeoutMs) => {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? r.error?.message ?? '') };
};

/** The retro-turn prompt: two lines only, under the draft this window wrote. */
export function retroTurnPrompt(file: string, marker: string): string {
  return [
    `[retro · graph] 실측 초안을 ${file} 에 덧붙였다(${marker}).`,
    `그 초안 맨 아래 «${RETRO_HYPOTHESIS}» 와 «${RETRO_KNOB}» 두 줄의 빈칸만 채워라(각 1줄 · 실측 숫자를 근거로).`,
    '다른 일은 이 턴에서 하지 않는다 — 파일을 고친 뒤 원래 일로 돌아간다.',
  ].join('\n');
}

/**
 * OP-NEXT-BEST-ACTION 3/3 — turn-end outcome lines for the retro draft (node input `turn_outcome: true`): the last hour of
 * the seat's turns from the fed-state ledger under the run's state root; request-only turns are flagged. Fail-open.
 */
export function retroTurnOutcome(seat: string, stateRoot: string, now: Date): string[] {
  try {
    const since = new Date(now.getTime() - 3_600_000);
    const { facts } = readFacts({ since, until: now, path: fedStatePath(stateRoot) });
    return [...turnOutcomeLines(classifyTurns(facts, { seat, since, until: now })), ...enforceRetroLines(enforcePaths(stateRoot).ledger, since, now)];
  } catch (error) {
    return [`- 턴 결과: (측정 실패 · ${(error instanceof Error ? error.message : String(error)).slice(0, 120)})`];
  }
}

/** The local clock hour a retro belongs to, «2026-11-26T19» (the retro file is per local date). */
export function retroHourKey(now: Date, timeZone?: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) })
    .formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

export function retroDraft(ctx: NodeContext, deps: { run?: RunMeasure; now?: () => Date; enqueueTurn?: (entry: DivertedEntry) => void } = {}): Record<string, unknown> {
  const input = ctx.input ?? {};
  const node = ctx.nodeInput ?? {};
  const seat = str(node.seat, 'seat');
  const v = vars(input);
  const now = (deps.now ?? (() => new Date()))();
  const window = input.window ?? now.toISOString();
  const file = expandTemplate(str(node.file, 'file'), v, window);
  const run = deps.run ?? defaultRun;
  // `every: hour` (op-pulse absorbed op-retro · LOOP-AUDIT-APPLY 11-26): the pulse fires every 15–90 min, the retro stays
  // once per clock hour — the first pulse of the hour drafts it, later ones in that hour skip.
  const hourly = node.every === 'hour';
  const marker = hourly ? `op-retro hour=${retroHourKey(now)}` : `op-retro window=${window}`;
  if (existsSync(file) && readFileSync(file, 'utf8').includes(`<!-- ${marker} -->`)) {
    return { outcome: 'ok', drafted: false, file, why: hourly ? 'draft for this hour already in the file' : 'draft for this window already in the file' };
  }
  const lines: string[] = [];
  for (const m of measures(node.measures)) {
    let out: ReturnType<RunMeasure>;
    try { out = run(m.cmd.map((arg) => expandTemplate(arg, v, window)), RETRO_MEASURE_TIMEOUT_MS); }
    catch (error) { out = { status: null, stdout: '', stderr: error instanceof Error ? error.message : String(error) }; }
    const text = out.stdout.trim().split('\n').filter((l) => l.trim()).slice(0, RETRO_MEASURE_MAX_LINES);
    if (out.status === 0 && text.length) lines.push(`- ${m.label}: ${text[0]}`, ...text.slice(1).map((l) => `  ${l}`));
    else lines.push(`- ${m.label}: (측정 실패 · exit ${out.status ?? 'none'} · ${out.stderr.trim().split('\n')[0]?.slice(0, 160) ?? ''})`);
  }
  if (node.turn_outcome === true) lines.push(...retroTurnOutcome(seat, v.stateRoot, now));
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const section = [
    '', `## ${clock} 매시 회고 초안 (graph ${ctx.graphId ?? '?'} · ${input.stage ?? 'manual'})`, `<!-- ${marker} -->`,
    '### 실측 (그래프가 잰 것)', ...(lines.length ? lines : ['- (측정 명령이 선언되지 않음)']),
    '### OP 판단 (OP 가 한 줄씩)', `${RETRO_HYPOTHESIS} `, `${RETRO_KNOB} `, '',
  ].join('\n');
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, section);
  const entry: DivertedEntry = { seat, from: `graph:${ctx.graphId ?? 'retro'}`, kind: 'retro', body: retroTurnPrompt(file, marker), at: now.toISOString(), refs: [window] };
  if (input.stage !== 'live') {
    const dir = input.shadowDir ?? join(v.stateRoot, 'loops', 'shadow', ctx.graphId ?? 'unknown');
    mkdirSync(dir, { recursive: true });
    const receipt = join(dir, `${window.replace(/[^\w.-]/g, '_')}.json`);
    writeFileSync(receipt, `${JSON.stringify({ drafted: file, wouldOpenTurn: entry, runId: ctx.runId, attempt: input.attempt ?? null, at: now.toISOString() })}\n`);
    return { outcome: 'ok', drafted: true, file, shadow: true, receipt };
  }
  try { (deps.enqueueTurn ?? ((e) => appendDiverted('retro-turn', e)))(entry); }
  catch (error) { return { outcome: 'fail', drafted: true, file, error: `retro-turn enqueue failed: ${error instanceof Error ? error.message : String(error)}` }; }
  return { outcome: 'ok', drafted: true, file, shadow: false, turn: 'retro-turn queued' };
}

export function idleProbe(ctx: NodeContext, now = new Date()): Record<string, unknown> {
  const input = ctx.input ?? {};
  const node = ctx.nodeInput ?? {};
  const seat = str(node.seat, 'seat');
  const v = vars(input);
  const window = input.window ?? now.toISOString();
  const idleMin = typeof node.idle_min === 'number' ? node.idle_min : 30;
  const paths = (Array.isArray(node.activity) ? node.activity : []).map(p => expandTemplate(str(p, 'activity[]'), v, window));
  const mtimes = paths.filter(p => existsSync(p)).map(p => statSync(p).mtimeMs);
  const latest = mtimes.length ? Math.max(...mtimes) : null;
  // A condition fire already measured idleness (its evidence is the reason); the activity check is the cron/manual path.
  const conditionFire = typeof input.reason === 'string' && input.reason.startsWith('condition:');
  const idle = conditionFire || latest === null || now.getTime() - latest >= idleMin * 60_000;
  const ledger = expandTemplate(typeof node.ledger === 'string' ? node.ledger : '{stateRoot}/loops/idle-triage.jsonl', v, window);
  mkdirSync(dirname(ledger), { recursive: true });
  const verdict = idle ? 'idle' : 'busy';
  appendFileSync(ledger, `${JSON.stringify({ window, seat, verdict, latestActivity: latest === null ? null : new Date(latest).toISOString(),
    idleMin, stage: input.stage ?? 'manual', reason: input.reason ?? null, runId: ctx.runId ?? null, at: now.toISOString() })}\n`);
  return { outcome: verdict, seat, latestActivity: latest === null ? null : new Date(latest).toISOString(), ledger };
}

function rhythmPathOf(node: Record<string, unknown>): string {
  const raw = typeof node.rhythm === 'string' ? node.rhythm : 'op-pulse.rhythm.yaml';
  return raw.startsWith('/') ? raw : join(process.env.ELANOUS_GRAPH_DIR ?? join(import.meta.dir, '../../graphs/triggers'), raw);
}

export async function pulseMeasure(ctx: NodeContext, probes?: import('./op-pulse-run.js').PulseProbes): Promise<Record<string, unknown>> {
  const input = ctx.input ?? {}; const v = vars(input);
  const { runPulse } = await import('./op-pulse-run.js');
  const p = probes ?? (await import('./op-pulse-live.js')).livePulseProbesWithPlanner({ stateRoot: v.stateRoot, seatState: v.seatState });
  const result = await runPulse(p, { rhythmPath: rhythmPathOf(ctx.nodeInput ?? {}), seatState: v.seatState, stateRoot: v.stateRoot, window: input.window ?? 'manual', stage: input.stage ?? 'manual' });
  if (result.brief) {
    const dir = join(v.stateRoot, 'loops', 'op-pulse-briefs'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${(input.window ?? 'manual').replace(/[^\w.-]/g, '_')}.md`), result.brief);
  }
  // COACH-CONTEXT-AUTO-INJECT — a live pulse regenerates WORLD-NOW.md from facts (fail-open · the coach cursor is not moved).
  let world: string | null = null;
  if ((input.stage ?? 'manual') === 'live') {
    try {
      const w = await import('../op-world/op-world.js');
      const now = new Date(); const path = w.worldNowPath(v.seatState, 'OP');
      // OP-WORLD-LENS — refresh the world card cache first so WORLD-NOW.md and the next OP turn read this pulse's numbers.
      try { await (await import('../op-world/world-lens.js')).freshLensLines('OP', now); } catch { /* card stays cached */ }
      w.writeWorldNow(path, w.renderWorldBlock(w.collectWorldFacts({ now, seat: 'OP' }), now), now); world = path;
    } catch { world = null; }
  }
  return { outcome: result.outcome, phase: result.phase.phase, gaps: result.gaps.length, entry: result.entry?.trigger ?? null, table: result.tablePath, world };
}

export async function pulseTurn(ctx: NodeContext, now = new Date()): Promise<Record<string, unknown>> {
  const input = ctx.input ?? {}; const v = vars(input);
  const window = input.window ?? 'manual';
  const briefPath = join(v.stateRoot, 'loops', 'op-pulse-briefs', `${window.replace(/[^\w.-]/g, '_')}.md`);
  if (!existsSync(briefPath)) return { outcome: 'fail', error: `no pulse brief for window ${window}` };
  const { deliverPulseTurn } = await import('./op-pulse-run.js');
  const out = deliverPulseTurn({ rhythmPath: '', seatState: v.seatState, stateRoot: v.stateRoot, window, stage: input.stage ?? 'manual', brief: readFileSync(briefPath, 'utf8'),
    runId: ctx.runId ?? '?', now, shadowDir: input.shadowDir ?? join(v.stateRoot, 'loops', 'shadow', ctx.graphId ?? 'op-pulse') });
  return { outcome: 'ok', ...out };
}

export async function watchersCheck(ctx: NodeContext): Promise<Record<string, unknown>> {
  const { runWatchCheck } = await import('../cli/watch-cli.js');
  const r = runWatchCheck({}, { post: ctx.input?.stage === 'live' });
  return { outcome: r.error ? 'fail' : 'ok', bad: r.verdicts.filter(v => v.status !== 'OK').map(v => `${v.status} ${v.name}`), carded: r.posted,
    ...(r.error ? { error: r.error } : {}) };
}

if (import.meta.main) {
  const command = process.argv[2];
  try {
    const ctx = readContext();
    if (command === 'wake') emit(wake(ctx));
    else if (command === 'idle-probe') emit(idleProbe(ctx));
    else if (command === 'pulse-measure') emit(await pulseMeasure(ctx));
    else if (command === 'pulse-turn') emit(await pulseTurn(ctx));
    else if (command === 'retro-draft') emit(retroDraft(ctx));
    else if (command === 'bulletin-write') emit(await (await import('./bulletin-write.js')).bulletinWrite(ctx));
    else if (command === 'watchers-check') emit(await watchersCheck(ctx));
    else { emit({ outcome: 'error', error: `unknown trigger node: ${command}` }); process.exitCode = 2; }
  } catch (error) {
    emit({ outcome: 'error', error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}
