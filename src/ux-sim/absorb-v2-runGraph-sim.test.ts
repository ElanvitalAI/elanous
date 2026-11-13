import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runGraph } from '../graph-runner/runner.js';
import { handleScraps } from '../nexus/api/scraps.js';
import { createNexusScrapsRouteOptions } from '../nexus/api/scraps-web-digest.js';
import { listAbsorbScraps } from '../intake-plane/items.js';
import { assertScene2Briefing, runScene2Absorb } from '../../scripts/demo1114-s2-absorb-scene.js';
import { createScrapsWebDigest } from '../nexus/api/scraps-web-digest.js';
import { buildAbsorbSummaryCard } from '../intake-plane/absorb-extract.js';
import { fakeBoardAttachmentReferences, runAbsorbGraphSimulation, runAbsorbPublishReceiptGraphSimulation, runAbsorbStoreRouteSimulation } from './absorb-v2-runGraph-sim.js';

describe('absorb graph simulation confirmation boundary', () => {
  test('real absorb-brief run binds KST day when graph input is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'absorb-no-input-kst-day-'));
    try {
      const state = await runGraph(join(import.meta.dir, '../../plugins/absorb/graph/absorb-brief.yaml'),
        { runId: 'absorb-no-input-kst-day', quiet: true, deps: { root } });
      const context = (state.input as { context: { kstDay: string } }).context;
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(state.startedAt!)).map(part => [part.type, part.value]));
      expect(context.kstDay).toBe(`${parts.year}-${parts.month}-${parts.day}`);
      expect(state.kstDayFallback).toMatchObject({ reason: 'missing-calendar-day', selected: context.kstDay });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('brief run binds a missing KST day before save-brief', async () => {
    const receipt = await runAbsorbGraphSimulation({ briefOnly: true, omitBriefKstDay: true });
    expect(receipt).toMatchObject({ ok: true, status: 'done', graphId: 'absorb-brief',
      briefing: { owner: 'member-demo', kstDay: '2026-11-09' } });
    expect((receipt.evidence as Array<Record<string, unknown>>)
      .find(node => node.nodeId === 'save-brief')).toMatchObject({ ok: true });
  }, 120_000);

  test('brief run replaces impossible KST dates and records the reason on save-brief', async () => {
    for (const invalidDay of ['2026-99-99', '2026-02-30']) {
      const receipt = await runAbsorbGraphSimulation({ briefOnly: true, briefKstDay: invalidDay });
      expect(receipt).toMatchObject({ ok: true, status: 'done', briefing: { kstDay: '2026-11-09' } });
      const save = (receipt.evidence as Array<Record<string, unknown>>).find(node => node.nodeId === 'save-brief');
      expect(save).toMatchObject({ ok: true });
      expect(JSON.parse(String(save?.output))).toMatchObject({
        kstDayFallback: { reason: 'invalid-calendar-day', selected: '2026-11-09' },
      });
    }
  }, 120_000);

  test('public suggestionId-only approval completes the actual build graph without an attachment input', async () => {
    const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', onAcceptedBuild: async () => {} });
    expect(receipt).toMatchObject({ ok: true, started: true, dispatch: 'dispatched',
      builds: { accepted: { status: 'done' } } });
    const released = (receipt.boardProgress as Array<Record<string, unknown>>)
      .find(event => event.state === 'released');
    expect(released).toMatchObject({ memberId: 'member-demo', runId: 'absorb-demo-build-pass',
      result: { publicUrl: 'https://lecture-scrap-demo.app.sim.invalid/' } });
    expect(released?.attachments).toBeUndefined();
  }, 120_000);

  test('default N leaves the graph, LLM, and app host unopened', async () => {
    const receipt = await runAbsorbGraphSimulation();

    expect(receipt).toMatchObject({
      ok: true,
      started: false,
      reason: 'confirmation-default-n',
      route: 'suggest_accept',
      dispatch: 'confirmation-required',
      handlerCalls: 0,
      appHostCalls: 0,
      llmCalls: 0,
    });
  });

  // Source: AWS1 full run took 65.1s after #36615 main merge; this test runs several actual graphs.
  test('the y path reads test-bound owner suggestions and preserves build/board behavior', async () => {
    const attachments = fakeBoardAttachmentReferences();
    const receipt = await runAbsorbGraphSimulation({ confirmation: 'y',
      boardAttachments: attachments,
      onAcceptedBuild: async state => { expect(state.status).toBe('done'); } });

    expect(receipt).toMatchObject({ ok: true, started: true, dispatch: 'dispatched',
      builds: { accepted: { status: 'done' } } });
    expect(receipt.suggestionFixtureIds).toContain('suggestion-2026-11-09-1');
    expect(receipt.suggestionFixtureIds).toContain('suggestion-2026-11-09-2');
    expect(receipt.suggestionStoreWrites).toContain('suggestions:member-demo:suggestion-2026-11-09-1');
    expect(receipt.suggestionLookups).toContain('member-demo:suggestion-2026-11-09-1');
    expect(receipt.suggestionLookups).toContain('member-demo:suggestion-2026-11-09-2');
    expect(receipt.boardProgress).toMatchObject([
      { state: 'building', memberId: 'member-demo', runId: 'absorb-demo-build-pass' },
      { state: 'testing', memberId: 'member-demo', runId: 'absorb-demo-build-pass' },
      { state: 'released', memberId: 'member-demo', runId: 'absorb-demo-build-pass', result: { publicUrl: 'https://lecture-scrap-demo.app.sim.invalid/' } },
    ]);
    const boardProgress = receipt.boardProgress as Array<Record<string, unknown>>;
    expect(boardProgress.find(event => event.state === 'released')?.attachments).toEqual(attachments);
    const boardTimes = boardProgress.map((event) => String(event.at));
    expect(boardTimes.every((at) => Number.isFinite(Date.parse(at)))).toBe(true);
    expect(new Set(boardTimes).size).toBe(3);
    expect([...boardTimes].sort()).toEqual(boardTimes);
    expect(attachments.map(attachment => attachment.kind).sort()).toEqual(['diagram', 'pdf']);
    expect(attachments.every(attachment => typeof attachment.sha256 === 'string' && /^[a-f\d]{64}$/i.test(attachment.sha256))).toBe(true);
  }, 120_000);
});

