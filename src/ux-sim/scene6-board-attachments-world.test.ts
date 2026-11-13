import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { handleScraps } from '../nexus/api/scraps.js';
import { createNexusScrapsRouteOptions } from '../nexus/api/scraps-web-digest.js';
import { createJsonlMemberEventStore } from '../nexus/api/member-event-store.js';
import { handleBoardRoute, type BoardCardEvent } from '../nexus/api/board-api.js';
import { nextScene6BoardReceipt } from '../repl/scene6-board-receipt.js';
import { runScene2Absorb } from '../../scripts/demo1114-s2-absorb-scene.js';
import { fakeBoardAttachmentReferences, runAbsorbGraphSimulation } from './absorb-v2-runGraph-sim.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('Scene 6 reads actual PNG and PDF bytes from the same S1 source root and graph board card', async () => {
  const evidenceBase = process.env.ABSORB_S6_EVIDENCE_ROOT;
  if (evidenceBase) mkdirSync(evidenceBase, { recursive: true });
  const root = mkdtempSync(join(evidenceBase ?? tmpdir(), 'absorb-s2-s6-'));
  const rootRunId = 'demo0316-s2-s6-root';
  const memberId = 'member-s2-s6';
  const sourceUrl = 'https://www.mk.co.kr/news/hot-issues/7963792';
  const token = 'test-member-session';
  const sourceCommit = process.env.ABSORB_H12_SOURCE_COMMIT ?? 'a'.repeat(40);
  const article = { ...createNexusScrapsRouteOptions(root, async () => ({ title: '나훈아 예매', content: [
    '# 기사 상세', '[매일경제 스타투데이 권성미 인턴기자]',
    '동시 접속 폭주, 중복 예매, 공정 대기열이 쟁점이다.', 'smk92419@mk.co.kr', '댓글정책',
  ].join('\n\n') })), resolveOwner: async () => ({ memberId }) };
  try {
    const post = await handleScraps(new Request('https://nexus.test/v1/scraps', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'demo0316-s2-s6-root' },
      body: JSON.stringify({ kind: 'web', source: 'pwa', raw: { url: sourceUrl } }),
    }), article);
    expect(post.status).toBe(201);
    const source = await post.json() as { id: string; status: string };
    const get = await handleScraps(new Request('https://nexus.test/v1/scraps'), article);
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ scraps: [expect.objectContaining({ id: source.id, memberId, status: 'absorbed' })] });
    const scene2 = await runScene2Absorb({ instanceRoot: root, sourceUrl, deviceId: 'fake-absorb-ingest',
      rootRunId, memberId, sourceScrapId: source.id, sourceCommit, sourceSurface: 'pwa',
      evidencePath: join(root, 'scene-2-receipt.json') });

    const artifactDirectory = join(root, 'test-artifacts');
    mkdirSync(artifactDirectory);
    const references = fakeBoardAttachmentReferences().map(row => {
      if ((row.kind !== 'diagram' && row.kind !== 'pdf') || typeof row.url !== 'string'
        || typeof row.title !== 'string' || typeof row.mime !== 'string'
        || typeof row.sha256 !== 'string' || typeof row.producedBy !== 'string')
        throw new Error('invalid checked-in board attachment reference');
      return { kind: row.kind, url: row.url, title: row.title, mime: row.mime,
        sha256: row.sha256, producedBy: row.producedBy };
    });
    const sourceDirectory = resolve(import.meta.dir, '../../plugins/gcp-architect-expand/sim/sample-output');
    const attachments = references.map(reference => {
      const name = basename(String(reference.url));
      const sourceFile = join(sourceDirectory, name);
      const bytes = readFileSync(sourceFile);
      expect(sha256(bytes)).toBe(reference.sha256);
      const destination = join(artifactDirectory, name);
      copyFileSync(sourceFile, destination);
      return { ...reference, url: `https://nexus.test/v1/test-artifacts/${rootRunId}/${name}`, path: destination };
    });
    const attachmentByUrl = new Map(attachments.map(({ url, path }) => [url, path]));
    const briefGraph = JSON.parse(readFileSync(scene2.briefingArtifact.path, 'utf8')) as {
      nodes: Array<{ nodeId: string; output?: string }> };
    const suggested = briefGraph.nodes.find(node => node.nodeId === 'suggest');
    const proposed = JSON.parse(String(suggested?.output)) as { result?: { items?: Array<Record<string, unknown>> } };
    const proposal = proposed.result?.items?.[0];
    const suggestionId = String(proposal?.id ?? '');
    expect(proposal).toMatchObject({ owner: memberId, briefingId: scene2.briefingArtifactId,
      designPackId: scene2.briefingArtifactId, evidenceScrapIds: [source.id] });
    const buildRunId = `${rootRunId}-s6`;
    const build = await runAbsorbGraphSimulation({ confirmation: 'y', buildOnly: true,
      worldPath: resolve(import.meta.dir, '../../plugins/absorb/sims/h12-s1-s2-same-root-world.yaml'),
      instanceRoot: root, memberId, sourceScrapId: source.id, sourceUrl, rootRunId,
      routeSuggestionId: suggestionId, sourceBriefRunId: scene2.sceneRunId, approvalRunId: buildRunId,
      boardAttachments: attachments.map(({ path: _path, ...reference }) => reference),
      onAcceptedBuild: async state => { expect(state.status).toBe('done'); },
    });
    const store = createJsonlMemberEventStore(join(root, 'member-board-events'));
    expect(build).toMatchObject({ status: 'done', selectedSuggestion: proposal,
      lookupSuggestion: proposal, sourceBrief: { path: scene2.briefingArtifact.path,
        sha256: scene2.briefingArtifact.sha256 } });
    const eventRows = await store.query({ memberId, type: 'board.card' });
    expect(eventRows.map(row => row.state)).toEqual(['building', 'testing', 'released']);
    const eventTimes = eventRows.map(row => Date.parse(String(row.at)));
    expect(eventTimes.every(Number.isFinite)).toBe(true);
    expect([...eventTimes].sort((a, b) => a - b)).toEqual(eventTimes);
    const released = eventRows.at(-1) as unknown as BoardCardEvent;
    expect(released).toMatchObject({ cardId: suggestionId, memberId, runId: buildRunId,
      result: { publicUrl: expect.stringContaining('sim.invalid') },
      attachments: expect.arrayContaining(attachments.map(({ path: _path, ...reference }) => expect.objectContaining({
        kind: reference.kind, url: reference.url, sha256: reference.sha256,
      }))) });

    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const authenticated = new Headers(init?.headers).get('authorization') === `Bearer ${token}`;
      if (!authenticated) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (url.pathname === '/v1/board') {
        const response = await handleBoardRoute(new Request(url, init), url.pathname,
          { store, resolveOwner: async () => ({ memberId }) });
        if (!response) throw new Error('board readback route unavailable');
        return response;
      }
      const path = attachmentByUrl.get(url.href);
      if (!path) return Response.json({ error: 'not_found' }, { status: 404 });
      return new Response(readFileSync(path), { status: 200,
        headers: { 'content-type': path.endsWith('.png') ? 'image/png' : 'application/pdf' } });
    };
    const card = await nextScene6BoardReceipt({ graph: { graphId: 'absorb-build', status: 'done', runId: buildRunId },
      expectedGraphId: 'absorb-build', cardId: suggestionId, memberId, nexusUrl: 'https://nexus.test',
      sessionToken: token, fetchImpl });
    expect(card).toContain('architecture.png');
    expect(card).toContain('architecture-design.pdf');
    expect(await nextScene6BoardReceipt({ graph: { graphId: 'absorb-build', status: 'done', runId: 'other-run' },
      expectedGraphId: 'absorb-build', cardId: suggestionId, memberId, nexusUrl: 'https://nexus.test',
      sessionToken: token, fetchImpl })).toBeNull();
    expect(await nextScene6BoardReceipt({ graph: { graphId: 'absorb-build', status: 'done', runId: buildRunId },
      expectedGraphId: 'absorb-build', cardId: suggestionId, memberId: 'other-member', nexusUrl: 'https://nexus.test',
      sessionToken: token, fetchImpl })).toBeNull();
    for (const attachment of attachments) {
      const response = await fetchImpl(attachment.url, { headers: { authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(sha256(bytes)).toBe(attachment.sha256);
      expect(response.headers.get('content-type')).toBe(attachment.kind === 'diagram' ? 'image/png' : 'application/pdf');
      expect(attachment.kind === 'diagram' ? Buffer.from(bytes.subarray(0, 8)).toString('hex') : new TextDecoder().decode(bytes.subarray(0, 5)))
        .toBe(attachment.kind === 'diagram' ? '89504e470d0a1a0a' : '%PDF-');
      expect((await fetchImpl(attachment.url)).status).toBe(401);
    }
    const graphPath = join(root, buildRunId, 'graph-runs', 'absorb-build', `${buildRunId}.json`);
    const journalPath = join(root, 'member-board-events', readdirSync(join(root, 'member-board-events'))
      .find(name => name.endsWith('.jsonl'))!);
    const receiptPath = join(root, 'scene6-receipt.json');
    const receipt = { rootRunId, memberId, sourceScrapId: source.id, sourceCommit, receiptPath,
      scene2ArtifactId: scene2.briefingArtifactId, scene2ArtifactPath: scene2.briefingArtifact.path,
      scene2ArtifactSha256: scene2.briefingArtifact.sha256, sourceProposal: proposal,
      buildSourceBrief: build.sourceBrief, buildRunId, graphPath,
      graphSha256: sha256(readFileSync(graphPath)), cardId: suggestionId,
      boardJournalPath: journalPath, boardJournalSha256: sha256(readFileSync(journalPath)),
      boardEvents: eventRows.map(row => ({ state: row.state, runId: row.runId, at: row.at })),
      attachments: attachments.map(({ kind, url, path, sha256: hash }) => ({ kind, url, path, sha256: hash })) };
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(receipt);
    console.log(`S2_S6_SAME_ROOT_RECEIPT ${JSON.stringify(receipt)}`);
  } finally { if (!evidenceBase) rmSync(root, { recursive: true, force: true }); }
}, 120_000);
