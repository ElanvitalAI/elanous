'use client';

// PWA `/setup` Phase 1 (2026-05-19) — LLM provider 첫 셋업 page.
//
// v2 단순화: 단일 화면. provider grid → 선택 시 inline ApiKeyField → Save.
// 성공 시 `/setup/done` 으로 이동 (Phase 2). 실패 시 inline error.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ChildLlmPreferenceCard } from '@/components/settings/ChildLlmPreferenceCard';
import { PwaRolePicker } from '@/components/shell/PwaRolePicker';
import { AnswerDepthCard } from '@/components/settings/AnswerDepthCard';
import { ApiKeyField, validateApiKey } from '@/components/ui/api-key-field';
import { Button } from '@/components/ui/button';
import type {
  LlmProviderEntry,
  LlmProvidersResponse,
  SetLlmProviderBody,
} from '@/nexus/client';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { cn } from '@/lib/utils';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; snapshot: LlmProvidersResponse }
  | { status: 'error'; message: string };

type SubmitState =
  | { status: 'idle' }
  | { status: 'mutating' }
  | { status: 'error'; message: string };

const KEY_PREFIX_BY_PROVIDER: Record<string, string | undefined> = {
  anthropic: 'sk-ant-',
  gemini: 'AIza',
  openai: 'sk-',
  // grok / openai-codex / kimi / qwen / glm 은 prefix 강제 없음 (사용자 키
  // 형식이 provider 측 변경에 자주 노출 — minLength 만 검증).
};

function buildValidation(provider: string) {
  const prefix = KEY_PREFIX_BY_PROVIDER[provider];
  return prefix ? { prefix, minLength: 16 } : { minLength: 16 };
}

export default function SetupPage() {
  const router = useRouter();
  const client = useOptionalNexusClient();

  const [mounted, setMounted] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  const [loadingSince, setLoadingSince] = useState(() => Date.now());
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });

  useEffect(() => { setMounted(true); }, []);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoadingSeconds(0);
    setLoadingSince(Date.now());
    setLoad({ status: 'loading' });
    try {
      const snapshot = await client.getLlmProviders();
      setLoad({ status: 'ok', snapshot });
    } catch (err) {
      setLoad({ status: 'error', message: (err as Error).message });
    }
  }, [client]);

  useEffect(() => {
    if (mounted && client) void refresh();
  }, [mounted, client, refresh]);

  useEffect(() => {
    if (load.status !== 'loading') return;
    const timer = window.setInterval(() => setLoadingSeconds(Math.floor((Date.now() - loadingSince) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [load.status, loadingSince]);

  const providers = load.status === 'ok' ? load.snapshot.providers : [];
  const subscriptionProvider = providers.find((provider) => provider.flow === 'codex');
  const selectedOption: LlmProviderEntry | null = useMemo(
    () => providers.find((p) => p.provider === selected) ?? null,
    [providers, selected],
  );

  const canSubmit = useMemo(() => {
    if (!selectedOption || submit.status === 'mutating') return false;
    if (selectedOption.flow === 'auto') return true;
    if (selectedOption.flow === 'apiKey') {
      return validateApiKey(apiKey, buildValidation(selectedOption.provider)).ok;
    }
    // codex / local — submit forwards to TUI hint (button still allowed
    // so the user can land on the 422 + see the hint).
    return false;
  }, [selectedOption, apiKey, submit.status]);

  const handleSubmit = useCallback(async () => {
    if (!client || !selectedOption) return;
    const body: SetLlmProviderBody = { provider: selectedOption.provider };
    if (selectedOption.flow === 'apiKey') body.apiKey = apiKey;

    setSubmit({ status: 'mutating' });
    try {
      await client.setLlmProvider(body);
      // success — head to summary
      router.push('/setup/done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSubmit({ status: 'error', message });
    }
  }, [client, selectedOption, apiKey, router]);

  // SSG safety: browser-only provider data is not rendered before mount.
  if (!mounted || !client) return <PwaRolePicker />;

  if (load.status === 'loading' || load.status === 'idle') {
    return (
      <div className="flex flex-col gap-6">
        <PwaRolePicker />
        <section role="status" aria-live="polite" className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">공급자 확인 중 · {loadingSeconds}초</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-24 animate-pulse rounded border border-border bg-card p-3">
                <div className="mb-3 h-4 w-1/2 rounded bg-muted" />
                <div className="h-3 w-3/4 rounded bg-muted" />
              </div>
            ))}
          </div>
        </section>
      </div>
    );
  }

  if (load.status === 'error') {
    return (
      <div className="flex flex-col gap-6">
        <PwaRolePicker />
        <div className="flex flex-col gap-3 rounded border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">
            Provider 카탈로그 로드 실패: {load.message}
          </p>
          <Button variant="outline" size="sm" onClick={refresh}>
            다시 시도
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PwaRolePicker />
      {subscriptionProvider ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-primary/30 bg-primary/5 p-4">
          <p className="text-sm font-medium">구독이 있으면 추가 비용 없이</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSelected(subscriptionProvider.provider);
              setApiKey('');
              setSubmit({ status: 'idle' });
              window.requestAnimationFrame(() => {
                document.getElementById('selected-provider')?.scrollIntoView({ behavior: 'smooth' });
              });
            }}
          >
            {subscriptionProvider.label} 구독 로그인 보기
          </Button>
        </div>
      ) : null}
      <ProviderGrid
        providers={providers}
        selected={selected}
        onSelect={(id) => { setSelected(id); setApiKey(''); setSubmit({ status: 'idle' }); }}
        activeProvider={load.snapshot.activeProvider}
      />

      {selectedOption ? (
        <SelectedProviderPanel
          provider={selectedOption}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          submitState={submit}
          canSubmit={canSubmit}
          onSubmit={handleSubmit}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          위에서 provider 를 선택해주세요.
        </p>
      )}
      <details className="rounded border border-border bg-card">
        <summary className="cursor-pointer p-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">고급 · 자식 LLM 선호</summary>
        <div className="p-4 pt-0"><ChildLlmPreferenceCard /></div>
      </details>
      <AnswerDepthCard />
    </div>
  );
}

