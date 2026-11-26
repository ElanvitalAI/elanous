// ORCHESTRATE-MAP-GENERAL — one worker child (eln · codex · claude, or a simulated pane): a bash script that the els pane
// (or a headless child) runs; the answer lands in <dir>/<id>.out and the exit code in <dir>/<id>.rc.
// Extracted from the invest demo (scripts/demo-invest-orch/handlers.ts runPanelCli) so the demo and `eln orchestrate map`
// share one child runner. The demo keeps its own prompt, tab title and answer parsing.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type WorkerRuntime = 'eln' | 'codex' | 'claude';
export const WORKER_RUNTIMES: readonly WorkerRuntime[] = ['eln', 'codex', 'claude'];
export const REPO_ROOT = resolve(import.meta.dir, '../..');

export interface WorkerBinding { readonly runtime: WorkerRuntime; readonly model?: string; readonly provider?: string }
export interface WorkerScriptOptions {
  readonly id: string;
  readonly label: string;
  readonly binding: WorkerBinding;
  readonly prompt: string;
  readonly dir: string;
  /** Simulated answer: the pane prints it line by line over `simDelayMs` (rehearsal · tests). */
  readonly simulated?: string;
  readonly simDelayMs?: number;
  /** Simulated exit code (tests of failure edges). */
  readonly simExit?: number;
}
export interface WorkerFiles { readonly script: string; readonly outFile: string; readonly rcFile: string; readonly promptFile: string }

