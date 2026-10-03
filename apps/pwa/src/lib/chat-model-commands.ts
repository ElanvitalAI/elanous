import type { DaemonClient } from './daemon-client';
import { fetchDaemonModelTier, pushLlmTierToDaemon, type DaemonHttpConfig } from './model-tier-sync';
import { isModelTier, lookupLlmTierSpec, MODEL_TIERS, type ModelTier } from './model-tier-spec';

// The PWA can persist only a tier; short model names map by capability.
// Luna (fast) < Terra (coding) < Sol (deep reasoning) in the TUI vocabulary.
const MODEL_ALIASES: Readonly<Record<string, ModelTier>> = {
  codex: 'balanced', luna: 'budget', terra: 'better', sol: 'best',
  sonnet: 'better', opus: 'best', grok: 'better',
};
const MODEL_VALUES = [...MODEL_TIERS, ...Object.keys(MODEL_ALIASES)].join(' · ');
const REASONING_VALUES = ['low', 'medium', 'high'] as const;

interface ProviderWire {
  provider: string;
  flow: string;
  hasSavedKey: boolean;
}
interface ProviderListWire {
  providers: ProviderWire[];
  activeProvider: string;
}

export type ModelCommand =
  | { kind: 'model'; tier?: ModelTier; invalid?: true }
  | { kind: 'reasoning'; level?: string; invalid?: true }
  | { kind: 'provider'; action: 'show' | 'next' | 'use'; name?: string; invalid?: true };

/** Interpret arguments without touching browser storage or the daemon. */
export function parseModelCommand(name: 'model' | 'reasoning' | 'provider', args: readonly string[]): ModelCommand {
  if (name === 'model') {
    if (!args.length) return { kind: 'model' };
    const value = args[0]!.toLowerCase();
    const tier = isModelTier(value) ? value : Object.hasOwn(MODEL_ALIASES, value) ? MODEL_ALIASES[value] : undefined;
    return args.length === 1 && tier ? { kind: 'model', tier } : { kind: 'model', invalid: true };
  }
  if (name === 'reasoning') {
    if (!args.length) return { kind: 'reasoning' };
    return args.length === 1 && (REASONING_VALUES as readonly string[]).includes(args[0]!)
      ? { kind: 'reasoning', level: args[0] }
      : { kind: 'reasoning', invalid: true };
  }
  if (!args.length) return { kind: 'provider', action: 'show' };
  if (args.length === 1 && args[0] === 'next') return { kind: 'provider', action: 'next' };
  if (args.length === 2 && args[0] === 'use') return { kind: 'provider', action: 'use', name: args[1] };
  return { kind: 'provider', action: 'show', invalid: true };
}

async function activeProvider(ctx: { client: DaemonClient; provider: string }): Promise<string> {
  try {
    const list = await ctx.client.fetchJson<ProviderListWire>('/v1/setup/llm-providers');
    return list.activeProvider || ctx.provider;
  } catch {
    return ctx.provider;
  }
}

export async function handleModelCommand(
  command: ModelCommand,
  ctx: { client: DaemonClient; daemon?: DaemonHttpConfig; provider: string },
): Promise<string> {
  if (command.kind === 'model') {
    if (command.invalid) return `쓸 수 있는 값: ${MODEL_VALUES}`;
    if (!command.tier) {
      const tier = ctx.daemon ? (await fetchDaemonModelTier(ctx.daemon))?.llm : undefined;
      if (!tier) return `현재 모델: 확인할 수 없음 · 쓸 수 있는 값: ${MODEL_VALUES}`;
      return `현재 모델: ${tier} · ${lookupLlmTierSpec(await activeProvider(ctx), tier).model} · 쓸 수 있는 값: ${MODEL_VALUES}`;
    }
    if (!ctx.daemon?.baseUrl) return '모델 설정을 저장하지 못했습니다 — 데몬 연결을 확인하세요';
    const status = await pushLlmTierToDaemon(ctx.daemon, command.tier);
    if (status !== 'synced') return '모델 설정을 저장하지 못했습니다 — 데몬 연결을 확인하세요';
    const provider = await activeProvider(ctx);
    return `모델: ${lookupLlmTierSpec(provider, command.tier).model}(으)로 바꿨습니다`;
  }
  if (command.kind === 'reasoning') {
    if (command.invalid) return `쓸 수 있는 값: ${REASONING_VALUES.join(' · ')}`;
    if (command.level) return '추론 강도는 설정 화면에서 바꾸세요';
    const tier = ctx.daemon ? (await fetchDaemonModelTier(ctx.daemon))?.llm : undefined;
    if (!tier) return '현재 추론 단계: 확인할 수 없음 · 추론 강도는 설정 화면에서 바꾸세요';
    return `현재 추론 단계: 확인할 수 없음 · 모델 티어 기본값: ${lookupLlmTierSpec(await activeProvider(ctx), tier).reasoningLevel ?? 'off'} · 추론 강도는 설정 화면에서 바꾸세요`;
  }
  if (command.invalid) return '쓸 수 있는 값: next · use <이름>';
  try {
    const list = await ctx.client.fetchJson<ProviderListWire>('/v1/setup/llm-providers');
    const providers = list.providers ?? [];
    const selectable = providers.filter((p) => (p.flow === 'apiKey' && p.hasSavedKey) || p.flow === 'auto');
    const values = selectable.map((p) => p.provider).join(' · ');
    if (command.action === 'show') return `현재 프로바이더: ${list.activeProvider || '(없음)'} · 쓸 수 있는 값: ${values || '(없음)'}`;
    const chosen = command.action === 'next'
      ? selectable[(selectable.findIndex((p) => p.provider === list.activeProvider) + 1) % selectable.length]
      : selectable.find((p) => p.provider === command.name);
    if (!chosen) return `쓸 수 있는 값: ${values || '(없음)'}`;
    if (command.action === 'next' && chosen.provider === list.activeProvider) return `현재 프로바이더: ${list.activeProvider}`;
    const response = await ctx.client.fetchJson<{ error?: string; active?: { provider: string } }>(
      '/v1/setup/llm-provider',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: chosen.provider }) },
    );
    return response?.error
      ? `프로바이더 전환 실패: ${response.error}`
      : `프로바이더: ${response?.active?.provider ?? chosen.provider}(으)로 바꿨습니다`;
  } catch {
    return '프로바이더 상태를 읽거나 저장하지 못했습니다 — 데몬 연결을 확인하세요';
  }
}
