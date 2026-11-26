// GOAL-ORCHESTRATION-NL — the runner: drives a normalized orchestration/v1 spec until its success criterion holds
// (or rounds/budget/stop end it). Backend-agnostic: els tabs, headless children or the sim world all implement
// WorkerBackend. Every state change goes to the stage feed (els tile --stage reads it). Safety lives here:
// spawn cap, parallel cap, budget check BEFORE each launch, stop closes every worker.
import type { LlmText } from './planner.js';
import { goalLanguage, type VoiceResult } from './voice.js';
import { HARD_CAPS, type OrchestrationSpec, type WorkerKind, type WorkerSpec } from './spec.js';
import { sourcesSection, withoutSources, type DeskResult } from './sources.js';

export interface WorkerJob { readonly id: string; readonly worker: WorkerSpec; readonly prompt: string; readonly title: string; readonly round: number }
export interface WorkerOutcome {
  readonly jobId: string; readonly workerId: string; readonly kind: WorkerKind; readonly ok: boolean; readonly text: string;
  readonly durationMs: number; readonly costUsd: number; readonly pane?: string; readonly error?: string;
  /** DEMO-SOURCES-VIA-SECRET: the data desk this worker fetched (source records, or «unavailable»). */
  readonly source?: DeskResult;
}
export interface WorkerBackend {
  readonly name: 'els' | 'headless' | 'sim';
  /** Is this worker kind runnable here (CLI installed)? */
  available(kind: WorkerKind): Promise<boolean>;
  run(job: WorkerJob, signal: AbortSignal): Promise<WorkerOutcome>;
  /** Close every tab/child this backend opened (stop · Ctrl-C · end of run when asked). */
  closeAll(): Promise<void>;
  /** Final publish node: run a local command in its own tab with the result in $ORCH_RESULT_FILE. */
  runCommand?(job: { readonly id: string; readonly title: string }, command: string, result: string, signal: AbortSignal, extraEnv?: Readonly<Record<string, string>>): Promise<{ readonly ok: boolean; readonly text: string }>;
}
export type ControlCommand = { readonly op: 'stop' } | { readonly op: 'add-workers'; readonly count: number; readonly kind?: WorkerKind } | { readonly op: 'spotlight'; readonly target: string };
export type FeedEvent = Record<string, unknown>;
export interface RunDeps {
  readonly backend: WorkerBackend;
  readonly llm?: LlmText;
  readonly feed?: (event: FeedEvent) => void;
  /** Drained between launches and while waiting: commands the person gave since the last call. */
  readonly control?: () => readonly ControlCommand[];
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** The voice node (spec.voice): the result → one mp3 next to the receipt. Never throws; skipped when absent. */
  readonly voice?: (result: string, signal: AbortSignal) => Promise<VoiceResult>;
}
export type RunStatus = 'met' | 'not-met' | 'stopped' | 'budget' | 'failed';
export interface RoundReport { readonly round: number; readonly result: string; readonly met: boolean; readonly why: string; readonly outcomes: readonly WorkerOutcome[] }
export interface RunReport {
  readonly status: RunStatus; readonly goal: string; readonly pattern: string; readonly result: string; readonly why: string;
  readonly rounds: readonly RoundReport[]; readonly costUsd: number; readonly workers: readonly WorkerSpec[]; readonly notes: readonly string[];
}

/** Estimated cost per worker call (USD, planning number — subscription CLIs are flat-rate, this keeps the cap honest). */
export const EST_COST_USD: Record<WorkerKind, number> = { eln: 0.01, codex: 0.03, claude: 0.03 };
export const tabTitle = (job: { worker: WorkerSpec; round: number }): string => `ORCH·${job.worker.id}${job.round > 1 ? `·r${job.round}` : ''}`;

class StopSignal extends Error {}

