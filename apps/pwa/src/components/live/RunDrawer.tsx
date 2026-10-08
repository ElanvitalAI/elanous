'use client';

// Live 런 서랍(🅢 09-28 «런 클릭 → 그 런의 화면·로그 · 멈춤(확인 한 번) · 승인 대기면 Approvals 카드로»).
// 화면 = `GET /v1/harness/run-screen`(`self screen --run` 과 같은 해석 · 이 인스턴스 로그) · 멈춤 = `POST /v1/harness/stop`(부드러운 멈춤).
// ⛔ 멈춤은 되돌릴 수 없는 쪽이라 한 번 더 묻는다. 못 찾은 화면은 «이유»를 그대로 보인다(빈 칸으로 접지 않는다).

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useNexusClient } from '@/nexus/hooks/use-nexus-context';
import type { RunScreenResponse } from '@/nexus/client';
import { LIVE_STAGE_LABEL, type LiveRun } from '@/lib/live-signals';
import { debugLog } from '@/lib/debug';

const REASON_TEXT: Record<string, string> = {
  'no-screen-key': '이 인스턴스 로그에 이 런의 화면 키가 없다 — 다른 우주(시험·Pod)에서 돈 런이면 그 우주에서 본다.',
  'screen-missing': '화면 키는 있는데 화면 파일이 없다 — 런이 끝나 화면이 정리됐을 수 있다.',
  'log-store-missing': '이 인스턴스에 로그 저장소가 없다.',
  'log-store-unreadable': '로그 저장소를 읽지 못했다.',
};

/** 승인 대기로 볼 수 있나 — PR 이 열렸고 아직 착지하지 않았다. */
export function awaitingApproval(run: Pick<LiveRun, 'pr' | 'stages' | 'blocked'> | null | undefined): boolean {
  return !!run?.pr && run.stages.land !== 'ok';
}

export interface RunDrawerViewProps {
  runId: string;
  run?: LiveRun | null;
  screen?: RunScreenResponse | null;
  screenError?: string | null;
  lines: string[];
  stopState: 'idle' | 'confirm' | 'stopping' | 'stopped' | 'failed';
  stopMessage?: string | null;
  onStop: () => void;
  onConfirmStop: () => void;
  onCancelStop: () => void;
  onClose: () => void;
  /** MAX «이 런만» — 없으면 버튼을 그리지 않는다(시험·옛 화면). */
  max?: { state: 'idle' | 'confirm' | 'on' | 'failed'; ask: () => void; confirm: () => void; cancel: () => void };
}

