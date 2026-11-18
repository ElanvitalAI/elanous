'use client';

// WEB-FIRST-CONNECT-ONBOARDING (대표 11-17 «최초 연결 새너타이징도 안 되어 있음»): the app asks «is this device connected?»
// once, first. Until the answer the screens are not mounted, so a device without a token sends no other request; when
// the answer is «not connected» (or a later call says the token expired) one connect screen takes their place.
//   • the one-time connect link (`eln nexus pwa connect-link` → /live-run#t=els_…) and /setup pass straight through,
//     because they are how a token arrives;
//   • an unreachable Nexus (offline, down) is not an auth answer: the screens mount and keep their own retry.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { probeDeviceAuth, type DeviceAuth } from '@/lib/device-auth';
import { loadDaemonConfig } from '@/lib/daemon-config';
import { clearAuthRequired, onAuthRequiredEvent } from '@/lib/auth-required';
import { readSetupLinkToken } from '@/lib/setup-link';

type GateState = 'checking' | DeviceAuth;

// 출처: polling screens ask every 8 s (ACTIVITY_POLL_MS); one re-check per 30 s keeps a screen whose own API keeps
// answering 401 from turning every poll into a probe.
const REPROBE_MIN_GAP_MS = 30_000;

/** Routes and links that bring a token in — never held back by the gate. */
export function passesGate(pathname: string | null, hash: string): boolean {
  if (readSetupLinkToken(hash)) return true;
  return !!pathname && (pathname === '/setup' || pathname.startsWith('/setup/'));
}

export function DeviceConnectGate({ children, probe = probeDeviceAuth, reprobeGapMs = REPROBE_MIN_GAP_MS }: {
  children: ReactNode; probe?: typeof probeDeviceAuth; reprobeGapMs?: number;
}) {
  const pathname = usePathname();
  const { config, setConfig } = useDaemon();
  const [state, setState] = useState<GateState>('checking');
  const [bypass, setBypass] = useState(false);
  const [round, setRound] = useState(0);
  // A pasted token that the Nexus still refuses: said on the screen instead of silently showing it again.
  const [pasted, setPasted] = useState(false);

  useEffect(() => {
    setBypass(typeof window !== 'undefined' && passesGate(pathname, window.location.hash));
  }, [pathname]);

  // Read the stored connection directly: this effect runs before the provider's own mount effect, whose state
  // still holds the empty pre-mount config at that point.
  useEffect(() => {
    let alive = true;
    lastProbeAt.current = Date.now();
    void probe(loadDaemonConfig()).then((answer) => {
      if (!alive) return;
      if (answer === 'connected') setPasted(false);
      // Any answer but «refused» re-arms the one-shot 401 notice (#38209 REVIEW-1): after an «unreachable» re-check
      // the next 401 must ask again — otherwise the connect screen never comes and the debug queue stays held.
      if (answer !== 'unconnected') clearAuthRequired();
      setState(answer);
    });
    return () => { alive = false; };
  // Asked again only when the token changes (pasted, claimed, another tab) or on «다시 확인» — the provider filling
  // in the stored base URL on mount is not a new question.
  }, [probe, config.token, round]);

  // A call answered 401 later on: ask the device question again instead of taking the app down — only «this device's
  // token is refused» (the probe says unconnected) brings the connect screen; another API's 401 stays that screen's
  // own error. The screens stay mounted while the probe runs.
  const lastProbeAt = useRef(0);
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const off = onAuthRequiredEvent(() => {
      if (pending) return;
      // Too soon after the last probe: postponed, not dropped (the 401 notice fires once until a fresh connection).
      const wait = Math.max(0, reprobeGapMs - (Date.now() - lastProbeAt.current));
      pending = setTimeout(() => { pending = undefined; setRound((value) => value + 1); }, wait);
    });
    return () => { off(); if (pending) clearTimeout(pending); };
  }, [reprobeGapMs]);

  const retry = useCallback(() => { setState('checking'); setRound((value) => value + 1); }, []);

  if (bypass || state === 'connected' || state === 'unreachable') return <>{children}</>;
  if (state === 'checking') return <div data-elanous-connect-gate="checking" className="min-h-screen bg-background" aria-busy="true" />;
  return <DeviceConnectScreen rejected={pasted} onToken={(token) => { setPasted(true); setConfig({ token }); retry(); }} onRetry={retry} />;
}

export function DeviceConnectScreen({ onToken, onRetry, rejected = false }: { onToken: (token: string) => void; onRetry: () => void; rejected?: boolean }) {
  const [token, setToken] = useState('');
  return (
    <main data-elanous-connect-gate="unconnected" className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <section role="alert" className="w-full max-w-md space-y-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-5 text-sm">
        <h1 className="text-base font-semibold">이 기기를 연결해야 합니다</h1>
        <p className="text-muted-foreground">이 기기는 아직 엘라누스에 연결되지 않았습니다(또는 연결이 만료됐습니다). 연결하면 대화가 바로 열립니다.</p>
        <div className="space-y-1">
          <h2 className="font-medium">연결 링크로 (권장)</h2>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>엘라누스가 도는 컴퓨터의 터미널에서 <code className="rounded bg-muted px-1 font-mono text-xs">eln nexus pwa connect-link</code> 를 실행합니다.</li>
            <li>나온 링크를 이 기기에서 엽니다(휴대폰이면 링크를 메시지로 보내 누르세요). 링크는 한 번만 쓰입니다.</li>
          </ol>
        </div>
        <form
          className="space-y-2"
          onSubmit={(event) => { event.preventDefault(); const value = token.trim(); if (value) onToken(value); }}
        >
          <label className="block font-medium" htmlFor="device-connect-token">또는 연결 토큰 붙여 넣기</label>
          <input
            id="device-connect-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="연결된 기기의 설정 › 연결 토큰 만들기"
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          />
          {rejected && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">이 토큰으로는 연결되지 않았습니다 — 새 토큰이나 연결 링크를 쓰세요.</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={!token.trim()} className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-50">연결</button>
            <button type="button" onClick={onRetry} className="rounded-md border border-border px-3 py-1.5 hover:bg-muted">다시 확인</button>
          </div>
        </form>
      </section>
    </main>
  );
}
