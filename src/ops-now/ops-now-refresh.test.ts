import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMemories, saveMemory, memoryIndexPath } from '../memory.js';
import { refreshOpsNow, type OpsNowComment } from './ops-now-refresh.js';
import { opsNowExitCode } from '../cli/ops-cli.js';

const now = new Date('2026-10-02T09:00:00.000Z');
const summary = '- 명함 시연 최신 안내 (출처: https://github.com/o/r/issues/1#issuecomment-2)';
let root: string;
const comments: OpsNowComment[] = [
  { body: '**[OP]** 📌안내 오래된 방식', createdAt: '2026-10-02T07:00:00Z', url: 'https://github.com/o/r/issues/1#issuecomment-1' },
  { body: '**[TC]** 17:30 📌안내 명함 시연 정정', createdAt: '2026-10-02T08:30:00Z', url: 'https://github.com/o/r/issues/1#issuecomment-2' },
  ...[0, 1, 2].map((n) => ({ body: `**[UX]** 평범한 글 ${n}`, createdAt: '2026-10-02T08:20:00Z', url: `https://example.org/${n}` })),
  { body: '**[MK]** 📌안내 옛 날짜', createdAt: '2026-09-30T08:00:00Z', url: 'https://example.org/old' },
];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ops-now-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const deps = (overrides: Partial<Parameters<typeof refreshOpsNow>[0]> = {}) => ({
  root, now: () => now, listComments: async () => comments, summarize: async () => summary, ...overrides,
});

