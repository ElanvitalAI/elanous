// Self-awareness memory (P1) 단위테스트 — 인메모리 db + mock embed(무네트워크).
import { setDefaultTimeout, describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyRecalledObserverOutput, recordSelfEvent, recallSelfEvents, injectSelfMemory, recentSelfChangesDigest, injectUtterance, recordCapability, listCapabilities, SELF_DOMAIN } from './self-awareness.js';
import { openSurfaceEventsDb, recordEvent, queryEvents } from './surface-events.js';
import { debug } from '../debug/log.js';
import { openKnowledgeDb, ingestDocsDir, SELF_DOC_PATTERN } from './knowledge.js';
import type { EmbedFn } from './knowledge.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function surfaceDb(): Database {
  return openSurfaceEventsDb(':memory:');
}

// 결정론 mock embed — 텍스트 길이 기반 벡터(네트워크 없음).
const mockEmbed: EmbedFn = async (text) => {
  const v = new Float32Array(8).fill(text.length % 7 / 7);
  return { vector: v, model: 'mock-embed' };
};

function captureRecall<T>(fn: () => T): { result: T; events: Array<{ event: string; data: Record<string, unknown> }> } {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const original = (debug as { log: typeof debug.log }).log;
  (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
    events.push({ event, data: (data ?? {}) as Record<string, unknown> });
  }) as typeof debug.log;
  try { return { result: fn(), events }; } finally { (debug as { log: typeof debug.log }).log = original; }
}

describe('recordSelfEvent — 에피소드 주입', () => {
  test('surface_events 에 domain=elanous·surface=ext:<tool>·direction=inbound 기록', () => {
    const db = surfaceDb();
    const id = recordSelfEvent(db, { tool: 'claude-code', summary: 'Phase C stop/budget 구현', kind: 'impl', refs: { pr: '3423' } });
    expect(id).toBeTruthy();
    const rows = queryEvents(db, { domain: SELF_DOMAIN });
    expect(rows.length).toBe(1);
    expect(rows[0]!.surface).toBe('ext:claude-code');
    expect(rows[0]!.direction).toBe('inbound');
    expect(rows[0]!.kind).toBe('impl');
    expect(rows[0]!.domain).toBe('elanous');
    expect(rows[0]!.importance).toBe(7);         // 기본 현저성
    expect(rows[0]!.refs).toContain('3423');     // refs JSON
    db.close();
  });

  test('kind/importance 커스텀 + text 상세', () => {
    const db = surfaceDb();
    recordSelfEvent(db, { tool: 'codex', summary: 'lead-lag 버그 수정', text: '상세 본문...', kind: 'fix', importance: 9 });
    const rows = queryEvents(db, { domain: SELF_DOMAIN });
    expect(rows[0]!.kind).toBe('fix');
    expect(rows[0]!.importance).toBe(9);
    expect(rows[0]!.text).toBe('상세 본문...');
    db.close();
  });
});

describe('classifyRecalledObserverOutput', () => {
  test('producer surface mark와 기존 task notification·PTY 기록을 관측 장치 산출로 분류한다', () => {
    expect(classifyRecalledObserverOutput({ surface: 'ext:tui-observe', text: 'tui:5043: RunShell(observer marker probe)', summary: null })).toBe('observer-generated');
    expect(classifyRecalledObserverOutput({ text: '<task-notification>\n<summary>monitor</summary>', summary: null })).toBe('observer-generated');
    expect(classifyRecalledObserverOutput({ text: 'tool pty_a4c9f0: screenshot', summary: null })).toBe('observer-generated');
  });

  test('명시 사람 provenance만 기존 관측 문면 인용을 제외하고, 다른 외부 producer의 레거시 판정은 보존한다', () => {
    expect(classifyRecalledObserverOutput({ surface: 'ext:claude-code', tags: 'origin:claude-code', text: '<task-notification>\n<summary>사람이 인용한 알림</summary>', summary: null })).toBe('not-observer-generated');
    expect(classifyRecalledObserverOutput({ surface: 'ext:claude-code', tags: 'origin:claude-code', text: '사람이 인용한 pty_a4c9f0: screenshot', summary: null })).toBe('not-observer-generated');
    expect(classifyRecalledObserverOutput({ surface: 'ext:other-producer', text: '<task-notification>\n<summary>legacy monitor</summary>', summary: null })).toBe('observer-generated');
    expect(classifyRecalledObserverOutput({ surface: 'ext:other-producer', text: 'tool pty_a4c9f0: screenshot', summary: null })).toBe('observer-generated');
    expect(classifyRecalledObserverOutput({ text: null, summary: null })).toBe('unknown');
  });
});

