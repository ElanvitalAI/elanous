#!/usr/bin/env bun
// 현장 피드 시작 — `bun scripts/field-feed/start.ts <현장폴더>`
// ① graphs/field/field-feed.yaml 런을 띄운다(reel → feed → post 에서 «게시 대기»로 멈춘다)
// ② 멈췄으면 «결정 대기자»를 떼어 띄운다: 15초마다 `graph run --resume <runId>` — 결정이 기록되기 전엔 같은 자리에 다시 멈추고,
//    «최종 게시»(approved)가 기록되면 deliver 까지, 거절이면 failed 로 끝난다. 48시간 뒤 스스로 그만둔다.
// `--wait <runId>` 는 그 대기자 자신(직접 부르지 않는다).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../../src/debug/log.js';

const ROOT = resolve(import.meta.dir, '../..');
const GRAPH = join(ROOT, 'graphs', 'field', 'field-feed.yaml');
const CLI = join(ROOT, 'bin', 'elanous.mjs');
type State = { runId?: string; status?: string; pending?: { decision?: string } };

function graphRun(args: string[]): State {
  const r = spawnSync(process.execPath, [CLI, 'graph', 'run', GRAPH, '--json', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const line = r.stdout.trim().split('\n').reverse().find((l) => l.startsWith('{'));
  if (!line) throw new Error(`graph run: 결과 없음 rc=${r.status} ${r.stderr.slice(-300)}`);
  return JSON.parse(line) as State;
}

const argv = process.argv.slice(2);
const waitAt = argv.indexOf('--wait');
if (waitAt >= 0) {
  const runId = argv[waitAt + 1]!;
  const deadline = Date.now() + 48 * 3600e3;
  let state: State = { status: 'awaiting-approval' };
  while (Date.now() < deadline) {
    await Bun.sleep(15000);
    try { state = graphRun(['--resume', runId]); } catch (error) {
      debug.log('field.feed', 'resume-error', { runId, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (state.status !== 'awaiting-approval') break;
  }
  debug.log('field.feed', 'wait-ended', { runId, status: state.status ?? 'unknown', timedOut: state.status === 'awaiting-approval' });
  console.log(`field-feed ${runId}: ${state.status}`);
  process.exit(0);
}

const folderArg = argv.find((a) => !a.startsWith('--'));
if (!folderArg) { console.error('usage: bun scripts/field-feed/start.ts <현장폴더>'); process.exit(2); }
const folder = resolve(folderArg.replace(/^~(?=\/)/, homedir()));
if (!existsSync(folder)) { console.error(`현장 폴더 없음: ${folder}`); process.exit(2); }
const started = Date.now();
const state = graphRun(['--input', JSON.stringify({ folder })]);
const seconds = Math.round((Date.now() - started) / 1000);
debug.log('field.feed', 'started', { runId: state.runId, status: state.status, seconds });
if (state.status === 'awaiting-approval' && state.runId) {
  const logDir = join(folder, 'feed');
  mkdirSync(logDir, { recursive: true });
  const out = openSync(join(logDir, 'wait.log'), 'a');
  const child = spawn(process.execPath, [import.meta.path, '--wait', state.runId], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  console.log(`field-feed ${state.runId}: 게시 대기 (${seconds}s) · 초안 ${join(folder, 'feed', 'feed-draft.json')} · 결정 대기자 pid ${child.pid}`);
} else {
  console.log(`field-feed ${state.runId}: ${state.status} (${seconds}s)`);
  if (state.status !== 'done') process.exitCode = 1;
}
