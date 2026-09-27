'use client';

// WT-S-1 + WT-C-1 + WT-N-1 + WT-N-2 — terminal-pane toolbar.
//
// WT-S-1: clear button.
// WT-C-1: Record / Stop / Download asciicast file via daemon
// `terminal/record/start` + `terminal/record/stop` ACP ext methods.
// State is per-(sessionId, terminalId) — switching the active tab
// resets the visible recording state to whatever the daemon has for
// that terminal (re-fetched via `terminal/record/list` on prop change).
// WT-N-1: CameraAttachButton — iOS Safari `<input capture="environment">`
// → `POST /v1/attachments` upload.
// WT-N-2: FileAttachButton — Files.app 멀티-파일 picker.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { cn } from '@/lib/utils';
import { debugLog } from '@/lib/debug';
import type { AttachmentMeta } from '@/lib/upload-attachment';
import type { VoicePhase } from '@/voice/use-voice-controller';
import { CameraAttachButton } from './CameraAttachButton';
import { FileAttachButton } from './FileAttachButton';
import { LiveCameraControl } from './LiveCameraControl';

/** Phase 2 (webterm voice control · PLAN v1.1) — voice mirror props
 *  from TerminalPanel. Same shape as the dock's voice prop but routes
 *  STT finals to `terminal/input` stdin (not :agent auto-send) when
 *  this mic is active. Q1=ABC + Q2=split. */
export interface TerminalControlsVoiceProps {
  active: boolean;
  phase: VoicePhase;
  dotColor: string;
  phaseLabel: string;
  disabled?: boolean;
  /** Click handler. TerminalPanel sets `activeMicSource = 'controls'`
   *  *before* toggling so the next final lands in xterm stdin. */
  onToggle: () => void;
}

interface Props {
  /** Active terminalId (drives ACP record-start target + state scope). */
  terminalId: string;
  onClear: () => void;
  /** Surface recording state to the parent so the minimized tab strip
   *  can render a compact REC pill without keeping this whole toolbar
   *  visible. Fires whenever `active` transitions on/off. */
  onRecordingChange?: (active: boolean) => void;
  /** Bubble Camera/Files attachment results up to the page so they can
   *  be injected into the active terminal (ctr.sh-style path piping). */
  onAttached?: (entries: AttachmentMeta[]) => void;
  /** Phase 2 — TUI Alt+V dictation 흡수. STT 결과가 xterm 으로 typing 된다. */
  voice?: TerminalControlsVoiceProps;
}

interface RecordingActive {
  recorderId: string;
  startedAt: number;
}

interface RecordingDone {
  recorderId: string;
  downloadUrl: string;
  frameCount: number;
  elapsedSec: number;
}