describe('recallSelfEvents — 회상(domain=elanous 격리)', () => {
  test('구현 요약 키워드로 회상 + finance 도메인은 섞이지 않음', () => {
    const db = surfaceDb();
    recordSelfEvent(db, { tool: 'claude-code', summary: 'M4 새벽 리플레이 armer 구현' });
    recordSelfEvent(db, { tool: 'claude-code', summary: 'trade checker gap risk 축 추가' });
    // finance 도메인 이벤트(격리 확인용).
    recordEvent(db, { surface: 'telegram', direction: 'outbound', kind: 'alert', text: '삼성 수급 전환', domain: 'finance' });

    const hits = recallSelfEvents(db, '리플레이 armer', { bump: false });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.every(h => h.domain === 'elanous')).toBe(true);   // finance 제외
    expect(hits.some(h => (h.summary ?? '').includes('리플레이'))).toBe(true);
    db.close();
  });

  test('관련 없는 질의 → 빈 결과 가능(domain 격리 유지)', () => {
    const db = surfaceDb();
    recordSelfEvent(db, { tool: 'claude-code', summary: 'Phase C 구현' });
    const hits = recallSelfEvents(db, 'xyzzy 존재하지않는키워드', { bump: false });
    expect(hits.every(h => h.domain === 'elanous')).toBe(true);
    db.close();
  });

  test('비제외 경로는 기존처럼 반환된 기억을 강화한다', () => {
    const db = surfaceDb();
    const eventId = recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'impl', text: 'default bump preservation probe' });
    const hits = recallSelfEvents(db, 'default bump preservation probe', { limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.recall_count).toBe(1);
    expect(db.prepare('SELECT recall_count FROM events WHERE id = ?').get(eventId)).toEqual({ recall_count: 1 });
    db.close();
  });

  test('관측 장치 산출과 판정 불가 수를 남기되 반환 hits는 바꾸지 않는다', () => {
    const db = surfaceDb();
    recordEvent(db, { domain: SELF_DOMAIN, surface: 'ext:tui-observe', direction: 'outbound', kind: 'utterance', text: 'tui:5043: probe observe' });
    recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'utterance', text: '<task-notification>\n<summary>probe observe</summary>' });
    recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'utterance', text: 'probe pty_a4c9f0: capture' });
    recordEvent(db, { domain: SELF_DOMAIN, surface: 'ext:claude-code', direction: 'inbound', kind: 'impl', text: 'ordinary probe observe' });
    const unclassifiableId = recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'impl', text: 'probe observe unclassifiable source' });
    db.prepare('UPDATE events SET text = ?, summary = ? WHERE id = ?').run('', null, unclassifiableId);
    const events: Array<Record<string, unknown>> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((_category, event, data) => {
      if (event === 'recall-result') events.push((data ?? {}) as Record<string, unknown>);
    }) as typeof debug.log;
    try {
      const defaultHits = recallSelfEvents(db, 'probe observe', { bump: false, limit: 8 });
      expect(defaultHits).toHaveLength(5);
      expect(defaultHits.map((hit) => hit.text)).toEqual(expect.arrayContaining([
        'tui:5043: probe observe', '<task-notification>\n<summary>probe observe</summary>', 'probe pty_a4c9f0: capture', 'ordinary probe observe', '',
      ]));
      expect(defaultHits.map((hit) => hit.id)).toContain(unclassifiableId);
      const filteredHits = recallSelfEvents(db, 'probe observe', { bump: false, limit: 8, excludeObserverOutput: true });
      expect(filteredHits).toHaveLength(2);
      expect(filteredHits.map((hit) => hit.text)).toEqual(expect.arrayContaining(['ordinary probe observe', '']));
      expect(filteredHits.map((hit) => hit.id)).toContain(unclassifiableId);
      expect(events).toContainEqual(expect.objectContaining({ hits: 5, preFilterHits: 5, postFilterHits: 5, observerGenerated: 3, unclassifiable: 1, excludedObserverOutput: 0 }));
      expect(events).toContainEqual(expect.objectContaining({ hits: 2, preFilterHits: 5, postFilterHits: 2, observerGenerated: 3, unclassifiable: 1, excludedObserverOutput: 3 }));
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      db.close();
    }
  });

  test('임시 저장소와 상태 루트를 연 self recall CLI는 관측 산출을 포함해 출력한다', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'self-recall-cli-'));
    const stateDir = join(runDir, 'state');
    const fixtureRepo = join(runDir, 'repo');
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = stateDir;
    try {
      mkdirSync(fixtureRepo, { recursive: true });
      writeFileSync(join(fixtureRepo, 'package.json'), JSON.stringify({ type: 'module' }));
      const db = openSurfaceEventsDb();
      try {
        recordEvent(db, { domain: SELF_DOMAIN, surface: 'ext:tui-observe', direction: 'outbound', kind: 'utterance', text: 'tui:5043: cli observer marker probe', importance: 10 });
        recordEvent(db, { domain: SELF_DOMAIN, surface: 'ext:claude-code', direction: 'inbound', kind: 'impl', text: 'cli observer marker human probe', importance: 1 });
      } finally {
        db.close();
      }
      const result = spawnSync('bun', [join(process.cwd(), 'bin/elanous.mjs'), `--test=${stateDir}`, 'self', 'recall', 'cli observer marker probe', '-n', '2', '--include-observer-output'], {
        cwd: fixtureRepo,
        encoding: 'utf-8',
        env: { ...process.env, ELANOUS_STATE_DIR: stateDir },
        timeout: 15_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('tui:5043: cli observer marker probe');
    } finally {
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('제외 시 observer 상위 결과를 보상해 요청 limit까지 의도 기억을 반환하고 pre/post hit 수를 남긴다', () => {
    const db = surfaceDb();
    recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'utterance', text: '<task-notification>\n<summary>limit compensation probe one</summary>', importance: 10 });
    recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'utterance', text: 'limit compensation probe pty_a4c9f0: capture', importance: 10 });
    recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'impl', text: 'intentional limit compensation probe one', importance: 1 });
    recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'impl', text: 'intentional limit compensation probe two', importance: 1 });
    const { result, events } = captureRecall(() => recallSelfEvents(db, 'limit compensation probe', { bump: false, limit: 2, excludeObserverOutput: true }));
    expect(result).toHaveLength(2);
    expect(result.every((hit) => classifyRecalledObserverOutput(hit) === 'not-observer-generated')).toBe(true);
    expect(events.find((event) => event.event === 'recall-result')?.data).toMatchObject({
      hits: 2, limit: 2, preFilterHits: 4, postFilterHits: 2, observerGenerated: 2, excludedObserverOutput: 2,
    });
    db.close();
  });

  test('제외 확대 조회는 반환된 의도 기억만 강화하고 제외·limit 밖 후보는 강화하지 않는다', () => {
    const db = surfaceDb();
    const observerId = recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'utterance', text: '<task-notification>\n<summary>bump compensation probe</summary>', importance: 10 });
    const returnedId = recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'impl', text: 'intentional bump compensation probe returned', importance: 5 });
    const trimmedId = recordEvent(db, { domain: SELF_DOMAIN, surface: 'test', direction: 'outbound', kind: 'impl', text: 'intentional bump compensation probe trimmed', importance: 1 });

    const hits = recallSelfEvents(db, 'bump compensation probe', { limit: 1, excludeObserverOutput: true });
    expect(hits.map((hit) => hit.id)).toEqual([returnedId]);
    const recallCounts = db.prepare('SELECT id, recall_count FROM events WHERE id IN (?, ?, ?)').all(observerId, returnedId, trimmedId) as Array<{ id: string; recall_count: number }>;
    expect(Object.fromEntries(recallCounts.map((row) => [row.id, row.recall_count]))).toEqual({
      [observerId]: 0,
      [returnedId]: 1,
      [trimmedId]: 0,
    });
    db.close();
  });
});

