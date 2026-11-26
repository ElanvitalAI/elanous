// ORCHESTRATE-MAP-GENERAL — `eln orchestrate map`: fan one task out to N worker children (one per item or shard), collect
// their answers, reduce them (concat · vote · consensus · llm-summary), and write the result plus a receipt.
//   --els: each child is a visible els tab «ORC·<id>·<n>» (els fanout when the installed els has it, else one `side new`
//   per child); a context that cannot open tabs falls back to headless and says so.
//   The stage feed (invest conductor format: phase/nodes/votes/consensus/spotlight/receipt/counters) is written as JSONL
//   so `els attach --tile --stage --feed <file>` can show the run.
// Failure handling: per-child timeout, one retry, partial reduce with the failures listed, abort closes the tabs it opened.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binaryOnPath, execCli, parseWorkerOutput, runtimeBinary, runWorkerScript, writeWorkerScript, WORKER_RUNTIMES, type ElsLaunch, type WorkerRuntime } from './worker.js';

export type Reducer = 'concat' | 'vote' | 'consensus' | 'llm-summary';
export const REDUCERS: readonly Reducer[] = ['concat', 'vote', 'consensus', 'llm-summary'];
/** Worker kinds: the three real CLIs, plus `sim` (a simulated pane — rehearsal and tests). */
export type WorkerKind = WorkerRuntime | 'sim';
/** Same ceiling as the per-seat agent spawn guard family: a map never runs more than this many children at once. */
export const MAX_PARALLEL_CAP = 6;
export const DEFAULT_PARALLEL = 3;
export const MAX_ITEMS = 100;

export interface MapChildResult {
  readonly n: number;
  readonly item: string;
  readonly worker: WorkerKind;
  readonly ok: boolean;
  readonly attempts: number;
  readonly code: number;
  readonly durationMs: number;
  readonly pane: string;
  readonly text: string;
  readonly model?: string;
  readonly error?: string;
}
export interface MapReceipt {
  readonly schema: 'orchestrate.map/1';
  readonly id: string;
  readonly task: string;
  readonly reducer: Reducer;
  readonly items: number;
  readonly workers: Record<string, number>;
  readonly maxParallel: number;
  readonly mode: 'els' | 'headless';
  readonly modeNote?: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly ok: number;
  readonly failed: number;
  readonly cancelled: boolean;
  readonly failures: ReadonlyArray<{ n: number; item: string; worker: WorkerKind; error: string }>;
  readonly children: ReadonlyArray<Omit<MapChildResult, 'text'> & { chars: number }>;
  readonly reduce: { readonly reducer: Reducer; readonly output: string; readonly label?: string; readonly agreement?: number; readonly partial: boolean };
  readonly paths: { readonly dir: string; readonly result: string; readonly receipt: string; readonly feed: string };
}

export interface ChildSpec { readonly n: number; readonly item: string; readonly worker: WorkerKind; readonly prompt: string; readonly title: string; readonly dir: string; readonly attempt: number }
export interface ChildOutcome { readonly code: number; readonly text: string; readonly pane: string; readonly durationMs: number; readonly model?: string; readonly error?: string; readonly elsError?: string }
export type ChildRunner = (spec: ChildSpec, ctx: { readonly timeoutMs: number; readonly signal: AbortSignal; readonly els?: ElsLaunch; readonly onTab: (tab: string) => void }) => Promise<ChildOutcome>;

export interface MapOptions {
  readonly task: string;
  readonly items: readonly string[];
  readonly workers: readonly WorkerKind[];
  readonly reducer: Reducer;
  readonly maxParallel?: number;
  readonly timeoutMs?: number;
  readonly outDir: string;
  readonly id?: string;
  /** els tabs: the CLI and env that reach the target els, and the workspace. */
  readonly els?: { readonly cli: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly ws: string; readonly fanout?: boolean };
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  /** Injected for tests (default: the real worker child). */
  readonly runChild?: ChildRunner;
  /** Simulated pane behaviour for `sim` workers: answer per item, delay, exit code. */
  readonly sim?: (item: string, n: number, attempt: number) => { text: string; delayMs?: number; exit?: number };
  readonly now?: () => number;
}