export function TerminalControls({ terminalId, onClear, onRecordingChange, onAttached, voice }: Props) {
  const { client, sessionId, config } = useDaemon();
  const [active, setActive] = useState<RecordingActive | null>(null);
  const [done, setDone] = useState<RecordingDone | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Notify parent on every active transition (start, stop, terminal
  // switch resync). Parent uses this to render a compact REC pill in
  // the tab strip when the panel is minimized.
  useEffect(() => {
    onRecordingChange?.(active !== null);
  }, [active, onRecordingChange]);

  // Lazy ACP connection — opened on first record action so we don't
  // spend a WS slot when the user never touches the toolbar. Closed on
  // unmount.
  const acpRef = useRef<ReturnType<typeof client.connectAcp> | null>(null);
  useEffect(() => () => {
    try { acpRef.current?.close(); } catch { /* swallow */ }
    acpRef.current = null;
  }, []);

  // On terminalId change, ask daemon whether a recording is in flight
  // for this terminal (so reload-mid-record resumes the visible badge).
  useEffect(() => {
    if (!sessionId) return;
    if (!acpRef.current) acpRef.current = client.connectAcp({ sessionId });
    const acp = acpRef.current;
    let cancelled = false;
    void (async () => {
      try {
        const res = (await acp.send('terminal/record/list', { sessionId })) as
          | { recordings: { recorderId: string; terminalId: string; startedAt: number }[] }
          | undefined;
        if (cancelled) return;
        const live = res?.recordings?.find((r) => r.terminalId === terminalId);
        if (live) setActive({ recorderId: live.recorderId, startedAt: live.startedAt });
        else setActive(null);
        setDone(null);
        setError(null);
      } catch (e) {
        debugLog('webterm.controls.list-error', { reason: String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [client, sessionId, terminalId]);

  const startRecord = useCallback(async (): Promise<void> => {
    if (!sessionId) {
      setError('session 미설정 — daemon 연결을 먼저 확인하세요');
      return;
    }
    if (!acpRef.current) acpRef.current = client.connectAcp({ sessionId });
    const acp = acpRef.current;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = (await acp.send('terminal/record/start', { sessionId, terminalId })) as
        | { started: boolean; recorderId?: string; startedAt?: number; reason?: string }
        | undefined;
      if (res?.started && res.recorderId) {
        debugLog('webterm.controls.record.started', { recorderId: res.recorderId, terminalId });
        setActive({ recorderId: res.recorderId, startedAt: res.startedAt ?? Date.now() });
      } else {
        setError(res?.reason ?? 'start failed');
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [client, sessionId, terminalId]);

  const stopRecord = useCallback(async (): Promise<void> => {
    if (!sessionId || !active) return;
    const acp = acpRef.current ?? client.connectAcp({ sessionId });
    acpRef.current = acp;
    setBusy(true);
    setError(null);
    try {
      const res = (await acp.send('terminal/record/stop', { sessionId, terminalId })) as
        | {
          stopped: boolean;
          recorderId?: string;
          downloadUrl?: string;
          frameCount?: number;
          elapsedSec?: number;
          reason?: string;
        }
        | undefined;
      if (res?.stopped && res.recorderId && res.downloadUrl) {
        debugLog('webterm.controls.record.stopped', {
          recorderId: res.recorderId,
          frameCount: res.frameCount,
          elapsedSec: res.elapsedSec,
        });
        setDone({
          recorderId: res.recorderId,
          downloadUrl: res.downloadUrl,
          frameCount: res.frameCount ?? 0,
          elapsedSec: res.elapsedSec ?? 0,
        });
        setActive(null);
      } else {
        setError(res?.reason ?? 'stop failed');
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }, [active, client, sessionId, terminalId]);

  const handleClear = (): void => {
    debugLog('webterm.controls.clear');
    onClear();
  };

  // Prefix the daemon baseUrl so the download `<a>` works from a PWA
  // hosted on a different origin (rare today since daemon serves /app
  // itself, but cheap to support). Bearer token is appended via a
  // query param fallback since the browser doesn't allow custom
  // headers on plain link clicks; daemon honours `?auth=<token>` for
  // GET endpoints when `noAuth` isn't set.
  const downloadHref = (url: string): string => {
    if (!url) return '';
    const base = config.baseUrl ?? '';
    const sep = url.includes('?') ? '&' : '?';
    const auth = config.token ? `${sep}auth=${encodeURIComponent(config.token)}` : '';
    return `${base}${url}${auth}`;
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1 text-xs">
      <button
        type="button"
        className="rounded border px-2 py-0.5 hover:bg-accent"
        onClick={handleClear}
      >
        clear
      </button>
      <CameraAttachButton onAttached={onAttached ? (entry) => onAttached([entry]) : undefined} />
      <FileAttachButton onAttached={onAttached} />
      <LiveCameraControl />

      {/* Phase 2 (webterm voice control · PLAN v1.1) — TUI native
          dictation 흡수. Q1=ABC · Q2=split: 이 진입점의 STT final 은
          terminal/input stdin 으로 직접 inject (xterm typing 효과).
          dock 헤더 mic 와 같은 controller 인스턴스를 share 하지만
          activeMicSource='controls' 로 routing 분기. */}
      {voice && (
        <button
          type="button"
          onClick={voice.onToggle}
          disabled={voice.disabled}
          title={voice.disabled ? '마이크 사용 불가 (insecure context 등)' : `${voice.phaseLabel} · xterm 으로 typing`}
          data-elanous-action="webterm-voice-toggle-controls"
          aria-pressed={voice.active}
          className={cn(
            'inline-flex items-center gap-1 rounded border px-2 py-0.5',
            voice.active
              ? 'border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-100'
              : 'hover:bg-accent',
            voice.disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              voice.dotColor,
              (voice.phase === 'listening' || voice.phase === 'speaking') && 'animate-pulse',
            )}
            aria-hidden="true"
          />
          {voice.active ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          <span>voice→stdin</span>
        </button>
      )}

      {!active && !done && (
        <button
          type="button"
          disabled={busy}
          className={`rounded border px-2 py-0.5 ${
            busy ? 'opacity-50' : 'hover:bg-accent'
          } text-rose-600 dark:text-rose-400`}
          onClick={() => void startRecord()}
          title="start asciicast recording"
        >
          ● record
        </button>
      )}
      {active && (
        <button
          type="button"
          disabled={busy}
          className={`rounded border px-2 py-0.5 ${
            busy ? 'opacity-50' : 'hover:bg-accent'
          } bg-rose-600 text-white animate-pulse`}
          onClick={() => void stopRecord()}
          title="stop + save .cast"
        >
          ■ stop
        </button>
      )}
      {done && (
        <a
          href={downloadHref(done.downloadUrl)}
          download={`${done.recorderId}.cast`}
          className="rounded border border-emerald-500 px-2 py-0.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950"
          onClick={() => debugLog('webterm.controls.download.click', { recorderId: done.recorderId })}
          title={`${done.frameCount} frames · ${done.elapsedSec.toFixed(1)}s`}
        >
          ⬇ download .cast
        </a>
      )}
      {done && (
        <button
          type="button"
          className="rounded border px-2 py-0.5 text-muted-foreground hover:bg-accent"
          onClick={() => setDone(null)}
          title="dismiss"
          aria-label="dismiss download"
        >
          ×
        </button>
      )}
      {(active || done) && (
        <span className="ml-auto text-[11px] text-muted-foreground">
          {active && '● recording'}
          {done && !active && `✓ ${done.recorderId}`}
        </span>
      )}
      {error && (
        <span className="ml-2 max-w-[40%] truncate text-[11px] text-rose-500" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
