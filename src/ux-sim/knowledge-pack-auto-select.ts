import { join } from 'node:path';
import { runCoreTurn } from '../core-turn/run-core-turn.js';
import type { LLMProvider } from '../llm.js';
import { debug } from '../debug/log.js';
import { getUserConfig, runWithUserConfigSnapshot } from '../user-config.js';
import { buildKnowledgeQueryTool, dispatchKnowledgeQuery, type KnowledgeQueryToolInput } from '../knowledge/tools/knowledge-query.js';
import { queryInstalledPack, resolveInstalledKnowledgePack } from '../knowledge/query.js';
import { createPack, type Pack } from '../knowledge/kgs/index.js';
import { KgsSqliteStore } from '../knowledge/kgs/sqlite-store.js';
import { validateKnowledgePack } from '../knowledge/write.js';

export const TICKETING_DESIGN_REQUEST = [
  '콘서트 지정 좌석 티켓팅 시스템을 설계해줘.',
  '동시 사용자 10만 명을 가정해줘.',
  '중복 예매 0건, 결제 실패 복구, 공정한 대기열이 핵심 제약이야.',
].join('\n');
// Source: seat-state/R-TICKET/PROOF-ticketing-1110.md §「두 3줄 조건」.

export const SYSTEM_ARCHITECTURE_DESIGN_REQUEST = [
  '한국어 교육용 동영상 플랫폼의 멀티 테넌트 SaaS를 설계해줘.',
  '이벤트 기반 미디어 처리와 실시간 검색·채팅을 제공해줘.',
  '급증하는 배치와 온라인 ML 추론을 처리하고 GCP 기준 비용·확장 선택을 비교해줘.',
].join('\n');

export type KnowledgePackProfile = 'default' | 'solar';

export interface KnowledgePackAutoSelectReceipt {
  profile: KnowledgePackProfile;
  provider: { name: string; model: string };
  activeTools: string[];
  warmPreloaded: number;
  kgsCalls: number;
  selectedPack: { id: string; title: string } | null;
  citations: string[];
}

const PROFILE_PROVIDERS: Record<KnowledgePackProfile, LLMProvider> = {
  default: {
    name: 'openai', defaultModel: 'gpt-6-sol', available: () => true,
    async *chat() {},
  },
  solar: {
    name: 'openrouter', defaultModel: 'openrouter/upstage/solar-pro4', available: () => true,
    async *chat() {},
  },
};

function ticketingPack(): Pack {
  return createPack({
    // Source: seat-state/R-TICKET/PROOF-ticketing-1110.md §「KGS 자동 선택 재측정」.
    id: { slug: 'ticketing-architecture-public', version: '0.2.0' },
    title: 'Ticketing architecture',
    intent: 'Architecture guidance for concert ticketing, reserved seats, payment recovery, and fair queues.',
    audience: 'public',
    kind: 'research-bundle',
    author: 'simulation-fixture',
    tags: ['콘서트', '지정', '좌석', '티켓팅', '중복', '예매', '결제', '실패', '복구', '공정한', '대기열'],
    now: 1, // Source: deterministic simulation fixture timestamp; not a runtime policy value.
    cards: [{
      schema_version: 2,
      id: 'ticketing/invariants',
      createdAt: '1970-01-01T00:00:00.001Z',
      updatedAt: '1970-01-01T00:00:00.001Z',
      author: 'simulation-fixture',
      title: 'Ticketing reservation and recovery invariants',
      body: '콘서트 지정 좌석 티켓팅은 좌석당 중복 예매를 막고, 결제 실패를 복구하며 공정한 대기열을 유지한다.',
      nature: 'principle',
      kind: 'card',
      reliability: 'verified',
      source: { kind: 'manual', author: 'simulation-fixture' },
      tags: ['ticketing'],
    }],
  });
}

function systemArchitecturePack(): Pack {
  return validateKnowledgePack(join(import.meta.dir, '../../packs/system-architecture-public')).pack;
}

/** Exercises the production core-turn profile, deferred preload, and KGS dispatch boundaries. */
export async function simulateKnowledgePackAutoSelect(
  profile: KnowledgePackProfile,
  request = TICKETING_DESIGN_REQUEST,
): Promise<KnowledgePackAutoSelectReceipt> {
  const store = new KgsSqliteStore(':memory:');
  store.writePack(ticketingPack());
  store.writePack(systemArchitecturePack());
  const provider = PROFILE_PROVIDERS[profile];
  let activeTools: string[] = [];
  let warmPreloaded = 0;
  let kgsCalls = 0;
  let selectedPack: KnowledgePackAutoSelectReceipt['selectedPack'] = null;
  let citations: string[] = [];
  const unregister = debug.registerSink({
    name: `knowledge-pack-auto-select-core-turn-${profile}`,
    emit: event => {
      if (event.category !== 'capability.resolve' || event.event !== 'tool-tier-split') return;
      const data = event.data as { immediate?: unknown; warmPreloaded?: unknown };
      if (Array.isArray(data.immediate)) activeTools = data.immediate.filter((item): item is string => typeof item === 'string');
      if (typeof data.warmPreloaded === 'number') warmPreloaded = data.warmPreloaded;
    },
  });
  try {
    const baseConfig = getUserConfig();
    const simulationConfig = {
      ...baseConfig,
      tools: { ...baseConfig.tools, deferred: { ...baseConfig.tools.deferred, mode: 'always' as const } },
    };
    await runWithUserConfigSnapshot(simulationConfig, () => runCoreTurn({
        sessionId: `knowledge-pack-auto-select-${profile}`,
        messages: [{ role: 'user', content: request }],
        userText: request,
        initialProvider: provider,
        tools: [buildKnowledgeQueryTool()],
        signal: new AbortController().signal,
        dispatchTool: async (name, args) => {
          if (name !== 'KnowledgeQuery') return null;
          const result = await dispatchKnowledgeQuery(args as KnowledgeQueryToolInput, {
            resolvePack: question => resolveInstalledKnowledgePack(question, store),
            vault: { root: '/__knowledge-pack-auto-select-vault-fallback__', isSimulated: true, label: 'simulation' },
            searchPack: (id, question) => {
              kgsCalls += 1;
              return queryInstalledPack(id, question, store);
            },
          });
          selectedPack = result.selectedPack ?? null;
          citations = (result.pack_hits ?? []).map(hit => hit.ref);
          return result;
        },
      }, { runResearch: async () => ({ ok: false, output: '' }) }));
    return {
      profile,
      provider: { name: provider.name, model: provider.defaultModel },
      activeTools,
      warmPreloaded,
      kgsCalls,
      selectedPack,
      citations,
    };
  } finally {
    unregister();
    store.close();
  }
}