// ── inputs ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** `--over`: a number N (shards 1..N), a JSON array file, or a file with one item per line. */
export function parseOver(over: string, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): string[] {
  const t = over.trim();
  if (/^\d+$/u.test(t)) {
    const n = Number(t);
    if (n < 1 || n > MAX_ITEMS) throw new Error(`--over ${n}: between 1 and ${MAX_ITEMS}`);
    return Array.from({ length: n }, (_, i) => `shard ${i + 1} of ${n}`);
  }
  if (!existsSync(t)) throw new Error(`--over: no file «${t}» (pass a number or an items file)`);
  const body = read(t);
  let items: string[];
  try { const j = JSON.parse(body) as unknown; items = Array.isArray(j) ? j.map((x) => typeof x === 'string' ? x : JSON.stringify(x)) : []; } catch { items = body.split('\n').map((l) => l.trim()).filter(Boolean); }
  if (!items.length) throw new Error(`--over: «${t}» has no items`);
  if (items.length > MAX_ITEMS) throw new Error(`--over: ${items.length} items — at most ${MAX_ITEMS}`);
  return items;
}

/** `--workers eln,codex,claude` or `eln:2,claude:1` → the rotation children take workers from. */
export function parseWorkers(spec: string): WorkerKind[] {
  const out: WorkerKind[] = [];
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [name, count] = part.split(':');
    const kind = name as WorkerKind;
    if (![...WORKER_RUNTIMES, 'sim'].includes(kind)) throw new Error(`--workers: unknown worker «${name}» (eln · codex · claude · sim)`);
    const k = count === undefined ? 1 : Number(count);
    if (!Number.isInteger(k) || k < 1 || k > MAX_ITEMS) throw new Error(`--workers: bad count in «${part}»`);
    for (let i = 0; i < k; i++) out.push(kind);
  }
  if (!out.length) throw new Error('--workers: name at least one worker');
  return out;
}

/** `--task`: a file's text when it names one, else the prompt itself. */
export function readTask(task: string): string { return existsSync(task) ? readFileSync(task, 'utf8') : task; }

export function childPrompt(task: string, item: string, n: number, total: number): string {
  if (task.includes('{item}')) return task.replaceAll('{item}', item).replaceAll('{n}', String(n)).replaceAll('{total}', String(total));
  return `${task.trimEnd()}\n\nItem ${n} of ${total}: ${item}\n\nAnswer for this item only. End with one line «VERDICT: <short label>».`;
}

