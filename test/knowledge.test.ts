// R3 — 지식레이어 (벡터 영속 + 유사국면 질의).
//
// 실 임베더(LM Studio/OpenAI)는 머신 의존이라 fake embedFn 주입으로
// 결정론 검증: 스키마·멱등 인제스트·코사인 랭킹·청킹·임베딩모델 공간 격리.
// 실 임베딩 품질은 dogfood(라이브 검증 3건)가 커버.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openKnowledgeDb, ingestKnowledge, ingestText, queryKnowledge, chunkReport,
  renderKnowledgeMatches, knowledgeStats, type EmbedFn,
} from '../src/domains/knowledge.js';
import { openSignalsDb } from '../src/domains/breaking-signals.js';
import { ensureDigTables } from '../src/domains/dig-engine.js';
import { openSurfaceEventsDb, recordEvent } from '../src/domains/surface-events.js';

// fake 임베더 — 키워드 원핫 방향벡터 (결정론·코사인 검증 가능)
const AXES = ['에너지', '반도체', '크립토', '금리'];
const fakeEmbed: EmbedFn = async (text) => {
  const v = new Float32Array(8);
  AXES.forEach((kw, i) => { if (text.includes(kw)) v[i] = 1; });
  if (v.every(x => x === 0)) v[7] = 1; // 무매치 → 잡음 축
  return { vector: v, model: 'fake-8d' };
};
const otherModelEmbed: EmbedFn = async (text) => {
  const { vector } = await fakeEmbed(text);
  return { vector, model: 'other-model' };
};

let dir: string;
let kdbPath: string;
let sigPath: string;
let alphaDir: string;
let sePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'knowledge-test-'));
  kdbPath = join(dir, 'knowledge.db');
  sigPath = join(dir, 'breaking_signals.db');
  alphaDir = join(dir, 'alpha_reports');
  sePath = join(dir, 'surface_events.db');
  mkdirSync(alphaDir);

  // Block 2 원료: 발송 원장 2건(유의 watch-zone importance 7 = 편입 · qna 3 = 제외).
  const edb = openSurfaceEventsDb(sePath);
  recordEvent(edb, { surface: 'watch-cron', direction: 'outbound', kind: 'watch-zone',
    text: '삼성 외국인 순매수 전환 감지 — 금리 하락 국면', importance: 7 });
  recordEvent(edb, { surface: 'telegram', direction: 'inbound', kind: 'qna', text: '삼성 어때?', importance: 3 });
  edb.close();

  // 원료: 신호 3건(6+ 2건 · 5점 1건 — floor 미만 제외 검증) + 디깅 1건
  const sdb = openSignalsDb(sigPath);
  ensureDigTables(sdb);
  const ins = sdb.prepare(`INSERT INTO signals(id, ts, source, author, text, url, urgency, market, kr, sector, impact, reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('s1', '2026-07-01T00:00:00Z', 'x', 'DeItaone', '사우디 OSP 인상 — 에너지 강세', 'u1', 7, 8, 2, 'energy', 8, '유가 상방');
  ins.run('s2', '2026-07-02T00:00:00Z', 'x', 'FirstSquawk', '반도체 HBM 수요 서프라이즈', 'u2', 6, 7, 6, 'semis', 7, null);
  ins.run('s3', '2026-07-03T00:00:00Z', 'x', 'yonhap', '잡음 신호', 'u3', 5, 5, 1, 'other', 4, null);
  sdb.prepare(`INSERT INTO dig_reports(ts, queue_id, topic, sector, verdict, confidence) VALUES (?,?,?,?,?,?)`)
    .run('2026-07-04T00:00:00Z', 'signal:s1', '에너지 디깅', 'energy', '**국면판단**: 에너지 강세 지속', 'high');
  sdb.close();

  writeFileSync(join(alphaDir, '2026-07-06-weekly-alpha.md'),
    '# 주간\n\n## 크립토\n크립토 자금 유입\n\n## 금리\n금리 동결 관찰\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('knowledge layer (R3)', () => {
  test('ingest: 4소스 적재 + floor 미만 제외 + 멱등', async () => {
    const db = openKnowledgeDb(kdbPath);
    const opts = { embed: fakeEmbed, signalsDbPath: sigPath, alphaReportsDir: alphaDir, surfaceEventsDbPath: sePath };
    const c1 = await ingestKnowledge(db, opts);
    expect(c1.signals).toBe(2);         // s3(max 5)는 floor 6 미만 — 제외
    expect(c1.digs).toBe(1);
    expect(c1.alpha).toBe(1);           // 짧은 리포트 = 1청크
    expect(c1.outbound).toBe(1);        // watch-zone(7) 편입 · qna(inbound·3) 제외
    expect(c1.skipped).toBe(0);

    const c2 = await ingestKnowledge(db, opts);
    expect(c2).toEqual({ signals: 0, digs: 0, alpha: 0, outbound: 0, skipped: 0 }); // 멱등

    const st = knowledgeStats(db);
    expect(st.total).toBe(5);
    db.close();
  });

  test('Block 2 — 발송 원장이 의미(벡터) 회상에 걸린다 (kind=outbound)', async () => {
    const db = openKnowledgeDb(kdbPath);
    // '금리' 축으로 질의 → 발송된 watch-zone 알림(금리 하락 국면)이 outbound로 회상.
    const hits = await queryKnowledge(db, '금리', { embed: fakeEmbed, kind: 'outbound' });
    expect(hits.length).toBe(1);
    expect(hits[0]!.kind).toBe('outbound');
    expect(hits[0]!.text).toContain('외국인 순매수');
    db.close();
  });

  test('query: 코사인 랭킹 + kind/sector 필터', async () => {
    const db = openKnowledgeDb(kdbPath);
    const top = await queryKnowledge(db, '에너지 유가 국면', { embed: fakeEmbed, k: 2 });
    expect(top[0]!.sector_tags).toBe('energy');
    expect(top[0]!.similarity).toBeGreaterThan(0.9);

    const digsOnly = await queryKnowledge(db, '에너지', { embed: fakeEmbed, kind: 'dig' });
    expect(digsOnly.every(m => m.kind === 'dig')).toBe(true);
    expect(digsOnly.length).toBe(1);

    const semis = await queryKnowledge(db, '반도체', { embed: fakeEmbed, sector: 'semis' });
    expect(semis.length).toBe(1);
    expect(semis[0]!.text).toContain('HBM');
    db.close();
  });

  test('query: embed_model 공간 격리 — 다른 모델 질의는 0건', async () => {
    const db = openKnowledgeDb(kdbPath);
    const r = await queryKnowledge(db, '에너지', { embed: otherModelEmbed });
    expect(r.length).toBe(0); // fake-8d 문서는 other-model 질의와 안 섞임
    db.close();
  });

  test('query: candidate pool restricts vector reranking and excludeId keeps the full requested result count', async () => {
    const db = openKnowledgeDb(join(dir, 'candidate-pool.db'));
    const doc = (id: string, text: string) => ingestText(db, {
      id, ts: '2026-11-06T00:00:00.000Z', kind: 'memory', domain: 'candidate-pool', text,
    }, fakeEmbed);
    await doc('case:query', '에너지 수요와 가격');
    await doc('case:bm25-candidate', '에너지 공급 전망');
    await doc('case:outside-pool', '에너지 정책 요약');

    const restricted = await queryKnowledge(db, '에너지', {
      embed: fakeEmbed,
      kind: 'memory',
      domain: 'candidate-pool',
      candidateIds: ['case:bm25-candidate'],
      excludeId: 'case:query',
    });
    expect(restricted.map((hit) => hit.id)).toEqual(['case:bm25-candidate']);

    const neighbors = await queryKnowledge(db, '에너지', {
      embed: fakeEmbed,
      kind: 'memory',
      domain: 'candidate-pool',
      k: 2,
      excludeId: 'case:query',
    });
    expect(neighbors).toHaveLength(2);
    expect(neighbors.some((hit) => hit.id === 'case:query')).toBe(false);
    db.close();
  });

  test('임베딩 실패는 skip 카운트 — 다음 주기 재시도 (멱등 보존)', async () => {
    const failEmbed: EmbedFn = async () => { throw new Error('embedder down'); };
    const db = openKnowledgeDb(join(dir, 'fresh.db'));
    const c = await ingestKnowledge(db, { embed: failEmbed, signalsDbPath: sigPath, alphaReportsDir: alphaDir, surfaceEventsDbPath: sePath });
    expect(c.skipped).toBe(5); // 신호2+디깅1+알파1+발송1
    expect(knowledgeStats(db).total).toBe(0);
    db.close();
  });

  test('chunkReport: 섹션 병합 + maxChars 하드 분할', () => {
    const small = chunkReport('## a\nxx\n\n## b\nyy', 2400);
    expect(small.length).toBe(1);
    const big = chunkReport(`## a\n${'x'.repeat(3000)}\n## b\nyy`, 1000);
    expect(big.length).toBeGreaterThan(2);
    expect(big.every(ch => ch.length <= 1000)).toBe(true);
  });

  test('renderKnowledgeMatches: 빈 결과·행 포맷', async () => {
    expect(renderKnowledgeMatches([])).toContain('유사국면 없음');
    const db = openKnowledgeDb(kdbPath);
    const top = await queryKnowledge(db, '에너지', { embed: fakeEmbed, k: 1 });
    const out = renderKnowledgeMatches(top);
    expect(out).toMatch(/\[2026-07-0\d·(signal|dig)·energy·유사도 \d\.\d\d\]/);
    db.close();
  });
});

