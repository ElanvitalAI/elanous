// 대표 2026-10-14 — 비공개 소스(Claude Code 사본) 통로 차단 회귀 방어.
// 후보 목록 · 로컬 그라운딩 · RefConsult · research 정의 문면 넷 ⊕ 표지 수 래칫.
import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';
import { denyNonPublicReference, isNonPublicReferenceName, localRefGroundingDigest } from './ref-grounding.js';
import { dispatchRefConsult } from '../tool-runtime/ref-consult-runtime.js';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const roots: string[] = [];
function tmpRoot(names: string[], withGit = false): string {
  const root = mkdtempSync(join(tmpdir(), 'ref-cutoff-'));
  roots.push(root);
  for (const n of names) mkdirSync(join(root, n, ...(withGit ? ['.git'] : [])), { recursive: true });
  return root;
}
afterEach(() => { while (roots.length) { try { rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* */ } } });

describe('비공개 소스 이름 판정', () => {
  test('사본 이름과 변형(대소문자·_·owner/repo)을 거부한다', () => {
    for (const name of ['claude-code-fork', 'Claude-Code-Fork', 'claude_code_src', 'claude-code-source', 'claudecode-leaked', 'someone/claude-code-fork', 'claude-code-fork/']) {
      expect(isNonPublicReferenceName(name)).toBe(true);
    }
  });
  test('공개 참조 이름은 통과한다', () => {
    for (const name of ['claude', 'claude-code', 'openclaw', 'codex', 'grok-cli', 'fork', 'claude-code-forks-guide']) {
      expect(isNonPublicReferenceName(name)).toBe(false);
    }
  });
  test('거부는 ref.grounding denied 한 줄을 남긴다', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(denyNonPublicReference('claude-code-fork')).toBe(true);
      expect(denyNonPublicReference('openclaw')).toBe(false);
      expect(log.mock.calls).toEqual([['ref.grounding', 'denied', { name: 'claude-code-fork', reason: 'non-public-source' }]]);
    } finally { log.mockRestore(); }
  });
});

describe('로컬 그라운딩 — 사본 디렉터리가 있어도 주입하지 않는다', () => {
  test('digest 에 사본 경로 0 · 공개 참조는 그대로 · 거부 로그', () => {
    const root = tmpRoot(['claude-code-fork', 'openclaw']);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const out = localRefGroundingDigest('openclaw 와 claude-code-fork 비교', [root]);
      expect(out).toContain(join(root, 'openclaw'));
      expect(out).not.toContain('claude-code-fork');
      expect(log.mock.calls).toContainEqual(['ref.grounding', 'denied', { name: 'claude-code-fork', reason: 'non-public-source' }]);
    } finally { log.mockRestore(); }
  });
  test('사본만 있으면 빈 문자열', () => {
    const root = tmpRoot(['claude-code-fork']);
    expect(localRefGroundingDigest('claude-code-fork 참고', [root])).toBe('');
  });
});

describe('RefConsult — 사본 이름은 grep·read 전에 거부', () => {
  test('로컬 ref 에 .git 이 있어도 rg 를 부르지 않고 거부 ⊕ 로그', () => {
    const root = tmpRoot(['claude-code-fork'], true);
    const cache = mkdtempSync(join(tmpdir(), 'ref-cutoff-cache-'));
    roots.push(cache);
    let rgCalls = 0;
    const runner = () => { rgCalls += 1; return { stdout: '', stderr: '', status: 1 }; };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      for (const mode of ['grep', 'read'] as const) {
        expect(() => dispatchRefConsult(
          { owner: 'x', repo: 'Claude-Code-Fork', mode, query: 'x', path: 'README.md', cacheRoot: cache, referenceRoots: [root] },
          { runner },
        )).toThrow(/non-public source/);
      }
      expect(rgCalls).toBe(0);
      expect(log.mock.calls).toContainEqual(['ref.grounding', 'denied', { name: 'Claude-Code-Fork', reason: 'non-public-source' }]);
    } finally { log.mockRestore(); }
  });
});

