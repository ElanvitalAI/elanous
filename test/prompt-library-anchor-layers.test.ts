// 🪪 L0 v2 — 앵커 층 넷: ① 전역 ~/.elanous/AGENTS.md ② 저장소 루트 ③ 루트→cwd 사이 디렉터리 ④ 로컬 *.local.md.
// 예산: ④ 먼저(안 잘림) → ③(cwd→부모) → ② → ①. 싣는 순서: ① → ② → ③(루트→cwd) → ④.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROJECT_ANCHOR_MAX_CHARS,
  buildUniversalPreamble,
  loadProjectAnchor,
  loadProjectAnchorWithMeta,
  resetUniversalPreambleCache,
  globalAnchorPath,
  setGlobalAnchorPathForTest,
} from '../src/prompt-library/universal-preamble.js';
import { resetEffectiveInstanceRoot } from '../src/instance/resolve.js';
import { debug } from '../src/debug/log.js';

let base: string;
let root: string;
let globalPath: string;
let deep: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'elanous-anchor-layers-'));
  root = join(base, 'repo');
  deep = join(root, 'pkg', 'app');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(base, 'home', '.elanous'), { recursive: true });
  globalPath = join(base, 'home', '.elanous', 'AGENTS.md');
  setGlobalAnchorPathForTest(globalPath);
  resetUniversalPreambleCache();
});

afterEach(() => {
  setGlobalAnchorPathForTest(undefined);
  rmSync(base, { recursive: true, force: true });
  resetUniversalPreambleCache();
});

const layersOf = (cwd: string) => loadProjectAnchorWithMeta(cwd).files.map(f => [f.layer, f.filename, f.relDir]);

describe('층 단독', () => {
  test('① 전역만', () => {
    writeFileSync(globalPath, '# 사용자 공통\n');
    const r = loadProjectAnchorWithMeta(root);
    expect(r.files.map(f => [f.layer, f.path])).toEqual([['global', globalPath]]);
    expect(r.content).toContain('=== User-global instructions (AGENTS.md @ instance root) ===');
  });

  test('전역 파일이 없으면 기록도 소음도 없다', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# root\n');
    const r = loadProjectAnchorWithMeta(root);
    expect(r.files.map(f => f.layer)).toEqual(['root']);
    expect(r.skipped.some(s => s.relDir.includes('.elanous'))).toBe(false);
  });

  test('② 루트만', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# root\n');
    expect(layersOf(deep)).toEqual([['root', 'AGENTS.md', '../..']]);
  });

  test('③ 사이 디렉터리만', () => {
    writeFileSync(join(root, 'pkg', 'AGENTS.md'), '# pkg\n');
    writeFileSync(join(deep, 'AGENTS.md'), '# app\n');
    expect(layersOf(deep)).toEqual([['dir', 'AGENTS.md', '..'], ['dir', 'AGENTS.md', '']]);
  });

  test('④ 로컬만', () => {
    writeFileSync(join(deep, 'AGENTS.local.md'), '# 자리\n');
    expect(layersOf(deep)).toEqual([['local', 'AGENTS.local.md', '']]);
  });
});

describe('전부 — 싣는 순서 ① → ② → ③(루트→cwd) → ④', () => {
  test('바깥에서 안쪽으로', () => {
    writeFileSync(globalPath, '# G\n');
    writeFileSync(join(root, 'AGENTS.md'), '# R\n');
    writeFileSync(join(root, 'DESIGN.md'), '# D\n');
    writeFileSync(join(root, 'pkg', 'AGENTS.md'), '# P\n');
    writeFileSync(join(deep, 'AGENTS.md'), '# A\n');
    writeFileSync(join(deep, 'AGENTS.local.md'), '# L\n');
    const r = loadProjectAnchorWithMeta(deep);
    expect(r.files.map(f => [f.layer, f.filename])).toEqual([
      ['global', 'AGENTS.md'], ['root', 'AGENTS.md'], ['root', 'DESIGN.md'], ['dir', 'AGENTS.md'], ['dir', 'AGENTS.md'], ['local', 'AGENTS.local.md'],
    ]);
    const c = r.content!;
    const order = ['# G', '# R', '# D', '# P', '# A', '# L'].map(t => c.indexOf(t));
    expect(order.every(i => i >= 0)).toBe(true);
    for (let i = 1; i < order.length; i++) expect(order[i]!).toBeGreaterThan(order[i - 1]!);
  });

  test('AGENTS.local.md 와 CLAUDE.local.md 공존 — AGENTS.local.md 만', () => {
    writeFileSync(join(deep, 'AGENTS.local.md'), '# agents local\n');
    writeFileSync(join(deep, 'CLAUDE.local.md'), '# claude local\n');
    const r = loadProjectAnchorWithMeta(deep);
    expect(r.content).toContain('# agents local');
    expect(r.content).not.toContain('# claude local');
    expect(r.skipped).toContainEqual({ filename: 'CLAUDE.local.md', relDir: '', reason: 'shadowed' });
  });
});

