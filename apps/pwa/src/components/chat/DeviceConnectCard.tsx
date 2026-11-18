'use client';

// WEB-CHAT-ACTIVITY-ERROR (대표 11-17): on a device the Nexus does not know (no token: every /v1 call is 401 under
// nexus.auth default-deny) the chat showed several red errors at once (activity, projects, the first reply). One card
// says what is wrong and how to fix it instead.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { authRequiredNow, onAuthRequiredEvent } from '@/lib/auth-required';

/** True once any request was answered 401 (this device is not connected). */
export function useAuthRequired(): boolean {
  // Read after mount (static export hydration).
  const [required, setRequired] = useState(false);
  useEffect(() => {
    setRequired(authRequiredNow());
    return onAuthRequiredEvent(() => setRequired(true));
  }, []);
  return required;
}

export function DeviceConnectCard() {
  return (
    <section role="alert" data-elanous-device-connect className="mx-auto w-full max-w-md space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-left text-sm text-foreground">
      <h2 className="font-semibold">이 기기를 연결해야 합니다</h2>
      <p className="text-muted-foreground">이 기기는 아직 엘라누스에 연결되지 않아 대화를 보낼 수 없습니다.</p>
      <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>엘라누스가 도는 컴퓨터의 터미널에서 <code className="rounded bg-muted px-1 font-mono text-xs">eln nexus pwa connect-link</code> 를 실행합니다.</li>
        <li>나온 연결 링크를 이 기기에서 엽니다.</li>
      </ol>
      <p className="text-xs text-muted-foreground">
        링크를 쓸 수 없으면 연결된 기기에서 연결 토큰을 만들어 이 기기의 <Link href="/settings" className="underline underline-offset-2">설정</Link> › 데몬 연결 › 연결 토큰 칸에 붙여 넣으세요.
      </p>
    </section>
  );
}