describe('RefConsult — repo 칸만 판정 · 캐시에 있어도 거부', () => {
  test('캐시에 사본 이름 저장소가 있어도 rg·read 전에 거부', () => {
    const cache = mkdtempSync(join(tmpdir(), 'ref-cutoff-cache-'));
    roots.push(cache);
    mkdirSync(join(cache, 'github.com', 'someone', 'claude-code-fork', '.git'), { recursive: true });
    let rgCalls = 0;
    const runner = () => { rgCalls += 1; return { stdout: '', stderr: '', status: 1 }; };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      for (const mode of ['grep', 'read'] as const) {
        expect(() => dispatchRefConsult(
          { owner: 'someone', repo: 'claude-code-fork', mode, query: 'x', path: 'README.md', cacheRoot: cache, referenceRoots: [] },
          { runner },
        )).toThrow(/non-public source/);
      }
      expect(rgCalls).toBe(0);
    } finally { log.mockRestore(); }
  });
  test('경로 정규화 우회(claude-code-fork/. · ..)를 단일 성분 검증으로 막는다', () => {
    const root = tmpRoot(['claude-code-fork'], true);
    mkdirSync(join(root, 'claude-code-fork', 'inner', '.git'), { recursive: true });
    const cache = mkdtempSync(join(tmpdir(), 'ref-cutoff-cache-'));
    roots.push(cache);
    let rgCalls = 0;
    const runner = () => { rgCalls += 1; return { stdout: '', stderr: '', status: 1 }; };
    const cases = [
      { owner: 'x', repo: 'claude-code-fork/.' },
      { owner: 'claude-code-fork/.', repo: 'inner' },
      { owner: 'x', repo: '..' },
      { owner: 'x', repo: 'a\\claude-code-fork' },
    ];
    for (const c of cases) {
      for (const mode of ['grep', 'read'] as const) {
        expect(() => dispatchRefConsult(
          { ...c, mode, query: 'x', path: 'README.md', cacheRoot: cache, referenceRoots: [root] },
          { runner },
        )).toThrow(/single path segment/);
      }
    }
    expect(rgCalls).toBe(0);
  });
  test('owner 이름만 같은 공개 캐시 저장소는 그대로 조회한다', () => {
    const cache = mkdtempSync(join(tmpdir(), 'ref-cutoff-cache-'));
    roots.push(cache);
    mkdirSync(join(cache, 'github.com', 'claude-code-fork', 'openclaw', '.git'), { recursive: true });
    const runner = () => ({ stdout: 'a.ts:1:x\n', stderr: '', status: 0 });
    const res = dispatchRefConsult(
      { owner: 'claude-code-fork', repo: 'openclaw', mode: 'grep', query: 'x', cacheRoot: cache, referenceRoots: [] },
      { runner },
    );
    expect(res.matches).toBe(1);
  });
  test('로컬 ref 의 사본 owner 디렉터리 아래로는 내려가지 않는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'ref-cutoff-'));
    roots.push(root);
    mkdirSync(join(root, 'claude-code-fork', 'inner', '.git'), { recursive: true });
    const cache = mkdtempSync(join(tmpdir(), 'ref-cutoff-cache-'));
    roots.push(cache);
    let rgCalls = 0;
    const runner = () => { rgCalls += 1; return { stdout: '', stderr: '', status: 1 }; };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(() => dispatchRefConsult(
        { owner: 'claude-code-fork', repo: 'inner', mode: 'grep', query: 'x', cacheRoot: cache, referenceRoots: [root] },
        { runner },
      )).toThrow(/not in cache/);
      expect(rgCalls).toBe(0);
      expect(log.mock.calls).toContainEqual(['ref.grounding', 'denied', { name: 'claude-code-fork', reason: 'non-public-source' }]);
    } finally { log.mockRestore(); }
  });
});

describe('research 정의 문면', () => {
  test('사본 경로 0 · Claude Code 는 공개 문서만', () => {
    const text = readFileSync(join(REPO_ROOT, 'plugins', 'agent-team', 'agents', 'research.md'), 'utf8');
    expect(text).not.toMatch(/claude[-_]?code[-_]?(?:fork|src|source|leak)/i);
    expect(text).toContain('code.claude.com');
  });
});

// 표지 주석 정리는 별도 계획(W1~W5) — 여기선 «늘지 않게»만 막는다. 줄이면 상한도 같이 낮춘다.
const FORK_MARKER_LINE_CEILING = 76;
describe('래칫 — src·plugins 의 사본 이름 표지 줄 수', () => {
  test(`비시험 파일의 표지 줄 ≤ ${FORK_MARKER_LINE_CEILING}`, () => {
    const res = spawnSync('rg', ['-i', '--count', '--no-filename', 'claude-code-fork', 'src', 'plugins', '--glob', '!*.test.ts'], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(res.error).toBeUndefined();
    expect(res.status === 0 || res.status === 1).toBe(true);
    const total = res.stdout.split('\n').filter(Boolean).reduce((sum, n) => sum + Number(n), 0);
    expect(total).toBeLessThanOrEqual(FORK_MARKER_LINE_CEILING);
  });
});