describe('absorb simulated publish receipt boundary', () => {
  test('the actual runGraph capability path publishes only for its own passing simulation receipt', async () => {
    const receipt = await runAbsorbPublishReceiptGraphSimulation();
    expect(receipt.ok).toBe(true);
    expect(receipt.graph).toBe('plugins/absorb/graph/absorb-build.yaml');
    expect(receipt.storedSuggestionId).toBe('suggestion-2026-11-09-1');
    expect(receipt.scenarios).toMatchObject({
      passed: { graphId: 'absorb-build', status: 'done', suggestionFixtureBound: true, suggestionLookupObserved: true,
        simulateReached: true, simulateSuggestionId: 'suggestion-2026-11-09-1', publishNodeReached: true,
        requirePassingReceipt: true, receiptMapped: true, appHostCalls: ['lecture-scrap-demo@artifact-suggestion-2026-11-09-1'] },
      failed: { graphId: 'absorb-build', status: 'failed', suggestionId: 'suggestion-2026-11-09-1', suggestionFixtureBound: true,
        suggestionLookupObserved: true, simulateReached: true, simulateSuggestionId: 'suggestion-2026-11-09-1',
        publishNodeReached: false, appHostCalls: [], currentBody: '<main>v1</main>' },
      missing: { graphId: 'absorb-build', status: 'failed', suggestionId: 'suggestion-2026-11-09-1', suggestionFixtureBound: true,
        suggestionLookupObserved: true, simulateReached: true, simulateSuggestionId: 'suggestion-2026-11-09-1',
        // An absent receipt now fails during binding, before the publish provider is called.
        path: expect.arrayContaining(['publish']), publishNodeReached: false, requirePassingReceipt: false,
        receiptMapped: false, appHostCalls: [], currentBody: '<main>v1</main>' },
      mismatched: { graphId: 'absorb-build', status: 'failed', suggestionId: 'suggestion-2026-11-09-1', suggestionFixtureBound: true,
        suggestionLookupObserved: true, simulateReached: true, simulateSuggestionId: 'suggestion-2026-11-09-1',
        publishNodeReached: true, requirePassingReceipt: true, receiptMapped: true, appHostCalls: [], currentBody: '<main>v1</main>' },
      'foreign-owner': { graphId: 'absorb-build', status: 'failed', suggestionFixtureBound: false,
        suggestionStoredForOtherOwner: true, suggestionLookupObserved: true, suggestionLookupFound: false,
        suggestionLookupReason: 'owner-mismatch', simulateReached: false, appHostCalls: [] },
    });
  // Source: AWS1 run took 32.9s after #36615 main merge; this test runs multiple actual graphs.
  }, 120_000);
});

describe('absorb owner-scoped store route', () => {
  // Source: AWS1 run took 16.0s after #36615 main merge.
  test('scrap_add stores status new and the brief/list graphs only expose the verified owner records', async () => {
    const receipt = await runAbsorbStoreRouteSimulation();
    expect(receipt.ok).toBe(true);
    expect(receipt).toMatchObject({
      route: 'scrap_add',
      handler: './graph:absorb-ingest',
      ingestStatus: 'done',
      addedScrap: { id: 'scrap-added-by-route', owner: 'member-demo', status: 'new' },
      readOnlySuggestionList: [{ id: 'suggestion-owned', owner: 'member-demo' }],
    });
    expect(receipt.collectedOwnerItems).toContainEqual(expect.objectContaining({ id: 'scrap-added-by-route', status: 'new' }));
    expect(receipt.collectedOwnerItems).not.toContainEqual(expect.objectContaining({ id: 'private-other-member' }));
  }, 30_000);
});

