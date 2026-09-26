'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import {
  NexusApiError,
  type ChildLlmChainEntry,
  type ChildLlmMode,
  type ChildLlmOnShortfall,
  type ChildLlmPreferenceBody,
  type ChildLlmPreferenceResponse,
  type ChildLlmResolved,
} from '@/nexus/client';

export interface ChildLlmCardClient {
  getChildLlmPreference(): Promise<ChildLlmPreferenceResponse>;
  setChildLlmPreference(body: ChildLlmPreferenceBody): Promise<{ resolved: ChildLlmResolved }>;
}

const ON_SHORTFALL: ReadonlyArray<{ value: ChildLlmOnShortfall; label: string }> = [
  { value: 'decompose', label: '쪼개기' },
  { value: 'wait-reset', label: '리셋까지 기다리기' },
  { value: 'next-provider', label: '다음 프로바이더' },
  { value: 'proceed', label: '그대로 진행' },
];

export interface ChildLlmDraft {
  mode: ChildLlmMode;
  chain: ChildLlmChainEntry[];
  minHeadroomPercent: string;
  onShortfall: ChildLlmOnShortfall;
}

export function draftFromResolved(state: ChildLlmPreferenceResponse): ChildLlmDraft {
  return {
    mode: state.resolved.mode,
    chain: state.resolved.chain.map((entry) => ({ ...entry })),
    minHeadroomPercent: String(state.resolved.budgetGate.minHeadroomPercent),
    onShortfall: state.resolved.budgetGate.onShortfall,
  };
}

/** chain 이 한 칸뿐이면 순서(위/아래) 칸을 숨긴다. */
export function showsChainOrder(chain: readonly ChildLlmChainEntry[]): boolean {
  return chain.length > 1;
}

function move(chain: ChildLlmChainEntry[], index: number, delta: number): ChildLlmChainEntry[] {
  const next = index + delta;
  if (next < 0 || next >= chain.length) return chain;
  const copy = chain.slice();
  const [item] = copy.splice(index, 1);
  copy.splice(next, 0, item!);
  return copy;
}

