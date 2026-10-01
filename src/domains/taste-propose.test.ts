import { test, expect, describe, afterEach } from 'bun:test';
import {
  clusterVectors, scoreThemes, proposeMissions,
  imprintProposal, recordProposalDecision, runProposalGate, pendingProposals,
} from './taste-propose.js';
import { syncTasteVectors } from './taste-model.js';
import { openSurfaceEventsDb, recordEvent, queryEvents } from './surface-events.js';
import { openKnowledgeDb, type EmbedFn } from './knowledge.js';
import { setUserConfigOverlay } from '../user-config.js';

const sdb = () => openSurfaceEventsDb(':memory:');
const kdb = () => openKnowledgeDb(':memory:');
afterEach(() => setUserConfigOverlay(null));

// 결정론 fake embedder — 키워드로 축 켜기(반도체=x·요리=y·투자=z).
const fakeEmbed: EmbedFn = async (text: string) => {
  const v = new Float32Array([
    /반도체|칩|semi/i.test(text) ? 1 : 0,
    /요리|음식|food/i.test(text) ? 1 : 0,
    /투자|주식|invest/i.test(text) ? 1 : 0,
  ]);
  if (v[0] === 0 && v[1] === 0 && v[2] === 0) v[0] = 0.01;
  return { vector: v, model: 'fake-3d' };
};

const cap = (sd: ReturnType<typeof sdb>, type: string, text: string, importance = 5, now?: Date) =>
  recordEvent(sd, {
    surface: 'cli', direction: 'inbound', kind: 'taste', category: 'taste.capture', domain: 'elanous', text, importance,
    tags: `taste:${type},conf:0.7`,
    ...(now ? { ts: now.toISOString() } : {}),
  });

// surface_events taste.capture → knowledge.db taste 벡터 시드.
async function seed(sd: ReturnType<typeof sdb>, kd: ReturnType<typeof kdb>, nowMs?: number) {
  await syncTasteVectors({ surfaceDb: sd, knowledgeDb: kd, embed: fakeEmbed, nowMs });
}

const onCfg = () => setUserConfigOverlay((c) => ({ ...c, taste: { captureEnabled: true, proposeEnabled: true } }));

describe('clusterVectors (순수)', () => {
  test('유사 벡터 군집·직교 분리', () => {
    const cl = clusterVectors([
      { text: '반도체 A', vector: new Float32Array([1, 0, 0]) },
      { text: '반도체 B', vector: new Float32Array([1, 0, 0]) },
      { text: '요리 C', vector: new Float32Array([0, 1, 0]) },
    ], 0.6);
    expect(cl).toHaveLength(2);
    const big = cl.find((c) => c.members.length === 2)!;
    expect(big.members).toContain('반도체 A');
  });
});

describe('scoreThemes — 창발 테마(반복만)', () => {
  test('반복 테마는 size≥2·단발 제외', async () => {
    const sd = sdb(), kd = kdb();
    cap(sd, 'recurring_topic', '반도체 사이클');
    cap(sd, 'recurring_topic', '반도체 칩 수요');
    cap(sd, 'intent_tag', '요리 레시피'); // 단발 → 제외
    await seed(sd, kd);
    const themes = scoreThemes({ knowledgeDb: kd });
    expect(themes).toHaveLength(1);
    expect(themes[0]!.size).toBe(2);
    expect(themes[0]!.score).toBeCloseTo(1);
  });

  test('fact/style_pref 는 테마 소스 아님(recurring_topic·intent_tag만)', async () => {
    const sd = sdb(), kd = kdb();
    cap(sd, 'fact', '반도체 회사 다님');
    cap(sd, 'fact', '반도체 엔지니어');
    await seed(sd, kd);
    expect(scoreThemes({ knowledgeDb: kd })).toHaveLength(0);
  });
});