// Source: DEMO-BRIEF-TO-REQUIREMENTS assigned by OP on 2026-11-11; one-article simulation acceptance line.
test('design pack and model skill name the exact change keys consumed by the real graph write', () => {
  const pack = parseYaml(readFileSync(join(import.meta.dir, '../../plugins/absorb/packs/brief-design/pack.yaml'), 'utf8')) as Record<string, unknown>;
  const itemFields = pack.changeFields as Array<{ name: string; type: string }> | undefined;
  expect(itemFields).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'requirement', type: 'string', required: true }),
    expect.objectContaining({ name: 'target', type: 'string', required: true }),
  ]));
  const skill = readFileSync(join(import.meta.dir, '../../plugins/absorb/skills/absorb/design/SKILL.md'), 'utf8');
  expect(skill).toContain('changes[].requirement');
  expect(skill).toContain('changes[].target');
});

test('one article becomes three requirements that the design pack actually uses', async () => {
  const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true,
    worldPath: join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml') });
  expect(receipt.ok).toBe(true);
  expect(receipt.articleId).toBe('article-1');
  expect(receipt.requirementLines).toHaveLength(3);
  expect((receipt.requirementLines as string[]).every((line: string) => line.includes('[article-1]'))).toBe(true);
  expect(receipt.requirementLines).toEqual([
    '동시 접속 폭주에도 예매 화면에 입장할 수 있어야 한다 [article-1]',
    '같은 좌석의 중복 예매를 막고 확정 결과를 보여줘야 한다 [article-1]',
    '공정 대기열에서 순번과 대기 상태를 볼 수 있어야 한다 [article-1]',
  ]);
  expect(receipt.designChanges).toHaveLength(3);
  expect(receipt.llmCalls).toContain('absorb/requirements');
  expect(receipt.llmCalls).toContain('absorb/design');
  expect(receipt.designInputs).toMatchObject([{ context: { memberId: 'member-demo',
    appSlots: [{ id: 'lecture-scrap-demo', screens: ['scraps', 'lecture-notes'], rpc: ['scraps.list', 'notes.create'] }] } }]);
  expect(receipt.design).toMatchObject({ owner: 'member-demo', appId: 'lecture-scrap-demo', scrapIds: ['article-1'] });
  expect(receipt.storeWrites).toContain('suggestions:member-demo:suggestion-2026-11-09-1');
  expect(receipt.graphPath).toContain('suggest');
  expect(receipt.graphPath).toContain('save-suggestions');
  expect(receipt.llmCalls).toContain('absorb/suggest');
}, 120_000); // Source: existing runGraph absorb simulation timeout in this file.