describe('injectUtterance — observer ingress 분류', () => {
  test('사람 발화가 관측 문면을 인용해도 provenance와 비관측 분류를 보존한다', () => {
    const db = surfaceDb();
    const ingress: Array<Record<string, unknown>> = [];
    const original = (debug as { log: typeof debug.log }).log;
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      if (category === 'memory.utterance' && event === 'ingress') ingress.push((data ?? {}) as Record<string, unknown>);
    }) as typeof debug.log;
    try {
      injectUtterance({ text: '<task-notification>\n<summary>사람이 인용한 알림</summary>', origin: 'claude-code', cwd: '/worktrees/observer' }, db);
      injectUtterance({ text: '사람이 인용한 pty_a4c9f0: screenshot', origin: 'claude-code' }, db);
      injectUtterance({ text: '', origin: 'claude-code' }, db);

      const rows = queryEvents(db, { domain: SELF_DOMAIN });
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.tags === 'origin:claude-code')).toBe(true);
      expect(rows.every((row) => row.surface === 'ext:claude-code' && row.kind === 'utterance')).toBe(true);
      expect(ingress).toEqual([
        expect.objectContaining({ observerGenerated: 0, unclassifiable: 0, cwd: '/worktrees/observer' }),
        expect.objectContaining({ observerGenerated: 0, unclassifiable: 0 }),
        expect.objectContaining({ observerGenerated: 0, unclassifiable: 1 }),
      ]);
      expect(ingress[1]).not.toHaveProperty('cwd');
      expect(ingress[2]).not.toHaveProperty('cwd');
    } finally {
      (debug as { log: typeof debug.log }).log = original;
      db.close();
    }
  });
});

