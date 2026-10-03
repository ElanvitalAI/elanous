// ── Memory system tests ──

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveMemory, loadMemory, listMemories, deleteMemory, searchMemories,
  rebuildIndex, readIndex, buildMemoryInjection,
  extractKeywords,
  memoryRoot, memoryIndexPath,
  selectJudgedMemories, buildMemoryInjectionLLM, buildMemoryJudgePrompt,
  writeFileDurable,
} from '../src/memory';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-'));
  process.env.XDG_DATA_HOME = root;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
});

function memDir() { return join(root, 'elanous', 'memory'); }

describe('memoryRoot respects XDG_DATA_HOME', () => {
  test('path under XDG_DATA_HOME/elanous/memory', () => {
    expect(memoryRoot()).toBe(memDir());
  });
});

describe('saveMemory / loadMemory', () => {
  test('round-trip + frontmatter', () => {
    const e = saveMemory({
      type: 'user',
      name: 'prefers-typescript',
      description: 'User writes TypeScript, not JavaScript.',
      body: 'Prefers strict mode and Bun as the runtime.',
    });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.filename).toMatch(/^[0-9a-f-]{36}-prefers-typescript\.md$/);
    const reloaded = loadMemory(e.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.name).toBe('prefers-typescript');
    expect(reloaded!.type).toBe('user');
    expect(reloaded!.body).toContain('Bun as the runtime');
  });

  test('saveMemory with existing id updates in place, preserves createdAt', async () => {
    const a = saveMemory({ type: 'project', name: 'orig', description: 'first', body: 'original body' });
    const createdAt = a.createdAt;
    // Wait a tick so updatedAt differs
    await new Promise(r => setTimeout(r, 10));
    const b = saveMemory({ type: 'project', name: 'orig', description: 'updated', body: 'new body', id: a.id });
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(createdAt);
    expect(b.updatedAt).not.toBe(createdAt);
    const reloaded = loadMemory(a.id)!;
    expect(reloaded.description).toBe('updated');
    expect(reloaded.body).toContain('new body');
  });

  test('loadMemory unknown id → null', () => {
    expect(loadMemory('nope')).toBeNull();
  });
});

