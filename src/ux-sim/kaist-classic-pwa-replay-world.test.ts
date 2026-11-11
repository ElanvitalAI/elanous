import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createKaistPwaReplayWorld, loadKaistClassicPtyReceipt, validateKaistClassicPtyReceipt } from './kaist-classic-pwa-replay-world.js';

test('KAIST PWA replay world serves the actual classic PTY owner, briefing, accepted build, board, and attachment', async () => {
  const envelope = loadKaistClassicPtyReceipt();
  validateKaistClassicPtyReceipt(envelope);
  const world = createKaistPwaReplayWorld(envelope);
  const appSlug = String((envelope.receipt.scenes['4']?.output.suggestion as { appId?: string } | undefined)?.appId ?? 'kaist-fake-app');
  const request = (path: string) => world.handleApi(new Request(`http://127.0.0.1${path}`));

  expect(await (await request('/v1/members')).json()).toMatchObject({
    member: { id: envelope.receipt.owner }, appSlot: { appSlug },
  });
  expect(await (await request(`/v1/members/owner?appSlug=${appSlug}`)).json()).toMatchObject({ memberId: envelope.receipt.owner });

  world.setScene(2);
  const briefing = await (await request('/v1/briefings?day=2026-11-11')).json() as { briefings: Array<{ memberId: string; id: string }> };
  expect(briefing.briefings[0]).toMatchObject({ memberId: envelope.receipt.owner,
    id: (envelope.receipt.scenes['3']?.output as { briefingId?: string } | undefined)?.briefingId });
  const proposed = await (await request('/v1/board')).json() as { cards: Array<{ id: string; state: string; runId: string }> };
  expect(proposed.cards[0]).toMatchObject({ id: envelope.receipt.boardCard.id, state: 'proposed', runId: envelope.receipt.scenes['3']?.runId });

  world.setScene(3);
  const chatBoard = await (await request('/v1/board')).json() as { cards: Array<{ title: string }> };
  const suggestedAsk = (envelope.receipt.scenes['4']?.output.suggestion as { ask?: string } | undefined)?.ask;
  if (suggestedAsk === undefined) throw new Error('KAIST suggestion receipt is missing its ask');
  expect(chatBoard.cards[0]?.title).toBe(suggestedAsk);

  world.setScene(5);
  const graphResponse = await request(`/v1/graph-instance-view?source=graph&runId=${envelope.receipt.graphRun?.runId}&graphId=absorb-build`);
  expect(graphResponse.status).toBe(200);
  const graphView = await graphResponse.json() as { instance: { runId: string; graphId: string; state: string }; progress: { completed: number } };
  expect(graphView.instance).toMatchObject({ runId: envelope.receipt.scenes['5']?.runId, graphId: 'absorb-build', state: 'done' });
  // Source: #36517 actual absorb-build receipt records at least one completed graph node.
  expect(graphView.progress.completed).toBeGreaterThan(0);
  expect((await request('/v1/graph-instance-view?source=graph&runId=foreign&graphId=absorb-build')).status).toBe(404);

  world.setScene(6);
  const deployed = await (await request('/v1/board')).json() as { cards: Array<{ id: string; state: string; resultUrl?: string; attachments?: Array<{ sha256: string; producedBy: string }> }> };
  expect(deployed.cards[0]).toMatchObject({ id: envelope.receipt.boardCard.id, state: 'deployed', resultUrl: envelope.receipt.scenes['6']?.output.resultUrl });
  expect(deployed.cards[0]?.attachments?.[0]).toMatchObject({ sha256: envelope.receipt.attachment.sha256, producedBy: 'absorb-build' });
  expect(world.unsupportedApiPaths).toEqual([]);
});