describe('injectSelfMemory — 이벤트 + 문서 벡터 인제스트', () => {
  test('docPath 없으면 이벤트만(docChunks=0)', async () => {
    const sdb = surfaceDb();
    const r = await injectSelfMemory({ tool: 'claude-code', summary: '단순 이벤트' }, { sdb });
    expect(r.eventId).toBeTruthy();
    expect(r.docChunks).toBe(0);
    expect(queryEvents(sdb, { domain: 'elanous' }).length).toBe(1);
    sdb.close();
  });

  test('docPath 있으면 문서 청크 벡터 인제스트(kind=docs·domain=elanous)', async () => {
    const sdb = surfaceDb();
    const kdb = openKnowledgeDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'self-doc-'));
    const docPath = join(dir, 'HANDOFF-test-2026-07-08.md');
    writeFileSync(docPath, '# 제목\n\n## 섹션1\n' + 'a'.repeat(50) + '\n\n## 섹션2\n' + 'b'.repeat(50));
    const r = await injectSelfMemory({ tool: 'claude-code', summary: '문서 포함 구현', docPath }, { sdb, kdb, embed: mockEmbed });
    rmSync(dir, { recursive: true, force: true });
    expect(r.eventId).toBeTruthy();
    expect(r.docChunks).toBeGreaterThanOrEqual(1);
    // knowledge.db 에 kind=docs·domain=elanous 로 적재.
    const docs = kdb.query(`SELECT kind, domain FROM docs`).all() as Array<{ kind: string; domain: string }>;
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs.every(d => d.kind === 'docs' && d.domain === 'elanous')).toBe(true);
    // 이벤트에 doc 태그.
    const ev = queryEvents(sdb, { domain: 'elanous' })[0]!;
    expect(ev.tags).toContain('HANDOFF-test');
    sdb.close(); kdb.close();
  });

  test('문서 인제스트 실패해도 이벤트는 남음(fail-soft)', async () => {
    const sdb = surfaceDb();
    const failEmbed: EmbedFn = async () => { throw new Error('embed down'); };
    const kdb = openKnowledgeDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'self-doc2-'));
    const docPath = join(dir, 'REPORT-x-2026-07-08.md');
    writeFileSync(docPath, '## s\n' + 'c'.repeat(30));
    const r = await injectSelfMemory({ tool: 'codex', summary: '임베딩 다운 상황', docPath }, { sdb, kdb, embed: failEmbed });
    rmSync(dir, { recursive: true, force: true });
    expect(r.eventId).toBeTruthy();               // 이벤트는 기록됨
    expect(r.docChunks).toBe(0);                   // 문서는 skip
    expect(queryEvents(sdb, { domain: 'elanous' }).length).toBe(1);
    sdb.close(); kdb.close();
  });
});