// ── priority/pinned + false-recall fixes (2026-07-19) ──
describe('recall relevance — priority / pinned / anti-false-recall', () => {
  test('priority + pinned round-trip through frontmatter', () => {
    const e = saveMemory({ type: 'reference', name: 'ref-tree', description: 'lazycodex ouroboros repos', body: 'x', priority: 8, pinned: true });
    expect(e.priority).toBe(8);
    expect(e.pinned).toBe(true);
    const reloaded = loadMemory(e.id)!;
    expect(reloaded.priority).toBe(8);
    expect(reloaded.pinned).toBe(true);
  });

  test('stale-after-minutes round-trip and update preserves freshness', () => {
    const a = saveMemory({ type: 'project', name: 'fresh', description: 'd', body: 'original', pinned: true, staleAfterMinutes: 120 });
    expect(readFileSync(join(memDir(), a.filename), 'utf8')).toContain('stale-after-minutes: 120');
    const b = saveMemory({ type: 'project', name: 'fresh', description: 'd', body: 'new', id: a.id });
    expect(b.staleAfterMinutes).toBe(120);
    expect(loadMemory(a.id)?.staleAfterMinutes).toBe(120);
  });

  test('pinned freshness guard in keyword and LLM paths; absent window preserves exact block', async () => {
    const a = saveMemory({ type: 'project', name: 'ops-now', description: 'd', body: 'body', pinned: true, staleAfterMinutes: 120 });
    const path = join(memDir(), a.filename);
    const raw = readFileSync(path, 'utf8');
    writeFileSync(path, raw.replace(/^updated: .*$/m, `updated: ${new Date(Date.now() - 3 * 3_600_000).toISOString()}`));
    const old = buildMemoryInjection('unrelated');
    expect(old.block).toContain('⚠️ 이 기억은 3시간 전 것이다');
    expect(old.block).toContain('«확인 중»');
    expect((await buildMemoryInjectionLLM('unrelated', { judge: async () => '[]' })).block).toContain('⚠️ 이 기억은 3시간 전 것이다');
    writeFileSync(path, raw.replace(/^updated: .*$/m, `updated: ${new Date(Date.now() - 3_600_000).toISOString()}`));
    expect(buildMemoryInjection('unrelated').block).not.toContain('⚠️ 이 기억은');
    const noWindow = saveMemory({ type: 'project', name: 'legacy', description: 'd', body: 'legacy body', pinned: true });
    const legacy = buildMemoryInjection('unrelated');
    expect(legacy.block).toContain(`### 📌 [project] ${noWindow.name}\n\nlegacy body`);
    expect(legacy.block).not.toContain(`### 📌 [project] legacy\n\n⚠️`);
    const legacyOnly = buildMemoryInjection('unrelated', {}, memDir());
    expect(legacyOnly.block).toContain(`### 📌 [project] legacy\n\nlegacy body`);
    expect(legacyOnly.block).not.toContain('⚠️ 이 기억은');
  });

  test('update preserves priority/pinned when not re-specified', () => {
    const a = saveMemory({ type: 'reference', name: 'r', description: 'd', body: 'b', priority: 5, pinned: true });
    const b = saveMemory({ type: 'reference', name: 'r', description: 'd2', body: 'b2', id: a.id });
    expect(b.priority).toBe(5);
    expect(b.pinned).toBe(true);
  });

  test('token-match: query token does NOT substring-match inside a longer word', () => {
    // "ref" must not recall a memory whose text only contains "reference"/"prefer".
    saveMemory({ type: 'project', name: 'reference guide', description: 'prefer strict mode', body: 'body' });
    expect(searchMemories('ref').length).toBe(0); // no substring bleed
    expect(searchMemories('reference').length).toBe(1); // exact token still matches
  });

  test('priority boost applies only to genuine matches (base>=2), not weak body hits', () => {
    saveMemory({ type: 'reference', name: 'alpha', description: 'beta', body: 'mentions codexthing widget', priority: 8 });
    // body-only weak match (+1) must NOT be boosted past threshold
    const weak = searchMemories('widget');
    expect(weak[0]?.score ?? 0).toBeLessThan(2);
    // name token match (base 3) IS boosted
    const strong = searchMemories('alpha');
    expect(strong[0].score).toBeGreaterThanOrEqual(3 + 8 * 2);
  });

  test('pinned memory is always injected regardless of keyword match', () => {
    saveMemory({ type: 'reference', name: 'pinned-fact', description: 'zzz distinct', body: 'always here', pinned: true, priority: 9 });
    saveMemory({ type: 'project', name: 'other', description: 'stuff', body: 'x' });
    const inj = buildMemoryInjection('completely unrelated query about turtles');
    expect(inj.block).toContain('Pinned memories');
    expect(inj.block).toContain('pinned-fact');
  });

  test('low-context guard: single-token query skips keyword recall (only pinned+index)', () => {
    saveMemory({ type: 'project', name: 'widget docs', description: 'widget usage', body: 'the widget' });
    const inj = buildMemoryInjection('widget'); // 1 token → guard skips keyword recall
    expect(inj.block).not.toContain('Retrieved memories');
    // but a 2-token query does recall it
    const inj2 = buildMemoryInjection('widget usage docs');
    expect(inj2.block).toContain('Retrieved memories');
  });

  test('raised minScore(2): a single weak body-only match does not inject', () => {
    saveMemory({ type: 'project', name: 'aaa', description: 'bbb', body: 'contains longword somewhere' });
    const inj = buildMemoryInjection('longword please'); // body +1 only, < minScore 2
    expect(inj.block).not.toContain('Retrieved memories');
  });
});

