import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeRequest, type NexusHttpServerOpts } from '../nexus/api/http-server.js';
import { createMembersApi } from '../nexus/members/members-api.js';
import { createMemberStore } from '../nexus/members/member-store.js';
import { createJsonlMemberEventStore } from '../nexus/api/member-event-store.js';
import { createDevProxyRuntimeRef } from '../nexus/api/admin-dev-proxy.js';
import { loadNexusAppHost } from '../nexus/apps/app-host.js';
import { createBoardApprovalDispatch } from '../../plugins/absorb/handlers/board-approval.js';
import { runAbsorbGraphSimulation } from './absorb-v2-runGraph-sim.js';
import type { BoardCardEvent } from '../nexus/api/board-api.js';
import { createHash } from 'node:crypto';
import { emptyGraphCapabilityRegistry, registerGraphCapabilityContract, registerGraphCapabilityProviderDeclaration } from '../graph-runner/capabilities.js';
import { generateStructuredDesign } from '../graph-runner/architecture-output/structured-design.js';
import { decideGraphApproval, runGraph } from '../graph-runner/runner.js';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { nextScene6BoardReceipt } from '../repl/scene6-board-receipt.js';

function createTestWorldArchitectureRegistry(repo: string, structuredDesignPath: string, output: string) {
  // The KAIST world tests graph approval and attachment routing. Renderer installation
  // and actual PNG/PDF generation have their own architecture-deliverables contract tests.
  const stages = ['design', 'diagram', 'pdf', 'verify'] as const;
  const sample = join(repo, 'docs/samples/architecture-deliverables/ticketing');
  let registry = emptyGraphCapabilityRegistry();
  for (const stage of stages) registry = registerGraphCapabilityContract(registry, {
    id: `architecture.${stage}@1`, input: { type: 'object' }, output: { type: 'object' },
  });
  return registerGraphCapabilityProviderDeclaration(registry, {
    id: 'kaist-test-world-architecture', provides: stages.map(stage => `architecture.${stage}@1` as const), tier: 'free',
    invoke: ({ nodeId, graphInput }) => {
      const input = graphInput && typeof graphInput === 'object' ? graphInput as Record<string, unknown> : {};
      if (input.structuredDesignPath !== structuredDesignPath || input.outDir !== output)
        return { ok: false, outcome: 'fail', error: 'test-world architecture input mismatch' };
      mkdirSync(output, { recursive: true });
      if (nodeId === 'design') {
        const design = generateStructuredDesign(JSON.parse(readFileSync(structuredDesignPath, 'utf8')) as unknown);
        writeFileSync(join(output, 'architecture.html'), design.html);
        writeFileSync(join(output, 'architecture.excalidraw'), design.diagram);
      } else if (nodeId === 'diagram') {
        copyFileSync(join(sample, 'architecture.png'), join(output, 'architecture.png'));
      } else if (nodeId === 'pdf') {
        copyFileSync(join(sample, 'architecture.pdf'), join(output, 'architecture.pdf'));
      } else if (nodeId === 'verify') {
        const html = readFileSync(join(output, 'architecture.html'), 'utf8');
        const source = JSON.parse(readFileSync(join(output, 'architecture.excalidraw'), 'utf8')) as { type?: string; elements?: unknown[] };
        const png = readFileSync(join(output, 'architecture.png'));
        const pdf = readFileSync(join(output, 'architecture.pdf'));
        if (!html.includes('kaist-design-output-300') || source.type !== 'excalidraw' || !source.elements?.length
          || png.subarray(0, 4).toString('hex') !== '89504e47' || pdf.subarray(0, 4).toString() !== '%PDF')
          return { ok: false, outcome: 'fail', error: 'test-world architecture artifact validation failed' };
        writeFileSync(join(output, 'verification.json'), JSON.stringify({ status: 'verified', mode: 'test-world-fixture' }));
      } else return { ok: false, outcome: 'fail', error: `unknown architecture stage: ${nodeId}` };
      return { ok: true, outcome: 'ok', result: { stage: nodeId, mode: 'test-world-fixture' } };
    },
  });
}