test('MK 7963792 ingestion excludes page menus and comments from card and real briefing graph', async () => {
  const url = 'https://www.mk.co.kr/news/hot-issues/7963792';
  // Short, offline Reader-shaped excerpt from the named article. The page has navigation before
  // the article detail and a second comment panel after its copyright line.
  const readerContent = [
    '댓글 _0_ 댓글 새로고침', '나의 댓글', '댓글정책', '공감순 최신순 오래된순',
    '전체메뉴 닫기', '# 기사 상세', '## 나훈아 콘서트 예매 오늘(5일) 시작, YES24 접속 장애',
    '글자 크기 변경하기', '스크랩 하기', '[매일경제 스타투데이 권성미 인턴기자]',
    '티켓 예매의 동시 접속 폭주, 같은 좌석 중복 예매, 공정 대기열이 쟁점이다.',
    'YES24 접속 장애가 발생했다가 복구됐다.', 'smk92419@mk.co.kr',
    '[ⓒ 매일경제 & mk.co.kr, 무단전재 및 재배포 금지]',
    '댓글 _0_ 댓글 새로고침', '나의 댓글', '댓글정책', '공감순 최신순 오래된순',
    '## 연예 많이 본 기사',
  ].join('\n\n');
  const digest = await createScrapsWebDigest(async () => ({ title: '나훈아 콘서트 예매', content: readerContent }))(url);
  const card = await buildAbsorbSummaryCard({ ...digest, originUrl: url });
  const root = mkdtempSync(join(tmpdir(), 'absorb-mk-article-'));
  try {
    const source = readFileSync(join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml'), 'utf8');
    const world = source.replace('https://example.test/article', url)
      .replace('티켓 예매의 동시 접속 폭주, 같은 좌석 중복 예매, 공정 대기열이 쟁점이다.', digest.body.replace(/\n+/g, ' '));
    expect(world).toContain(digest.body.replace(/\n+/g, ' '));
    const worldPath = join(root, 'mk-7963792-world.yaml');
    writeFileSync(worldPath, world);
    const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true, worldPath });
    expect(receipt.ok).toBe(true);
    expect(receipt.graphStatus).toBe('done');
    const extractNode = (receipt.graphNodes as Array<{ nodeId: string; output?: string }>).find(node => node.nodeId === 'extract');
    expect(extractNode?.output).toContain(digest.body.replace(/\n+/g, ' '));
    const outputs = JSON.stringify({ digest, card, graphNodes: receipt.graphNodes, briefing: receipt.briefingSummary });
    for (const marker of ['댓글정책', '공감순', '전체메뉴', '글자 크기 변경하기', '스크랩 하기', '연예 많이 본 기사']) {
      expect(outputs).not.toContain(marker);
    }
    expect(digest.body).toContain('YES24 접속 장애');
    expect(receipt.graphPath).toContain('save-brief');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('H12 S1 HTTP source scrap feeds S2 briefing in the same isolated root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'absorb-h12-s1-s2-'));
  const url = 'https://www.mk.co.kr/news/hot-issues/7963792';
  const memberId = 'member-h12';
  const rootRunId = 'h12-s1-s2-root-test';
  const options = { ...createNexusScrapsRouteOptions(root, async () => ({ title: '나훈아 예매', content: [
    '# 기사 상세', '[매일경제 스타투데이 권성미 인턴기자]',
    '티켓 예매의 동시 접속 폭주, 같은 좌석 중복 예매, 공정 대기열이 쟁점이다.',
    'smk92419@mk.co.kr', '댓글정책',
  ].join('\n\n') })), resolveOwner: async () => ({ memberId }) };
  try {
    const post = await handleScraps(new Request('https://nexus.test/v1/scraps', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'h12-s1-s2-001' },
      body: JSON.stringify({ kind: 'web', source: 'telegram', raw: { url } }),
    }), options);
    expect(post.status).toBe(201);
    const s1 = await post.json() as { id: string; status: string };
    expect(s1.status).toBe('absorbed');
    const get = await handleScraps(new Request('https://nexus.test/v1/scraps'), options);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ scraps: [expect.objectContaining({ id: s1.id, memberId, status: 'absorbed' })] });
    const source = listAbsorbScraps(root, memberId).find(item => item.id === s1.id);
    expect(source?.absorb?.raw.url).toBe(url);
    const receipt = await runScene2Absorb({ instanceRoot: root, sourceUrl: url, deviceId: 'fake-absorb-ingest',
      rootRunId, memberId, sourceScrapId: s1.id, sourceCommit: process.env.ABSORB_H12_SOURCE_COMMIT ?? 'a'.repeat(40),
      evidencePath: join(root, 'scene-2.json') });
    expect(receipt).toMatchObject({ scene: 2, status: 'done', rootRunId, memberId,
      sourceScrapId: s1.id, briefingArtifactId: 'brief-member-h12-2026-11-09' });
    expect(JSON.parse(readFileSync(receipt.evidencePath, 'utf8'))).toEqual(receipt);
    const graphRaw = readFileSync(receipt.briefingArtifact.path, 'utf8');
    const graphState = JSON.parse(graphRaw) as { input: Record<string, unknown>;
      nodes: Array<{ nodeId: string; output?: string }> };
    expect(graphState.input).toMatchObject({ sourceScrapId: s1.id, rootRunId,
      context: { memberId, sourceScrapId: s1.id, rootRunId } });
    const briefOutput = JSON.parse(String(graphState.nodes.find(node => node.nodeId === 'brief')?.output)) as {
      evidence: { briefing: { id: string; scrapIds: string[] } } };
    expect(briefOutput.evidence.briefing).toMatchObject({ id: receipt.briefingArtifactId,
      scrapIds: [s1.id] });
    console.log(`H12_S1_S2_RECEIPT ${JSON.stringify(receipt)}`);
    expect(listAbsorbScraps(root, memberId).find(item => item.id === s1.id)?.absorb?.status).toBe('absorbed');
    await expect(runScene2Absorb({ instanceRoot: root, sourceUrl: url, deviceId: receipt.deviceId,
      rootRunId: `${rootRunId}-wrong-surface`, memberId, sourceScrapId: s1.id,
      sourceCommit: receipt.sourceCommit, sourceSurface: 'pwa', evidencePath: join(root, 'wrong-surface.json') }))
      .rejects.toThrow('source surface does not match');
    for (const protectedPath of [receipt.sourceLedger.path, receipt.briefingArtifact.path]) {
      const original = readFileSync(protectedPath, 'utf8');
      await expect(runScene2Absorb({ instanceRoot: root, sourceUrl: url,
        deviceId: receipt.deviceId, rootRunId, memberId, sourceScrapId: s1.id,
        sourceCommit: receipt.sourceCommit, evidencePath: protectedPath }))
        .rejects.toThrow('receipt path collides');
      expect(readFileSync(protectedPath, 'utf8')).toBe(original);
    }
    const aliasRunId = `${rootRunId}-alias`;
    const aliasSceneRunId = `${aliasRunId}-s2`;
    const futureArtifactPath = join(root, aliasSceneRunId, 'graph-runs', 'absorb-brief', `${aliasSceneRunId}.json`);
    const aliasParent = join(root, 'root-alias');
    symlinkSync(root, aliasParent, 'dir');
    expect(existsSync(futureArtifactPath)).toBe(false);
    await expect(runScene2Absorb({ instanceRoot: root, sourceUrl: url,
      deviceId: receipt.deviceId, rootRunId: aliasRunId, memberId, sourceScrapId: s1.id,
      sourceCommit: receipt.sourceCommit, evidencePath: join(aliasParent, aliasSceneRunId,
        'graph-runs', 'absorb-brief', `${aliasSceneRunId}.json`) }))
      .rejects.toThrow('receipt path collides');
    expect(existsSync(futureArtifactPath)).toBe(false);
    await expect(runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true, instanceRoot: root,
      sourceScrapId: s1.id, memberId: 'other-member', sourceUrl: url, rootRunId })).rejects.toThrow('same-root owner source scrap unavailable');
    await expect(runScene2Absorb({ instanceRoot: join(root, 'other-root'), sourceUrl: url,
      deviceId: receipt.deviceId, rootRunId, memberId, sourceScrapId: s1.id,
      sourceCommit: receipt.sourceCommit, evidencePath: join(root, 'wrong-root.json') }))
      .rejects.toThrow('same-root owner source scrap unavailable');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);

