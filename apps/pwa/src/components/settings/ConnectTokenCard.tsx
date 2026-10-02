'use client';

// T4.D — Generate connect token card.
//
// 사용자가 다른 기기 (laptop · phone · desktop) 에서 `elanous nexus connect`
// 시 paste 할 token 을 mint + clipboard 로 복사. NEXUS 가 single-host
// dogfood 인 동안은 raw bearer 를 그대로 노출 (v1 simple mode); v2 (mutual
// auth) 에서 5min single-use JWT 로 강화. ROADMAP §6.2 (T4.D · ~100 LOC).

import { useCallback, useEffect, useState } from 'react';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { Button } from '@/components/ui/button';

type CardState =
  | { status: 'idle' }
  | { status: 'minting' }
  | { status: 'shown'; token: string; hint: string }
  | { status: 'error'; error: string };

export function ConnectTokenCard() {
  const client = useOptionalNexusClient();
  const [state, setState] = useState<CardState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  // Hydration safety — see QuickSetupCard (PR #1866) for the same pattern.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const mint = useCallback(async () => {
    if (!client) return;
    setState({ status: 'minting' });
    setCopied(false);
    try {
      const r = await client.mintConnectToken();
      setState({ status: 'shown', token: r.token, hint: r.hint });
    } catch (err) {
      setState({ status: 'error', error: (err as Error).message });
    }
  }, [client]);

  const copy = useCallback(async () => {
    if (state.status !== 'shown') return;
    try {
      await navigator.clipboard.writeText(state.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setState({ status: 'error', error: `clipboard: ${(err as Error).message}` });
    }
  }, [state]);

  // SSG-safe: NexusProvider 미mount (next build prerender) 시 silent hide.
  // Mount guard prevents the SSR=null vs CSR=<section> hydration mismatch.
  if (!mounted || !client) return null;

  return (
    <section
      data-testid="connect-token-card"
      className="space-y-2"
    >
      <h2 className="text-sm font-medium">연결 토큰 만들기 (다른 기기용)</h2>
      <div className="rounded-md border border-border bg-card p-3 text-xs space-y-2">
        <p className="text-muted-foreground">
          다른 머신에서 <code className="rounded bg-muted px-1">elanous nexus connect &lt;host&gt;</code> 시
          paste 할 bearer token 을 발급. 한 번 paste 하면 그 머신의 bookmark 에 영구 저장 — 매번 재발급할 필요 없음.
        </p>
        {state.status === 'idle' && (
          <Button
            size="sm"
            onClick={() => void mint()}
            data-testid="connect-token-generate"
          >
            Generate connect token
          </Button>
        )}
        {state.status === 'minting' && (
          <p className="text-muted-foreground">Minting…</p>
        )}
        {state.status === 'shown' && (
          <div className="space-y-2">
            <code
              className="block break-all rounded bg-muted p-2 font-mono text-[11px] select-all"
              data-testid="connect-token-value"
            >
              {state.token}
            </code>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => void copy()}
                data-testid="connect-token-copy"
              >
                {copied ? '✓ Copied' : 'Copy to clipboard'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setState({ status: 'idle' })}
                data-testid="connect-token-hide"
              >
                Hide
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground">{state.hint}</p>
          </div>
        )}
        {state.status === 'error' && (
          <div className="space-y-2">
            <p className="text-rose-500">발급 실패: {state.error}</p>
            <Button size="sm" variant="outline" onClick={() => setState({ status: 'idle' })}>
              Reset
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