describe('예산 초과 — 잘리는 순서 ① → ② → ③(얕은 것부터), ④ 는 보존', () => {
  const big = (n: number, ch: string) => ch.repeat(n);

  test('③ 의 깊은 것이 먼저, 바깥 층이 잘리고 ④ 는 보존', () => {
    const q = Math.floor(PROJECT_ANCHOR_MAX_CHARS / 3) - 10;
    writeFileSync(globalPath, big(q, 'G'));
    writeFileSync(join(root, 'AGENTS.md'), big(q, 'R'));
    writeFileSync(join(deep, 'AGENTS.md'), big(q, 'A'));
    writeFileSync(join(root, 'pkg', 'AGENTS.md'), big(q, 'P'));
    writeFileSync(join(deep, 'AGENTS.local.md'), '# L\n');
    const r = loadProjectAnchorWithMeta(deep);
    const by = (layer: string, relDir: string) => r.files.find(f => f.layer === layer && f.relDir === relDir);
    expect(by('dir', '')!.truncated).toBe(false);
    expect(by('dir', '..')!.truncated).toBe(false);
    expect(by('root', '../..')!.truncated).toBe(false);
    expect(r.files.some(f => f.layer === 'global')).toBe(false);
    expect(r.skipped.some(s => s.filename === 'AGENTS.md' && s.relDir.includes('.elanous') && s.reason === 'budget-exhausted')).toBe(true);
    expect(by('local', '')!.truncated).toBe(false);
  });

  test('③ 이 없으면 ② 를 통째로 보존하고 ① 을 잘라낸다', () => {
    writeFileSync(globalPath, big(Math.floor(PROJECT_ANCHOR_MAX_CHARS / 2), 'G'));
    writeFileSync(join(root, 'AGENTS.md'), big(PROJECT_ANCHOR_MAX_CHARS, 'R'));
    const r = loadProjectAnchorWithMeta(root);
    expect(r.files.find(f => f.layer === 'root')!.truncated).toBe(false);
    expect(r.files.some(f => f.layer === 'global')).toBe(false);
    expect(r.skipped.some(s => s.reason === 'budget-exhausted' && s.relDir.includes('.elanous'))).toBe(true);
    expect(r.totalChars).toBe(PROJECT_ANCHOR_MAX_CHARS);
  });

  test('경계 — 남은 공용 예산이 절단 마커와 «같으면» 마커만 싣고, 작으면 뺀다', () => {
    const MARKER = '\n…[truncated to fit anchor budget]';
    writeFileSync(join(root, 'AGENTS.md'), 'R'.repeat(PROJECT_ANCHOR_MAX_CHARS - MARKER.length));
    writeFileSync(join(root, 'DESIGN.md'), 'D'.repeat(100));
    const equal = loadProjectAnchorWithMeta(root);
    expect(equal.files.find(f => f.filename === 'DESIGN.md')).toEqual(expect.objectContaining({ truncated: true, chars: MARKER.length }));
    expect(equal.totalChars).toBe(PROJECT_ANCHOR_MAX_CHARS);
    writeFileSync(join(root, 'AGENTS.md'), 'R'.repeat(PROJECT_ANCHOR_MAX_CHARS - MARKER.length + 1));
    const less = loadProjectAnchorWithMeta(root);
    expect(less.files.find(f => f.filename === 'DESIGN.md')).toBeUndefined();
    expect(less.skipped).toContainEqual({ filename: 'DESIGN.md', relDir: '', reason: 'budget-exhausted' });
  });

  test('④ 는 공용이 넘쳐도 그대로', () => {
    writeFileSync(join(root, 'AGENTS.md'), big(PROJECT_ANCHOR_MAX_CHARS + 100, 'R'));
    writeFileSync(join(root, 'AGENTS.local.md'), '# 너는 OP 다\n');
    const r = loadProjectAnchorWithMeta(root);
    expect(r.files.find(f => f.layer === 'local')).toEqual(expect.objectContaining({ truncated: false }));
    expect(r.content!.endsWith('=== end AGENTS.local.md ===')).toBe(true);
  });
});