for (const [surface, wire] of [['pwa', 'pwa'], ['iphone', 'android-share']] as const) {
  test(`Scene 2 consumes the same-root ${surface} member scrap ID`, async () => {
    const root = mkdtempSync(join(tmpdir(), `absorb-${surface}-s2-`));
    const url = 'https://www.mk.co.kr/news/hot-issues/7963792';
    const memberId = `member-${surface}`;
    const options = { ...createNexusScrapsRouteOptions(root, async () => ({ title: '나훈아 예매', content: [
      '# 기사 상세', '[매일경제 스타투데이 권성미 인턴기자]',
      '티켓 예매의 동시 접속 폭주, 같은 좌석 중복 예매, 공정 대기열이 쟁점이다.',
      'smk92419@mk.co.kr', '댓글정책',
    ].join('\n\n') })), resolveOwner: async () => ({ memberId }) };
    try {
      const post = await handleScraps(new Request('https://nexus.test/v1/scraps', { method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `${surface}-scene2-001` },
        body: JSON.stringify({ kind: 'web', source: wire, raw: { url } }),
      }), options);
      expect(post.status).toBe(201);
      const source = await post.json() as { id: string; source: string };
      const get = await handleScraps(new Request('https://nexus.test/v1/scraps'), options);
      expect(get.status).toBe(200);
      expect(await get.json()).toMatchObject({ scraps: [expect.objectContaining({ id: source.id, source: wire, memberId })] });
      const receipt = await runScene2Absorb({ instanceRoot: root, sourceUrl: url,
        deviceId: 'fake-absorb-ingest', rootRunId: `same-root-${surface}`, memberId,
        sourceScrapId: source.id, sourceCommit: process.env.ABSORB_H12_SOURCE_COMMIT ?? 'a'.repeat(40),
        sourceSurface: surface, evidencePath: join(root, `scene-2-${surface}.json`) });
      expect(receipt).toMatchObject({ scene: 2, status: 'done', sourceSurface: surface,
        sourceWire: wire, sourceScrapId: source.id, memberId, briefingArtifactId: expect.any(String) });
      expect(readFileSync(receipt.briefingArtifact.path, 'utf8')).toContain(source.id);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 120_000);
}

test('scene-2 rejects missing or blank briefing IDs before issuing a receipt', () => {
  for (const id of [undefined, '', '   ']) {
    expect(() => assertScene2Briefing({ id, owner: 'member-h12', scrapIds: ['source-1'] },
      'member-h12', 'source-1', 'done')).toThrow('nonempty artifact ID');
  }
});

for (const scenario of ['member-without-app-slot', 'empty-member-sources'] as const) {
  test(`${scenario} keeps briefing storage and notification while skipping optional requirements`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'absorb-brief-fallback-'));
    try {
      const source = readFileSync(join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml'), 'utf8');
      const world = scenario === 'member-without-app-slot'
        ? source.replace(/      apps:\n        - id: lecture-scrap-demo\n          screens: \[scraps, lecture-notes\]\n          rpc: \[scraps.list, notes.create\]/, '      apps: []')
        : source.replace(/^    - \{ id: article-1,.*\}\n/m, '');
      expect(world).not.toBe(source);
      const worldPath = join(root, 'fallback-world.yaml');
      writeFileSync(worldPath, world);
      const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true, worldPath });
      expect(receipt.graphStatus).toBe('done');
      expect(receipt.graphPath).toContain('save-brief');
      expect(receipt.graphPath).toContain('notify');
      expect(receipt.graphPath).not.toContain('design');
      expect(receipt.storeWrites).toContain('briefings:member-demo:2026-11-09');
      expect(receipt.storeWrites).not.toContainEqual(expect.stringContaining('design-packs:'));
      expect(receipt.notificationDeliveries).toEqual([
        'brief-member-demo-2026-11-09:android',
        'brief-member-demo-2026-11-09:tui',
        'brief-member-demo-2026-11-09:telegram',
      ]);
      const skipped = (receipt.graphNodes as Array<{ nodeId: string; output?: string }>).find(node => node.nodeId === 'requirements');
      expect(skipped?.output).toContain(`optional-evidence-unavailable:${scenario === 'member-without-app-slot' ? 'slots' : 'sources'}`);
      expect(receipt.llmCalls).not.toContain('absorb/requirements');
      expect(receipt.llmCalls).not.toContain('absorb/design');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
}

