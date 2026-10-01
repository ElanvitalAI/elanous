'use client';

// PWA `/setup/done` Phase 2 (2026-05-19) — wizard 완료 + "more setup?" links.
//
// v2 단순화 핵심: wizard 가 LLM 만 책임 → 나머지는 /settings 의 카드 (Phase 3
// 에서 anchor 가 추가됨). 사용자가 setup wizard 거치든 안 거치든 동일 UX.
// 본 page 의 link 들은 Phase 3 머지 전엔 그냥 `/settings` 로 이동하고,
// Phase 3 머지 후 `/settings#<anchor>` 로 점프함 (link 텍스트 그대로 유지).

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';

interface ActiveLlmState {
  provider: string;
  // model 은 PWA Phase 1 의 setLlmProvider 응답에서만 채워짐 — /setup/done
  // 직접 방문 시 비어 있을 수 있음.
  model?: string;
}

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; active: ActiveLlmState }
  | { status: 'error'; message: string };

// 2026-07-07 — SETUP_LINKS 데이터는 ./setup-links.ts 로 분리 (Next 15 가
// page.tsx 의 비-Page export 를 거부: "not a valid Page export field").
import { SETUP_LINKS, type SetupLinkCard } from './setup-links';
import { SetupNextSteps, SetupRecommendations } from './SetupNextSteps';

export default function SetupDonePage() {
  const client = useOptionalNexusClient();

  const [mounted, setMounted] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!mounted || !client) return;
    setLoad({ status: 'loading' });
    void client
      .getLlmProviders()
      .then((snap) => {
        setLoad({
          status: 'ok',
          active: { provider: snap.activeProvider || '(unset)' },
        });
      })
      .catch((err) => {
        setLoad({ status: 'error', message: (err as Error).message });
      });
  }, [mounted, client]);

  if (!mounted || !client) return null;

  return (
    <div className="flex flex-col gap-6">
      <SetupRecommendations />
      <ActiveLlmCard load={load} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">곧장 chat 으로</h2>
        <p className="text-xs text-muted-foreground">
          LLM 만 셋업해도 chat 은 바로 사용 가능합니다. 나머지는 필요할 때
          <span className="font-mono"> /settings</span> 에서 추가하세요.
        </p>
        <div>
          <Link href="/chat" data-testid="setup-done-chat-link">
            <Button size="lg">Chat 시작 →</Button>
          </Link>
        </div>
      </section>

      <SetupNextSteps />
      <MoreSetupLinks />
    </div>
  );
}

function ActiveLlmCard({ load }: { load: LoadState }) {
  if (load.status === 'loading' || load.status === 'idle') {
    return (
      <section className="rounded border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">상태 확인 중…</p>
      </section>
    );
  }
  if (load.status === 'error') {
    return (
      <section className="rounded border border-destructive/40 bg-destructive/5 p-4">
        <p className="text-sm text-destructive">
          LLM 상태 로드 실패: {load.message}
        </p>
      </section>
    );
  }
  const provider = load.active.provider;
  const isUnset = provider === '(unset)';
  return (
    <section
      className="rounded border border-primary/40 bg-primary/5 p-4"
      data-testid="setup-done-active-llm"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            현재 LLM provider
          </p>
          <p className="mt-1 font-mono text-base font-semibold">
            {provider}
          </p>
        </div>
        {isUnset ? (
          <Link href="/setup">
            <Button variant="outline" size="sm">셋업</Button>
          </Link>
        ) : (
          <span className="rounded bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
            ✓ 준비됨
          </span>
        )}
      </header>
    </section>
  );
}

function MoreSetupLinks() {
  const primary = SETUP_LINKS.filter((l) => l.primary);
  const optional = SETUP_LINKS.filter((l) => !l.primary);

  return (
    <section className="flex flex-col gap-3">
      <header>
        <h2 className="text-sm font-semibold">필요하면 더 셋업하기</h2>
        <p className="text-xs text-muted-foreground">
          모두 선택. 안 만져도 chat 은 잘 됩니다.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {primary.map((link) => (
          <SetupLinkTile key={link.anchor} link={link} />
        ))}
      </div>

      <details className="rounded border border-border bg-card">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          기타 ({optional.length})
        </summary>
        <div className="grid grid-cols-1 gap-2 border-t border-border p-2 sm:grid-cols-3">
          {optional.map((link) => (
            <SetupLinkTile key={link.anchor} link={link} />
          ))}
        </div>
      </details>
    </section>
  );
}

function SetupLinkTile({ link }: { link: SetupLinkCard }) {
  // Phase 3 머지 전 — `/settings` 로 이동. Phase 3 머지 후 `#anchor` 가
  // SettingsPanel 의 해당 카드로 scroll. anchor 값은 본 파일 내 SETUP_LINKS
  // 가 single source — Phase 3 가 같은 id 사용.
  const href = `/settings#${link.anchor}`;
  return (
    <Link
      href={href}
      data-testid={`setup-done-link-${link.anchor}`}
      className="flex flex-col gap-1 rounded border border-border bg-card p-3 transition-colors hover:border-primary/40"
    >
      <span className="text-sm font-medium">{link.label}</span>
      <span className="text-xs text-muted-foreground">{link.description}</span>
    </Link>
  );
}

// SETUP_LINKS / SetupLinkCard 는 ./setup-links.ts 에서 export — anchor sync
// 테스트(SettingsPanel.anchors.test.ts)도 그쪽을 import.