async function runFakeGcpExpansionAndDeliverables(root: string) {
  const repo = resolve(import.meta.dir, '../..');
  const plugin = join(repo, 'plugins/gcp-architect-expand');
  const output = join(root, 'architecture');
  const stateRoot = join(root, 'architecture-graph-state');
  const structuredDesignPath = join(root, 'ticketing-architecture.json');
  const structuredDesign = JSON.parse(readFileSync(join(repo, 'plugins/architecture-deliverables/examples/structured-ticketing-gcp.json'), 'utf8')) as {
    title: string; summary: string; background: string; nodes: Array<{ id: string; details?: string[] }>;
  };
  const designMarker = 'kaist-design-output-300';
  structuredDesign.title = `티켓 예매 서비스 · 동시 300명 · ${designMarker}`;
  structuredDesign.summary = '동시 접속 300명을 공정한 대기열로 제어하고 좌석 원장으로 중복 예매를 막는다.';
  structuredDesign.background = '공연 예매 오픈에 300명이 동시에 접속한다. 공정 대기열과 멱등 좌석 확정으로 접속 폭주·중복 예매를 막는다.';
  const fans = structuredDesign.nodes.find(node => node.id === 'fans');
  if (!fans) throw new Error('ticketing architecture fixture has no users node');
  fans.details = ['300 concurrent', 'Signed admission token'];
  writeFileSync(structuredDesignPath, `${JSON.stringify(structuredDesign, null, 2)}\n`);
  const graphPath = join(plugin, 'graph.yaml');
  const contracts = ['cloud-resource.observe@1', 'cloud-resource.design@1', 'cloud-resource.architecture-deliverables@1',
    'cloud-resource.provision@1', 'cloud-resource.schedule@1', 'cloud-resource.idle-stop@1'] as const;
  let registry = emptyGraphCapabilityRegistry();
  for (const id of contracts) registry = registerGraphCapabilityContract(registry, { id, input: { type: 'object' }, output: { type: 'object' } });
  const calls: string[] = [];
  registry = registerGraphCapabilityProviderDeclaration(registry, {
    id: 'kaist-fake-gcp-expansion', provides: contracts, tier: 'free', invoke: async ({ nodeId, outputs }) => {
      calls.push(nodeId);
      if (nodeId === 'detect') return { ok: true, outcome: 'shortage', result: { source: 'synthetic-test-fixture' } };
      if (nodeId === 'design') return { ok: true, outcome: 'proposed', result: {
        proposalId: 'kaist-synthetic-expansion-proposal', architectureSpec: structuredDesign,
        price: 'unpriced', source: 'synthetic-test-fixture',
      } };
      if (nodeId === 'deliverables') {
        try {
          const designResult = outputs.design && typeof outputs.design === 'object' ? outputs.design as Record<string, unknown> : {};
          const designOutput = designResult.result && typeof designResult.result === 'object' ? designResult.result as Record<string, unknown> : {};
          const architectureSpec = designOutput.architectureSpec;
          if (!architectureSpec || typeof architectureSpec !== 'object' || Array.isArray(architectureSpec))
            throw new Error('shared architecture graph did not receive the design node output');
          writeFileSync(structuredDesignPath, `${JSON.stringify(architectureSpec, null, 2)}\n`);
          const sharedState = await runGraph(join(repo, 'plugins/architecture-deliverables/graphs/architecture-deliverables.yaml'), {
            input: { structuredDesignPath, outDir: output, resourceRoot: repo }, quiet: true,
            deps: { root: join(stateRoot, 'shared'), capabilityProviders: createTestWorldArchitectureRegistry(repo, structuredDesignPath, output) },
          });
          if (sharedState.status !== 'done') throw new Error(`shared graph ${sharedState.status}: ${JSON.stringify(sharedState.nodes.map(step => ({ id: step.nodeId, error: step.error, output: step.output })))}`);
          const verification = JSON.parse(readFileSync(join(output, 'verification.json'), 'utf8')) as { status?: string };
          if (verification.status !== 'verified') throw new Error('shared graph verification receipt missing');
          if (!readFileSync(join(output, 'architecture.html'), 'utf8').includes(designMarker))
            throw new Error('shared architecture output did not preserve design-node marker');
          const specs = [
            ['architecture.excalidraw', 'diagram-source', '편집 가능한 아키텍처 도면', 'application/json', 'diagram'],
            ['architecture.png', 'diagram', 'GCP 확장 구성도', 'image/png', 'diagram'],
            ['architecture.pdf', 'pdf', '시스템 아키텍처 설계 문서', 'application/pdf', 'pdf'],
            ['architecture.html', 'html', '설계 문서 HTML 원본', 'text/html', 'pdf'],
          ] as const;
          const attachments = specs.map(([name, kind, title, mime, producedBy]) => ({ kind, title,
            url: `https://example.test/kaist-simulation/${name}`, mime,
            sha256: createHash('sha256').update(readFileSync(join(output, name))).digest('hex'), producedBy }));
          return { ok: true, outcome: 'done', result: { graphId: sharedState.graphId, runId: sharedState.runId, verification, attachments } };
        } catch (error) { return { ok: false, outcome: 'failed', error: String(error) }; }
      }
      if (nodeId === 'provision' || nodeId === 'schedule') return { ok: true, outcome: 'done', result: { testWorld: true } };
      if (nodeId === 'idle-stop') return { ok: true, outcome: 'stopped', result: { testWorld: true } };
      return { ok: false, outcome: 'failed', error: `unknown fake GCP node: ${nodeId}` };
    },
  });
  const state = await runGraph(graphPath, { input: { ticketDesignPath: join(plugin, 'demo/fixtures/ticketing-design.json'), context: { memberId: 'kaist-fake-member' } },
    quiet: true, deps: { root: stateRoot, capabilityProviders: registry } });
  const outputNode = state.nodes.find(node => node.nodeId === 'deliverables')?.output;
  const parsed = typeof outputNode === 'string' ? JSON.parse(outputNode) as { result?: { attachments?: Array<{ sha256: string; url: string }> } } : {};
  const attachments = parsed.result?.attachments ?? [];
  if (state.status !== 'awaiting-approval' || state.pending?.nodeId !== 'approve'
    || calls.join(',') !== 'detect,design,deliverables' || attachments.length !== 4
    || attachments.some(attachment => !/^[a-f0-9]{64}$/u.test(attachment.sha256))) {
    throw new Error(`fake GCP expansion did not stop at approval with verified deliverables: ${JSON.stringify({ status: state.status, pending: state.pending?.nodeId, calls, attachments,
      nodes: state.nodes.map(node => ({ id: node.nodeId, error: node.error, output: node.output })) })}`);
  }
  for (const attachment of attachments) {
    const name = attachment.url.split('/').at(-1);
    if (!name) throw new Error('GCP attachment URL has no artifact name');
    const bytes = readFileSync(join(output, name));
    if (createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) throw new Error(`GCP artifact hash mismatch: ${name}`);
  }
  decideGraphApproval(state.graphId, state.runId, 'approved', 'kaist-fake-member', stateRoot);
  const resumed = await runGraph(graphPath, { resumeRunId: state.runId,
    input: { ticketDesignPath: join(plugin, 'demo/fixtures/ticketing-design.json'), context: { memberId: 'kaist-fake-member' } },
    quiet: true, deps: { root: stateRoot, capabilityProviders: registry } });
  const expectedCalls = 'detect,design,deliverables,provision,schedule,idle-stop';
  if (resumed.status !== 'done' || calls.join(',') !== expectedCalls) {
    throw new Error(`fake GCP owner approval did not finish through idle stop: ${JSON.stringify({ status: resumed.status, calls,
      nodes: resumed.nodes.map(node => ({ id: node.nodeId, error: node.error, output: node.output })) })}`);
  }
  return { state: resumed, approvalNode: 'approve', attachments, output, approved: true };
}