export async function runOrchestration(spec: OrchestrationSpec, deps: RunDeps): Promise<RunReport> {
  const now = deps.now ?? Date.now;
  const started = now();
  const log = deps.log ?? (() => undefined);
  const notes: string[] = [];
  const abort = new AbortController();
  let stopped = false;
  let budgetHit = false;
  let spent = 0;
  let calls = 0;
  let spotlight: string | undefined;
  const added: WorkerSpec[] = [];
  /** Set by the running pattern: how a worker added mid-round gets a job in this round (panel · map-reduce). */
  const extra: { job?: (w: WorkerSpec) => WorkerJob | undefined } = {};
  const workers: WorkerSpec[] = [];
  // Preflight: a worker whose CLI is missing is swapped for eln (noted) — never a silent drop.
  for (const w of spec.workers) {
    if (await deps.backend.available(w.kind)) { workers.push(w); continue; }
    const swapped: WorkerSpec = { ...w, id: `${w.id}-eln`, kind: 'eln' };
    delete (swapped as { model?: string }).model;
    notes.push(`${w.kind} CLI not found: ${w.id} runs on eln instead`);
    workers.push(swapped);
  }
  const nodes = ['plan', 'spawn', 'work', 'reduce', 'check', ...(spec.voice ? ['voice'] : []), ...(spec.publish ? ['publish'] : []), 'done'];
  const emit = (phase: string, extra: FeedEvent = {}): void => {
    deps.feed?.({ phase, nodes, counters: { agents: workers.length, models: new Set(workers.map((w) => w.kind)).size, toolCalls: calls, elapsedMs: now() - started }, ...(spotlight ? { spotlightPane: spotlight, spotlightMs: 8_000 } : {}), ...extra });
  };
  const drain = (): void => {
    for (const cmd of deps.control?.() ?? []) {
      if (cmd.op === 'stop') { if (!stopped) { stopped = true; notes.push('stopped by the user'); abort.abort(); } }
      else if (cmd.op === 'spotlight') { spotlight = cmd.target; emit('work', { spotlightCaption: `spotlight · ${cmd.target}` }); }
      else if (cmd.op === 'add-workers') {
        const room = HARD_CAPS.workers - workers.length;
        const n = Math.max(0, Math.min(cmd.count, room));
        if (n < cmd.count) notes.push(`add-workers: capped at ${HARD_CAPS.workers} workers (${cmd.count - n} refused)`);
        for (let i = 0; i < n; i++) { const w: WorkerSpec = { id: `extra-${workers.length + 1}`, kind: cmd.kind ?? 'eln', role: workers[0]?.role ?? 'worker' }; workers.push(w); added.push(w); }
        if (n > 0) { notes.push(`added ${n} ${cmd.kind ?? 'eln'} worker(s)`); emit('spawn'); }
      }
    }
  };

  /** Run jobs with the parallel cap; the budget is checked before each launch. Jobs may be appended while running. */
  const runPool = async (jobs: WorkerJob[]): Promise<WorkerOutcome[]> => {
    const out: WorkerOutcome[] = [];
    let next = 0;
    const running = new Set<Promise<void>>();
    const launch = (job: WorkerJob): void => {
      const est = EST_COST_USD[job.worker.kind];
      if (spent + est > spec.limits.budgetUsd) {
        if (!budgetHit) notes.push(`budget $${spec.limits.budgetUsd} reached — no more workers launched`);
        budgetHit = true;
        return;
      }
      spent += est; calls++;
      if (spec.layout.spotlight === 'active') spotlight = job.title;
      emit('spawn', { spotlightCaption: `${job.worker.id} · ${job.worker.kind} · ${job.worker.persona ?? job.worker.role}` });
      log(`▶ ${job.title} [${job.worker.kind}]`);
      const p = deps.backend.run(job, abort.signal).catch((error: unknown): WorkerOutcome => ({ jobId: job.id, workerId: job.worker.id, kind: job.worker.kind, ok: false, text: '',
        durationMs: 0, costUsd: est, error: error instanceof Error ? error.message : String(error) })).then((o) => {
        out.push(o);
        log(`${o.ok ? '✓' : '✗'} ${job.title}${o.error ? ` — ${o.error}` : ''}`);
        emit('work', { votes: out.map((x) => ({ pane: tabTitle({ worker: workers.find((w) => w.id === x.workerId) ?? job.worker, round: job.round }), vote: x.ok ? voteOf(x.text) ?? 'done' : 'fail' })) });
      });
      const tracked = p.finally(() => running.delete(tracked));
      running.add(tracked);
      lastLaunch = Date.now();
    };
    // Inside els, tabs switch on one after another (a short stagger) so the grid visibly fills tile by tile.
    const stagger = deps.backend.name === 'els' ? 1_200 : 0;
    let lastLaunch = 0;
    while (next < jobs.length || running.size > 0) {
      drain();
      if (stopped) break;
      for (const w of added.splice(0)) { const j = extra.job?.(w); if (j) jobs.push(j); }
      while (!budgetHit && running.size < spec.limits.maxParallel && next < jobs.length) {
        if (stagger && Date.now() - lastLaunch < stagger) { await new Promise((r) => setTimeout(r, stagger - (Date.now() - lastLaunch))); drain(); if (stopped) break; }
        launch(jobs[next++]!);
      }
      if (budgetHit && running.size === 0) break;
      if (running.size === 0 && next >= jobs.length) break;
      await Promise.race([...running, new Promise((r) => setTimeout(r, 200))]);
    }
    if (stopped) { await Promise.allSettled([...running]); throw new StopSignal(); }
    return out;
  };

  const rounds: RoundReport[] = [];
  let refine = '';
  emit('plan', { spotlightCaption: `${spec.pattern} · ${spec.goal.slice(0, 80)}` });
  try {
    for (let round = 1; round <= spec.limits.maxRounds; round++) {
      const outcomes = await runPattern(spec, workers, round, refine, runPool, rounds.at(-1), extra);
      // Inside els the aggregation is a tab of its own (ORCH·reduce), spotlit while it fills in — the person watches every
      // worker's answer flow into one result. Elsewhere it runs in-process.
      // Every model call is charged before it runs: a reduce that would cross the budget is refused (answers joined instead).
      // A model call happens only through the els reduce tab or an injected model; joining answers costs nothing.
      const reduceNeedsModel = spec.reduce.method === 'llm-summary' && outcomes.some((o) => o.ok) && (deps.backend.name === 'els' || !!deps.llm);
      const reduceAffordable = !reduceNeedsModel || spent + EST_COST_USD.eln <= spec.limits.budgetUsd;
      if (!reduceAffordable) { if (!budgetHit) notes.push(`budget $${spec.limits.budgetUsd} reached — reduce joined the answers without a model`); budgetHit = true; }
      if (reduceNeedsModel && reduceAffordable) { spent += EST_COST_USD.eln; calls++; }
      const visible = deps.backend.name === 'els' && reduceNeedsModel && reduceAffordable;
      const reduceTitle = `ORCH·reduce${round > 1 ? `·r${round}` : ''}`;
      emit('reduce', visible ? { spotlightPane: reduceTitle, spotlightMs: 600_000, verdictPane: reduceTitle, spotlightCaption: `aggregating ${outcomes.filter((o) => o.ok).length} answers → one result` } : {});
      const reduceLlm = reduceAffordable ? deps.llm : undefined;
      const result: { text: string; consensus?: { label: string; value: number } } = visible ? await reduceInTab(spec, outcomes, round, deps.backend, abort.signal).catch(() => reduce(spec, outcomes, undefined)) : await reduce(spec, outcomes, reduceLlm);
      emit('check', { ...(result.consensus ? { consensus: result.consensus } : {}) });
      // A round the budget cut short is never a success: planned work did not run.
      const judgeAffordable = !spec.reduce.success.startsWith('llm-judge') || spent + EST_COST_USD.eln <= spec.limits.budgetUsd;
      if (spec.reduce.success.startsWith('llm-judge') && judgeAffordable && deps.llm) { spent += EST_COST_USD.eln; calls++; }
      const verdict = budgetHit ? { met: false, why: 'budget reached before all planned work ran' }
        : await checkSuccess(spec, result.text, outcomes, judgeAffordable ? deps.llm : undefined);
      // The 출처 section is appended after the check (it never makes a thin result pass) and kept with the result the
      // publish node turns into the brief/PDF.
      rounds.push({ round, result: withSources(result.text, outcomes), met: verdict.met, why: verdict.why, outcomes });
      log(`round ${round}: ${verdict.met ? 'success criterion met' : `not met — ${verdict.why}`}`);
      if (verdict.met || budgetHit) break;
      if (!outcomes.some((o) => o.ok)) { notes.push('every worker failed this round — not retrying'); break; }
      refine = `Previous round did not meet the success criterion «${spec.reduce.success}»: ${verdict.why}. Improve on this previous result:\n${result.text.slice(0, 2_000)}`;
    }
  } catch (error) {
    if (!(error instanceof StopSignal)) { notes.push(`failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let published: { ok: boolean; text: string } | undefined;
  const lastRound = rounds.at(-1);
  // Voice: after the criterion holds, before publish. Any failure is «voice skipped» — the run still publishes the PDF.
  let voice: VoiceResult | undefined;
  if (!stopped && spec.voice && lastRound?.met) {
    emit('voice', { spotlightCaption: 'Voice · brief → mp3' });
    log('▶ Voice');
    voice = deps.voice ? await deps.voice(withoutSources(lastRound.result), abort.signal).catch((error: unknown): VoiceResult => ({ ok: false, chars: 0, why: error instanceof Error ? error.message : String(error) }))
      : { ok: false, chars: 0, why: 'no voice backend in this run' };
    notes.push(voice.ok ? `voice ok: ${voice.chars} chars → ${voice.file}` : `voice skipped: ${voice.why}`);
    log(voice.ok ? `Voice ✓ ${voice.file} (${voice.chars} chars)` : `\x1b[2mvoice skipped — ${voice.why}\x1b[0m`);
    emit('voice', { spotlightCaption: voice.ok ? 'Voice ✓' : 'voice skipped' });
  }
  if (!stopped && spec.publish && lastRound?.met && deps.backend.runCommand) {
    emit('publish', { spotlightPane: 'ORCH·publish', spotlightMs: 600_000, verdictPane: 'ORCH·publish', spotlightCaption: spec.publish.title ?? 'publish' });
    log('▶ ORCH·publish');
    const extraEnv: Record<string, string> = voice?.ok && voice.file ? { ORCH_VOICE_FILE: voice.file } : {};
    try { published = await deps.backend.runCommand({ id: `publish`, title: 'ORCH·publish' }, spec.publish.command, lastRound.result, abort.signal, extraEnv); }
    catch (error) { published = { ok: false, text: error instanceof Error ? error.message : String(error) }; }
    notes.push(`publish ${published.ok ? 'ok' : 'failed'}: ${published.text.split('\n').filter(Boolean).slice(-3).join(' · ').slice(0, 300)}`);
    log(`${published.ok ? '✓' : '✗'} ORCH·publish`);
  }
  if (stopped) await deps.backend.closeAll();
  const last = rounds.at(-1);
  const status: RunStatus = stopped ? 'stopped' : budgetHit ? 'budget' : last?.met ? 'met' : last && last.outcomes.some((o) => o.ok) ? 'not-met' : 'failed';
  const receipt = `${status.toUpperCase()} · ${rounds.length} round(s) · ${calls} worker call(s) · est $${spent.toFixed(2)}${voice ? (voice.ok ? ' · Voice ✓' : ' · voice skipped') : ''}`;
  emit('done', { receipt, ...(spec.layout.spotlight === 'verdict' ? { spotlightCaption: (last?.result ?? '').split('\n').find(Boolean)?.slice(0, 150) ?? status } : {}) });
  return { status, goal: spec.goal, pattern: spec.pattern, result: last?.result ?? '', why: last?.why ?? notes.at(-1) ?? '', rounds, costUsd: Number(spent.toFixed(4)), workers, notes };
}

const job = (worker: WorkerSpec, round: number, key: string, prompt: string): WorkerJob => ({ id: `r${round}-${key}`, worker, round, prompt, title: tabTitle({ worker, round }) });
const persona = (w: WorkerSpec): string => w.persona ? `You are ${w.persona}.` : `You are the ${w.role}.`;
const tail = 'Answer in plain English, concise (under 250 words). No tool calls, no file writes.';

async function runPattern(spec: OrchestrationSpec, workers: WorkerSpec[], round: number, refine: string,
  runPool: (jobs: WorkerJob[]) => Promise<WorkerOutcome[]>, prev: RoundReport | undefined, extra: { job?: (w: WorkerSpec) => WorkerJob | undefined }): Promise<WorkerOutcome[]> {
  const ctx = refine ? `\n\n${refine}` : '';
  extra.job = undefined;
  switch (spec.pattern) {
    case 'map-reduce':
      extra.job = (w) => job(w, round, `${w.id}-second`, `${persona(w)} Goal: ${spec.goal}\nItems: ${spec.tasks.join('; ')}\nGive a second opinion across all items. Last line: "VERDICT: <one line>".\n${tail}`);
      return runPool(spec.tasks.map((item, i) => job(workers[i % workers.length]!, round, `item${i + 1}`,
        `${persona(workers[i % workers.length]!)} Goal: ${spec.goal}\nYour item: ${item}\nAnalyze this one item for the goal. Last line: "VERDICT: <one line>".${ctx}\n${tail}`)));
    case 'panel': {
      const others = prev ? `\n\nOther panelists said last round:\n${prev.outcomes.filter((o) => o.ok).map((o) => `- ${o.workerId}: ${o.text.slice(0, 300)}`).join('\n')}` : '';
      const ask = (w: WorkerSpec): WorkerJob => job(w, round, w.id, `${persona(w)} Panel question: ${spec.goal}${spec.tasks.length ? `\nConsider: ${spec.tasks.join('; ')}` : ''}${others}${ctx}\nGive your view, then a last line "VOTE: <short choice>".\n${tail}`);
      extra.job = ask;
      return runPool(workers.map(ask));
    }
    case 'pipeline': {
      const outs: WorkerOutcome[] = [];
      let carry = refine ? `\n\n${refine}` : '';
      for (const [i, stage] of spec.tasks.entries()) {
        const w = workers[i % workers.length]!;
        const [o] = await runPool([job(w, round, `stage${i + 1}`, `${persona(w)} Overall goal: ${spec.goal}\nYour stage (${i + 1}/${spec.tasks.length}): ${stage}${carry ? `\n\nInput from the previous stage:\n${carry}` : ''}\n${tail.replace('under 250 words', 'full output for your stage')}`)]);
        if (!o) break;
        outs.push(o);
        if (!o.ok) break;
        carry = o.text.slice(0, 6_000);
      }
      return outs;
    }
    case 'supervisor-workers': {
      const [sup, ...hands] = workers;
      const [plan] = await runPool([job(sup!, round, 'split', `${persona(sup!)} Split this goal into exactly ${hands.length} independent subtasks, one per line, numbered "1." ...: ${spec.goal}${ctx}`)]);
      const parts = (plan?.ok ? plan.text : '').split('\n').map((l) => /^\s*\d+[.)]\s*(.+)$/u.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);
      const subtasks = hands.map((_, i) => parts[i] ?? spec.tasks[i] ?? `part ${i + 1} of: ${spec.goal}`);
      const outs = await runPool(hands.map((w, i) => job(w, round, `sub${i + 1}`, `${persona(w)} Overall goal: ${spec.goal}\nYour subtask: ${subtasks[i]}\n${tail}`)));
      return [...(plan ? [plan] : []), ...outs];
    }
    case 'loop-until': {
      const w = workers[0]!;
      return runPool([job(w, round, 'iter', `${persona(w)} Goal: ${spec.goal}${spec.tasks.length ? `\nSteps: ${spec.tasks.join('; ')}` : ''}${ctx}\n${tail}`)]);
    }
  }
}

/** DEMO-SOURCES-VIA-SECRET — result + «출처»: the fetched source records of the desks whose answers were used, and
 *  the desks with no source (named, with no claim). Runs without data desks keep their result unchanged. */
export function withSources(text: string, outcomes: readonly WorkerOutcome[]): string {
  const desks = outcomes.filter((o) => o.source).map((o) => ({ workerId: o.workerId, result: o.source!, used: o.ok && !!o.text.trim() }));
  if (!desks.length || !text.trim()) return text;
  return `${text.trimEnd()}\n\n${sourcesSection(desks)}\n`;
}
/** Extra reduce rule when workers fetched data: cite, never fill a gap. */
export function sourceRule(outcomes: readonly WorkerOutcome[], goal = ''): string {
  if (!outcomes.some((o) => o.source)) return '';
  const gaps = outcomes.filter((o) => o.source && !(o.ok && o.text.trim())).map((o) => o.workerId);
  const korean = /[\uac00-\ud7a3]/u.test(goal) ? ' Write the whole result in Korean — headings, bullets and labels; summarize English sources in Korean and keep source titles and URLs as they are.' : '';
  return `\nSource rule:${korean} State only facts that appear in the worker answers below, each with the URL it came from. Do not add facts, numbers or quotes from memory. A «출처» list is appended automatically — do not write one.${gaps.length ? ` These desks had no source and gave no answer: ${gaps.join(', ')} — say in one line that their data is unavailable and state nothing about what they would have covered.` : ''}`;
}

/** The llm-summary reduce as a worker job (its own tab), so the aggregation is visible. */
export async function reduceInTab(spec: OrchestrationSpec, outcomes: readonly WorkerOutcome[], round: number, backend: WorkerBackend, signal: AbortSignal): Promise<{ text: string }> {
  const ok = outcomes.filter((o) => o.ok && o.text.trim());
  const concat = ok.map((o) => `## ${o.workerId} (${o.kind})\n${o.text.trim()}`).join('\n\n');
  const worker: WorkerSpec = { id: 'reduce', kind: 'eln', role: 'aggregator' };
  const o = await backend.run({ id: `r${round}-reduce`, worker, round, title: `ORCH·reduce${round > 1 ? `·r${round}` : ''}`,
    prompt: `You are the aggregator. Goal: ${spec.goal}\nCombine these ${ok.length} worker answers into one result that meets the goal. The workers' data was fetched minutes ago — use it as current, name its sources, and do not refuse for lack of verification (say briefly what is uncertain). Start with a one-line answer, then the key points as short bullets. ${languageRule(spec)}${voiceHint(spec)}${sourceRule(outcomes, spec.goal)}\n\n${concat.slice(0, 12_000)}` }, signal);
  if (!o.ok || !o.text.trim()) throw new Error(o.error ?? 'reduce tab failed');
  return { text: o.text.trim() };
}

/** The result's language: explicit Korean for a Korean goal (brief, PDF and voice stay Korean end to end). */
const languageRule = (spec: OrchestrationSpec): string => goalLanguage(spec.goal) === 'Korean'
  ? 'Write the whole result in natural Korean (한국어) — every sentence, even when the worker answers are in English; keep tickers and numbers as they are.'
  : "Write in the goal's language.";
/** With a voice node the result is read aloud afterwards — the aggregator must not apologise that it cannot speak. */
const voiceHint = (spec: OrchestrationSpec): string => spec.voice ? ' A separate voice step reads your result aloud and sends the audio, so never say you cannot produce or play audio; write sentences that read well aloud.' : '';

export const voteOf = (text: string): string | undefined => /^\s*(?:VOTE|VERDICT):\s*(.+)$/imu.exec(text)?.[1]?.trim().slice(0, 60);

export async function reduce(spec: OrchestrationSpec, outcomes: readonly WorkerOutcome[], llm?: LlmText): Promise<{ text: string; consensus?: { label: string; value: number } }> {
  const ok = outcomes.filter((o) => o.ok && o.text.trim());
  if (ok.length === 0) return { text: '' };
  const concat = ok.map((o) => `## ${o.workerId} (${o.kind})\n${o.text.trim()}`).join('\n\n');
  switch (spec.reduce.method) {
    case 'last': return { text: ok.at(-1)!.text.trim() };
    case 'concat': return { text: concat };
    case 'vote': case 'consensus': {
      const tally = new Map<string, number>();
      for (const o of ok) { const v = (voteOf(o.text) ?? 'no vote').toLowerCase(); tally.set(v, (tally.get(v) ?? 0) + 1); }
      const [winner, count] = [...tally].sort((a, b) => b[1] - a[1])[0]!;
      const value = count / ok.length;
      const head = spec.reduce.method === 'consensus' && value <= 0.5 ? `No consensus (top: ${winner} ${count}/${ok.length})` : `Decision: ${winner} (${count}/${ok.length})`;
      return { text: `${head}\nTally: ${[...tally].map(([k, n]) => `${k} ${n}`).join(' · ')}\n\n${concat}`, consensus: { label: winner.slice(0, 12), value } };
    }
    case 'llm-summary': {
      if (!llm) return { text: `Summary (no model available — answers joined):\n\n${concat}` };
      try {
        const s = await llm(`Goal: ${spec.goal}\nCombine these worker answers into one result that meets the goal. Start with a one-line recommendation/answer, then the reasons. ${languageRule(spec)}${voiceHint(spec)}${sourceRule(outcomes, spec.goal)}\n\n${concat.slice(0, 12_000)}`);
        return { text: s.trim() || concat };
      } catch { return { text: `Summary (model failed — answers joined):\n\n${concat}` }; }
    }
  }
}

export async function checkSuccess(spec: OrchestrationSpec, result: string, outcomes: readonly WorkerOutcome[], llm?: LlmText): Promise<{ met: boolean; why: string }> {
  const c = spec.reduce.success;
  const okCount = outcomes.filter((o) => o.ok).length;
  if (!result.trim()) return { met: false, why: 'no worker produced output' };
  if (c === 'all-ok') return okCount === outcomes.length ? { met: true, why: `all ${okCount} workers answered` } : { met: false, why: `${outcomes.length - okCount} of ${outcomes.length} workers failed` };
  if (c.startsWith('contains:')) { const needle = c.slice(9).trim(); return result.toLowerCase().includes(needle.toLowerCase()) ? { met: true, why: `result mentions «${needle}»` } : { met: false, why: `result does not mention «${needle}»` }; }
  const m = /^(min-length|min-items):\s*(\d+)$/u.exec(c);
  if (m) {
    const n = Number(m[2]);
    if (m[1] === 'min-length') return result.length >= n ? { met: true, why: `${result.length} chars ≥ ${n}` } : { met: false, why: `${result.length} chars < ${n}` };
    return okCount >= n ? { met: true, why: `${okCount} answers ≥ ${n}` } : { met: false, why: `${okCount} answers < ${n}` };
  }
  // llm-judge[:question]
  const question = c.includes(':') ? c.slice(c.indexOf(':') + 1).trim() : `Does this result fully meet the goal «${spec.goal}»?`;
  if (!llm) return result.length >= 300 ? { met: true, why: 'no judge model; result is substantial (≥300 chars)' } : { met: false, why: 'no judge model; result is short' };
  try {
    const a = await llm(`${question}\nAnswer "YES" or "NO" on the first line, then one short reason.\n\nResult:\n${result.slice(0, 8_000)}`);
    const met = /^\s*\**\s*yes\b/iu.test(a);
    return { met, why: (a.split('\n').slice(1).join(' ').trim() || a.trim()).slice(0, 200) };
  } catch (error) { return { met: false, why: `judge failed: ${error instanceof Error ? error.message : String(error)}` }; }
}