describe('recentSelfChangesDigest — 데몬 ambient(P4)', () => {
  test('최근 elanous 변경을 요약(domain=elanous·finance 무관)', () => {
    const db = surfaceDb();
    recordSelfEvent(db, { tool: 'claude-code', summary: 'L2 코어 도구 리팩토링', kind: 'refactor' });
    recordSelfEvent(db, { tool: 'codex', summary: 'self_recall 추가', kind: 'impl' });
    // finance 발송(격리 확인) — digest 에 안 섞임.
    recordEvent(db, { surface: 'outbound', direction: 'outbound', kind: 'alert', text: '삼성 알림', domain: 'finance' });
    const digest = recentSelfChangesDigest(db);
    expect(digest).toContain('구현/변경');
    expect(digest).toContain('L2 코어 도구');
    expect(digest).toContain('self_recall');
    expect(digest).not.toContain('삼성 알림');       // finance 격리
    expect(digest).toContain('self_recall'); // self_recall 안내
    db.close();
  });

  test('변경 없으면 빈 문자열(주입 안 함)', () => {
    const db = surfaceDb();
    const digest = recentSelfChangesDigest(db);
    expect(digest).toBe('');
    db.close();
  });

  test('kind=utterance(훅 발화 ingress) 제외 — 프롬프트 원문이 구현 이력을 밀어내지 않음', () => {
    const db = surfaceDb();
    recordSelfEvent(db, { tool: 'claude-code', summary: '관측 싱크 배선', kind: 'impl' });
    // 발화 ingress(PR#4619 훅) — 더 최근이지만 digest 에서 제외돼야(라벨↔내용 정합).
    injectUtterance({ text: '기억 시스템 확인해주세요', origin: 'claude-code' }, db);
    const digest = recentSelfChangesDigest(db);
    expect(digest).toContain('관측 싱크 배선');        // 구현 이력은 살아남고
    expect(digest).not.toContain('기억 시스템 확인');   // 발화 원문은 제외
    db.close();
  });

  test('배선 가드 — 공유 턴 ambient 에 코어(비-finance-gated) 주입', () => {
    // [갱신 2026-07-13] M4a 가 어셈블리를 telegram-agent → agent/monad-agent-turn +
    // agent/self-ambient 로 추출 — 가드를 이사한 실제 주입 지점으로 옮긴다(의도 동일:
    // 자기인지 ambient 가 finance 게이트 없이 코어로 들어가야 함).
    const { readFileSync } = require('node:fs');
    const ambient = readFileSync(join(import.meta.dir, '..', 'agent', 'self-ambient.ts'), 'utf-8') as string;
    expect(ambient).toContain('recentSelfChangesContext()');
    expect(ambient).not.toContain('finance ? recentSelfChangesContext'); // finance 게이트 아님
    const turn = readFileSync(join(import.meta.dir, '..', 'agent', 'monad-agent-turn.ts'), 'utf-8') as string;
    expect(turn).toContain('elanousSelfAmbientParts'); // 공유 턴에 실제 배선
  });
});

describe('ingestDocsDir — docs/ 자동 벡터화(P3)', () => {
  test('SELF_DOC_PATTERN — 구현 문서만 매칭(index/vision 제외)', () => {
    expect(SELF_DOC_PATTERN.test('HANDOFF-x-2026-07-08.md')).toBe(true);
    expect(SELF_DOC_PATTERN.test('REPORT-y.md')).toBe(true);
    expect(SELF_DOC_PATTERN.test('PLAN-z.md')).toBe(true);
    expect(SELF_DOC_PATTERN.test('_index.md')).toBe(false);       // 인덱스 제외
    expect(SELF_DOC_PATTERN.test('VISION-foo.md')).toBe(false);   // 비-구현 제외
    expect(SELF_DOC_PATTERN.test('notes.txt')).toBe(false);
  });

  test('디렉터리 순회 → 패턴 매칭 md 만 domain=elanous·kind=docs 인제스트(멱등)', async () => {
    const kdb = openKnowledgeDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'docs-dir-'));
    writeFileSync(join(dir, 'HANDOFF-a-2026-07-08.md'), '## s\n' + 'a'.repeat(40));
    writeFileSync(join(dir, 'REPORT-b-2026-07-08.md'), '## s\n' + 'b'.repeat(40));
    writeFileSync(join(dir, '_index.md'), 'skip me');            // 패턴 불일치 → 제외
    const r = await ingestDocsDir(kdb, { dir, domain: 'elanous', embed: mockEmbed });
    expect(r.files).toBe(2);                                     // _index 제외
    expect(r.chunks).toBeGreaterThanOrEqual(2);
    const rows = kdb.query(`SELECT DISTINCT kind, domain FROM docs`).all() as Array<{ kind: string; domain: string }>;
    expect(rows.every(x => x.kind === 'docs' && x.domain === 'elanous')).toBe(true);
    // 멱등 — 재실행 시 신규 0.
    const r2 = await ingestDocsDir(kdb, { dir, domain: 'elanous', embed: mockEmbed });
    expect(r2.chunks).toBe(0);
    rmSync(dir, { recursive: true, force: true });
    kdb.close();
  });

  test('디렉터리 없으면 0(fail-soft)', async () => {
    const kdb = openKnowledgeDb(':memory:');
    const r = await ingestDocsDir(kdb, { dir: '/nonexistent-docs-xyz', embed: mockEmbed });
    expect(r).toEqual({ files: 0, chunks: 0, skipped: 0, unchanged: 0, refreshed: 0 });
    kdb.close();
  });
});