const TEST_NOW = '2026-11-14T01:00:00.000Z';

describe('KAIST absorb path · fake member session and fixed-response provider', () => {
  test('scrap → brief/suggestion → human OK → harness dispatch → simulated mini-board projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kaist-absorb-e2e-'));
    const memberStore = createMemberStore({ path: join(root, 'members.sqlite'), now: () => Date.parse(TEST_NOW) });
    // Source: #36288's fake member E2E provisions exactly one registration for its single test owner.
    memberStore.provisionEventCode({ code: 'KAIST-TEST', maxUses: 1 });
    const member = memberStore.register({ sub: 'fake-kaist-owner', email: 'kaist-owner@example.test', emailVerified: true, name: 'KAIST Test Owner' }, { consents: { privacy: 'v1', terms: 'v1' }, eventCode: 'KAIST-TEST' }, TEST_NOW);
    const appSlot = memberStore.createAppSlotForMember(member.id, TEST_NOW);
    expect(['created', 'already-exists']).toContain(appSlot.outcome);
    if (appSlot.outcome !== 'created' && appSlot.outcome !== 'already-exists') throw new Error('fake member app slot was not created');
    const appDir = join(root, 'apps', appSlot.slot.appSlug);
    mkdirSync(join(appDir, 'out'), { recursive: true });
    writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: ${appSlot.slot.appSlug}\ntitle: KAIST test\nfrontend:\n  kind: static-export\n  out: out\nroles:\n  owner: { via: nexus-session }\n`);
    writeFileSync(join(appDir, 'out', 'index.html'), '<main>KAIST simulation</main>');
    const appHost = loadNexusAppHost(join(root, 'apps'), undefined, {
      dir: join(root, 'app-auth'), databaseDirectory: join(root, 'app-databases'),
      key: 'kaist-absorb-e2e-test-key-with-at-least-256-bits', now: () => Date.parse(TEST_NOW),
    }).appHost;
    const fakeSession = appHost.issueOwnerSession(appSlot.slot.appSlug, member.id);
    const membersApi = createMembersApi({
      store: memberStore,
      google: {
        redirectUri: 'https://example.test/v1/members/oauth/google/callback',
        // Source: #36288's fake Google provider is never invoked; this value is not issued to a browser.
        start: async () => ({ authorizationUrl: 'https://example.test/oauth', state: 'unused', cookieValue: 'unused', maxAgeSeconds: 0 }),
        complete: async () => { throw new Error('unused'); },
      },
      successRedirectUri: 'https://example.test/signup/complete',
      now: () => Date.parse(TEST_NOW),
      resolveVerifiedOwner: (appSlug, credential, members) => appHost.resolveVerifiedOwner(appSlug, credential, members, 'kaist-test-owner'),
      resolveVerifiedMemberOwner: (credential, members) => appHost.resolveVerifiedMemberOwner(credential, members, 'kaist-test-owner'),
    });
    const boardEventStore = createJsonlMemberEventStore(join(root, 'events'));
    let suggested!: BoardCardEvent;
    let graphSuggestion: Record<string, unknown> = {};
    let graphRun: Promise<unknown> | undefined;
    let acceptedBuild: { graphId: string; status: string; runId: string } | undefined;
    let deployedReadback: { status: number; sha256: string } | undefined;
    let appArtifactSha256: string | undefined;
    let gcpExpansion: Awaited<ReturnType<typeof runFakeGcpExpansionAndDeliverables>> | undefined;
    let worldPath = '';
    const opts = {
      metaApi: { noAuth: true },
      appHost,
      membersApi,
      boardEventStore,
      boardApprovalDispatch: createBoardApprovalDispatch({
        appsRoot: join(root, 'apps'),
        createRunId: () => 'accept-kaist-test-1',
        runGraph: async (file, options) => {
          expect(file).toContain('absorb-build.yaml');
          if (!options) throw new Error('board approval graph options missing');
          const runOptions = options;
          expect(runOptions.input).toMatchObject({ suggestionId: suggested.cardId, context: { memberId: member.id, target: realpathSync(appDir) } });
          graphRun = (async () => {
            gcpExpansion = await runFakeGcpExpansionAndDeliverables(root);
            expect(gcpExpansion.approved).toBe(true);
            expect(gcpExpansion.state.status).toBe('done');
            expect(gcpExpansion.state.path).toContain('idle-stop');
            return await runAbsorbGraphSimulation({ confirmation: 'y', buildOnly: true, approvalRunId: runOptions.runId, worldPath, memberId: member.id,
              routeSuggestionId: String((runOptions.input as { suggestionId: string }).suggestionId),
              onAppPublish: async event => {
                if (event.runId !== runOptions.runId) return;
                if (event.action === 'simulate') {
                  await boardEventStore.append({ ...suggested, state: 'building', runId: event.runId,
                    summary: `[시뮬] 앱 빌드 산출물 ${String(event.artifact.id)}`, at: '2026-11-09T01:05:00.000Z' });
                  await boardEventStore.append({ ...suggested, state: 'testing', runId: event.runId,
                    summary: `[시뮬] 격리 시험 영수증 ${String(event.evidence.receipt && (event.evidence.receipt as Record<string, unknown>).id)}`,
                    at: '2026-11-09T01:06:00.000Z' });
                } else {
                  deployedReadback = event.readback;
                  const index = (event.artifact.files as Record<string, unknown>)?.['/index.html'];
                  if (typeof index !== 'string') throw new Error('simulated app index artifact missing');
                  appArtifactSha256 = createHash('sha256').update(index).digest('hex');
                  await boardEventStore.append({ ...suggested, state: 'released', runId: event.runId,
                    summary: `[시뮬] 그래프 발행 완료; GCP 가짜 소유자 승인·유휴 종료 ${gcpExpansion!.state.runId}`,
                    attachments: gcpExpansion!.attachments,
                    result: { publicUrl: String(event.result.resultUrl) }, at: '2026-11-09T01:07:00.000Z' });
                }
              },
              onAcceptedBuild: async state => {
                acceptedBuild = { graphId: state.graphId, status: state.status, runId: state.runId };
                expect(state.status).toBe('done');
                expect(state.path).toEqual(expect.arrayContaining(['build', 'simulate', 'publish']));
                const lookup = state.nodes.find(node => node.nodeId === 'lookup-suggestion');
                const lookupOutput = typeof lookup?.output === 'string' ? JSON.parse(lookup.output) as { evidence?: { suggestion?: unknown } } : lookup?.output as { evidence?: { suggestion?: unknown } };
                expect(lookupOutput?.evidence?.suggestion).toEqual(graphSuggestion);
              } });
          })();
          await graphRun;
          return { status: 'done' } as never;
        },
      }),
      scraps: {
        instanceRoot: root,
        extractors: {},
        now: () => new Date('2026-11-09T01:00:00.000Z'),
      },
    } as unknown as NexusHttpServerOpts;
    const nexusState = { nexusVersion: 'test' } as never;
    const graphEvents: unknown[] = [];
    const unsubscribe = boardEventStore.subscribe(event => {
      graphEvents.push(event);
    });
    const call = (path: string, method = 'GET', body?: unknown, sessionToken = fakeSession.sessionToken) => routeRequest(new Request(`http://nexus.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${sessionToken}`,
        origin: 'http://nexus.test',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(path === '/v1/scraps' && method === 'POST' ? { 'idempotency-key': 'kaist-e2e-scrap-001' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), opts, nexusState, null, createDevProxyRuntimeRef());

    try {
      const scrapResponse = await call('/v1/scraps', 'POST', {
        kind: 'text', source: 'tui', raw: { text: '축제·콘서트 티켓 대란, 접속 폭주로 예매 실패' },
      });
      expect(scrapResponse?.status).toBe(201);
      const scrap = await scrapResponse!.json() as { id: string; memberId: string; status: string; card: { title: string } };
      expect(scrap).toMatchObject({ memberId: member.id, status: 'absorbed' });
      expect(scrap.card.title).toBe('축제·콘서트 티켓 대란, 접속 폭주로 예매 실패');
      const world = parseYaml(readFileSync(join(import.meta.dir, '../../plugins/absorb/sims/absorb-demo-world.yaml'), 'utf8')) as {
        fixtures: { scraps: Array<Record<string, unknown>>; suggestions: Array<Record<string, unknown>> };
      };
      const textScrap = world.fixtures.scraps.find(row => row.id === 'scrap-text');
      if (!textScrap) throw new Error('absorb fake world has no scene 1 text scrap');
      textScrap.id = scrap.id;
      textScrap.text = scrap.card.title;
      world.fixtures.suggestions = [];
      worldPath = join(root, 'kaist-absorb-world.json');
      writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`);
      const briefReceipt = await runAbsorbGraphSimulation({ confirmation: 'y', briefOnly: true, worldPath, memberId: member.id,
        onSuggestion: async records => {
          const generated = records.suggestions.find(row => row.id === `suggestion-2026-11-09-2-${scrap.id}`);
          if (!generated) throw new Error('absorb brief graph returned no suggestion');
          graphSuggestion = { ...generated };
          suggested = { type: 'board.card', cardId: String(generated.id), memberId: member.id, state: 'suggested',
            title: String(generated.ask), summary: String(generated.change), at: '2026-11-09T01:01:00.000Z' };
          await boardEventStore.append(suggested);
        } });
      expect(briefReceipt.status).toBe('done');
      expect(briefReceipt.briefing).toMatchObject({ owner: member.id, scrapIds: expect.arrayContaining([scrap.id]),
        summary: '티켓 예매 서비스 · 동시 300명. 쟁점: 동시 접속 · 중복 예매 · 공정 대기열.' });
      expect(graphSuggestion.id).toBe(`suggestion-2026-11-09-2-${scrap.id}`);
      expect(graphSuggestion.ask).toBe(`우리 행사용 티켓팅 서비스 만들어 볼까요? · 원본 스크랩 ${scrap.id}`);
      expect(graphSuggestion.evidenceScrapIds).toContain(scrap.id);
      world.fixtures.suggestions = [graphSuggestion];
      writeFileSync(worldPath, `${JSON.stringify(world, null, 2)}\n`);
      const beforeApproval = await call('/v1/board');
      expect(beforeApproval?.status).toBe(200);
      const preApprovalBoard = await beforeApproval!.json() as { cards: Array<{ id: string; state: string }> };
      expect(preApprovalBoard.cards).toMatchObject([{ id: suggested.cardId, state: 'proposed', title: suggested.title }]);

      const approvedResponse = await call(`/v1/board/${suggested.cardId}/approve`, 'POST', { decision: 'approved' });
      expect(approvedResponse?.status).toBe(202);
      expect(await approvedResponse!.json()).toMatchObject({ card: { state: 'approved' }, dispatch: { acceptanceId: 'accept-kaist-test-1' } });
      expect(graphRun).toBeDefined();
      const simReceipt = await graphRun as { selectedSuggestion: Record<string, unknown>; lookupSuggestion: Record<string, unknown>; llmInputs: string[] };
      expect(simReceipt.selectedSuggestion).toEqual(graphSuggestion);
      expect(simReceipt.lookupSuggestion).toEqual(graphSuggestion);
      expect(simReceipt.llmInputs.some(prompt => prompt.includes(String(graphSuggestion.ask)))).toBe(true);
      const runId = 'accept-kaist-test-1';

      const boardResponse = await call('/v1/board');
      expect(boardResponse?.status).toBe(200);
      const board = await boardResponse!.json() as { cards: Array<{ id: string; memberId: string; title: string; state: 'deployed'; summary: string; runId: string; publicUrl?: string }> };
      expect(board.cards).toMatchObject([{
        id: suggested.cardId, memberId: member.id, title: suggested.title, state: 'deployed',
        runId,
      }]);
      expect(board.cards[0]?.summary).toStartWith('[시뮬] 그래프 발행 완료; GCP 가짜 소유자 승인·유휴 종료 ');
      expect(board.cards[0]?.publicUrl).toBe('https://lecture-scrap-demo.app.sim.invalid/');
      expect(gcpExpansion).toBeDefined();
      const boardCard = board.cards[0];
      if (!boardCard) throw new Error('simulated board card missing');
      const cardAttachments = (boardCard as unknown as { attachments?: Array<{ kind: string; sha256: string; producedBy: string }> }).attachments;
      expect(JSON.stringify(cardAttachments)).toBe(JSON.stringify(gcpExpansion!.attachments));
      expect(cardAttachments?.map(attachment => attachment.kind))
        .toEqual(['diagram-source', 'diagram', 'pdf', 'html']);
      const deployedUrl = boardCard.publicUrl;
      if (!deployedUrl) throw new Error('simulated deployed URL missing');
      expect(deployedReadback?.status).toBe(200);
      expect(deployedReadback?.sha256).toBe(appArtifactSha256);
      const pdfAttachment = gcpExpansion!.attachments.find(attachment => attachment.url.endsWith('/architecture.pdf'));
      if (!pdfAttachment) throw new Error('simulated PDF attachment missing');
      const pdfBytes = readFileSync(join(gcpExpansion!.output, 'architecture.pdf'));
      const pdfSha256 = createHash('sha256').update(pdfBytes).digest('hex');
      expect(pdfBytes.subarray(0, 4).toString()).toBe('%PDF');
      expect(pdfSha256).toBe(pdfAttachment.sha256);
      expect(cardAttachments?.some(attachment => attachment.kind === 'pdf' && attachment.sha256 === pdfSha256)).toBe(true);
      if (!acceptedBuild) throw new Error('accepted build graph missing');
      const s6Receipt = await nextScene6BoardReceipt({ graph: acceptedBuild,
        expectedGraphId: acceptedBuild.graphId, cardId: suggested.cardId, memberId: member.id,
        nexusUrl: 'https://nexus.test', sessionToken: fakeSession.sessionToken,
        fetchImpl: async (_input, init) => await routeRequest(new Request('http://nexus.test/v1/board', init), opts, nexusState, null, createDevProxyRuntimeRef()) ?? new Response(null, { status: 404 }),
      });
      expect(s6Receipt).toContain('PDF');
      const receiptPath = process.env.ELANOUS_S6_SIM_RECEIPT_PATH;
      if (receiptPath) writeFileSync(receiptPath, `${JSON.stringify({
        source: 'kaist-absorb-e2e', nexusDevice: 'mini-board-card', graphId: acceptedBuild.graphId, runId: acceptedBuild.runId,
        boardCardId: boardCard.id, boardRunId: boardCard.runId, boardState: boardCard.state,
        deployedUrl, appReadbackStatus: deployedReadback?.status, appReadbackSha256: deployedReadback?.sha256,
        appArtifactSha256,
        pdfSha256, pdfBytes: pdfBytes.length,
        pdfHeader: '%PDF', boardPdfHashMatched: true, scene6Receipt: s6Receipt,
      }, null, 2)}\n`);
      expect(graphEvents).toHaveLength(5);
      expect(graphEvents.map(event => (event as { state: string }).state)).toEqual(['suggested', 'approved', 'building', 'testing', 'released']);
      expect((await call('/v1/board', 'GET'))?.status).toBe(200);
      const invalidSession = await call('/v1/scraps', 'POST', {
        kind: 'text', source: 'tui', raw: { text: 'invalid session must not write' },
      }, 'aps_invalid_test_session');
      expect(invalidSession?.status).toBe(401);
    } finally {
      unsubscribe();
      appHost.close();
      memberStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