// ── LLM-judge recall (2026-07-19) — WSD 완결 ──
describe('LLM-judge recall', () => {
  test('selectJudgedMemories picks the ids the judge returns, drops hallucinated', async () => {
    const a = saveMemory({ type: 'reference', name: 'ref-repos', description: 'lazycodex ouroboros', body: 'x' });
    const b = saveMemory({ type: 'project', name: 'proj', description: 'stuff', body: 'y' });
    const judge = async () => `[${JSON.stringify(a.id.slice(0, 8))}, "deadbeef"]`; // b not selected, deadbeef hallucinated
    const sel = await selectJudgedMemories('anything', [a, b], { judge });
    expect(sel.map(e => e.id)).toEqual([a.id]);
  });

  test('WSD: judge returns [] for an unrelated sense → ref memory NOT injected', async () => {
    saveMemory({ type: 'reference', name: 'ref-repos', description: 'lazycodex ouroboros repos', body: 'external refs' });
    const judge = async () => '[]'; // judge reasons "git ref" is unrelated
    const inj = await buildMemoryInjectionLLM('git ref 정리해줘', { judge });
    expect(inj.block).not.toContain('Retrieved memories');
  });

  test('judge selects the relevant memory → injected under Retrieved (LLM-judged)', async () => {
    const a = saveMemory({ type: 'reference', name: 'ref-repos', description: 'lazycodex ouroboros', body: 'external refs live here' });
    const judge = async () => JSON.stringify([a.id.slice(0, 8)]);
    const inj = await buildMemoryInjectionLLM('lazycodex 어떻게 되묻나', { judge });
    expect(inj.block).toContain('LLM-judged');
    expect(inj.block).toContain('ref-repos');
  });

  test('pinned still always-injected under LLM-judge path (even if judge picks nothing)', async () => {
    saveMemory({ type: 'reference', name: 'pinned-fact', description: 'zzz', body: 'always', pinned: true, priority: 9 });
    const inj = await buildMemoryInjectionLLM('unrelated turtles', { judge: async () => '[]' });
    expect(inj.block).toContain('Pinned memories');
    expect(inj.block).toContain('pinned-fact');
  });

  test('low-context (1 token) skips the judge entirely', async () => {
    saveMemory({ type: 'project', name: 'widget', description: 'widget docs', body: 'z' });
    let judgeCalled = false;
    const judge = async () => { judgeCalled = true; return '[]'; };
    await buildMemoryInjectionLLM('ref', { judge });
    expect(judgeCalled).toBe(false);
  });

  test('judge throwing → keyword fallback (fail-soft)', async () => {
    saveMemory({ type: 'reference', name: 'lazycodex-notes', description: 'lazycodex ulw-plan', body: 'ok' });
    const judge = async () => { throw new Error('llm down'); };
    const inj = await buildMemoryInjectionLLM('lazycodex ulw-plan 참고', { judge });
    // fell back to keyword search → the strongly-matching memory still surfaces
    expect(inj.block).toContain('lazycodex-notes');
  });

  test('judge prompt carries the WSD instruction', () => {
    const p = buildMemoryJudgePrompt('git ref', '- 12345678 [reference] ref-repos — repos');
    expect(p).toContain('git ref');
    expect(p).toMatch(/reference.*단어가 우연히 겹|우연히 겹/);
  });
});

test('pinned memory without a freshness window retains the exact legacy injection bytes in both paths', async () => {
  saveMemory({ type: 'project', name: 'legacy', description: 'd', body: 'legacy body', pinned: true });
  const expected = `## Memory\n\n## Memory index\n\n${readIndex().trim()}\n\n## Pinned memories\n\n### 📌 [project] legacy\n\nlegacy body`;
  expect(buildMemoryInjection('unrelated').block).toBe(expected);
  expect((await buildMemoryInjectionLLM('unrelated', { judge: async () => '[]' })).block).toBe(expected);
});

describe('listMemories', () => {
  test('newest first; type filter; limit', async () => {
    // Small sleep between saves so ISO-ms timestamps don't tie-break randomly.
    saveMemory({ type: 'user', name: 'a', description: 'first', body: '' });
    await new Promise(r => setTimeout(r, 5));
    saveMemory({ type: 'feedback', name: 'b', description: 'second', body: '' });
    await new Promise(r => setTimeout(r, 5));
    saveMemory({ type: 'user', name: 'c', description: 'third', body: '' });

    const all = listMemories();
    expect(all.length).toBe(3);
    // Newest (most recently created) first
    expect(all[0].name).toBe('c');

    const users = listMemories({ type: 'user' });
    expect(users.map(m => m.name)).toEqual(['c', 'a']);

    const limited = listMemories({ limit: 1 });
    expect(limited.length).toBe(1);
  });

  test('MEMORY.md and non-.md files skipped', () => {
    saveMemory({ type: 'user', name: 'x', description: 'y', body: '' });
    writeFileSync(join(memDir(), 'notes.txt'), 'not a memory');
    expect(listMemories().length).toBe(1);
  });
});

describe('deleteMemory', () => {
  test('removes file + rebuilds index', () => {
    const e = saveMemory({ type: 'user', name: 'gone', description: 'x', body: 'y' });
    expect(deleteMemory(e.id)).toBe(true);
    expect(loadMemory(e.id)).toBeNull();
    expect(deleteMemory(e.id)).toBe(false);
  });
});