describe('ingestDocsDir — mtime 증분 (DocOps P0 · 2026-07-13)', () => {
  test('무변경 파일은 stat 만으로 통과(embed 0회) · 수정 파일은 구청크 교체', async () => {
    const kdb = openKnowledgeDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'docs-incr-'));
    const f = join(dir, 'PLAN-live-2026-07-13.md');
    writeFileSync(f, '## v1\n' + 'x'.repeat(40));
    let embedCalls = 0;
    const countingEmbed: EmbedFn = async (t) => { embedCalls++; return mockEmbed(t); };

    const r1 = await ingestDocsDir(kdb, { dir, embed: countingEmbed });
    expect(r1.files).toBe(1);
    const callsAfterFirst = embedCalls;

    // 2회차 — 무변경: read/chunk/embed 없이 통과
    const r2 = await ingestDocsDir(kdb, { dir, embed: countingEmbed });
    expect(r2.unchanged).toBe(1);
    expect(r2.chunks).toBe(0);
    expect(embedCalls).toBe(callsAfterFirst);

    // 수정 (mtime 강제 전진) — 구청크 삭제 후 재인제스트·내용 갱신 반영
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(f, '## v2\n' + 'y'.repeat(40));
    const r3 = await ingestDocsDir(kdb, { dir, embed: countingEmbed });
    expect(r3.refreshed).toBe(1);
    expect(r3.chunks).toBeGreaterThanOrEqual(1);
    const texts = (kdb.query(`SELECT text FROM docs WHERE id LIKE 'docs:%PLAN-live%'`).all() as Array<{ text: string }>).map((x) => x.text).join('');
    expect(texts).toContain('v2');
    expect(texts).not.toContain('v1'); // stale 청크가 남지 않는다
    rmSync(dir, { recursive: true, force: true });
    kdb.close();
  });

  test('마이그레이션 — 기존 청크 있고 상태 없음 + 무수정 → 재임베딩 없이 상태만 기록', async () => {
    const kdb = openKnowledgeDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'docs-migr-'));
    const f = join(dir, 'HANDOFF-old-2026-07-01.md');
    writeFileSync(f, '## s\n' + 'z'.repeat(40));
    // 1) 구버전 동작 재현 — 상태 테이블 없이 청크만 존재(미래 ts 로 '인제스트가 수정보다 나중' 상황)
    const future = new Date(Date.now() + 60_000).toISOString();
    kdb.run(`CREATE TABLE IF NOT EXISTS docs_probe(x)`); // noop — db 초기화 보장용
    const { ingestDocFile } = await import('./knowledge.js');
    await ingestDocFile(kdb, { path: f, embed: mockEmbed, ts: future });
    let embedCalls = 0;
    const countingEmbed: EmbedFn = async (t) => { embedCalls++; return mockEmbed(t); };
    // 2) 증분 버전 첫 실행 — 재임베딩 0·unchanged 처리
    const r = await ingestDocsDir(kdb, { dir, embed: countingEmbed });
    expect(embedCalls).toBe(0);
    expect(r.unchanged).toBe(1);
    // 3) 이후 수정 → 정상 재인제스트
    await new Promise((rr) => setTimeout(rr, 5));
    writeFileSync(f, '## s2\n' + 'w'.repeat(40));
    const r2 = await ingestDocsDir(kdb, { dir, embed: countingEmbed });
    expect(r2.refreshed + r2.files).toBeGreaterThanOrEqual(1);
    expect(embedCalls).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
    kdb.close();
  });

  test('LIKE 특수문자 파일명(언더스코어) — 이웃 파일 청크를 오삭제하지 않는다', async () => {
    const kdb = openKnowledgeDb(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'docs-like-'));
    writeFileSync(join(dir, 'PLAN-a_b-2026.md'), '## s\n' + 'p'.repeat(40));
    writeFileSync(join(dir, 'PLAN-aXb-2026.md'), '## s\n' + 'q'.repeat(40)); // _ 와일드카드 오매치 후보
    await ingestDocsDir(kdb, { dir, embed: mockEmbed });
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(dir, 'PLAN-a_b-2026.md'), '## s2\n' + 'p2'.repeat(30)); // a_b 만 수정
    await ingestDocsDir(kdb, { dir, embed: mockEmbed });
    const xb = kdb.query(`SELECT COUNT(*) n FROM docs WHERE id LIKE 'docs:%PLAN-aXb%'`).get() as { n: number };
    expect(xb.n).toBeGreaterThanOrEqual(1); // 이웃 보존
    rmSync(dir, { recursive: true, force: true });
    kdb.close();
  });
});

