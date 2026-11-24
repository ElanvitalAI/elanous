// MEMORY-STORE-SPLIT (0.3.35 P0) — CLI · 세션 시작 색인 · memory_save 가 «같은» 저장소를 쓰는지 시험 우주에서 잰다.
// ① 자리: `ELANOUS_TRACK=OP eln memory add` → 자리 저장소 파일 → `memory seat-index OP` 에 보임 → 자리 세션 시작 색인에 실림.
// ② 일반 사용자(본부 배치 없음): clone ⊕ worktree 2 — worktree A 의 memory_save → worktree B 세션 시작 색인에 보임 · 무관한 저장소엔 안 보임.
// 기대값은 제품 상수를 쓰지 않은 독립 리터럴이다.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { simCli } from '../ux-sim/in-process-cli.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSeatMemoryIndexSystemMessages, resetSeatBootCacheForTest, resolveSessionMemoryStore } from '../seat/seat-boot-preamble.js';
import { applySeatMemoryTools } from './seat-memory-tools.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';

const roots: string[] = [];
const world = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `mem-split-${p}-`))); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

let oldState: string | undefined;
let oldTrack: string | undefined;
beforeEach(() => { oldState = process.env.ELANOUS_STATE_DIR; oldTrack = process.env.ELANOUS_TRACK; delete process.env.ELANOUS_TRACK; resetSeatBootCacheForTest(); });
afterEach(() => {
  if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
  if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
  resetSeatBootCacheForTest();
});

const MEMORY_PATHS = [['memory', 'add'], ['memory', 'seat-index'], ['memory', 'where'], ['memory', 'list']] as const;
const cli = async (args: string[], cwd: string, state: string, env: Record<string, string>) => {
  const r = await simCli(['memory', ...args], { mode: 'spawn', stateRoot: state, cwd, env, allowPaths: MEMORY_PATHS, timeoutMs: 60_000 });
  console.log(`시험 우주 eln memory ${args.join(' ')} (cwd ${cwd}) rc=${r.exitCode}\n${r.stdout}${r.stderr}`);
  return r;
};

test('seat: ELANOUS_TRACK=OP eln memory add → seat store file → seat-index shows it → seat session start index includes it', async () => {
  const root = world('seat');
  const state = join(root, 'state');
  const home = join(root, 'home');
  const elsewhere = join(root, 'plain-dir');
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
  const seatCwd = join(home, 'elanous-hq', 'seats', 'OP');
  mkdirSync(seatCwd, { recursive: true });
  const env = { HOME: home, ELANOUS_TRACK: 'OP' };

  const add = await cli(['add', 'feedback', 'split-proof-1124', 'quickpass publish order stands'], elsewhere, state, env);
  expect(add.exitCode).toBe(0);
  const file = join(state, 'elanous', 'memory', 'seats', 'OP', 'split-proof-1124.md');
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, 'utf8')).toContain('quickpass publish order stands');

  const index = await cli(['seat-index', 'OP'], elsewhere, state, { HOME: home });
  expect(index.exitCode).toBe(0);
  expect(index.stdout).toContain('- [split-proof-1124](split-proof-1124.md) — quickpass publish order stands');

  const where = await cli(['where'], elsewhere, state, env);
  expect(where.stdout).toContain('store        seat OP');
  expect(where.stdout).toContain(join(state, 'elanous', 'memory', 'seats', 'OP'));

  const list = await cli(['list'], elsewhere, state, env);
  expect(list.stdout).toContain('split-proof-1124');

  // 자리 세션(els 가 ELANOUS_STATE_DIR 을 찍어 준 프로세스)의 세션 시작 색인.
  process.env.ELANOUS_STATE_DIR = state;
  const block = buildSeatMemoryIndexSystemMessages({ cwd: seatCwd }, { home, env: {}, msgPath: join(home, 'msg.db') });
  expect(block).toHaveLength(1);
  expect(String(block[0]!.content)).toContain('- [split-proof-1124](split-proof-1124.md) — quickpass publish order stands');
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

test('general user (no seats/ · no seat-state): clone + 2 worktrees share one project store; unrelated repo does not', async () => {
  const root = world('general');
  const state = join(root, 'state');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '-q');
  writeFileSync(join(origin, 'README.md'), 'x\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-q', '-m', 'init');
  const clone = join(root, 'app');
  git(root, 'clone', '-q', origin, clone);
  const wtA = join(root, 'app-wt-a');
  const wtB = join(root, 'app-wt-b');
  git(clone, 'worktree', 'add', '-q', '-b', 'a', wtA);
  git(clone, 'worktree', 'add', '-q', '-b', 'b', wtB);
  const other = join(root, 'other');
  mkdirSync(other);
  git(other, 'init', '-q');
  process.env.ELANOUS_STATE_DIR = state;
  const deps = { home, env: {}, msgPath: join(home, 'msg.db') };

  const targetA = resolveSessionMemoryStore(wtA, deps);
  expect(targetA?.store.kind).toBe('project');
  const specs: LLMToolSpec[] = [{ name: 'memory_save', description: 'global', parameters: { type: 'object', properties: {} } }];
  const dispatch = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  applySeatMemoryTools(specs, dispatch, { seat: targetA!.seat, dir: targetA!.dir });
  expect(await dispatch.get('memory_save')!({ name: 'deploy-uses-port-8080', description: 'deploy on port 8080', type: 'project', body: 'The app deploys on port 8080.' }))
    .toMatchObject({ saved: true, action: 'created', name: 'deploy-uses-port-8080' });

  const inB = buildSeatMemoryIndexSystemMessages({ cwd: wtB }, deps);
  expect(inB).toHaveLength(1);
  expect(String(inB[0]!.content)).toContain('- [deploy-uses-port-8080](deploy-uses-port-8080.md) — deploy on port 8080');
  resetSeatBootCacheForTest();
  expect(buildSeatMemoryIndexSystemMessages({ cwd: clone }, deps).map(m => String(m.content)).join('')).toContain('deploy-uses-port-8080');
  resetSeatBootCacheForTest();
  expect(buildSeatMemoryIndexSystemMessages({ cwd: other }, deps).map(m => String(m.content)).join('')).not.toContain('deploy-uses-port-8080');

  // CLI 도 같은 저장소를 본다(worktree B 에서).
  const list = await cli(['list'], wtB, state, { HOME: home });
  expect(list.stdout).toContain('deploy-uses-port-8080');
  const where = await cli(['where'], other, state, { HOME: home });
  expect(where.stdout).toContain('store        project PROJECT-OTHER-');
});
