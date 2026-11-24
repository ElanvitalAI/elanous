// SEAT-COMMON-MEMORY (0.3.35 P0) — 본부 자리 공통 기억 층(`<기억 뿌리>/seats/_common`) ⊕ 계약 공통 교훈 5줄.
// ① 손 자리(TC-H-CX-7) 세션 시작 색인 = 공통 교훈 줄이 자리 줄보다 앞 · ② memory_search 가 공통 교훈을 찾는다(자리 먼저)
// ③ 프롬프트 스냅숏에 5줄이 정확히 한 번 · ④ `eln memory promote <name> --to common` 이 파일 ⊕ 색인 줄을 복사(OP 만)
// ⑤ 일반 사용자(자리 없음)는 공통 층을 읽지 않는다. 기대값은 제품 상수를 쓰지 않은 독립 리터럴이다.
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';
import { buildSeatMemoryIndexSystemMessages, resetSeatBootCacheForTest, resolveSessionMemoryStore } from '../seat/seat-boot-preamble.js';
import { applySeatMemoryTools } from './seat-memory-tools.js';
import type { LLMToolSpec } from '../llm/tool-spec.js';
import { buildUniversalPreamble, resetUniversalPreambleCache, setGlobalAnchorPathForTest } from '../prompt-library/universal-preamble.js';

const roots: string[] = [];
const world = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `mem-common-${p}-`))); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

let oldState: string | undefined;
let oldTrack: string | undefined;
beforeEach(() => { oldState = process.env.ELANOUS_STATE_DIR; oldTrack = process.env.ELANOUS_TRACK; delete process.env.ELANOUS_TRACK; resetSeatBootCacheForTest(); });
afterEach(() => {
  if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = oldState;
  if (oldTrack === undefined) delete process.env.ELANOUS_TRACK; else process.env.ELANOUS_TRACK = oldTrack;
  resetSeatBootCacheForTest();
});