const shq = (s: string) => `'${s.replace(/'/gu, `'\\''`)}'`;

/** Which CLI a runtime needs on PATH (eln runs through this tree's bun). */
export const runtimeBinary = (runtime: WorkerRuntime): string => runtime === 'eln' ? 'bun' : runtime;

export function binaryOnPath(bin: string, path = process.env.PATH ?? ''): boolean {
  return path.split(':').some((d) => d && existsSync(join(d, bin)));
}

export function writeWorkerScript(o: WorkerScriptOptions): WorkerFiles {
  mkdirSync(o.dir, { recursive: true });
  const { id, binding } = o;
  const promptFile = join(o.dir, `${id}.prompt.md`), outFile = join(o.dir, `${id}.out`), rcFile = join(o.dir, `${id}.rc`), script = join(o.dir, `${id}.sh`);
  writeFileSync(promptFile, o.prompt);
  const scrub = binding.runtime === 'claude' ? 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDECODE CLAUDE_CODE_ENTRYPOINT'
    : binding.runtime === 'codex' ? 'unset OPENAI_API_KEY CODEX_API_KEY' : ':';
  const model = binding.model;
  let body: string;
  if (o.simulated !== undefined) {
    writeFileSync(join(o.dir, `${id}.sim.txt`), o.simulated);
    const lines = Math.max(1, o.simulated.split('\n').length);
    body = `while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; sleep ${Math.max(0.02, (o.simDelayMs ?? 1500) / 1000 / lines).toFixed(3)}; done < ${shq(join(o.dir, `${id}.sim.txt`))} | tee ${shq(outFile)}${o.simExit ? `; (exit ${o.simExit})` : ''}`;
  } else if (binding.runtime === 'eln') {
    const env = [binding.provider ? `ELANOUS_LLM_PROVIDER=${shq(binding.provider)}` : '', model ? `ELANOUS_LLM_MODEL=${shq(model)}` : ''].filter(Boolean).join(' ');
    body = `${env} bun ${shq(join(REPO_ROOT, 'bin/elanous.mjs'))} llm --json "$(cat ${shq(promptFile)})" | tee ${shq(outFile)}`;
  } else if (binding.runtime === 'codex') {
    body = `CODEX_HOME=${shq(process.env.INVEST_DEMO_CODEX_HOME ?? process.env.ORCHESTRATE_CODEX_HOME ?? join(homedir(), '.codex-third-owner'))} codex exec --skip-git-repo-check --ephemeral -s read-only -C ${shq(o.dir)} ${model ? `-m ${shq(model)} ` : ''}-o ${shq(`${outFile}.last`)} - < ${shq(promptFile)} 2>&1 | tee ${shq(outFile)}`;
  } else {
    body = `claude -p --model ${shq(model ?? 'haiku')} --no-session-persistence --disallowed-tools Bash Edit Write WebFetch WebSearch < ${shq(promptFile)} 2>&1 | tee ${shq(outFile)}`;
  }
  // `(exit n)` after a pipe sets PIPESTATUS[0] only for the pipe itself; a simulated failure records its own code.
  const rcLine = o.simulated !== undefined && o.simExit ? `rc=${o.simExit}` : 'rc=${PIPESTATUS[0]}';
  writeFileSync(script, ['#!/bin/bash', `export PATH=${shq(process.env.PATH ?? '')}`, `export HOME=${shq(homedir())}`,
    ...(process.env.ELANOUS_STATE_DIR ? [`export ELANOUS_STATE_DIR=${shq(process.env.ELANOUS_STATE_DIR)}`] : []), scrub,
    `printf '\\033[1m▶ %s\\033[0m\\n' ${shq(`${o.label} · ${binding.runtime}${model ? ` · ${model}` : ''}${o.simulated !== undefined ? ' · simulated' : ''}`)}`,
    `printf '%s\\n\\n' ${shq(o.prompt.split('\n')[0]!.slice(0, 120))}`, body, rcLine, `echo $rc > ${shq(rcFile)}`, 'printf "\\n[done rc=%s]\\n" $rc', ''].join('\n'));
  return { script, outFile, rcFile, promptFile };
}

export interface ElsLaunch {
  /** The CLI that runs `side new` (this tree's by default). */
  readonly cli: readonly string[];
  readonly ws: string;
  readonly title: string;
  readonly env: NodeJS.ProcessEnv;
}
export interface WorkerRun { readonly code: number; readonly pane: string; readonly tab?: string; readonly durationMs: number; readonly raw: string; readonly elsError?: string }

interface Exec { code: number; stdout: string; stderr: string }
export function execCli(cmd: string, args: readonly string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<Exec> {
  return new Promise((done) => {
    execFile(cmd, [...args], { env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => done({ code: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run a written worker script: in an els tab when `els` is given and the tab opens, else headless.
 * `signal` aborts the wait (and kills a headless child). Exit 124 = timed out.
 */
export async function runWorkerScript(files: WorkerFiles, o: { readonly timeoutMs: number; readonly cwd: string; readonly els?: ElsLaunch; readonly signal?: AbortSignal; readonly onTab?: (tab: string) => void }): Promise<WorkerRun> {
  const started = Date.now();
  let pane = 'headless', tab: string | undefined, elsError: string | undefined;
  if (o.els) {
    const r = await execCli(o.els.cli[0]!, [...o.els.cli.slice(1), 'side', 'new', '--ws', o.els.ws, '--title', o.els.title, '--cwd', o.cwd, '--', 'bash', files.script], { timeoutMs: 15_000, env: o.els.env });
    if (r.code === 0) {
      try {
        const j = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { address?: string; pane?: string; tab?: string };
        pane = `els:${j.address ?? `${o.els.ws}/${o.els.title}`}`; tab = j.tab ?? j.address?.split('/')[1] ?? j.pane;
      } catch { pane = `els:${o.els.ws}/${o.els.title}`; }
      if (tab) o.onTab?.(tab);
    } else elsError = (r.stderr || r.stdout).trim().slice(0, 200) || `side new exit ${r.code}`;
  }
  let code = 1;
  if (pane === 'headless') {
    const child: ChildProcess = spawn('bash', [files.script], { stdio: 'ignore' });
    code = await new Promise<number>((done) => {
      const kill = () => { child.kill('SIGTERM'); done(130); };
      const timer = setTimeout(() => { child.kill('SIGTERM'); done(124); }, o.timeoutMs);
      o.signal?.addEventListener('abort', () => { clearTimeout(timer); kill(); }, { once: true });
      child.on('exit', (c) => { clearTimeout(timer); done(c ?? 1); });
      child.on('error', () => { clearTimeout(timer); done(127); });
    });
    // The script records the worker's own exit code (the script itself ends on a printf).
    if (code === 0 && existsSync(files.rcFile)) code = Number(readFileSync(files.rcFile, 'utf8').trim()) || 0;
  } else {
    while (Date.now() - started < o.timeoutMs && !existsSync(files.rcFile) && !o.signal?.aborted) await sleep(250);
    code = existsSync(files.rcFile) ? Number(readFileSync(files.rcFile, 'utf8').trim()) : o.signal?.aborted ? 130 : 124;
  }
  const raw = existsSync(`${files.outFile}.last`) ? readFileSync(`${files.outFile}.last`, 'utf8') : existsSync(files.outFile) ? readFileSync(files.outFile, 'utf8') : '';
  return { code, pane, ...(tab ? { tab } : {}), durationMs: Date.now() - started, raw, ...(elsError ? { elsError } : {}) };
}

/** The answer text and model a runtime's raw output carries (eln prints a JSON envelope; codex names its model). */
export function parseWorkerOutput(runtime: WorkerRuntime, raw: string, outFileText = ''): { text: string; model?: string } {
  if (runtime === 'eln') {
    for (const line of raw.trim().split('\n').reverse()) {
      try { const j = JSON.parse(line) as { reply?: string; model?: string; provider?: string }; if (j?.reply) return { text: j.reply, model: `${j.provider ?? ''}/${j.model ?? ''}` }; } catch { /* not the envelope */ }
    }
    return { text: raw };
  }
  if (runtime === 'codex') { const m = /^model:\s*(\S+)/mu.exec(outFileText); return { text: raw, ...(m ? { model: m[1]! } : {}) }; }
  return { text: raw };
}
