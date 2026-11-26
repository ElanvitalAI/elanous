// GOAL-ORCHESTRATION-NL — worker backends. els: each worker is a visible tab (`side new … -- bash <script>`), the
// answer lands in <dir>/<id>.out and <id>.rc. headless: the same script as a child process. sim: seeded,
// deterministic, no process at all (the sim world: missing workers, slow workers, round-2 improvement).
// Worker scripts scrub API keys so codex/claude run on their CLI subscription logins, never on paid keys.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { EST_COST_USD, type WorkerBackend, type WorkerJob, type WorkerOutcome } from './runner.js';
import type { WorkerKind } from './spec.js';
import { parseDeskResult, type DeskResult } from './sources.js';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const shq = (s: string): string => `'${s.replace(/'/gu, `'\\''`)}'`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The eln CLI this tree runs (never the installed operational binary unless ORCH_ELN names it). */
export function elnCli(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.ORCH_ELN ? [env.ORCH_ELN] : [process.execPath, join(REPO_ROOT, 'bin/elanous.mjs')];
}

export function workerScript(job: WorkerJob, dir: string, env: NodeJS.ProcessEnv = process.env): { script: string; outFile: string; rcFile: string } {
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, `${job.id}.prompt.md`), outFile = join(dir, `${job.id}.out`), rcFile = join(dir, `${job.id}.rc`), script = join(dir, `${job.id}.sh`);
  writeFileSync(promptFile, job.prompt);
  // A worker with `fetch` gathers its data first, in its own tab (visible), then answers over prompt + data.
  const fullFile = join(dir, `${job.id}.full.md`);
  const fetchFile = join(dir, `${job.id}.fetch.sh`);
  // DEMO-SOURCES-VIA-SECRET: a desk command (`eln orchestrate source …`) writes its source records here. A desk that
  // reports «unavailable» ends the worker before any model call — no answer, so no claim, from a desk with no source.
  const sourcesFile = sourcesPath(dir, job.id);
  // `eln` in a fetch command means this tree's CLI (the same universe as the run), never the installed binary by accident.
  if (job.worker.fetch) writeFileSync(fetchFile, `eln() { ${elnCli(env).map(shq).join(' ')} "$@"; }\n${job.worker.fetch}\n`);
  const gather = job.worker.fetch
    ? [`rm -f ${shq(sourcesFile)}`, `export ORCH_SOURCES_FILE=${shq(sourcesFile)}`, `printf '\\033[33m⇣ fetching data…\\033[0m\\n'`, `bash ${shq(fetchFile)} 2>&1 | head -c 12000 | tee ${shq(`${fullFile}.data`)} | head -n 18`,
      `{ cat ${shq(promptFile)}; printf '\\n\\n## Data (fetched just now, %s — treat it as current; cite the sources it names)\\n' \"$(date '+%Y-%m-%d %H:%M %Z')\"; cat ${shq(`${fullFile}.data`)}; } > ${shq(fullFile)}`, `unset ORCH_SOURCES_FILE`,
      `if [ -f ${shq(sourcesFile)} ] && grep -Eq '"status": ?"unavailable"' ${shq(sourcesFile)}; then`,
      `  printf '\\n\\033[1;33m⚠ source unavailable — this desk gives no answer and the brief states nothing from it\\033[0m\\n'`,
      `  printf 'source unavailable\\n' > ${shq(outFile)}; echo 3 > ${shq(rcFile)}`,
      `  printf "\\n\\033[1m[done rc=3 · source unavailable]\\033[0m\\n"`, '  sleep 600', '  exit 3', 'fi',
      `printf '\\n\\033[33m⇡ answering…\\033[0m\\n'`]
    : [`cp ${shq(promptFile)} ${shq(fullFile)}`];
  const model = job.worker.model;
  const kind = job.worker.kind;
  const scrub = kind === 'claude' ? 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDECODE CLAUDE_CODE_ENTRYPOINT'
    : kind === 'codex' ? 'unset OPENAI_API_KEY CODEX_API_KEY' : ':';
  const cli = elnCli(env).map(shq).join(' ');
  const body = kind === 'eln'
    ? `${model ? `ELANOUS_LLM_MODEL=${shq(model)} ` : ''}${cli} llm "$(cat ${shq(fullFile)})" | tee ${shq(outFile)}`
    : kind === 'codex'
      ? `codex exec --skip-git-repo-check --ephemeral -s read-only -C ${shq(dir)} ${model ? `-m ${shq(model)} ` : ''}-o ${shq(`${outFile}.last`)} - < ${shq(fullFile)} 2>&1 | tee ${shq(outFile)}`
      : `claude -p --model ${shq(model ?? 'haiku')} --no-session-persistence --disallowed-tools Bash Edit Write WebFetch WebSearch < ${shq(fullFile)} 2>&1 | tee ${shq(outFile)}`;
  writeFileSync(script, ['#!/bin/bash', `export PATH=${shq(env.PATH ?? '')}`, `export HOME=${shq(env.HOME ?? homedir())}`,
    ...(env.ELANOUS_STATE_DIR ? [`export ELANOUS_STATE_DIR=${shq(env.ELANOUS_STATE_DIR)}`] : []), scrub,
    `printf '\\033[1;36m▶ %s\\033[0m\\n' ${shq(`${job.worker.id} · ${kind}${model ? ` · ${model}` : ''} · ${job.worker.persona ?? job.worker.role}`)}`,
    `printf '\\033[2m%s\\033[0m\\n\\n' ${shq(job.prompt.split('\n').find((l) => l.trim())!.slice(0, 160))}`,
    ...gather, body, 'rc=${PIPESTATUS[0]}', `echo $rc > ${shq(rcFile)}`, 'printf "\\n\\033[1m[done rc=%s]\\033[0m\\n" $rc', 'sleep 600', 'exit $rc', ''].join('\n'));
  return { script, outFile, rcFile };
}

