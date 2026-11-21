'use client';

import { Component, type ReactNode } from 'react';
import { clearLegacyVoiceToken, saveDaemonConfig } from '@/lib/daemon-config';

// 출처: #39459 WEBCHAT-REJECTED-TOKEN-NO-CRASH — 거부·만료 토큰으로 /app/chat 를
// 열 때 챗 런타임의 잡히지 않은 render throw 가 Next.js 기본 «Application error»
// 페이지로 전체 PWA 를 죽이던 결함(2026-11-21 g8 실화면 · evidence/20261121/
// testverse-g8-live/15-crash-pinpoint.md). 이 바운더리는 그 throw 를 라우트 안에서
// 잡아 «다시 연결» 안내(연결 화면 복귀)로 바꾼다 — 401 응답 자체는 reportAuthRequired
// 가 배너로 흡수하므로 여기엔 오지 않고, 여기 오는 건 회복 불능 렌더 예외뿐이다.
// 이 앱에는 /login 라우트가 없다(basePath /app 정적 export — JUD-B #122871 판정
// 보류 지적): «재인증»의 자리는 DeviceConnectGate 의 연결 화면이다.

type ChatErrorBoundaryProps = { children: ReactNode };
type ChatErrorBoundaryState = { error: Error | null };

export class ChatErrorBoundary extends Component<ChatErrorBoundaryProps, ChatErrorBoundaryState> {
  override state: ChatErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ChatErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  // 출처: #39459 + JUD #123140 보안 HOLD — 예외 message 에는 요청 URL·토큰 등이
  // 실릴 수 있어 화면·콘솔 어디에도 예외 내용을 흘리지 않는다(고정 문구만).
  override componentDidCatch(): void {
    console.error('[chat-error-boundary] 챗 렌더 예외 — «다시 연결»로 회복');
  }

  private reset(): void {
    this.setState({ error: null });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div role="alert" className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-base font-semibold">대화를 열지 못했습니다</p>
          <p className="text-sm opacity-80">연결을 다시 만들면 이어서 계속할 수 있습니다</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => this.reset()} className="rounded border px-3 py-1.5 text-sm">
              다시 시도
            </button>
            <button type="button" onClick={reconnectRejectedDevice} className="rounded border px-3 py-1.5 text-sm">
              다시 연결
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * «다시 연결» — 거부·만료로 챗 런타임이 죽은 연결 토큰을 해제하고 앱을 다시 띄운다.
 * 재기동하면 DeviceConnectGate 가 빈 토큰으로 기기를 다시 물어 연결 화면(연결 링크
 * · 토큰 붙여넣기 — 이 앱의 재인증 자리)을 내놓는다. 서버가 /v1/nexus 를 401 로
 * 답하는 한 빈 토큰의 프로브도 같은 «unconnected» 로 연결 화면에 닿는다
 * (apps/pwa/src/lib/device-auth.ts).
 */
export function reconnectRejectedDevice(): void {
  if (typeof window === 'undefined') return;
  saveDaemonConfig({ token: '' });
  // 출처: #39459 — 레거시 elanous.voice.token 까지 제거: 재로드 때 이주가
  // 되살리는 문(JUD-B #124629 기능 HOLD — 빈 토큰 복원 차단).
  clearLegacyVoiceToken();
  window.location.reload();
}