describe('격리 — 전역 층은 «이 우주»의 뿌리를 따른다', () => {
  test('ELANOUS_STATE_DIR 로 격리된 우주는 그 우주의 AGENTS.md 를 읽고 운영 파일을 안 읽는다', () => {
    setGlobalAnchorPathForTest(undefined);
    const prev = process.env.ELANOUS_STATE_DIR;
    const universe = join(base, 'test-universe');
    mkdirSync(universe, { recursive: true });
    writeFileSync(join(universe, 'AGENTS.md'), '# 격리 우주 전역\n');
    writeFileSync(globalPath, '# 운영 전역 — 읽히면 안 된다\n'); // 운영 흉내(홈 아래)
    process.env.ELANOUS_STATE_DIR = universe;
    resetEffectiveInstanceRoot();
    try {
      expect(globalAnchorPath()).toBe(join(universe, 'AGENTS.md'));
      const r = loadProjectAnchorWithMeta(root);
      expect(r.content).toContain('# 격리 우주 전역');
      expect(r.content).not.toContain('운영 전역');
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prev;
      resetEffectiveInstanceRoot();
    }
  });
});

describe('격리 — 별도 프로세스(HOME ⊕ ELANOUS_STATE_DIR)', () => {
  test('HOME 아래 운영 파일이 있어도 격리 우주의 파일만 싣는다', () => {
    const home = join(base, 'home');
    writeFileSync(join(home, '.elanous', 'AGENTS.md'), '# HOME-PROD-MARKER-7c1\n');
    const universe = join(base, 'universe');
    mkdirSync(universe, { recursive: true });
    writeFileSync(join(universe, 'AGENTS.md'), '# UNIVERSE-MARKER-3d9\n');
    writeFileSync(join(root, 'AGENTS.md'), '# R\n');
    const modulePath = join(import.meta.dir, '..', 'src', 'prompt-library', 'universal-preamble.ts');
    const script = `const m = await import(${JSON.stringify(modulePath)}); process.stdout.write(m.loadProjectAnchorWithMeta(${JSON.stringify(root)}).content ?? '');`;
    const out = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      env: { PATH: process.env.PATH ?? '', HOME: home, ELANOUS_STATE_DIR: universe },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const content = out.stdout.toString();
    expect(out.exitCode).toBe(0);
    expect(content).toContain('UNIVERSE-MARKER-3d9');
    expect(content).not.toContain('HOME-PROD-MARKER-7c1');
  }, 60_000);
});

describe('중복 — 우주 뿌리가 저장소 트리 안(예: --test=<트리>)', () => {
  test('전역 파일이 루트 AGENTS.md 와 같은 파일이면 한 번만 싣는다', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# R\n');
    writeFileSync(join(root, 'DESIGN.md'), '# D\n');
    setGlobalAnchorPathForTest(join(root, 'AGENTS.md'));
    const r = loadProjectAnchorWithMeta(root);
    expect(r.files.map(f => [f.layer, f.filename])).toEqual([['root', 'AGENTS.md'], ['root', 'DESIGN.md']]);
  });
});

describe('관측·캐시', () => {
  test('built 관측에 anchorLayers(층·경로·잘림)', () => {
    writeFileSync(globalPath, '# G\n');
    writeFileSync(join(root, 'AGENTS.md'), '# R\n');
    writeFileSync(join(root, 'AGENTS.local.md'), '# L\n');
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const origLog = debug.log;
    const wasEnabled = debug.enabled;
    (debug as { log: unknown }).log = (category: string, event: string, data: Record<string, unknown>) => { events.push({ category, event, data }); };
    if (!wasEnabled) debug.setDiagEnabled(true);
    try {
      buildUniversalPreamble({ cwd: root, enabledTools: ['Read'] });
    } finally {
      (debug as { log: unknown }).log = origLog;
      if (!wasEnabled) debug.setDiagEnabled(false);
    }
    const built = events.find(e => e.category === 'chat.universal-preamble' && e.event === 'built')!;
    expect((built.data.anchorLayers as Array<{ layer: string; path: string; truncated: boolean }>).map(l => [l.layer, l.path, l.truncated])).toEqual([
      ['global', globalPath, false],
      ['root', join(root, 'AGENTS.md'), false],
      ['local', join(root, 'AGENTS.local.md'), false],
    ]);
  });

  test('캐시 — 전역 파일을 새로 만들면 다음 조회에 반영된다', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# R\n');
    expect(loadProjectAnchor(root).files.some(f => f.layer === 'global')).toBe(false);
    writeFileSync(globalPath, '# G\n');
    expect(loadProjectAnchor(root).files.some(f => f.layer === 'global')).toBe(true);
  });
});