export const sourcesPath = (dir: string, jobId: string): string => join(dir, `${jobId}.sources.json`);
/** The desk result a worker's fetch wrote (undefined for workers without a desk command). */
export function readDesk(dir: string, jobId: string): DeskResult | undefined {
  const p = sourcesPath(dir, jobId);
  return existsSync(p) ? parseDeskResult(readFileSync(p, 'utf8')) : undefined;
}
const errorFor = (code: number): string => code === 124 ? 'timeout' : code === 130 ? 'stopped' : code === 3 ? 'source unavailable' : `exit ${code}`;

function readAnswer(outFile: string): string {
  const raw = existsSync(`${outFile}.last`) ? readFileSync(`${outFile}.last`, 'utf8') : existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  return raw.replace(/\u001b\[[0-9;?]*[A-Za-z]/gu, '').trim();
}

/** The publish node's script: result file + run dir in env, output tee'd for the report. */
export function commandScript(job: { id: string; title: string }, command: string, result: string, dir: string, env: NodeJS.ProcessEnv = process.env, extraEnv: Readonly<Record<string, string>> = {}): { script: string; outFile: string; rcFile: string } {
  mkdirSync(dir, { recursive: true });
  const resultFile = join(dir, 'result.md'), outFile = join(dir, `${job.id}.out`), rcFile = join(dir, `${job.id}.rc`), script = join(dir, `${job.id}.sh`), cmdFile = join(dir, `${job.id}.cmd.sh`);
  writeFileSync(resultFile, result);
  writeFileSync(cmdFile, `${command}\n`);
  writeFileSync(script, ['#!/bin/bash', `export PATH=${shq(env.PATH ?? '')}`, `export HOME=${shq(env.HOME ?? homedir())}`,
    ...(env.ELANOUS_STATE_DIR ? [`export ELANOUS_STATE_DIR=${shq(env.ELANOUS_STATE_DIR)}`] : []),
    `export ORCH_RESULT_FILE=${shq(resultFile)} ORCH_RUN_DIR=${shq(resolve(dir, '..'))}`,
    ...Object.entries(env).filter(([k, v]) => /^ORCH_PUBLISH_[A-Z_]+$/u.test(k) && typeof v === 'string').map(([k, v]) => `export ${k}=${shq(v!)}`),
    ...Object.entries(extraEnv).filter(([k]) => /^ORCH_[A-Z_]+$/u.test(k)).map(([k, v]) => `export ${k}=${shq(v)}`),
    `printf '\\033[1;35m▶ %s\\033[0m\\n\\n' ${shq(job.title)}`, `bash ${shq(cmdFile)} 2>&1 | tee ${shq(outFile)}`, 'rc=${PIPESTATUS[0]}',
    `echo $rc > ${shq(rcFile)}`, 'printf "\\n\\033[1m[done rc=%s]\\033[0m\\n" $rc', 'sleep 600', 'exit $rc', ''].join('\n'));
  return { script, outFile, rcFile };
}

/** SIGTERM the child's whole process group (the worker CLI under `| tee`), then SIGKILL whatever is left after a grace
 *  period — even when the leader (bash) already exited. Resolves once the group is gone, so callers can await the reap. */
export async function killGroup(child: import('node:child_process').ChildProcess, graceMs = 3_000): Promise<void> {
  if (child.pid === undefined) return;
  const pid = child.pid;
  const alive = (): boolean => { try { process.kill(-pid, 0); return true; } catch { return false; } };
  try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  const start = Date.now();
  while (alive() && Date.now() - start < graceMs) await sleep(100);
  if (alive()) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
  while (alive() && Date.now() - start < graceMs + 2_000) await sleep(100);
}

const which = (bin: string): boolean => spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;

export interface ProcessBackendOptions { readonly dir: string; readonly timeoutSec: number; readonly env?: NodeJS.ProcessEnv }

export function headlessBackend(o: ProcessBackendOptions): WorkerBackend {
  const children = new Set<import('node:child_process').ChildProcess>();
  return {
    name: 'headless',
    available: async (kind) => kind === 'eln' || which(kind),
    async run(job, signal) {
      const started = Date.now();
      const { script, outFile } = workerScript(job, o.dir, o.env);
      writeFileSync(script, readFileSync(script, 'utf8').replace(/^\s*sleep 600\n/gmu, ''));
      const child = spawn('bash', [script], { stdio: 'ignore', detached: true });   // own process group: stop reaps the whole pipeline
      children.add(child);
      const code = await new Promise<number>((done) => {
        // Timeout and stop both kill the whole group and then WAIT until the group is gone (nothing orphaned).
        let timedOut = false;
        let reaping: Promise<void> | undefined;
        const kill = (): void => { reaping ??= killGroup(child); };
        const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutSec * 1000);
        signal.addEventListener('abort', kill, { once: true });
        child.on('exit', (c) => { clearTimeout(timer); children.delete(child); void (reaping ?? Promise.resolve()).then(() => done(timedOut ? 124 : c ?? 1)); });
      });
      const text = readAnswer(outFile);
      const source = readDesk(o.dir, job.id);
      return { jobId: job.id, workerId: job.worker.id, kind: job.worker.kind, ok: code === 0 && !!text, text, durationMs: Date.now() - started,
        costUsd: EST_COST_USD[job.worker.kind], pane: 'headless', ...(source ? { source } : {}), ...(code === 0 ? {} : { error: errorFor(code) }) };
    },
    async closeAll() { await Promise.all([...children].map((c) => killGroup(c))); children.clear(); },
    async runCommand(job, command, result, signal, extraEnv) {
      const { script, outFile } = commandScript(job, command, result, o.dir, o.env, extraEnv);
      writeFileSync(script, readFileSync(script, 'utf8').replace('sleep 600\n', ''));
      const child = spawn('bash', [script], { stdio: 'ignore', detached: true });
      children.add(child);
      const code = await new Promise<number>((done) => {
        let timedOut = false;
        let reaping: Promise<void> | undefined;
        const kill = (): void => { reaping ??= killGroup(child); };
        const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutSec * 1000);
        signal.addEventListener('abort', kill, { once: true });
        child.on('exit', (c) => { clearTimeout(timer); children.delete(child); void (reaping ?? Promise.resolve()).then(() => done(timedOut ? 124 : c ?? 1)); });
      });
      return { ok: code === 0, text: existsSync(outFile) ? readFileSync(outFile, 'utf8') : '' };
    },
  };
}