// ── reducers ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** The label a child voted: «VERDICT: x» line, else its last non-empty line (trimmed, lower-cased for counting). */
export function voteLabel(text: string): string | undefined {
  const m = /VERDICT:\s*(.+)$/imu.exec(text);
  const raw = m ? m[1]! : text.trim().split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  const label = raw?.replace(/[*_`«»"]/gu, '').trim().slice(0, 60);
  return label ? label : undefined;
}

export function tally(children: readonly MapChildResult[]): Array<{ label: string; votes: number }> {
  const counts = new Map<string, { label: string; votes: number }>();
  for (const c of children) {
    if (!c.ok) continue;
    const label = voteLabel(c.text);
    if (!label) continue;
    const key = label.toLowerCase();
    const prev = counts.get(key);
    counts.set(key, { label: prev?.label ?? label, votes: (prev?.votes ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.votes - a.votes || a.label.localeCompare(b.label));
}

export function reduceLocal(reducer: Exclude<Reducer, 'llm-summary'>, children: readonly MapChildResult[]): { output: string; label?: string; agreement?: number } {
  const ok = children.filter((c) => c.ok);
  if (reducer === 'concat') return { output: ok.map((c) => `## ${c.n}. ${c.item} (${c.worker})\n\n${c.text.trim()}`).join('\n\n') };
  const t = tally(children);
  if (!t.length) return { output: 'No votes: no child answered with a label.' };
  const top = t[0]!, total = t.reduce((s, x) => s + x.votes, 0);
  const tie = t.length > 1 && t[1]!.votes === top.votes;
  const agreement = top.votes / total;
  const lines = t.map((x) => `- ${x.label}: ${x.votes}`).join('\n');
  if (reducer === 'vote') return { output: `${tie ? 'Tie' : `Majority: ${top.label}`} (${top.votes}/${total})\n\n${lines}`, label: tie ? 'tie' : top.label, agreement };
  // consensus: a label holds only with at least two thirds of the votes.
  const holds = !tie && agreement >= 2 / 3;
  return { output: `${holds ? `Consensus: ${top.label}` : 'No consensus'} (${Math.round(agreement * 100)}% agree · ${total} votes)\n\n${lines}`, label: holds ? top.label : 'no consensus', agreement };
}

export function summaryPrompt(task: string, children: readonly MapChildResult[]): string {
  return [`Summarize the answers below into one result for this task. Note where they agree and where they differ. Be brief.`, '', `Task: ${task.trim().slice(0, 2000)}`, '',
    ...children.filter((c) => c.ok).map((c) => `### Answer ${c.n} (${c.item} · ${c.worker})\n${c.text.trim().slice(0, 4000)}`)].join('\n');
}

// ── stage feed (invest conductor format) ─────────────────────────────────────────────────────────────────────────
export interface StageFeed { child(n: number, state: 'waiting' | 'running' | 'done' | 'failed', title: string): void; vote(n: number, label: string): void; phase(p: string): void; verdict(label: string, value: number): void; receipt(text: string): void }
export function stageFeedWriter(emit: (ev: Record<string, unknown>) => void, now: () => number = Date.now): StageFeed {
  const nodes = new Map<string, { id: string; state: string; title: string }>();
  const votes = new Map<string, string>();
  const t0 = now();
  let phase = 'prompt', consensus: { label: string; value: number } | undefined, receipt: string | undefined, verdictPane: string | undefined;
  const counters = () => ({ toolCalls: 0, cited: 0, agents: nodes.size, models: 0, elapsedMs: Math.max(0, now() - t0) });
  const snap = () => emit({ phase, nodes: [...nodes.values()], evidence: 0, counters: counters(), votes: [...votes].map(([id, vote]) => ({ id, vote })),
    ...(consensus ? { consensus } : {}), ...(verdictPane ? { verdictPane } : {}), ...(receipt ? { receipt } : {}) });
  return {
    child(n, state, title) { nodes.set(`orc-${n}`, { id: `orc-${n}`, state, title }); if (state === 'running' && phase === 'prompt') phase = 'spawn'; else if (state !== 'running' && phase === 'spawn') phase = 'work'; snap(); },
    vote(n, label) { votes.set(`orc-${n}`, label); phase = 'votes'; snap(); },
    phase(p) { phase = p; snap(); },
    verdict(label, value) { consensus = { label, value }; phase = 'verdict'; snap(); },
    receipt(text) { receipt = text; phase = 'receipt'; snap(); },
  };
}

// ── the real child runner ────────────────────────────────────────────────────────────────────────────────────────
export const defaultChildRunner = (sim?: MapOptions['sim']): ChildRunner => async (spec, ctx) => {
  const id = `child-${spec.n}-a${spec.attempt}`;
  if (spec.worker !== 'sim' && !binaryOnPath(runtimeBinary(spec.worker))) return { code: 127, text: '', pane: 'none', durationMs: 0, error: `worker CLI «${runtimeBinary(spec.worker)}» not on PATH` };
  const s = spec.worker === 'sim' ? (sim?.(spec.item, spec.n, spec.attempt) ?? { text: `Simulated answer for ${spec.item}\nVERDICT: ok` }) : undefined;
  const files = writeWorkerScript({ id, label: spec.title, binding: { runtime: spec.worker === 'sim' ? 'eln' : spec.worker }, prompt: spec.prompt, dir: spec.dir,
    ...(s ? { simulated: s.text, simDelayMs: s.delayMs ?? 800, ...(s.exit ? { simExit: s.exit } : {}) } : {}) });
  const r = await runWorkerScript(files, { timeoutMs: ctx.timeoutMs, cwd: spec.dir, signal: ctx.signal, onTab: ctx.onTab, ...(ctx.els ? { els: { ...ctx.els, title: spec.title } } : {}) });
  const parsed = spec.worker === 'sim' ? { text: r.raw } : parseWorkerOutput(spec.worker, r.raw, existsSync(files.outFile) ? readFileSync(files.outFile, 'utf8') : '');
  return { code: r.code, text: parsed.text, pane: r.pane, durationMs: r.durationMs, ...(parsed.model ? { model: parsed.model } : {}), ...(r.elsError ? { elsError: r.elsError } : {}),
    ...(r.code === 124 ? { error: `timed out after ${Math.round(ctx.timeoutMs / 1000)}s` } : r.code === 130 ? { error: 'cancelled' } : r.code !== 0 ? { error: `exit ${r.code}` } : !parsed.text.trim() ? { error: 'empty answer' } : {}) };
};

/** Whether the target els has the native fan-out primitive (`els fanout` · `els gather`). */
export async function elsHasFanout(cli: readonly string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  const r = await execCli(cli[0]!, [...cli.slice(1), 'side', '--help'], { env, timeoutMs: 15_000 });
  return /^\s+fanout\b/mu.test(r.stdout) && /^\s+gather\b/mu.test(r.stdout);
}

// ── the map ──────────────────────────────────────────────────────────────────────────────────────────────────────
export async function runMap(o: MapOptions): Promise<MapReceipt> {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((l: string) => console.error(l));
  const id = o.id ?? `${new Date(now()).toISOString().slice(11, 19).replaceAll(':', '')}${Math.random().toString(36).slice(2, 5)}`;
  const maxParallel = Math.max(1, o.maxParallel ?? DEFAULT_PARALLEL);
  if (maxParallel > MAX_PARALLEL_CAP) throw new Error(`--max-parallel ${maxParallel}: the cap is ${MAX_PARALLEL_CAP} children at once`);
  if (!o.items.length) throw new Error('no items');
  if (!o.workers.length) throw new Error('no workers');
  const timeoutMs = o.timeoutMs ?? 180_000;
  const dir = join(o.outDir, `orc-${id}`);
  mkdirSync(dir, { recursive: true });
  const feedPath = join(dir, 'stage-feed.jsonl');
  writeFileSync(feedPath, '');
  const feed = stageFeedWriter((ev) => { try { appendFileSync(feedPath, `${JSON.stringify(ev)}\n`); } catch { /* viewer only */ } }, now);
  const runChild = o.runChild ?? defaultChildRunner(o.sim);
  const controller = new AbortController();
  o.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const tabs = new Set<string>();
  let mode: 'els' | 'headless' = o.els ? 'els' : 'headless';
  let modeNote: string | undefined;
  const els: ElsLaunch | undefined = o.els ? { cli: o.els.cli, env: o.els.env, ws: o.els.ws, title: '' } : undefined;
  let useEls = Boolean(els);
  const t0 = now();
  const total = o.items.length;
  const title = (n: number) => `ORC·${id}·${n}`;
  const results: MapChildResult[] = new Array(total);
  for (let i = 0; i < total; i++) feed.child(i + 1, 'waiting', title(i + 1));
  log(`orchestrate: map ${id} — ${total} items · workers ${[...new Set(o.workers)].join('/')} · up to ${maxParallel} at once · ${mode}`);

  const one = async (i: number): Promise<void> => {
    const n = i + 1, item = o.items[i]!, worker = o.workers[i % o.workers.length]!;
    let last: ChildOutcome | undefined, attempts = 0;
    for (let attempt = 1; attempt <= 2 && !controller.signal.aborted; attempt++) {
      attempts = attempt;
      feed.child(n, 'running', title(n));
      last = await runChild({ n, item, worker, prompt: childPrompt(o.task, item, n, total), title: title(n) + (attempt > 1 ? ' (retry)' : ''), dir: join(dir, `child-${n}`), attempt },
        { timeoutMs, signal: controller.signal, onTab: (t) => tabs.add(t), ...(useEls && els ? { els } : {}) });
      if (last.elsError && useEls) {
        // A context that cannot open tabs (tool door · no verified seat): headless from here on, said once.
        useEls = false; mode = 'headless';
        modeNote = `els tabs refused (${last.elsError}) — children run headless`;
        log(`orchestrate: ${modeNote}`);
      }
      if (last.code === 0 && !last.error) break;
      if (last.code === 127 || last.code === 130) break; // a missing CLI or a cancel does not get better on retry
      if (attempt === 1) log(`orchestrate: child ${n} (${worker}) failed: ${last.error ?? `exit ${last.code}`} — retrying once`);
    }
    const ok = Boolean(last && last.code === 0 && !last.error);
    results[i] = { n, item, worker, ok, attempts, code: last?.code ?? 130, durationMs: last?.durationMs ?? 0, pane: last?.pane ?? 'none', text: last?.text ?? '',
      ...(last?.model ? { model: last.model } : {}), ...(!ok ? { error: last?.error ?? 'cancelled' } : {}) };
    feed.child(n, ok ? 'done' : 'failed', title(n));
    if (ok && (o.reducer === 'vote' || o.reducer === 'consensus')) { const l = voteLabel(results[i]!.text); if (l) feed.vote(n, l); }
  };

  // Each child gets its own folder: a worker that can read files (codex -C) never sees a sibling's prompt or answer.
  // pool: never more than maxParallel children at once
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(maxParallel, total) }, async () => {
    while (next < total && !controller.signal.aborted) { const i = next++; await one(i); }
  }));
  for (let i = 0; i < total; i++) if (!results[i]) results[i] = { n: i + 1, item: o.items[i]!, worker: o.workers[i % o.workers.length]!, ok: false, attempts: 0, code: 130, durationMs: 0, pane: 'none', text: '', error: 'cancelled' };
  const cancelled = controller.signal.aborted;
  if (cancelled && tabs.size && els) {
    for (const t of tabs) await execCli(els.cli[0]!, [...els.cli.slice(1), 'side', 'tab', 'close', '--yes', t], { env: els.env, timeoutMs: 10_000 });
    log(`orchestrate: cancelled — closed ${tabs.size} tab(s)`);
  }

  // reduce (partial: whatever answered)
  const okKids = results.filter((r) => r.ok);
  feed.phase('votes');
  let reduce: MapReceipt['reduce'];
  const partial = okKids.length < total;
  if (!okKids.length) reduce = { reducer: o.reducer, output: 'No child answered: nothing to reduce.', partial: true };
  else if (o.reducer === 'llm-summary') {
    const worker = okKids[0]!.worker;
    const r = cancelled ? undefined : await runChild({ n: 0, item: 'reduce', worker, prompt: summaryPrompt(o.task, results), title: `ORC·${id}·reduce`, dir: join(dir, 'reduce'), attempt: 1 }, { timeoutMs, signal: controller.signal, onTab: (t) => tabs.add(t), ...(useEls && els ? { els } : {}) });
    reduce = r && r.code === 0 && !r.error && r.text.trim()
      ? { reducer: o.reducer, output: r.text.trim(), partial }
      : { reducer: o.reducer, output: `Summary worker failed (${r?.error ?? 'cancelled'}); concatenated answers instead.\n\n${reduceLocal('concat', results).output}`, partial: true };
  } else reduce = { reducer: o.reducer, ...reduceLocal(o.reducer, results), partial };
  if (reduce.label) feed.verdict(reduce.label, reduce.agreement ?? 0);
  const failures = results.filter((r) => !r.ok).map((r) => ({ n: r.n, item: r.item, worker: r.worker, error: r.error ?? 'failed' }));
  const workers: Record<string, number> = {};
  for (const r of results) workers[r.worker] = (workers[r.worker] ?? 0) + 1;
  const durationMs = now() - t0;
  const resultPath = join(dir, 'result.md'), receiptPath = join(dir, 'receipt.json');
  const receipt: MapReceipt = { schema: 'orchestrate.map/1', id, task: o.task.slice(0, 2000), reducer: o.reducer, items: total, workers, maxParallel, mode, ...(modeNote ? { modeNote } : {}),
    startedAt: new Date(t0).toISOString(), durationMs, ok: okKids.length, failed: failures.length, cancelled, failures,
    children: results.map(({ text, ...rest }) => ({ ...rest, chars: text.length })), reduce, paths: { dir, result: resultPath, receipt: receiptPath, feed: feedPath } };
  writeFileSync(resultPath, [`# orchestrate map ${id} — ${o.reducer}`, '', reduce.output, '',
    ...(failures.length ? ['## Failures', '', ...failures.map((f) => `- ${f.n}. ${f.item} (${f.worker}): ${f.error}`), ''] : []),
    `${okKids.length}/${total} children answered · ${Math.round(durationMs / 1000)}s${partial ? ' · partial' : ''}`, ''].join('\n'));
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  feed.receipt(`${total} children · ${Object.keys(workers).length} workers · ${Math.round(durationMs / 1000)}s · ${failures.length} failed`);
  return receipt;
}
