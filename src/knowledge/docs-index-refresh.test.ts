// 문서 색인 한 번에 따라잡기 — 검색 시 25개 상한과 달리 `docs index`(refreshDocsIndex)는 변경 문서 전부를 색인한다.
// 정적 import 만 쓴다(TEST-INTERFERENCE-RATCHET).
import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hybridQueryKnowledge, ingestDocsCorpus, openKnowledgeDb, type EmbedFn } from '../domains/knowledge.js';
import { defaultSpawnDetached, kickDocsIndexRefresh, refreshDocsIndex } from './docs-index-refresh.js';

const fakeEmbed: EmbedFn = async (text) => {
  const vector = new Float32Array(32);
  for (const token of text.toLowerCase().split(/[^가-힣a-z0-9]+/)) {
    if (!token) continue;
    let h = 0;
    for (const ch of token) h = (h * 31 + ch.charCodeAt(0)) % 32;
    vector[h] = (vector[h] ?? 0) + 1;
  }
  return { vector, model: 'fake-embed-deterministic' };
};

function manyDocsFixture(count: number) {
  const root = mkdtempSync(join(tmpdir(), 'docs-index-refresh-'));
  const docs = join(root, 'repo', 'docs');
  mkdirSync(join(docs, 'conductor'), { recursive: true });
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(docs, 'conductor', `LANE-${String(i).padStart(2, '0')}.md`), `# 차선 ${i}\n\n- LANEMARK${i} 설계 한 줄.\n`);
  }
  return { root, docs, opts: { docsRoots: [docs], env: { ELANOUS_STATE_DIR: join(root, 'state') }, embed: fakeEmbed } };
}

describe('docs index — 변경 문서 전부를 한 번에', () => {
  test('30개 변경 문서: 검색 시 상한(25)은 5개를 남기고, refreshDocsIndex 는 전부 색인한다', async () => {
    const capped = manyDocsFixture(30);
    const full = manyDocsFixture(30);
    const dbCapped = openKnowledgeDb(join(capped.root, 'knowledge.db'));
    const dbFull = openKnowledgeDb(join(full.root, 'knowledge.db'));
    try {
      const searchTime = await ingestDocsCorpus(dbCapped, { ...capped.opts, maxFiles: 25 });
      expect(searchTime.files).toBe(25);
      expect(searchTime.pending).toBe(5);

      const refreshed = await refreshDocsIndex(dbFull, full.opts);
      expect(refreshed.files).toBe(30);
      expect(refreshed.pending).toBe(0);
      const last = await hybridQueryKnowledge(dbFull, 'LANE-30', { kind: 'docs', k: 5, embed: fakeEmbed });
      expect(last[0]!.source_ref).toBe(join(full.docs, 'conductor', 'LANE-30.md'));

      // 두 번째는 무변경 — 다시 임베딩하지 않는다.
      const again = await refreshDocsIndex(dbFull, full.opts);
      expect(again.files).toBe(0);
      expect(again.unchanged).toBe(30);
    } finally {
      dbCapped.close(); dbFull.close();
      rmSync(capped.root, { recursive: true, force: true });
      rmSync(full.root, { recursive: true, force: true });
    }
  });
});

describe('설치 직후 킥 — 분리 자식으로 `<prefix>/bin/elanous docs index`', () => {
  test('자식이 떴을 때만 kicked=true · 못 뜨면 실제 사유 · 엔트리 없음 · 시험 우주에선 실물 spawn 0 — 로그 줄이 갈린다', async () => {
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const spy = spyOn(debug, 'log').mockImplementation(((c: string, e: string, d: Record<string, unknown>) => { logs.push([c, e, d]); }) as typeof debug.log);
    try {
      const spawned: Array<[string, string[]]> = [];
      const ok = await kickDocsIndexRefresh('/prefix', { exists: () => true, spawnDetached: async (c, a) => { spawned.push([c, a]); } });
      expect(ok).toEqual({ kicked: true, reason: 'docs index started in background', command: join('/prefix', 'bin', 'elanous') });
      expect(spawned).toEqual([[join('/prefix', 'bin', 'elanous'), ['docs', 'index']]]);

      const failed = await kickDocsIndexRefresh('/prefix', { exists: () => true, spawnDetached: async () => { throw new Error('spawn EACCES'); } });
      expect(failed).toMatchObject({ kicked: false, reason: 'spawn failed: spawn EACCES' });

      const missing = await kickDocsIndexRefresh('/prefix', { exists: () => false, spawnDetached: async () => { throw new Error('must not spawn'); } });
      expect(missing.kicked).toBe(false);
      expect(missing.reason).toContain('installed entry missing');

      const guarded = await kickDocsIndexRefresh('/prefix', { exists: () => true, env: { NODE_ENV: 'test' } });
      expect(guarded).toEqual({ kicked: false, reason: 'test guard: no live spawn' });

      const docsRows = logs.filter(([c]) => c === 'docs').map(([, e]) => e);
      expect(docsRows).toEqual(['index-refresh-kicked', 'index-refresh-kick-failed', 'index-refresh-kick-failed', 'index-refresh-kick-failed']);
    } finally {
      spy.mockRestore();
    }
  });

  test('기본 분리 실행: 실제로 뜨면 resolve · 비동기 error(없는 실행 파일)면 그 사유로 reject', async () => {
    await expect(defaultSpawnDetached(process.execPath, ['-e', '0'])).resolves.toBeUndefined();
    const missing = join(tmpdir(), `no-such-elanous-${process.pid}`, 'bin', 'elanous');
    await expect(defaultSpawnDetached(missing, ['docs', 'index'])).rejects.toThrow(/ENOENT/);
  });
});