export interface ElsBackendOptions extends ProcessBackendOptions { readonly workspace: string; readonly closeOnFinish?: boolean }

/** One tab per worker in the target els workspace; stop/Ctrl-C closes every tab this run opened. */
export function elsBackend(o: ElsBackendOptions): WorkerBackend & { readonly panes: () => readonly string[] } {
  const panes = new Map<string, string>();
  const fanRuns = new Set<string>();
  const cli = elnCli(o.env);
  const side = (args: string[]) => spawnSync(cli[0]!, [...cli.slice(1), 'side', ...args], { encoding: 'utf8', env: o.env ?? process.env, timeout: 20_000 });
  // Native `els fanout` (ELS-FANOUT-GATHER) when this els has it: same server door as `els new`, one run record per
  // worker, `els gather --close` closes it. Older els → `els new`.
  let fanout: boolean | undefined;
  const hasFanout = (): boolean => (fanout ??= ((r) => r.status === 0 && /--over/u.test(r.stdout ?? ''))(side(['fanout', '--help'])));
  return {
    name: 'els',
    panes: () => [...panes.values()],
    available: async (kind) => kind === 'eln' || which(kind),
    async run(job, signal) {
      const started = Date.now();
      const { script, outFile, rcFile } = workerScript(job, o.dir, o.env);
      let address = `${o.workspace}/${job.title}`;
      if (hasFanout()) {
        const over = join(o.dir, `${job.id}.items`);
        writeFileSync(over, `${script}\n`);
        const r = side(['fanout', '--ws', o.workspace, '--name', job.title, '--over', over, '--cwd', o.dir, '--', 'bash {item}']);
        if (r.status !== 0) throw new Error(`els fanout refused: ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`);
        const runId = /"runId"\s*:\s*"([\w-]+)"/u.exec(r.stdout)?.[1];
        if (runId) fanRuns.add(runId);
        address = `${o.workspace}/${job.title}·1`;
      } else {
        const r = side(['new', '--ws', o.workspace, '--title', job.title, '--cwd', o.dir, '--', 'bash', script]);
        if (r.status !== 0) throw new Error(`els tab did not open: ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`);
        try { address = (JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { address?: string }).address ?? address; } catch { /* keep the name */ }
        panes.set(job.id, address);
      }
      while (!signal.aborted && Date.now() - started < o.timeoutSec * 1000 && !existsSync(rcFile)) await sleep(400);
      const code = existsSync(rcFile) ? Number(readFileSync(rcFile, 'utf8').trim()) : signal.aborted ? 130 : 124;
      const text = readAnswer(outFile);
      const source = readDesk(o.dir, job.id);
      return { jobId: job.id, workerId: job.worker.id, kind: job.worker.kind, ok: code === 0 && !!text, text, durationMs: Date.now() - started,
        costUsd: EST_COST_USD[job.worker.kind], pane: address, ...(source ? { source } : {}), ...(code === 0 ? {} : { error: errorFor(code) }) };
    },
    async runCommand(job, command, result, signal, extraEnv) {
      const { script, outFile, rcFile } = commandScript(job, command, result, o.dir, o.env, extraEnv);
      const r = side(['new', '--ws', o.workspace, '--title', job.title, '--cwd', o.dir, '--', 'bash', script]);
      if (r.status !== 0) throw new Error(`els tab did not open: ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`);
      try { const a = (JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { address?: string }).address; if (a) panes.set(job.id, a); } catch { /* name only */ }
      const started = Date.now();
      while (!signal.aborted && Date.now() - started < o.timeoutSec * 1000 && !existsSync(rcFile)) await sleep(400);
      const code = existsSync(rcFile) ? Number(readFileSync(rcFile, 'utf8').trim()) : 124;
      return { ok: code === 0, text: existsSync(outFile) ? readFileSync(outFile, 'utf8') : '' };
    },
    async closeAll() {
      for (const address of panes.values()) side(['pane', 'close', address]);
      for (const runId of fanRuns) side(['gather', runId, '--close']);
      panes.clear(); fanRuns.clear();
    },
  };
}