describe('GEN 소급 — knowledge.domain (Conatus 탈피)', () => {
  test('outbound 도큐가 surface_events domain 상속 + domain 필터', async () => {
    const db = openKnowledgeDb(join(dir, 'gen.db'));
    const opts = { embed: fakeEmbed, signalsDbPath: sigPath, alphaReportsDir: alphaDir, surfaceEventsDbPath: sePath };
    const counts = await ingestKnowledge(db, opts);
    expect(counts.outbound).toBe(1);
    const postIngestOutbound = (db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE kind = 'outbound'`).get() as { n: number }).n;
    expect(postIngestOutbound).toBe(1);
    const withoutDomain = await queryKnowledge(db, '금리', { embed: fakeEmbed, kind: 'outbound' });
    expect(withoutDomain.length).toBe(1);
    // 계측 진단: postIngestOutbound=1, withoutDomain=1 이므로 인제스트·시드가 아니라 domain 필터 지점에서 0건이 발생했다.
    // 발송 원장 시드(watch-zone·domain 미지정 중립값 → knowledge finance fallback) → outbound 도큐 domain=finance
    const fin = await queryKnowledge(db, '금리', { embed: fakeEmbed, kind: 'outbound', domain: 'finance' });
    expect(fin.length).toBe(1);
    expect(fin[0]!.domain).toBe('finance');
    // 다른 도메인 필터는 0
    expect((await queryKnowledge(db, '금리', { embed: fakeEmbed, kind: 'outbound', domain: 'ops' })).length).toBe(0);
    db.close();
  });
});