test('KCB ticket receipt carries build-owned service and capacity fields while retaining the briefing-owner gap', () => {
  const envelope = loadKaistClassicPtyReceipt(resolve(import.meta.dir, 'fixtures/kcb-ticket-classic-pty-receipt.json'));
  const mapping = JSON.parse(readFileSync(resolve(import.meta.dir, 'fixtures/kcb-ticket-requirements-mapping.json'), 'utf8')) as {
    sourceRunIds: { briefing: string; acceptance: string };
    briefingMapping: { id: string; owner: { status: string }; topics: unknown[] };
    acceptance: { suggestionId: string; owner: string; accepted: boolean; service: string };
    capacityAssumption: { concurrentUsers: number; rationale: string; source: string; userSpecified: boolean };
  };
  expect(mapping.sourceRunIds).toEqual({ briefing: envelope.receipt.scenes['3']!.runId, acceptance: envelope.receipt.scenes['5']!.runId });
  const sourceBriefing = envelope.receipt.scenes['3']!.output.briefing as { id: string; topics: unknown[] };
  expect(mapping.briefingMapping.id).toBe(sourceBriefing.id);
  expect(mapping.briefingMapping.topics).toEqual(sourceBriefing.topics);
  expect(mapping.acceptance).toEqual(envelope.receipt.scenes['5']!.output.acceptance);
  expect(envelope.receipt.graphPath).toEqual(['lookup-suggestion', 'build', 'simulate', 'approve-publish', 'publish', 'done']);
  expect(envelope.receipt.graphRun?.path).toEqual(envelope.receipt.graphPath);
  expect(mapping.briefingMapping.owner.status).toBe('missing');
  expect(mapping.acceptance.service).toBe('티켓 예매 서비스');
  expect(mapping.capacityAssumption).toEqual({ concurrentUsers: 300,
    rationale: '요청에 "동시 300명"이 명시됨.', source: 'user-input', userSpecified: true });
  expect(envelope.receipt.scenes['5']?.output.acceptance).toMatchObject({
    suggestionId: envelope.receipt.scenes['4']?.output.suggestion && (envelope.receipt.scenes['4']!.output.suggestion as { id: string }).id,
    owner: envelope.receipt.owner, accepted: true, service: '티켓 예매 서비스',
  });
  expect(envelope.receipt.scenes['5']?.output.capacityAssumption).toEqual(mapping.capacityAssumption);
});

test('KAIST replay receipt validation permits additional ordered graph steps', () => {
  const envelope = loadKaistClassicPtyReceipt(resolve(import.meta.dir, 'fixtures/kcb-ticket-classic-pty-receipt.json'));
  const extended = structuredClone(envelope);
  extended.receipt.graphPath!.splice(3, 0, 'validate-publish-input');
  extended.receipt.graphRun!.path.splice(3, 0, 'validate-publish-input');
  expect(() => validateKaistClassicPtyReceipt(extended)).not.toThrow();
});

test('KAIST replay receipt validation rejects publish before approval even if publish runs again later', () => {
  const envelope = loadKaistClassicPtyReceipt(resolve(import.meta.dir, 'fixtures/kcb-ticket-classic-pty-receipt.json'));
  const reordered = structuredClone(envelope);
  const approvalIndex = reordered.receipt.graphPath!.indexOf('approve-publish');
  reordered.receipt.graphPath!.splice(approvalIndex, 0, 'publish');
  reordered.receipt.graphRun!.path.splice(approvalIndex, 0, 'publish');
  expect(() => validateKaistClassicPtyReceipt(reordered)).toThrow('ordered absorb-build path');
});

test('KAIST replay receipt validation rejects required build steps that occur after an early publish', () => {
  const envelope = loadKaistClassicPtyReceipt(resolve(import.meta.dir, 'fixtures/kcb-ticket-classic-pty-receipt.json'));
  const reordered = structuredClone(envelope);
  const invalidPath = ['lookup-suggestion', 'approve-publish', 'publish', 'build', 'simulate', 'approve-publish', 'publish', 'done'];
  reordered.receipt.graphPath = invalidPath;
  reordered.receipt.graphRun!.path = [...invalidPath];
  expect(() => validateKaistClassicPtyReceipt(reordered)).toThrow('ordered absorb-build path');
});

test('KAIST replay receipt validation permits an earlier approval when required steps precede first publish', () => {
  const envelope = loadKaistClassicPtyReceipt(resolve(import.meta.dir, 'fixtures/kcb-ticket-classic-pty-receipt.json'));
  const extended = structuredClone(envelope);
  const path = ['lookup-suggestion', 'approve-publish', 'build', 'simulate', 'approve-publish', 'publish', 'done'];
  extended.receipt.graphPath = path;
  extended.receipt.graphRun!.path = [...path];
  expect(() => validateKaistClassicPtyReceipt(extended)).not.toThrow();
});
