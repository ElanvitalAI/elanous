#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { release } from 'node:os';

export const FILE_TIMEOUT_MS = 300_000;
export type Execution = { rc: number | null; stdout: string; stderr: string; secs: number; timedOut: boolean };
export type Executor = (file: string, timeoutMs: number) => Promise<Execution>;
export type Measurement = {
  file: string; rc: number | null; pass: number | null; fail: number | null; skip: number | null;
  secs: number; platform: string; release: string; verdict: 'pass' | 'fail' | 'skip' | '못 잼';
};

export const TIMEOUT_EXIT_GRACE_MS = 5_000;

// The wrapper handles SIGTERM by stopping its detached test group. Do not
// start another file until the wrapper closes, even after SIGKILL.
export function execute(
  file: string,
  timeoutMs: number,
  deps: {
    spawnChild?: typeof spawn;
    signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
    graceMs?: number;
  } = {},
): Promise<Execution> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = (deps.spawnChild ?? spawn)('bun', ['run', 'test:deterministic', file], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let closed = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let terminationCheck: ReturnType<typeof setTimeout> | undefined;
    const seconds = () => Math.round((performance.now() - started) / 1000 * 100) / 100;
    const signal = (name: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { (deps.signalGroup ?? ((pid, sig) => process.kill(-pid, sig)))(child.pid, name); }
      catch (groupError) {
        try { child.kill(name); }
        catch (directError) { stderr += `\n${name} failed: ${String(groupError)}; ${String(directError)}`; }
      }
    };
    // Bun's summary is at the end; bounded capture avoids an unbounded memory cost.
    const collect = (previous: string, chunk: Buffer) => (previous + chunk.toString('utf8')).slice(-256_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk); });
    const graceMs = deps.graceMs ?? TIMEOUT_EXIT_GRACE_MS;
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      escalation = setTimeout(() => {
        if (closed) return;
        signal('SIGKILL');
        terminationCheck = setTimeout(() => {
          if (!closed) reject(new Error(`Cannot confirm termination of timed-out test: ${file}; stopping measurements`));
        }, graceMs);
      }, graceMs);
    }, timeoutMs);
    child.on('error', (error) => { stderr += `\n${error.message}`; });
    child.on('close', (code) => {
      closed = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (terminationCheck) clearTimeout(terminationCheck);
      resolve({ rc: timedOut ? null : code, stdout, stderr, secs: seconds(), timedOut });
    });
  });
}

export async function measureList(files: readonly string[], runner: Executor = execute): Promise<Measurement[]> {
  const measurements: Measurement[] = [];
  for (const file of files) {
    const result = await runner(file, FILE_TIMEOUT_MS);
    const output = `${result.stdout}\n${result.stderr}`;
    const count = (kind: 'pass' | 'fail' | 'skip'): number | null => {
      const matches = [...output.matchAll(new RegExp(`^\\s*(\\d+) ${kind}\\b`, 'gm'))];
      return matches.length ? Number(matches.at(-1)![1]) : null;
    };
    const pass = result.timedOut ? null : count('pass');
    const fail = result.timedOut ? null : count('fail');
    const skip = result.timedOut ? null : count('skip');
    const measured = pass !== null || fail !== null || skip !== null;
    const verdict = result.timedOut || !measured || result.rc === null ? '못 잼'
      : fail !== null && fail > 0 ? 'fail'
      : result.rc !== 0 ? '못 잼'
      : skip !== null && skip > 0 ? 'skip'
      : pass !== null && pass > 0 ? 'pass' : '못 잼';
    measurements.push({ file, rc: result.rc, pass, fail, skip, secs: result.secs, platform: process.platform, release: release(), verdict });
  }
  return measurements;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== '--json')) {
    console.error('usage: bun scripts/test-diet/remeasure-list.ts <목록 파일> [--json]');
    process.exitCode = 2;
  } else {
    try {
      const files = readFileSync(args[0]!, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
      if (!files.length) throw new Error('empty test list');
      const results = await measureList(files);
      if (args[1] === '--json') console.log(JSON.stringify(results, null, 2));
      else for (const row of results) console.log([row.file, row.rc ?? 'null', row.pass ?? '?', row.fail ?? '?', row.skip ?? '?', row.secs, row.platform, row.release, row.verdict].join('\t'));
    } catch (error) {
      console.error(error);
      process.exitCode = 2;
    }
  }
}