test('an unrelated article keeps the general three-line requirements route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'absorb-general-article-'));
  try {
    const source = readFileSync(join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml'), 'utf8');
    const world = source.replace('티켓 예매의 동시 접속 폭주, 같은 좌석 중복 예매, 공정 대기열이 쟁점이다.', '강연 노트를 회원의 읽기 목록에 저장하고 다시 열어본다.');
    expect(world).not.toBe(source);
    const worldPath = join(root, 'general-world.yaml');
    writeFileSync(worldPath, world);
    const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true, worldPath });
    expect(receipt.ok).toBe(true);
    expect(receipt.requirementLines).toEqual([
      'Save the article as a member-owned reading item [article-1]',
      'Show the article summary in the briefing view [article-1]',
      'Open the source article from the reading item [article-1]',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('requirements enforce the declared bracket citation form before design save', async () => {
  const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true,
    worldPath: join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml'),
    permissiveDesignStore: true,
    mutateRequirements: (requirements: Record<string, unknown>) => ({ ...requirements,
      lines: (requirements.lines as string[]).map(line => line.replace('[article-1]', '(source: article-1)')) }) });
  expect(receipt.ok).toBe(false);
  expect(receipt.storeWrites).not.toContainEqual(expect.stringContaining('design-packs:'));
  expect(receipt.storeWrites).not.toContainEqual(expect.stringContaining('suggestions:'));
}, 90_000); // Source: one bounded runGraph simulation on the same aws2 fixture.

const designRejectionCases = [
  { omitAppSlotsFromStore: true },
  { mutateRequirements: (requirements: Record<string, unknown>) => ({ ...requirements,
    lines: (requirements.lines as string[]).map(line => line.replace(/\s*\[[^\]]+\]/, '')) }) },
  { mutateDesign: (design: Record<string, unknown>) => ({ ...design, requirementLines: [...(design.requirementLines as string[])].reverse() }) },
  { mutateDesign: (design: Record<string, unknown>) => ({ ...design, scrapIds: ['private-other-member'] }) },
  { mutateDesignResult: (result: Record<string, unknown>) => ({ ...result, scrapIds: ['private-other-member'] }) },
  { mutateDesign: (design: Record<string, unknown>) => ({ ...design, changes: (design.changes as Array<Record<string, unknown>>).map((change) => ({ ...change, target: 'invented-screen' })) }) },
];

async function expectDesignWritesRejected(cases: typeof designRejectionCases): Promise<void> {
  const worldPath = join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml');
  for (const scenario of cases) {
    const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true, worldPath,
      permissiveDesignStore: true, ...scenario });
    expect(receipt.ok).toBe(false);
    expect(receipt.storeWrites).not.toContainEqual(expect.stringContaining('design-packs:'));
    expect(receipt.storeWrites).not.toContainEqual(expect.stringContaining('suggestions:'));
  }
}

test('design uses owner app slots and rejects missing slots or altered requirements', async () => {
  const worldPath = join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml');
  const serverSupplied = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true, worldPath,
    omitAppSlotsFromGraphInput: true, permissiveDesignStore: true });
  expect(serverSupplied.ok).toBe(true);
  expect(serverSupplied.designInputs).toMatchObject([{ context: { appSlots: [{ id: 'lecture-scrap-demo' }] } }]);
  expect(serverSupplied.storeWrites).toContain('suggestions:member-demo:suggestion-2026-11-09-1');
  await expectDesignWritesRejected(designRejectionCases.slice(0, 3)); // Source: first three failure cases in this test matrix.
}, 180_000); // Source: four bounded runGraph simulations at about 30 seconds each on aws2.

test('design rejects altered source IDs and app targets before storage', async () => {
  await expectDesignWritesRejected(designRejectionCases.slice(3));
}, 180_000); // Source: three bounded runGraph simulations at about 30 seconds each on aws2.