describe('searchMemories', () => {
  beforeEach(() => {
    saveMemory({ type: 'user',     name: 'prefers-typescript', description: 'User writes TypeScript', body: 'strict mode on Bun runtime.' });
    saveMemory({ type: 'project',  name: 'bun-stack',          description: 'Bun + TypeScript + SQLite project', body: '' });
    saveMemory({ type: 'reference',name: 'openai-api',         description: 'OpenAI API reference', body: 'sk- format keys.' });
  });

  test('keyword match in name ranks highest', () => {
    const hits = searchMemories('typescript');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].entry.name).toBe('prefers-typescript');
  });

  test('type filter narrows results', () => {
    const hits = searchMemories('typescript', { type: 'project' });
    expect(hits.every(h => h.entry.type === 'project')).toBe(true);
  });

  test('empty query → empty result', () => {
    expect(searchMemories('')).toEqual([]);
  });

  test('no match → empty result', () => {
    expect(searchMemories('quantum cryptography')).toEqual([]);
  });
});

describe('rebuildIndex / readIndex', () => {
  test('groups by type, names show up as bullets', () => {
    saveMemory({ type: 'user', name: 'u1', description: 'a', body: '' });
    saveMemory({ type: 'feedback', name: 'f1', description: 'b', body: '' });
    const idx = readIndex();
    expect(idx).toContain('## user');
    expect(idx).toContain('## feedback');
    expect(idx).toContain('- [u1]');
    expect(idx).toContain('- [f1]');
  });

  test('empty store → no index file', () => {
    expect(existsSync(memoryIndexPath())).toBe(false);
  });

  test('rebuildIndex is idempotent', () => {
    saveMemory({ type: 'user', name: 'only', description: 'once', body: '' });
    const first = readIndex();
    rebuildIndex();
    expect(readIndex()).toBe(first);
  });
});

describe('buildMemoryInjection', () => {
  test('returns empty block when no memories exist', () => {
    const r = buildMemoryInjection('hello');
    expect(r.block).toBe('');
    expect(r.injectedIds).toEqual([]);
  });

  test('always includes the index when present', () => {
    saveMemory({ type: 'user', name: 'anything', description: 'test memory', body: '' });
    const r = buildMemoryInjection('totally unrelated query');
    expect(r.block).toContain('Memory index');
    expect(r.block).toContain('## user');
  });

  test('appends matching memories when keywords hit', () => {
    const e = saveMemory({ type: 'user', name: 'prefers-typescript', description: 'User writes TypeScript.', body: 'Strict mode on Bun.' });
    const r = buildMemoryInjection('does the user prefer typescript?');
    expect(r.injectedIds).toContain(e.id);
    expect(r.block).toContain('Retrieved memories');
    expect(r.block).toContain('prefers-typescript');
  });

  test('respects maxTokens budget', () => {
    saveMemory({ type: 'user', name: 'a', description: 'user-a description', body: 'x'.repeat(5000) });
    saveMemory({ type: 'user', name: 'b', description: 'user-b description', body: 'y'.repeat(5000) });
    const r = buildMemoryInjection('user description', { maxTokens: 400 });
    expect(r.tokens).toBeLessThanOrEqual(400);
  });

  test('alwaysIncludeIndex=false skips the index', () => {
    saveMemory({ type: 'user', name: 'skipped-idx', description: 'd', body: 'b' });
    const r = buildMemoryInjection('unrelated', { alwaysIncludeIndex: false });
    expect(r.block).toBe('');
  });
});

describe('extractKeywords', () => {
  test('lowercases, dedupes, drops stopwords', () => {
    const kw = extractKeywords('The quick brown fox and THE lazy dog');
    expect(kw).toContain('quick');
    expect(kw).toContain('brown');
    expect(kw).toContain('fox');
    expect(kw).not.toContain('the');
    expect(kw).not.toContain('and');
  });

  test('handles Korean / CJK', () => {
    const kw = extractKeywords('삼성전자 외국인 수급');
    expect(kw.length).toBeGreaterThan(0);
  });
});

// 🩸 09-25 GCP debian-12: `memory add` 직후 전원 차단 → 새 파일과 MEMORY.md 가 크기만 남고 NUL. rename 은 원자적이지만 내구적이지 않다.
describe('writeFileDurable — fsync before the rename, then the directory', () => {
  test('the file is fsynced while still at the temp name, the directory after the rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-durable-'));
    const target = join(dir, 'MEMORY.md');
    const seen: Array<{ tmpExists: boolean; targetExists: boolean }> = [];
    writeFileDurable(target, 'hello', () => { seen.push({ tmpExists: existsSync(`${target}.tmp`), targetExists: existsSync(target) }); });
    expect(seen).toEqual([{ tmpExists: true, targetExists: false }, { tmpExists: false, targetExists: true }]);
    expect(readFileSync(target, 'utf8')).toBe('hello');
    expect(existsSync(`${target}.tmp`)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