describe('proposeMissions — gate (미션 생성 없음)', () => {
  test('config OFF → []', async () => {
    setUserConfigOverlay((c) => ({ ...c, taste: { ...c.taste, proposeEnabled: false } }));
    const sd = sdb(), kd = kdb();
    cap(sd, 'recurring_topic', '반도체 A'); cap(sd, 'recurring_topic', '반도체 B');
    await seed(sd, kd);
    expect(proposeMissions({ knowledgeDb: kd, surfaceDb: sd })).toEqual([]);
  });

  test('config ON + 강한 테마 → 제안(임계 초과)', async () => {
    onCfg();
    const sd = sdb(), kd = kdb();
    cap(sd, 'recurring_topic', '반도체 A'); cap(sd, 'recurring_topic', '반도체 B');
    await seed(sd, kd);
    const p = proposeMissions({ knowledgeDb: kd, surfaceDb: sd, threshold: 0.5 });
    expect(p).toHaveLength(1);
    expect(p[0]!.label).toContain('반도체');
    expect(p[0]!.rationale).toContain('창발');
  });

  test('최근 좌절(reward≤-0.3) → 제안 억제', async () => {
    onCfg();
    const sd = sdb(), kd = kdb();
    cap(sd, 'recurring_topic', '반도체 A'); cap(sd, 'recurring_topic', '반도체 B');
    await seed(sd, kd);
    recordEvent(sd, { surface: 'cli', direction: 'inbound', kind: 'taste', category: 'taste.sentiment', domain: 'elanous', text: '답답', importance: 6, tags: 'sentiment:frustration,reward:-0.80' });
    expect(proposeMissions({ knowledgeDb: kd, surfaceDb: sd, threshold: 0.5 })).toEqual([]);
  });

  test('쿨다운 — 이미 제안된 테마 제외', async () => {
    onCfg();
    const sd = sdb(), kd = kdb();
    cap(sd, 'recurring_topic', '반도체 A'); cap(sd, 'recurring_topic', '반도체 B');
    await seed(sd, kd);
    // 먼저 제안 각인(쿨다운 소스).
    const first = proposeMissions({ knowledgeDb: kd, surfaceDb: sd, threshold: 0.5 });
    imprintProposal(first[0]!, { db: sd });
    // 재실행 → 쿨다운으로 제외.
    expect(proposeMissions({ knowledgeDb: kd, surfaceDb: sd, threshold: 0.5, cooldownDays: 7 })).toEqual([]);
  });
});

describe('imprintProposal / recordProposalDecision — 관측·라벨(미션 아님)', () => {
  test('제안 각인 → taste.propose (decision:pending)', () => {
    const sd = sdb();
    imprintProposal({ theme: '반도체 사이클', label: '반도체 사이클', score: 0.9, rationale: 'r' }, { db: sd });
    const rows = queryEvents(sd, { category: 'taste.propose' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tags).toContain('decision:pending');
  });

  test('대표 결정 라벨 축적(approve/reject)', () => {
    const sd = sdb();
    recordProposalDecision('반도체 사이클', 'approve', { db: sd });
    recordProposalDecision('요리', 'reject', { db: sd });
    const rows = queryEvents(sd, { category: 'taste.propose' });
    expect(rows.some((r) => (r.tags ?? '').includes('decision:approve'))).toBe(true);
    expect(rows.some((r) => (r.tags ?? '').includes('decision:reject'))).toBe(true);
  });
});

describe('pendingProposals — HITL 목록(결정된 것 제외)', () => {
  test('pending 만·approve/reject 된 테마 제외', () => {
    const sd = sdb();
    const t1 = new Date();
    const t0 = new Date(t1.getTime() - 60 * 60 * 1000); // 결정은 제안보다 나중.
    imprintProposal({ theme: '반도체 사이클', label: '반도체 사이클', score: 0.9, rationale: 'r1' }, { db: sd, now: t0 });
    imprintProposal({ theme: '투자 전략', label: '투자 전략', score: 0.7, rationale: 'r2' }, { db: sd, now: t0 });
    // 반도체는 승인 처리 → pending 에서 빠져야.
    recordProposalDecision('반도체 사이클', 'approve', { db: sd, now: t1 });
    const pend = pendingProposals({ db: sd });
    expect(pend).toHaveLength(1);
    expect(pend[0]!.theme).toBe('투자 전략');
  });

  test('무제안 → []', () => {
    expect(pendingProposals({ db: sdb() })).toEqual([]);
  });
});

describe('runProposalGate — 제안+각인 오케스트레이터', () => {
  test('config ON → 제안 생성 + taste.propose 각인', async () => {
    onCfg();
    const sd = sdb(), kd = kdb();
    const now = new Date('2026-08-26T00:00:00Z');
    const capturedAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    cap(sd, 'recurring_topic', '투자 전략', 5, capturedAt);
    cap(sd, 'recurring_topic', '투자 포트폴리오', 5, capturedAt);
    await seed(sd, kd, now.getTime());
    const p = runProposalGate({ knowledgeDb: kd, surfaceDb: sd, now, threshold: 0.5 });
    expect(p.length).toBeGreaterThanOrEqual(1);
    expect(queryEvents(sd, { category: 'taste.propose' }).length).toBeGreaterThanOrEqual(1);
  });
});