function errorMessage(error: unknown): string {
  if (error instanceof NexusApiError && error.body && typeof error.body === 'object') {
    const body = error.body as { reason?: string; error?: string };
    return body.reason ?? body.error ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function ChildLlmPreferenceCard(props: { client?: ChildLlmCardClient; initialDraft?: ChildLlmDraft } = {}) {
  const contextClient = useOptionalNexusClient();
  const client = props.client ?? contextClient;
  const [mounted, setMounted] = useState(props.initialDraft ? true : false);
  const [providers, setProviders] = useState<string[]>([]);
  const [draft, setDraft] = useState<ChildLlmDraft | null>(props.initialDraft ?? null);
  const [loading, setLoading] = useState(props.initialDraft ? false : true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { setMounted(true); }, []);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const next = await client.getChildLlmPreference();
      setProviders(next.providers);
      setDraft(draftFromResolved(next));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => { if (mounted && client) void refresh(); }, [mounted, client, refresh]);

  const save = async () => {
    if (!client || !draft) return;
    setSaving(true);
    setMessage('');
    setError('');
    const headroom = Number(draft.minHeadroomPercent);
    try {
      const saved = await client.setChildLlmPreference({
        mode: draft.mode,
        chain: draft.chain
          .map((entry) => ({
            provider: entry.provider.trim(),
            ...(entry.model?.trim() ? { model: entry.model.trim() } : {}),
          }))
          .filter((entry) => entry.provider),
        budgetGate: {
          ...(Number.isFinite(headroom) ? { minHeadroomPercent: headroom } : {}),
          onShortfall: draft.onShortfall,
        },
      });
      setDraft(draftFromResolved({ resolved: saved.resolved, providers }));
      setMessage('저장했습니다.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (!mounted || !client || !draft) {
    return (
      <section className="space-y-2 rounded border border-border bg-card p-4" data-testid="child-llm-preference-card">
        {error && <p role="alert" className="text-xs text-destructive" data-testid="child-llm-error">{error}</p>}
        {loading && <p className="text-xs text-muted-foreground">불러오는 중…</p>}
      </section>
    );
  }

  const orderVisible = showsChainOrder(draft.chain);
  const providerChoices = providers.length > 0 ? providers : ['grok'];

  return (
    <section className="space-y-4 rounded border border-border bg-card p-4" data-testid="child-llm-preference-card">
      <header>
        <h2 className="text-sm font-semibold">자식 LLM 선호</h2>
        <p className="text-xs text-muted-foreground">구현에 쓸 모델 순서와, 예산이 모자랄 때의 행동.</p>
      </header>

      <div className="space-y-1">
        <label htmlFor="child-llm-mode" className="text-sm font-medium">모드</label>
        <select
          id="child-llm-mode"
          data-testid="child-llm-mode"
          value={draft.mode}
          onChange={(event) => setDraft({ ...draft, mode: event.target.value as ChildLlmMode })}
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="pinned">고정</option>
          <option value="auto">자동</option>
        </select>
      </div>

      {draft.mode === 'auto' && (
        <div className="space-y-2" data-testid="child-llm-chain">
          <p className="text-sm font-medium">순서</p>
          {draft.chain.map((entry, index) => (
            <div key={`${entry.provider}-${index}`} className="flex items-center gap-2" data-testid="child-llm-chain-row">
              <select
                aria-label={`프로바이더 ${index + 1}`}
                value={entry.provider}
                onChange={(event) => {
                  const chain = draft.chain.slice();
                  chain[index] = { ...entry, provider: event.target.value };
                  setDraft({ ...draft, chain });
                }}
                className="flex h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
              >
                {providerChoices.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              {orderVisible && (
                <span className="flex gap-1" data-testid="child-llm-order">
                  <Button type="button" size="sm" variant="outline" aria-label={`${index + 1} 위로`} disabled={index === 0} onClick={() => setDraft({ ...draft, chain: move(draft.chain, index, -1) })}>위</Button>
                  <Button type="button" size="sm" variant="outline" aria-label={`${index + 1} 아래로`} disabled={index === draft.chain.length - 1} onClick={() => setDraft({ ...draft, chain: move(draft.chain, index, 1) })}>아래</Button>
                </span>
              )}
              <Button type="button" size="sm" variant="outline" aria-label={`${index + 1} 빼기`} onClick={() => setDraft({ ...draft, chain: draft.chain.filter((_, i) => i !== index) })}>빼기</Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="child-llm-add"
            onClick={() => setDraft({ ...draft, chain: [...draft.chain, { provider: providerChoices[0] ?? 'grok' }] })}
          >추가</Button>
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor="child-llm-headroom" className="text-sm font-medium">예산 여유 %</label>
        <Input
          id="child-llm-headroom"
          data-testid="child-llm-headroom"
          inputMode="numeric"
          value={draft.minHeadroomPercent}
          onChange={(event) => setDraft({ ...draft, minHeadroomPercent: event.target.value })}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="child-llm-shortfall" className="text-sm font-medium">모자랄 때</label>
        <select
          id="child-llm-shortfall"
          data-testid="child-llm-shortfall"
          value={draft.onShortfall}
          onChange={(event) => setDraft({ ...draft, onShortfall: event.target.value as ChildLlmOnShortfall })}
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {ON_SHORTFALL.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>

      <Button type="button" size="sm" data-testid="child-llm-save" onClick={() => void save()} disabled={saving}>저장</Button>
      {message && <p role="status" className="text-xs" data-testid="child-llm-saved">{message}</p>}
      {error && <p role="alert" className="text-xs text-destructive" data-testid="child-llm-error">{error}</p>}
    </section>
  );
}
