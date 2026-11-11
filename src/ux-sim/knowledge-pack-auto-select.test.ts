import { describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import * as llmModule from '../llm.js';
import { applyDeferredTools } from '../session-runtime/tier-flip.js';
import { buildKnowledgeQueryTool, dispatchKnowledgeQuery } from '../knowledge/tools/knowledge-query.js';
import { createPack } from '../knowledge/kgs/index.js';
import { KgsSqliteStore } from '../knowledge/kgs/sqlite-store.js';
import { queryInstalledPack, resolveInstalledKnowledgePack } from '../knowledge/query.js';
import { validateKnowledgePack } from '../knowledge/write.js';
import { simulateKnowledgePackAutoSelect, SYSTEM_ARCHITECTURE_DESIGN_REQUEST, TICKETING_DESIGN_REQUEST } from './knowledge-pack-auto-select.js';

describe('knowledge pack auto-select simulation', () => {
  for (const profile of ['default', 'solar'] as const) {
    test(`${profile} profile core-turn path preloads KnowledgeQuery and dispatches an installed pack`, async () => {
      const selectionEvents: string[] = [];
      const streamCalls: Array<{ provider?: string; model?: string; tools: string[] }> = [];
      let dispatched = false;
      const stream = spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers, options) => {
        streamCalls.push({
          provider: options?.initialProvider?.name,
          model: options?.initialProvider?.defaultModel ?? options?.model,
          tools: options?.tools?.map(spec => spec.name) ?? [],
        });
        if (!dispatched && options?.tools?.some(spec => spec.name === 'KnowledgeQuery')) {
          dispatched = true;
          await handlers.dispatchTool('KnowledgeQuery', { question: TICKETING_DESIGN_REQUEST }, { callId: `knowledge-pack-${profile}` });
        }
        return 'simulated provider answer';
      });
      const unregister = debug.registerSink({ name: `knowledge-pack-select-${profile}`,
        emit: event => { if (event.category === 'knowledge-pack.select') selectionEvents.push(event.event); } });
      try {
        const receipt = await simulateKnowledgePackAutoSelect(profile);
        const expectedProvider = profile === 'solar' ? 'openrouter' : 'openai';
        const expectedModel = profile === 'solar' ? 'openrouter/upstage/solar-pro4' : 'gpt-6-sol';
        expect(receipt.provider).toEqual({ name: expectedProvider, model: expectedModel });
        expect(streamCalls[0]).toMatchObject({ provider: expectedProvider, model: expectedModel });
        expect(streamCalls[0]?.tools).toContain('KnowledgeQuery');
        expect(receipt.activeTools).toContain('KnowledgeQuery');
        expect(receipt.warmPreloaded).toBe(1);
        expect(receipt.selectedPack?.id).toBe('pack:ticketing-architecture-public@0.2.0');
        expect(receipt.citations).toContain('pack:ticketing-architecture-public@0.2.0#ticketing/invariants');
        expect(receipt.kgsCalls).toBe(receipt.citations.length);
        expect(selectionEvents).toContain('selected');
      } finally {
        unregister();
        stream.mockRestore();
      }
    });
  }

  test('three-line system design request selects and cites the KPACK1 system architecture pack', async () => {
    const stream = spyOn(llmModule, 'streamLLMWithTools').mockImplementation(async (_messages, handlers, options) => {
      if (options?.tools?.some(spec => spec.name === 'KnowledgeQuery')) {
        await handlers.dispatchTool('KnowledgeQuery', { question: SYSTEM_ARCHITECTURE_DESIGN_REQUEST },
          { callId: 'knowledge-pack-system-architecture' });
      }
      return 'simulated provider answer';
    });
    try {
      const receipt = await simulateKnowledgePackAutoSelect('default', SYSTEM_ARCHITECTURE_DESIGN_REQUEST);
      // Source: SYSTEM-DESIGN-DOMAIN-PACK completion contract requires three-line selection.
      expect(SYSTEM_ARCHITECTURE_DESIGN_REQUEST.split('\n')).toHaveLength(3);
      expect(receipt.activeTools).toContain('KnowledgeQuery');
      expect(receipt.selectedPack?.id).toBe('pack:system-architecture-public@0.1.0');
      expect(receipt.citations.some(ref => ref.startsWith('pack:system-architecture-public@0.1.0#'))).toBe(true);
      // Source: the acceptance path makes one KGS dispatch, which can return many cited cards.
      expect(receipt.kgsCalls).toBe(1);
      const pack = validateKnowledgePack(join(import.meta.dir, '../../packs/system-architecture-public')).pack;
      const hasCitedSource = (titlePart: string, sourcePart: string) => pack.cards.some(card =>
        card.title.includes(titlePart)
        && card.source.kind === 'external'
        && typeof card.source.url === 'string'
        && card.source.url.includes(sourcePart)
        && receipt.citations.includes(`${receipt.selectedPack?.id}#${card.id}`));
      expect(hasCitedSource('업로드와 메타데이터 경계', 'serverless-image-handler')).toBe(true);
      expect(hasCitedSource('검색 스키마와 랭킹', 'enterprise-search-introduction')).toBe(true);
      expect(hasCitedSource('온라인 추론 endpoint', 'mlops-continuous-delivery-and-automation-pipelines')).toBe(true);
    } finally {
      stream.mockRestore();
    }
  });

  test('equal intent tags and priority ask the user to choose two packs without vault fallback', async () => {
    const store = new KgsSqliteStore(':memory:');
    const pack = (slug: string, title: string) => createPack({
      id: { slug, version: '1.0.0' }, title, intent: 'Concert ticketing payment recovery architecture',
      audience: 'team', kind: 'research-bundle', author: 'simulation-fixture',
      tags: ['콘서트', '티켓팅', '결제'], cards: [],
    });
    store.writePack(pack('ticketing-architecture-public', 'Ticketing architecture'));
    store.writePack(pack('concert-ticketing-recovery', 'Concert ticketing recovery'));
    const events: Array<{ event: string; data?: unknown }> = [];
    const unregister = debug.registerSink({ name: 'knowledge-pack-select-tie', emit: event => {
      if (event.category === 'knowledge-pack.select') events.push({ event: event.event, data: event.data });
    } });
    let kgsCalls = 0;
    try {
      const result = await dispatchKnowledgeQuery({ question: '콘서트 티켓팅 결제 복구 설계' }, {
        resolvePack: question => resolveInstalledKnowledgePack(question, store),
        searchPack: () => { kgsCalls += 1; return []; },
        vault: { root: '/__knowledge-pack-auto-select-vault-fallback__', isSimulated: true, label: 'simulation' },
      });
      expect(result.selectionQuestion).toBe('어느 지식 팩을 사용할까요? Concert ticketing recovery / Ticketing architecture 중에서 선택해 주세요.');
      expect(result.selectionQuestion).not.toContain('\n');
      expect(result.notices).toBeUndefined();
      expect(result.results).toHaveLength(0);
      expect(kgsCalls).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({ event: 'choice-needed' }));
      expect(events[0]?.data).toMatchObject({
        candidateNames: ['Concert ticketing recovery', 'Ticketing architecture'],
      });
    } finally {
      unregister();
      store.close();
    }
  });

  test('non-design turns keep the specialized query deferred', () => {
    const split = applyDeferredTools([], [buildKnowledgeQueryTool()], { userText: '현재 상태를 요약해줘.' });
    expect(split.tools.map(spec => spec.name)).not.toContain('KnowledgeQuery');
    expect(split.stats.deferredNames).toContain('KnowledgeQuery');
    // Source: R-TICKET proof preserves this exact three-line design request.
    expect(TICKETING_DESIGN_REQUEST.split('\n')).toHaveLength(3);
  });

  test('Korean particle on an auto-selected topic still returns a cited pack card', async () => {
    const store = new KgsSqliteStore(':memory:');
    try {
      store.writePack(createPack({
        id: { slug: 'concert-ticketing', version: '1.0.0' }, title: '콘서트 티켓팅',
        intent: '콘서트 티켓팅 설계', audience: 'team', kind: 'research-bundle',
        author: 'simulation-fixture', tags: ['티켓팅'], cards: [{
          schema_version: 2, id: 'reservation', kind: 'card', nature: 'principle',
          title: '티켓팅 좌석 예약', body: '좌석 예약은 중복 결제를 막는다.',
          createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z',
          author: 'simulation-fixture', reliability: 'verified',
          source: { kind: 'manual' }, tags: ['ticketing'],
        }],
      }));
      const result = await dispatchKnowledgeQuery({ question: '티켓팅을 설계해줘.' }, {
        resolvePack: question => resolveInstalledKnowledgePack(question, store),
        searchPack: (id, question) => queryInstalledPack(id, question, store),
        vault: { root: '/__knowledge-pack-auto-select-vault-fallback__', isSimulated: true, label: 'simulation' },
      });
      expect(result.selectedPack?.id).toBe('pack:concert-ticketing@1.0.0');
      expect(result.pack_hits?.map(hit => hit.ref)).toEqual(['pack:concert-ticketing@1.0.0#reservation']);
    } finally {
      store.close();
    }
  });
});