describe('ops-now refresh', () => {
  test('two notices only (1500 chars each), older first, one pinned project write with header and freshness', async () => {
    let prompt = ''; let since = '';
    const result = await refreshOpsNow(deps({ listComments: async (s) => { since = s; return comments; }, summarize: async (p) => { prompt = p; return summary; } }));
    expect(since).toBe('2026-10-01T09:00:00.000Z');
    expect(result.outcome).toBe('updated');
    expect(result.notices).toBe(2);
    expect(prompt).toContain('오래된 방식');
    expect(prompt).toContain('정정');
    expect(prompt.indexOf('시각: 2026-10-02T07:00:00Z')).toBeLessThan(prompt.indexOf('시각: 2026-10-02T08:30:00Z'));
    expect(prompt).not.toContain('평범한 글');
    expect(prompt).not.toContain('옛 날짜');
    expect(prompt).toContain('비밀 값·토큰·개인 메모·계정 이름은 옮기지 않는다');
    const entries = listMemories({}, root);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.name).toBe('ops-now'); expect(entry.type).toBe('project'); expect(entry.pinned).toBe(true);
    expect(entry.staleAfterMinutes).toBe(120);
    expect(entry.body.trimStart()).toStartWith('갱신: 2026-10-02T09:00:00.000Z · 출처 글 2개\n');
    expect(entry.body).toContain(summary);
    const raw = readFileSync(join(root, entry.filename), 'utf8');
    expect(raw.split('---')[2]?.trimStart()).toStartWith('갱신: 2026-10-02T09:00:00.000Z');
    expect(raw).toContain('stale-after-minutes: 120');
    expect(raw).toContain('pinned: true');
  });

  test('repeat is unchanged without touching memory or index mtime', async () => {
    await refreshOpsNow(deps());
    const [entry] = listMemories({}, root);
    const file = join(root, entry.filename);
    const first = statSync(file).mtimeMs, index = statSync(memoryIndexPath(root)).mtimeMs;
    const second = await refreshOpsNow(deps());
    expect(second).toMatchObject({ outcome: 'unchanged', memoryId: entry.id, notices: 2 });
    expect(statSync(file).mtimeMs).toBe(first);
    expect(statSync(memoryIndexPath(root)).mtimeMs).toBe(index);
  });

  test('no notices leaves memory untouched', async () => {
    const before = saveMemory({ name: 'ops-now', type: 'project', description: 'old', body: 'old', pinned: true }, root);
    let called = false;
    const r = await refreshOpsNow(deps({ listComments: async () => comments.filter((c) => !c.body.includes('📌안내')), summarize: async () => { called = true; return summary; } }));
    expect(r.outcome).toBe('no-notices'); expect(called).toBe(false);
    expect(listMemories({}, root)[0].body).toBe('\n' + before.body);
  });

  test('summarizer throwing or empty output preserves old body', async () => {
    const before = saveMemory({ name: 'ops-now', type: 'project', description: 'old', body: 'old body' }, root);
    for (const summarize of [async () => { throw Error('down'); }, async () => '']) {
      const r = await refreshOpsNow(deps({ summarize }));
      expect(r.outcome).toBe('summarize-failed');
      expect(listMemories({}, root)[0].body).toBe('\n' + before.body);
    }
  });

  test('channel null and throw are unreadable rather than zero notices; memory untouched', async () => {
    const before = saveMemory({ name: 'ops-now', type: 'project', description: 'old', body: 'old body' }, root);
    for (const listComments of [async () => null, async () => { throw Error('gh down'); }]) {
      const r = await refreshOpsNow(deps({ listComments }));
      expect(r.outcome).toBe('channel-unreadable');
      expect(listMemories({}, root)[0].body).toBe('\n' + before.body);
    }
  });

  test('dry-run prints proposed body without creating a memory or index', async () => {
    const r = await refreshOpsNow(deps({ dryRun: true }));
    expect(r.outcome).toBe('updated'); expect(r.body).toStartWith('갱신: ');
    expect(r.body).toContain(summary);
    expect(existsSync(memoryIndexPath(root))).toBe(false);
    expect(listMemories({}, root)).toHaveLength(0);
  });

  test('rejects a summary without a valid notice source or exceeding the full 2000-character body', async () => {
    const original = saveMemory({ name: 'ops-now', type: 'project', description: 'old', body: 'old body' }, root);
    for (const summarize of [async () => 'unsigned', async () => `- ${'x'.repeat(2000)} (출처: ${comments[0]!.url})`]) {
      const result = await refreshOpsNow(deps({ summarize }));
      expect(result.outcome).toBe('summarize-failed');
      expect(listMemories({}, root)[0].body).toBe('\n' + original.body);
    }
  });

  test('preserves an older valid channel citation alongside a new notice citation', async () => {
    const older = 'https://github.com/o/r/issues/1#issuecomment-999';
    saveMemory({ name: 'ops-now', type: 'project', description: 'old', pinned: true,
      body: `갱신: 2026-09-30T09:00:00.000Z · 출처 글 1개\n- 아직 유효한 안내 (출처: ${older})` }, root);
    let prompt = '';
    const merged = `- 아직 유효한 안내 (출처: ${older})\n- 명함 시연 최신 안내 (출처: ${comments[1]!.url})`;
    const result = await refreshOpsNow(deps({ summarize: async (p) => { prompt = p; return merged; } }));
    expect(prompt).toContain(older);
    expect(result.outcome).toBe('updated');
    expect(listMemories({}, root)[0]!.body).toContain(merged);
  });

  test('preserves an existing citation to the coordination PR (GitHub pull URL)', async () => {
    const older = 'https://github.com/o/r/pull/1#issuecomment-999';
    const notice = { ...comments[1]!, url: 'https://github.com/o/r/pull/1#issuecomment-2' };
    saveMemory({ name: 'ops-now', type: 'project', description: 'old', pinned: true,
      body: `갱신: 2026-09-30T09:00:00.000Z · 출처 글 1개\n- 유효한 안내 (출처: ${older})` }, root);
    const merged = `- 유효한 안내 (출처: ${older})\n- 새 안내 (출처: ${notice.url})`;
    const result = await refreshOpsNow(deps({ listComments: async () => [notice], summarize: async () => merged }));
    expect(result.outcome).toBe('updated');
    expect(listMemories({}, root)[0]!.body).toContain(merged);
  });

  test('rejects mixed cited and uncited items, including an unlisted citation; keeps existing memory', async () => {
    const before = saveMemory({ name: 'ops-now', type: 'project', description: 'old', pinned: true, body: 'old body' }, root);
    const file = join(root, before.filename);
    const original = readFileSync(file, 'utf8');
    for (const summarize of [
      async () => `${summary}\n- 검증되지 않은 안내`,
      async () => `${summary}\n- 다른 채널 안내 (출처: https://github.com/o/r/issues/2#issuecomment-55)`,
    ]) {
      expect((await refreshOpsNow(deps({ summarize }))).outcome).toBe('summarize-failed');
      expect(readFileSync(file, 'utf8')).toBe(original);
    }
  });

  test('CLI --test --once --dry-run --json returns unreadable with exit 2 and never writes a memory', async () => {
    const { spawnSync } = await import('node:child_process');
    const config = join(root, 'config.json');
    writeFileSync(config, '{}');
    const proc = spawnSync('bun', ['bin/elanous.mjs', `--test=${root}`, 'ops', 'now-refresh', '--once', '--dry-run', '--json'], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30_000,
    });
    expect(proc.status).toBe(2);
    const result = JSON.parse(proc.stdout.trim());
    expect(result.outcome).toBe('channel-unreadable');
    expect(result.notices).toBe(0);
    expect(existsSync(join(root, 'elanous', 'memory', 'MEMORY.md'))).toBe(false);
  });

  test('CLI exit status treats failed summarization as failure, not a successful no-op', async () => {
    const result = await refreshOpsNow(deps({ summarize: async () => { throw Error('model down'); } }));
    expect(result.outcome).toBe('summarize-failed');
    expect(opsNowExitCode(result.outcome)).toBe(2);
    expect(opsNowExitCode('channel-unreadable')).toBe(2);
    for (const outcome of ['updated', 'unchanged', 'no-notices'] as const) expect(opsNowExitCode(outcome)).toBe(0);
  });

  test('truncates each notice to 1500 characters before summarizing and saves the cited result', async () => {
    let prompt = '';
    const cited = `- 최신 안내 (출처: ${comments[0]!.url})`;
    const result = await refreshOpsNow(deps({ listComments: async () => [{ ...comments[0]!, body: '**[OP]** 📌안내 ' + 'a'.repeat(3000) }], summarize: async (p) => { prompt = p; return cited; } }));
    expect(prompt).not.toContain('a'.repeat(1500));
    expect(prompt).toContain('a'.repeat(1400));
    expect(result.outcome).toBe('updated');
    expect(listMemories({}, root)[0]!.body.trim()).toBe(`갱신: ${now.toISOString()} · 출처 글 1개\n${cited}`);
  });
});