/** 화면만 — 시험이 몰 수 있다(훅 없음). */
export function RunDrawerView({ runId, run, screen, screenError, lines, stopState, stopMessage, onStop, onConfirmStop, onCancelStop, onClose, max }: RunDrawerViewProps) {
  const stoppable = !!screen?.stoppable;
  return (
    <section className="space-y-2 rounded-lg border border-primary/40 bg-card/60 p-3" aria-label="런 서랍" data-live-run-drawer={runId}>
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-xs text-muted-foreground">{runId}</span>
        {run?.current && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[11px]">{LIVE_STAGE_LABEL[run.current]}</span>}
        {run?.blocked && <span className="rounded bg-error/15 px-1.5 py-0.5 text-[11px] text-error">막힘</span>}
        {run?.pr && <span className="font-mono text-[11px]">PR #{run.pr}</span>}
        <span className="ml-auto flex items-center gap-2">
          {max && (max.state === 'confirm' ? (
            <span className="flex items-center gap-1 text-xs" role="alertdialog" aria-label="MAX 이 런만 확인">
              <span className="text-amber-500">이 런만 30분 상세 계측(부하가 든다)?</span>
              <button type="button" onClick={max.confirm} className="rounded-md border border-amber-500 px-2 py-1 text-amber-600 hover:bg-amber-500/10" data-elanous-action="live-run-max-confirm">켜기</button>
              <button type="button" onClick={max.cancel} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted">취소</button>
            </span>
          ) : (
            <button type="button" onClick={max.ask} disabled={max.state === 'on'} className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50" data-elanous-action="live-run-max" title="이 런의 판단 «왜·목적·어디로»를 30분 자세히 남긴다">
              {max.state === 'on' ? '● MAX 이 런 켜짐' : max.state === 'failed' ? 'MAX 못 켬 · 다시' : 'MAX 이 런만'}
            </button>
          ))}
          <Link href={`/trace?level=L2&run=${encodeURIComponent(runId)}` as never} className="rounded-md border px-2 py-1 text-xs hover:bg-muted" data-elanous-action="live-run-trace">
            Trace 로 →
          </Link>
          <Link href={`/live-run/?run=${encodeURIComponent(runId)}` as never} className="rounded-md border px-2 py-1 text-xs hover:bg-muted" data-elanous-action="live-run-scene">
            런 장면 →
          </Link>
          {awaitingApproval(run) && (
            <Link href={`/approvals?pr=${encodeURIComponent(run!.pr!)}` as never} className="rounded-md border px-2 py-1 text-xs hover:bg-muted" data-elanous-action="live-run-approvals">
              승인 카드로 →
            </Link>
          )}
          {stopState === 'confirm' ? (
            <span className="flex items-center gap-1 text-xs" role="alertdialog" aria-label="멈춤 확인">
              <span className="text-error">이 런을 멈출까요? 되돌릴 수 없습니다.</span>
              <button type="button" onClick={onConfirmStop} className="rounded-md border border-error px-2 py-1 text-error hover:bg-error/10" data-elanous-action="live-run-stop-confirm">멈춤</button>
              <button type="button" onClick={onCancelStop} className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted">취소</button>
            </span>
          ) : (
            <button
              type="button"
              onClick={onStop}
              disabled={!stoppable || stopState === 'stopping' || stopState === 'stopped'}
              title={stoppable ? '부드러운 멈춤을 보낸다(확인 한 번)' : '살아 있는 화면이 없어 멈출 수 없다'}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
              data-elanous-action="live-run-stop"
            >
              ⏹ 멈춤
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted" aria-label="서랍 닫기">✕</button>
        </span>
      </header>
      {stopMessage && <p className={`text-xs ${stopState === 'failed' ? 'text-error' : 'text-muted-foreground'}`} data-live-run-stop-result>{stopMessage}</p>}
      <div className="grid gap-2 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">화면{screen?.screenKey ? <span className="ml-1 font-mono">· {screen.screenKey}</span> : null}</h3>
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed" data-live-run-screen>
            {screenError ? `화면을 못 읽었다: ${screenError}` : screen?.text ?? (screen?.reason ? REASON_TEXT[screen.reason] ?? screen.reason : '불러오는 중…')}
          </pre>
        </div>
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">로그 <span className="font-mono">· {lines.length}</span></h3>
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed" data-live-run-log>{lines.slice(0, 40).join('\n') || '—'}</pre>
        </div>
      </div>
    </section>
  );
}

export function RunDrawer({ runId, run, lines, onClose }: { runId: string; run?: LiveRun | null; lines: string[]; onClose: () => void }) {
  const client = useNexusClient();
  const screen = useQuery({ queryKey: ['live', 'run-screen', runId], queryFn: () => client.getRunScreen(runId, 60), refetchInterval: 3_000 });
  const [stopState, setStopState] = useState<RunDrawerViewProps['stopState']>('idle');
  const [stopMessage, setStopMessage] = useState<string | null>(null);
  // MAX «이 런만»(RFC v6 T4 조작) — 이 런의 판단 «왜·목적·어디로»를 30분 더 자세히 남긴다(부하가 든다 · 확인 한 번).
  const [maxState, setMaxState] = useState<'idle' | 'confirm' | 'on' | 'failed'>('idle');
  const turnOnRunMax = () => {
    client.setLiveDetail({ scope: runId, ttlMin: 30, by: 'pwa-run-drawer' })
      .then((st) => { setMaxState(st.on ? 'on' : 'failed'); debugLog('pwa.live.run-max', { runId, on: st.on }); })
      .catch(() => setMaxState('failed'));
  };
  const confirmStop = () => {
    const key = screen.data?.screenKey;
    if (!key) return;
    setStopState('stopping');
    client.stopHarness(key)
      .then((r) => {
        const ok = !!r.stopped;
        debugLog('pwa.live.run-stop', { runId, ok });
        setStopState(ok ? 'stopped' : 'failed');
        setStopMessage(ok ? `멈춤을 보냈다 — 런이 다음 확인 지점에서 멈춘다(${r.stopped}).` : `멈추지 못했다: ${r.error ?? '알 수 없음'}`);
      })
      .catch((e) => {
        debugLog('pwa.live.run-stop', { runId, ok: false });
        setStopState('failed');
        setStopMessage(`멈추지 못했다: ${e instanceof Error ? e.message : String(e)}`);
      });
  };
  return (
    <RunDrawerView
      runId={runId}
      run={run}
      screen={screen.data ?? null}
      screenError={screen.error ? (screen.error instanceof Error ? screen.error.message : String(screen.error)) : null}
      lines={lines}
      stopState={stopState}
      stopMessage={stopMessage}
      onStop={() => setStopState('confirm')}
      onConfirmStop={confirmStop}
      onCancelStop={() => setStopState('idle')}
      onClose={onClose}
      max={{ state: maxState, ask: () => setMaxState('confirm'), confirm: turnOnRunMax, cancel: () => setMaxState('idle') }}
    />
  );
}