/** Seeded sim world. `missing` kinds report unavailable; round 1 answers are short unless `strong`, round 2+ long. */
export interface SimOptions { readonly seed: number; readonly missing?: readonly WorkerKind[]; readonly delayMs?: number; readonly failIds?: readonly string[]; readonly strong?: boolean; readonly votes?: readonly string[] }
export function simBackend(o: SimOptions): WorkerBackend & { readonly launched: string[]; readonly closed: () => number } {
  let x = o.seed >>> 0 || 1;
  const rand = (): number => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 0xffffffff; };
  const launched: string[] = [];
  let closed = 0;
  const live = new Set<string>();
  return {
    name: 'sim', launched, closed: () => closed,
    available: async (kind) => !(o.missing ?? []).includes(kind),
    async run(job, signal) {
      launched.push(job.id); live.add(job.id);
      const delay = Math.floor((o.delayMs ?? 20) * (0.5 + rand()));
      await new Promise<void>((done) => { const t = setTimeout(done, delay); signal.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true }); });
      live.delete(job.id);
      if (signal.aborted) return { jobId: job.id, workerId: job.worker.id, kind: job.worker.kind, ok: false, text: '', durationMs: delay, costUsd: EST_COST_USD[job.worker.kind], error: 'stopped' };
      if ((o.failIds ?? []).includes(job.worker.id)) return { jobId: job.id, workerId: job.worker.id, kind: job.worker.kind, ok: false, text: '', durationMs: delay, costUsd: EST_COST_USD[job.worker.kind], error: 'exit 1' };
      const vote = o.votes?.[launched.length % o.votes.length] ?? ['A', 'A', 'B'][Math.floor(rand() * 3)]!;
      const body = o.strong || job.round > 1 ? `${job.worker.id} analysis (seed ${o.seed}): ${'detailed point. '.repeat(30)}` : `${job.worker.id}: brief.`;
      return { jobId: job.id, workerId: job.worker.id, kind: job.worker.kind, ok: true, text: `${body}\nVOTE: ${vote}`, durationMs: delay, costUsd: EST_COST_USD[job.worker.kind], pane: `sim/${job.title}` };
    },
    async closeAll() { closed += 1; live.clear(); },
  };
}