const memoryFile = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\ntype: feedback\n---\n\n${body}\n`;

/** 공통 층 한 줄 ⊕ 손 자리 한 줄을 깐다. */
function seedStores(memRoot: string): void {
  const common = join(memRoot, 'seats', '_common');
  mkdirSync(common, { recursive: true });
  writeFileSync(join(common, 'measure-it-yourself.md'), memoryFile('measure-it-yourself', 'measure it yourself, never end unverified', 'If you can measure it, measure it yourself. Why: unverified endings stall the federation.'));
  writeFileSync(join(common, 'MEMORY.md'), '- ⭐⭐[measure it yourself · never end unverified](measure-it-yourself.md)\n');
  const own = join(memRoot, 'seats', 'TC-H-CX-7');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'gate-on-minim5.md'), memoryFile('gate-on-minim5', 'run focused tests on minim5', 'Focused tests run on minim5, not mshq.'));
  writeFileSync(join(own, 'MEMORY.md'), '- [gate-on-minim5](gate-on-minim5.md) — run focused tests on minim5\n');
}

test('hand seat TC-H-CX-7: session start index carries the _common lesson line before its own line', () => {
  const root = world('hand');
  const memRoot = join(root, 'mem');
  const home = join(root, 'home');
  const seatCwd = join(home, 'elanous-hq', 'seats', 'TC-H-CX-7');
  mkdirSync(seatCwd, { recursive: true });
  seedStores(memRoot);
  const deps = { home, env: {}, msgPath: join(home, 'msg.db'), seatMemoryRoot: memRoot };

  const target = resolveSessionMemoryStore(seatCwd, deps);
  expect(target?.seat).toBe('TC-H-CX-7');
  expect(target?.commonDir).toBe(join(memRoot, 'seats', '_common'));

  const msgs = buildSeatMemoryIndexSystemMessages({ cwd: seatCwd }, deps);
  expect(msgs).toHaveLength(1);
  const content = String(msgs[0]!.content);
  const commonAt = content.indexOf('- ⭐⭐[measure it yourself · never end unverified](measure-it-yourself.md)');
  const ownAt = content.indexOf('- [gate-on-minim5](gate-on-minim5.md) — run focused tests on minim5');
  expect(commonAt).toBeGreaterThanOrEqual(0);
  expect(ownAt).toBeGreaterThan(commonAt);
  expect(content).toContain('_common');
});

test('memory_search finds a common lesson (own hits first, common tagged store=common)', async () => {
  const root = world('search');
  const memRoot = join(root, 'mem');
  seedStores(memRoot);
  const specs: LLMToolSpec[] = [];
  const dispatch = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  applySeatMemoryTools(specs, dispatch, { seat: 'TC-H-CX-7', dir: join(memRoot, 'seats', 'TC-H-CX-7'), commonDir: join(memRoot, 'seats', '_common') });

  const common = await dispatch.get('memory_search')!({ query: 'measure unverified' }) as { hits: Array<{ name: string; store: string }> };
  expect(common.hits.map(h => [h.name, h.store])).toEqual([['measure-it-yourself', 'common']]);

  // 자리 기억과 공통 교훈이 같이 맞으면 자리 쪽이 먼저다.
  writeFileSync(join(memRoot, 'seats', 'TC-H-CX-7', 'measure-gate-time.md'), memoryFile('measure-gate-time', 'measure gate time yourself', 'Measure gate time on minim5.'));
  const both = await dispatch.get('memory_search')!({ query: 'measure yourself' }) as { hits: Array<{ name: string; store: string }> };
  expect(both.hits.map(h => h.store)).toEqual(['seat', 'common']);
  expect(both.hits[0]!.name).toBe('measure-gate-time');
});

test('prompt snapshot: the 5 common lesson lines appear exactly once for coordinator and hand seats, never for non-seats', () => {
  const root = world('prompt');
  const cwd = join(root, 'seats', 'TC-H-CX-7');
  mkdirSync(cwd, { recursive: true });
  setGlobalAnchorPathForTest(null);
  resetUniversalPreambleCache();
  try {
    const lines = [
      '- Measure what you can measure yourself; never end a turn with «unverified».',
      '- A blocked turn must end in coordinate (hand off + reply waker) or create (open a gap cell + assign) — no excuse endings.',
      '- Missing command/tool → open a capability-gap cell in the same turn and continue via a workaround.',
      '- Expected events (your cadence, replies you wait for) late by 10 min → do it yourself or chase once, then reassign.',
      "- Commitments close automatically; don't hunt for a close command.",
    ];
    const count = (hay: string, needle: string) => hay.split(needle).length - 1;
    for (const seatRole of ['coordinator', 'hand'] as const) {
      const out = buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'], seatRole }).map(m => String(m.content)).join('\n\n');
      expect(count(out, 'Common lessons (all seats)\n')).toBe(1);
      for (const line of lines) expect(count(out, line)).toBe(1);
      // 같은 뜻의 옛 줄은 합쳐졌다(중복 0).
      expect(out).not.toContain('if unanswered at 30 minutes');
    }
    resetUniversalPreambleCache();
    const plain = buildUniversalPreamble({ cwd, modelFamily: 'gpt', enabledTools: ['Read'] }).map(m => String(m.content)).join('\n\n');
    for (const line of lines) expect(plain).not.toContain(line);
  } finally {
    setGlobalAnchorPathForTest(undefined);
    resetUniversalPreambleCache();
  }
});

const MEMORY_PATHS = [['memory', 'add'], ['memory', 'promote']] as const;
const cli = async (args: string[], cwd: string, state: string, env: Record<string, string>) => {
  const r = await simCli(['memory', ...args], { mode: 'spawn', stateRoot: state, cwd, env, allowPaths: MEMORY_PATHS, timeoutMs: 60_000 });
  console.log(`시험 우주 eln memory ${args.join(' ')} (cwd ${cwd}) rc=${r.exitCode}\n${r.stdout}${r.stderr}`);
  return r;
};

test('eln memory promote <name> --to common copies the file and its index line (OP only)', async () => {
  const root = world('promote');
  const state = join(root, 'state');
  const home = join(root, 'home');
  const elsewhere = join(root, 'plain-dir');
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(home, { recursive: true });

  const add = await cli(['add', 'feedback', 'chase-late-events', 'late expected events: chase once then reassign'], elsewhere, state, { HOME: home, ELANOUS_TRACK: 'OP' });
  expect(add.exitCode).toBe(0);

  const denied = await cli(['promote', 'chase-late-events', '--to', 'common', '--from', 'OP'], elsewhere, state, { HOME: home, ELANOUS_TRACK: 'TC-H-CX-7' });
  expect(denied.exitCode).not.toBe(0);
  expect(existsSync(join(state, 'elanous', 'memory', 'seats', '_common', 'chase-late-events.md'))).toBe(false);

  const promoted = await cli(['promote', 'chase-late-events', '--to', 'common'], elsewhere, state, { HOME: home, ELANOUS_TRACK: 'OP' });
  expect(promoted.exitCode).toBe(0);
  const commonFile = join(state, 'elanous', 'memory', 'seats', '_common', 'chase-late-events.md');
  expect(readFileSync(commonFile, 'utf8')).toBe(readFileSync(join(state, 'elanous', 'memory', 'seats', 'OP', 'chase-late-events.md'), 'utf8'));
  const index = readFileSync(join(state, 'elanous', 'memory', 'seats', '_common', 'MEMORY.md'), 'utf8');
  expect(index).toBe('- [chase-late-events](chase-late-events.md) — late expected events: chase once then reassign\n');

  // 다시 승격해도 색인 줄은 하나다.
  const again = await cli(['promote', 'chase-late-events', '--to', 'common'], elsewhere, state, { HOME: home, ELANOUS_TRACK: 'OP' });
  expect(again.exitCode).toBe(0);
  expect(readFileSync(join(state, 'elanous', 'memory', 'seats', '_common', 'MEMORY.md'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
});

test('general user (no seats/): project store has no common layer, index ignores seats/_common', () => {
  const root = world('general');
  const state = join(root, 'state');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const repo = join(root, 'app');
  mkdirSync(repo);
  const r = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  expect(r.status).toBe(0);
  process.env.ELANOUS_STATE_DIR = state;
  seedStores(join(state, 'elanous', 'memory'));
  const deps = { home, env: {}, msgPath: join(home, 'msg.db') };

  const target = resolveSessionMemoryStore(repo, deps);
  expect(target?.store.kind).toBe('project');
  expect(target?.commonDir).toBeUndefined();
  const content = buildSeatMemoryIndexSystemMessages({ cwd: repo }, deps).map(m => String(m.content)).join('');
  expect(content).not.toContain('measure-it-yourself');
});