describe('하이브리드 검색 (DocOps P2) — 벡터+BM25 RRF', () => {
  // mockEmbed 는 길이 기반이라 의미 유사도가 무의미 — 키워드 축 검증에 적합.
  async function seed(kdb: ReturnType<typeof openKnowledgeDb>) {
    const { ingestText } = await import('./knowledge.js');
    await ingestText(kdb, { id: 'docs:A.md#0', ts: '2026-07-01T00:00:00Z', kind: 'docs', text: '격리 테스트 인스턴스 config 물질화 사본 설계', domain: 'elanous' }, mockEmbed);
    await ingestText(kdb, { id: 'docs:B.md#0', ts: '2026-07-02T00:00:00Z', kind: 'docs', text: 'PtyShell 스크린샷 첨부 디스코드 배선', domain: 'elanous' }, mockEmbed);
  }

  test('키워드 축 — 고유명사(PtyShell)가 BM25 로 잡힌다 · matchedBy 표기', async () => {
    const { hybridQueryKnowledge } = await import('./knowledge.js');
    const kdb = openKnowledgeDb(':memory:');
    await seed(kdb);
    const r = await hybridQueryKnowledge(kdb, 'PtyShell', { k: 5, domain: 'elanous', embed: mockEmbed });
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0]!.id).toBe('docs:B.md#0');
    expect(['keyword', 'both']).toContain(r[0]!.matchedBy);
    kdb.close();
  });

  test('임베딩 다운 → 키워드 단독 강등 (fail-soft)', async () => {
    const { hybridQueryKnowledge } = await import('./knowledge.js');
    const kdb = openKnowledgeDb(':memory:');
    await seed(kdb);
    const down: EmbedFn = async () => { throw new Error('embed down'); };
    const r = await hybridQueryKnowledge(kdb, '물질화 사본', { k: 5, domain: 'elanous', embed: down });
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0]!.id).toBe('docs:A.md#0');
    expect(r[0]!.matchedBy).toBe('keyword');
    kdb.close();
  });

  test('FTS 동기 — pruneKnowledge/구청크 삭제 후 키워드 매치도 사라진다', async () => {
    const { hybridQueryKnowledge, ingestText, pruneKnowledge } = await import('./knowledge.js');
    const kdb = openKnowledgeDb(':memory:');
    await ingestText(kdb, { id: 'signal:old', ts: '2025-01-01T00:00:00Z', kind: 'signal', text: 'PtyShell 옛 신호', domain: 'elanous' }, mockEmbed);
    pruneKnowledge(kdb, { maxAgeDays: 180 });
    const r = await hybridQueryKnowledge(kdb, 'PtyShell', { k: 5, embed: mockEmbed });
    expect(r.length).toBe(0);
    kdb.close();
  });

  test('backfillDocsFts — 기존 행 1회 색인·멱등', async () => {
    const { backfillDocsFts, hybridQueryKnowledge } = await import('./knowledge.js');
    const kdb = openKnowledgeDb(':memory:');
    // fts 우회 직접 insert 로 "기존 코퍼스" 재현
    const v = new Float32Array(8).fill(0.1);
    kdb.prepare(`INSERT INTO docs(id, ts, kind, text, embed_model, embedding, domain) VALUES (?,?,?,?,?,?,?)`)
      .run('docs:LEGACY.md#0', '2026-06-01T00:00:00Z', 'docs', 'LegacySymbol 레거시 본문', 'mock-embed', new Uint8Array(v.buffer), 'elanous');
    expect(backfillDocsFts(kdb)).toBe(1);
    expect(backfillDocsFts(kdb)).toBe(0); // 멱등
    const r = await hybridQueryKnowledge(kdb, 'LegacySymbol', { k: 5, domain: 'elanous', embed: mockEmbed });
    expect(r.some((m) => m.id === 'docs:LEGACY.md#0')).toBe(true);
    kdb.close();
  });
});

