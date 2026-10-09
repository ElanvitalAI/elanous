#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../../src/debug/log.js';
import {
  defaultGitMergeSeam, defaultLlmResolve, mergeMainWithLlmResolve,
  type MergeGitSeam,
} from '../../src/autopilot/build/llm-conflict-merge.js';

type Command = (cwd: string, program: 'git' | 'gh', args: readonly string[]) => { status: number; stdout: string; stderr: string };
export type ShadowOutcome = 'clean' | 'resolved-deterministic' | 'resolved-llm' | 'unresolved' | 'unmeasured';
export interface ShadowRow { pr: number; outcome: ShadowOutcome; files: string[]; durationMs: number }
interface Draft { number: number; headRefName: string; isDraft: boolean; mergeable: string | boolean | null }

export interface ShadowOptions {
  repo: string;
  stateRoot: string;
  limit?: number;
  run?: Command;
  git?: MergeGitSeam;
  resolve?: (file: string, conflicted: string) => Promise<string>;
  log?: (line: string) => void;
  now?: () => number;
}

export const runCommand: Command = (cwd, program, args) => {
  const result = spawnSync(program, [...args], { cwd, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') };
};

function mustRun(run: Command, cwd: string, program: 'git' | 'gh', args: readonly string[]): string {
  const result = run(cwd, program, args);
  if (result.status !== 0) throw new Error(`${program} ${args.slice(0, 3).join(' ')}: ${result.stderr || 'failed'}`);
  return result.stdout;
}

/** Use the same harness ownership boundary as the draft sweep; never touch a non-harness PR. */
export function conflictingHarnessDrafts(json: string): Draft[] {
  const rows: unknown = JSON.parse(json);
  if (!Array.isArray(rows)) throw new Error('gh PR inventory is not an array');
  if (rows.some((row) => !row || typeof row !== 'object' || !Number.isSafeInteger(row.number)
    || row.number <= 0 || typeof row.headRefName !== 'string' || typeof row.isDraft !== 'boolean'
    || !('mergeable' in row) || !['string', 'boolean'].includes(typeof row.mergeable) && row.mergeable !== null)) {
    throw new Error('gh PR inventory is incomplete');
  }
  return (rows as Draft[]).filter((row) => row.isDraft && row.headRefName.startsWith('self-impl/')
    && (row.mergeable === 'CONFLICTING' || row.mergeable === false));
}

/** GitHub 는 병합 가능 여부를 늦게 계산한다 — 첫 조회에 UNKNOWN 이면 «충돌 0»이 아니라 «아직 못 잼»이다(10-05 첫 운영 실행이 조용히 0). */
export function unknownMergeableDrafts(json: string): number {
  const rows = JSON.parse(json) as Draft[];
  return rows.filter((row) => row.isDraft && row.headRefName.startsWith('self-impl/') && (row.mergeable === 'UNKNOWN' || row.mergeable === null)).length;
}

export function shadowSummary(rows: readonly ShadowRow[]): string {
  const measured = rows.filter((row) => row.outcome !== 'unmeasured');
  const recoverable = measured.filter((row) => row.outcome !== 'unresolved').length;
  return `충돌 draft ${measured.length} 중 살릴 수 있음 ${recoverable} = ${measured.length ? Math.round(recoverable / measured.length * 100) : 0}%`;
}

/** Shadow only: fetch a PR snapshot, detach it outside the repo, simulate merging fresh origin/main, then discard it. */
export async function runResyncShadow(options: ShadowOptions): Promise<ShadowRow[]> {
  const { repo, stateRoot, limit = 10, run = runCommand, log = console.log, now = Date.now } = options;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
  const rows: ShadowRow[] = [];
  const output = join(stateRoot, 'smart-merge', 'resync-shadow.jsonl');
  const record = (row: ShadowRow): void => {
    mkdirSync(dirname(output), { recursive: true });
    appendFileSync(output, `${JSON.stringify(row)}\n`);
    rows.push(row);
    debug.log('smart-merge.resync', 'shadow-result', { pr: row.pr, outcome: row.outcome, files: row.files });
  };
  let drafts: Draft[];
  try {
    // gh's mergeable GraphQL field is CONFLICTING/MERGEABLE/UNKNOWN (some adapters return false/true).
    const inventory = mustRun(run, repo, 'gh', [
      'pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,isDraft,headRefName,mergeable',
    ]);
    drafts = conflictingHarnessDrafts(inventory).slice(0, limit);
    const unknown = unknownMergeableDrafts(inventory);
    if (unknown) log(`병합 가능 여부 미계산 draft ${unknown} — GitHub 계산 뒤 다시 돌려라(이번 수에 안 들어감)`);
  } catch (error) {
    log(`못 잼: GitHub draft 조회 실패 (${String(error)})`);
    log(shadowSummary(rows));
    return rows;
  }
  for (const draft of drafts) {
    const start = now();
    let temp: string | undefined;
    let attached = false;
    let outcome: ShadowOutcome = 'unmeasured';
    let files: string[] = [];
    try {
      // refs/pull/N/head supports fork heads too; FETCH_HEAD is consumed before the next fetch.
      mustRun(run, repo, 'git', ['fetch', 'origin', `refs/pull/${draft.number}/head`]);
      temp = mkdtempSync(join(tmpdir(), 'elanous-resync-shadow-'));
      mustRun(run, repo, 'git', ['worktree', 'add', '--detach', temp, 'FETCH_HEAD']);
      attached = true;
      const seam = options.git ?? defaultGitMergeSeam();
      const observedGit: MergeGitSeam = {
        ...seam,
        conflictedFiles: (wt) => { files = seam.conflictedFiles(wt); return files; },
      };
      const result = await mergeMainWithLlmResolve(temp, 'origin/main',
        options.resolve ?? ((file, conflicted) => defaultLlmResolve(file, conflicted, 'origin/main', { worktreePath: temp })), observedGit);
      if (result.status === 'merged' || result.status === 'up-to-date') outcome = 'clean';
      else if (result.status === 'deterministic-resolved') {
        files = result.resolvedFiles ?? files;
        outcome = 'resolved-deterministic';
      } else if (result.status === 'llm-resolved') {
        files = result.resolvedFiles ?? files;
        outcome = 'resolved-llm';
      } else if (result.status === 'conflict-unresolved') outcome = 'unresolved';
      // A git error is a measurement failure, not evidence of an unresolvable conflict.
    } catch {
      outcome = 'unmeasured';
    } finally {
      if (attached && temp) {
        try { mustRun(run, repo, 'git', ['worktree', 'remove', '--force', temp]); }
        catch { outcome = 'unmeasured'; }
      }
      if (temp) {
        try { rmSync(temp, { recursive: true, force: true }); }
        catch { outcome = 'unmeasured'; }
      }
      record({ pr: draft.number, outcome, files, durationMs: Math.max(0, now() - start) });
    }
  }
  log(shadowSummary(rows));
  return rows;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valid = args.length === 0 || args.length === 2 && args[0] === '--limit' && /^[1-9]\d*$/.test(args[1]!);
  if (!valid) {
    console.error('usage: bun scripts/smart-merge/resync-shadow.ts [--limit N]');
    process.exitCode = 2;
  } else {
    await runResyncShadow({
      repo: mustRun(runCommand, process.cwd(), 'git', ['rev-parse', '--show-toplevel']).trim(),
      stateRoot: process.env.ELANOUS_STATE_DIR || join(homedir(), '.elanous'),
      ...(args.length ? { limit: Number(args[1]) } : {}),
    });
  }
}