test('design rejects absent or blank change action before storage', async () => {
  const worldPath = join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml');
  const mutations = [
    (change: Record<string, unknown>) => { const { action: _action, ...rest } = change; return rest; },
    (change: Record<string, unknown>) => ({ ...change, action: '  ' }),
  ];
  for (const mutate of mutations) {
    const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true, worldPath,
      permissiveDesignStore: true,
      mutateDesign: (design: Record<string, unknown>) => ({ ...design,
        changes: (design.changes as Array<Record<string, unknown>>).map(mutate) }) });
    expect(receipt.ok).toBe(false);
    expect(receipt.storeWrites).not.toContainEqual(expect.stringContaining('design-packs:'));
    expect(receipt.storeWrites).not.toContainEqual(expect.stringContaining('suggestions:'));
  }
}, 120_000);

test('a completed design persists suggestions after owner design validation', async () => {
  const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true,
    worldPath: join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml') });
  expect(receipt.graphStatus).toBe('done');
  expect(receipt.graphPath).toEqual(expect.arrayContaining(['save-brief', 'save-design', 'persist-design', 'notify', 'done']));
  expect(receipt.graphPath).toContain('validate-design');
  expect(receipt.graphPath).toEqual(expect.arrayContaining(['load-design', 'suggest', 'validate-suggestions', 'save-suggestions']));
  expect(receipt.storeWrites).toContain('design-packs:member-demo:brief-member-demo-2026-11-09');
  expect(receipt.storeWrites).toContain('suggestions:member-demo:suggestion-2026-11-09-1');
}, 120_000);

test('one real brief graph run stores owner suggestions without fixture injection', async () => {
  const receipt = await runAbsorbGraphSimulation({ briefOnly: true, confirmation: 'y',
    withoutSuggestionFixtures: true, verifyApprovalTarget: true,
    worldPath: join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml') });
  expect(receipt).toMatchObject({ ok: true, status: 'done', suggestionSource: 'graph-store' });
  expect(receipt.suggestionStoreWrites).toContain('suggestions:member-demo:suggestion-2026-11-09-1');
  expect(receipt.suggestions).toEqual(expect.arrayContaining([expect.objectContaining({
    id: 'suggestion-2026-11-09-1', owner: 'member-demo', appId: 'lecture-scrap-demo',
    briefingId: 'brief-member-demo-2026-11-09', designPackId: 'brief-member-demo-2026-11-09',
    evidenceScrapIds: ['article-1'],
  })]));
  const listedSuggestionIds = (receipt.consumer as { suggestions: Array<{ id: string }> }).suggestions.map(item => item.id);
  expect(receipt.consumer).toMatchObject({ graphId: 'absorb-suggest-list', status: 'done',
    suggestions: expect.arrayContaining([expect.objectContaining({
      id: 'suggestion-2026-11-09-1', designPackId: 'brief-member-demo-2026-11-09',
    })]),
  });
  expect(receipt.approvalTarget).toMatchObject({ graphId: 'absorb-build', status: 'awaiting-approval',
    lookup: { designPackId: 'brief-member-demo-2026-11-09' },
  });
  const approval = receipt.approvalTarget as { suggestionId: string; lookup: { id: string } };
  expect(approval.lookup.id).toBe(approval.suggestionId);
  expect(listedSuggestionIds).toContain(approval.suggestionId);
  expect((receipt.evidence as Array<Record<string, unknown>>).map(node => node.nodeId))
    .toEqual(expect.arrayContaining(['load-design', 'suggest', 'validate-suggestions', 'save-suggestions']));
}, 120_000);

test('real graph rejects mismatched owner, source, citation, and slot before suggestion storage', async () => {
  const worldPath = join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml');
  for (const field of ['owner', 'source', 'citation', 'slot'] as const) {
    const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true, worldPath,
      mutateSuggestion: suggestion => field === 'owner' ? { ...suggestion, owner: 'other-member' }
        : field === 'source' ? { ...suggestion, evidenceScrapIds: ['other-scrap'] }
          : field === 'citation' ? { ...suggestion, change: 'uncited recommendation' }
          : { ...suggestion, appId: 'foreign-app' } });
    expect(receipt.graphStatus).toBe('failed');
    expect(receipt.graphPath).toContain('validate-suggestions');
    expect(receipt.suggestionStoreWrites).toEqual([]);
    expect(receipt.notificationDeliveries).toHaveLength(3);
  }
}, 180_000);

test('real graph rejects a mixed allowed and foreign citation before suggestion storage', async () => {
  const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true,
    worldPath: join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml'),
    mutateSuggestion: suggestion => ({ ...suggestion, change: `${suggestion.change} [foreign-scrap]` }) });
  expect(receipt.graphStatus).toBe('failed');
  expect(receipt.graphPath).toContain('validate-suggestions');
  expect(receipt.suggestionStoreWrites).toEqual([]);
}, 120_000);