describe('capability registry — 미션이 만든 자원 인지·라이프사이클', () => {
  test('recordCapability → listCapabilities 로 조회(핸들 포함)', async () => {
    const db = surfaceDb();
    await recordCapability({
      name: 'elanous local inventory CLI', summary: '전 노드 LLM 자원 발견',
      missionId: 'apm_x', prUrls: ['https://.../4169'], cliCommand: 'elanous local inventory',
      files: ['src/index.ts'], source: 'external:claude-code',
    }, { sdb: db });
    const caps = listCapabilities(db);
    expect(caps).toHaveLength(1);
    expect(caps[0]!.name).toBe('elanous local inventory CLI');
    expect(caps[0]!.status).toBe('active');
    expect(caps[0]!.cliCommand).toBe('elanous local inventory');
    expect(caps[0]!.missionId).toBe('apm_x');
    expect(caps[0]!.source).toBe('external:claude-code');
  });

  test('update — 같은 name 재기록 시 최신이 이김(append-supersede)', async () => {
    const db = surfaceDb();
    await recordCapability({ name: 'cap-A', summary: 'v1', source: 'mission' }, { sdb: db });
    await recordCapability({ name: 'cap-A', summary: 'v2 갱신', status: 'active', scheduleIds: ['cron-1'] }, { sdb: db });
    const caps = listCapabilities(db);
    expect(caps).toHaveLength(1); // dedupe by name
    expect(caps[0]!.summary).toContain('v2');
    expect(caps[0]!.scheduleIds).toEqual(['cron-1']);
  });

  test('remove — status=removed 면 기본 조회에서 숨김, --all 로 보임', async () => {
    const db = surfaceDb();
    await recordCapability({ name: 'cap-B', summary: 'x', scheduleIds: ['cron-9'] }, { sdb: db });
    await recordCapability({ name: 'cap-B', summary: 'x 제거', status: 'removed' }, { sdb: db });
    expect(listCapabilities(db)).toHaveLength(0); // 숨김
    const all = listCapabilities(db, { includeRemoved: true });
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('removed');
    expect(all[0]!.scheduleIds).toEqual(['cron-9']); // 핸들 보존(삭제 라우팅용)
  });

  test('missionId 필터 — 미션별 자원 조회', async () => {
    const db = surfaceDb();
    await recordCapability({ name: 'c1', summary: 's', missionId: 'apm_1' }, { sdb: db });
    await recordCapability({ name: 'c2', summary: 's', missionId: 'apm_2' }, { sdb: db });
    expect(listCapabilities(db, { missionId: 'apm_1' })).toHaveLength(1);
    expect(listCapabilities(db, { missionId: 'apm_1' })[0]!.name).toBe('c1');
  });

  test('self recall 이 능력 이벤트도 회상(같은 척추·무결)', () => {
    const db = surfaceDb();
    recordSelfEvent(db, { tool: 'autopilot', kind: 'capability', summary: '[능력] wiki-claim-proposer — claim 제안기' });
    const hits = recallSelfEvents(db, 'wiki claim proposer', { sinceHours: 720 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});