interface ProviderGridProps {
  providers: LlmProviderEntry[];
  selected: string | null;
  onSelect: (id: string) => void;
  activeProvider: string;
}

function ProviderGrid({ providers, selected, onSelect, activeProvider }: ProviderGridProps) {
  const recommended = providers.filter((p) => p.recommended);
  const others = providers.filter((p) => !p.recommended);

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          주요 provider
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {recommended.map((p) => (
            <ProviderCard
              key={p.provider}
              provider={p}
              selected={selected === p.provider}
              active={activeProvider === p.provider}
              onSelect={onSelect}
            />
          ))}
        </div>
      </section>

      {others.length > 0 ? (
        <details className="rounded border border-border bg-card">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            기타 provider ({others.length})
          </summary>
          <div className="grid grid-cols-1 gap-2 border-t border-border p-2 sm:grid-cols-2">
            {others.map((p) => (
              <ProviderCard
                key={p.provider}
                provider={p}
                selected={selected === p.provider}
                active={activeProvider === p.provider}
                onSelect={onSelect}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

interface ProviderCardProps {
  provider: LlmProviderEntry;
  selected: boolean;
  active: boolean;
  onSelect: (id: string) => void;
}

function ProviderCard({ provider, selected, active, onSelect }: ProviderCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(provider.provider)}
      data-testid={`provider-card-${provider.provider}`}
      aria-pressed={selected}
      className={cn(
        'flex flex-col items-start gap-1 rounded border bg-card p-3 text-left transition-colors',
        'hover:border-primary/40 focus-visible:border-primary focus-visible:outline-none',
        selected ? 'border-primary bg-primary/5' : 'border-border',
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="text-sm font-medium">{provider.label}</span>
        <div className="flex gap-1">
          {active ? (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              현재
            </span>
          ) : null}
          {provider.hasSavedKey ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              key 저장됨
            </span>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{provider.description}</p>
    </button>
  );
}

interface SelectedProviderPanelProps {
  provider: LlmProviderEntry;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  submitState: SubmitState;
  canSubmit: boolean;
  onSubmit: () => void;
}

function SelectedProviderPanel({
  provider,
  apiKey,
  onApiKeyChange,
  submitState,
  canSubmit,
  onSubmit,
}: SelectedProviderPanelProps) {
  const isApiKeyFlow = provider.flow === 'apiKey';
  const isAutoFlow = provider.flow === 'auto';
  const isInteractiveFlow = provider.flow === 'codex' || provider.flow === 'local';

  return (
    <section id="selected-provider" className="flex flex-col gap-4 rounded border border-border bg-card p-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-base font-semibold">{provider.label}</h3>
        <p className="text-xs text-muted-foreground">{provider.description}</p>
      </header>

      {isApiKeyFlow ? (
        <ApiKeyField
          label={provider.apiKeyLabel}
          value={apiKey}
          onChange={onApiKeyChange}
          validation={buildValidation(provider.provider)}
          disabled={submitState.status === 'mutating'}
        />
      ) : null}

      {isAutoFlow ? (
        <p className="rounded bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Auto 모드는 매 호출마다 env 에서 첫 번째 사용 가능한 provider 를
          선택합니다. 사용자가 export 한 env 변수에 의존하니, 실패 시
          provider 를 명시 선택해주세요.
        </p>
      ) : null}

      {isInteractiveFlow ? (
        <p className="rounded bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-400">
          {provider.flow === 'codex' ? 'OAuth' : 'Local runtime probe'} 흐름은
          PWA 에서 직접 처리할 수 없어요. 터미널에서{' '}
          <span className="font-mono">elanous setup llm</span> 을 실행해주세요.
        </p>
      ) : null}

      {submitState.status === 'error' ? (
        <p className="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {submitState.message}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          data-testid="setup-submit"
        >
          {submitState.status === 'mutating' ? '저장중…' : '저장 & chat 으로'}
        </Button>
      </div>
    </section>
  );
}