test('real graph rejects a suggestion ID already held by another briefing without overwriting approval', async () => {
  const existing = { id: 'suggestion-2026-11-09-1', owner: 'member-demo',
    briefingId: 'another-brief', designPackId: 'another-brief', appId: 'lecture-scrap-demo',
    approvalStatus: 'approved', evidenceScrapIds: ['article-1'], requirementLines: [] };
  const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true,
    worldPath: join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml'),
    initialSuggestions: [existing] });
  expect(receipt.graphStatus).toBe('failed');
  expect(receipt.graphPath).toContain('validate-suggestions');
  expect(receipt.suggestionStoreWrites).toEqual([]);
  expect(receipt.suggestions).toContainEqual(expect.objectContaining(existing));
}, 120_000);

test('real graph keeps an approved same-brief suggestion when the model proposes its ID again', async () => {
  const existing = { id: 'suggestion-2026-11-09-1', owner: 'member-demo',
    briefingId: 'brief-member-demo-2026-11-09', designPackId: 'brief-member-demo-2026-11-09',
    appId: 'lecture-scrap-demo', approvalStatus: 'approved', evidenceScrapIds: ['article-1'],
    requirementLines: [
      '동시 접속 폭주에도 예매 화면에 입장할 수 있어야 한다 [article-1]',
      '같은 좌석의 중복 예매를 막고 확정 결과를 보여줘야 한다 [article-1]',
      '공정 대기열에서 순번과 대기 상태를 볼 수 있어야 한다 [article-1]',
    ] };
  const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true,
    worldPath: join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml'),
    initialSuggestions: [existing] });
  expect(receipt.graphStatus).toBe('done');
  expect(receipt.suggestionStoreWrites).not.toContain('suggestions:member-demo:suggestion-2026-11-09-1');
  expect(receipt.suggestionStoreWrites).toContain('suggestions:member-demo:suggestion-2026-11-09-2');
  expect(receipt.suggestions).toContainEqual(expect.objectContaining(existing));
}, 120_000);

test('two concurrent real brief graphs cannot replace the same owner suggestion or its approval', async () => {
  const receipt = await runAbsorbGraphSimulation({ concurrentBriefRuns: true, confirmation: 'y',
    worldPath: join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml') });
  expect(receipt.concurrentReadCount).toBe(2);
  expect(receipt.statuses).toContain('failed');
  const writes = receipt.suggestionStoreWrites as string[];
  expect(writes).not.toHaveLength(0);
  expect(new Set(writes).size).toBe(writes.length);
  const suggestions = receipt.suggestions as Array<Record<string, unknown>>;
  expect(new Set(suggestions.map(item => item.id)).size).toBe(suggestions.length);
  expect(suggestions.filter(item => item.approvalStatus === 'approved')).toHaveLength(1);
}, 120_000);

test('real graph rejects a changed persisted design before suggestion storage', async () => {
  const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true,
    worldPath: join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml'),
    mutateLoadedDesign: design => ({ ...design, scrapIds: ['other-scrap'] }) });
  expect(receipt.graphStatus).toBe('failed');
  expect(receipt.graphPath).toContain('validate-suggestions');
  expect(receipt.suggestionStoreWrites).toEqual([]);
}, 120_000);

test('real graph stops when the persisted owner design is missing', async () => {
  const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true,
    worldPath: join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml'),
    omitStoredDesignOnRead: true });
  expect(receipt.graphStatus).toBe('failed');
  expect(receipt.graphPath).toContain('load-design');
  expect(receipt.graphPath).not.toContain('suggest');
  expect(receipt.suggestionStoreWrites).toEqual([]);
  expect(receipt.notificationDeliveries).toHaveLength(3);
}, 120_000);

test('design storage fails when the graph key or value reference is broken', async () => {
  const worldPath = join(import.meta.dir, '../../plugins/absorb/sims/brief-requirements-design-world.yaml');
  const graph = readFileSync(join(import.meta.dir, '../../plugins/absorb/graph/absorb-brief.yaml'), 'utf8');
  const root = mkdtempSync(join(tmpdir(), 'absorb-design-ref-test-'));
  try {
    for (const reference of ['key', 'value']) {
      const changed = graph.replace(`${reference}: "$${reference === 'key' ? 'brief.evidence.briefing.id' : 'design.evidence.design'}"`, `${reference}: "$missing.evidence.design"`);
      expect(changed).not.toBe(graph);
      const path = join(root, `bad-${reference}.yaml`);
      writeFileSync(path, changed);
      const receipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefDesignOnly: true, worldPath,
        briefGraphFile: path, permissiveDesignStore: true });
      expect(receipt.ok).toBe(false);
      expect(receipt.storeWrites).not.toContainEqual(expect.stringContaining('design-packs:'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000); // Source: two graph mutations exercise the real save-design key/value bindings.
