'use client';
// SC1 «공유용 캡처»(beta) — 지금 화면을 연결 줄·내부 주소·토큰을 가린 뒤 PNG 로 데몬에 올린다(티저·현장·보고용).
// 가림 규칙·이중 방어는 `lib/share-capture.ts` 머리말. 이 버튼 자체(`data-share-capture-ui`)도 사진에서 뺀다.
import { useState } from 'react';
import { Camera } from 'lucide-react';
import { toast } from 'sonner';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { debugLog } from '@/lib/debug';
import { captureScreenToPng, shareLiterals } from '@/lib/share-capture';

export function ShareCaptureButton() {
  const { config } = useDaemon();
  const [busy, setBusy] = useState(false);

  const capture = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const literals = shareLiterals({ pageHost: window.location.host, baseUrl: config.baseUrl, token: config.token });
      const shot = await captureScreenToPng(literals);
      const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/captures`, {
        method: 'POST',
        headers: { 'content-type': 'image/png', ...(config.token ? { authorization: `Bearer ${config.token}` } : {}) },
        body: shot.blob,
      });
      if (!res.ok) throw new Error(res.status === 401 ? 'auth' : `http-${res.status}`);
      const body = (await res.json()) as { id: string };
      debugLog('pwa.share-capture.uploaded', { hits: shot.hits, width: shot.width, height: shot.height });
      toast.success(`공유용 캡처를 저장했습니다 — 가린 항목 ${shot.hits}개`, { description: `데몬 captures/${body.id}.png · 올리기 전에 한 번 더 확인해 주세요` });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      debugLog('pwa.share-capture.failed', { reason });
      toast.error(reason === 'auth' ? '저장하지 못했습니다 — 연결 토큰이 필요합니다(설정 › 데몬 연결)' : '이 화면은 아직 캡처하지 못했습니다(beta) — 다른 브라우저에서 다시 시도해 주세요');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-share-capture-ui
      onClick={() => { void capture(); }}
      disabled={busy}
      aria-label="공유용 캡처"
      title="공유용 캡처 (beta) — 주소·토큰을 가린 사진을 데몬에 저장"
      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
    >
      <Camera className="h-4 w-4" />
    </button>
  );
}
