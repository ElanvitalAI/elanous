// CV-3 mobile-readiness #3 · Showroom voice intake (Phase 0.5).
//
// Long-press mic button next to the FileAttach + Camera buttons in
// ShowroomInput. Hold → Web Speech API STT runs (browser-native);
// release → final transcript posts to /v1/intake (separate from
// the existing voice phase 1 auto-broadcast). Two-layer split
// mirrors HitlBanner / IntentPanel / ShowroomCameraIntake.
//
// Why separate from `useVoiceController`: that hook wires the
// daemon WS auto-broadcast loop. Here we want a focused capture
// that ends in /v1/intake, not in panel broadcast — different
// destination, different UX (review modal before commit).
//
// BACKLOG-pwa-mobile-readiness §2.3

'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, Loader2, X, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { debugLog } from '@/lib/debug';
import { userIntentLogger } from '@/lib/user-intent-logger';
import {
  postVoiceIntake,
  resolveSpeechRecognition,
  startVoiceRecognition,
  type VoiceRecognitionSession,
} from '@/lib/voice-intake';
import { NEXUS_URL_MISSING } from '@/lib/nexus-url-missing';

export interface ShowroomVoiceIntakeViewProps {
  /** 'idle' = button only · 'recording' = pulsing mic · 'review' =
   *  modal showing the captured transcript awaiting confirm. */
  phase: 'idle' | 'recording' | 'review' | 'submitting';
  /** Live transcript while recording, final transcript while
   *  reviewing. */
  transcript: string;
  /** Allow the user to edit the transcript before submitting. */
  onTranscriptChange: (next: string) => void;
  error: string | null;
  /** True when Web Speech API isn't available — disable the
   *  button + surface a tooltip. */
  apiAvailable: boolean;
  onPressStart: () => void;
  onPressEnd: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ShowroomVoiceIntakeView(props: ShowroomVoiceIntakeViewProps) {
  const {
    phase,
    transcript,
    onTranscriptChange,
    error,
    apiAvailable,
    onPressStart,
    onPressEnd,
    onConfirm,
    onCancel,
  } = props;
  const recording = phase === 'recording';
  const reviewing = phase === 'review' || phase === 'submitting';
  const submitting = phase === 'submitting';

  return (
    <>
      <button
        type="button"
        onPointerDown={apiAvailable ? onPressStart : undefined}
        onPointerUp={apiAvailable ? onPressEnd : undefined}
        onPointerLeave={recording ? onPressEnd : undefined}
        disabled={!apiAvailable || submitting}
        aria-label={apiAvailable ? '음성 메모 (길게 누르기)' : '음성 메모 (브라우저 미지원)'}
        title={apiAvailable ? '길게 눌러 녹음 → intake 저장' : '브라우저가 Web Speech API 미지원'}
        data-testid="showroom-voice-button"
        data-phase={phase}
        className={`rounded p-1.5 transition disabled:cursor-not-allowed disabled:opacity-50 ${
          recording
            ? 'animate-pulse bg-red-500 text-white'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        }`}
      >
        {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
      </button>
      {reviewing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Voice intake review"
          data-testid="showroom-voice-modal"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
        >
          <div className="flex w-[min(calc(100vw-2rem),28rem)] flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">음성 메모 검토</span>
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                aria-label="cancel"
                data-testid="showroom-voice-cancel"
                className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <textarea
              value={transcript}
              onChange={(e) => onTranscriptChange(e.target.value)}
              disabled={submitting}
              placeholder="(녹음된 텍스트가 비어있습니다)"
              rows={4}
              data-testid="showroom-voice-transcript"
              className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                data-testid="showroom-voice-discard"
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
              >
                버리기
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={submitting || transcript.trim().length === 0}
                data-testid="showroom-voice-confirm"
                className="flex-1 rounded-lg border border-emerald-500 bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="inline-flex items-center gap-1">
                  <Check className="h-3.5 w-3.5" />
                  Intake 저장
                </span>
              </button>
            </div>
            {error && (
              <div role="alert" data-testid="showroom-voice-error" className="text-xs text-red-600 dark:text-red-400">
                {error}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export interface ShowroomVoiceIntakeProps {
  /** Override Speech Recognition constructor (tests). */
  recognitionImpl?: ConstructorParameters<typeof Object>[0] extends never ? never : unknown;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

export function ShowroomVoiceIntake(_props: ShowroomVoiceIntakeProps = {}) {
  const { config } = useDaemon();
  const [phase, setPhase] = useState<'idle' | 'recording' | 'review' | 'submitting'>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<VoiceRecognitionSession | null>(null);
  const [apiAvailable, setApiAvailable] = useState(true);

  // Resolve API availability lazily — SSR-safe.
  useEffect(() => {
    setApiAvailable(resolveSpeechRecognition() !== null);
  }, []);

  const reset = (): void => {
    setPhase('idle');
    setTranscript('');
    setError(null);
    sessionRef.current = null;
  };

  const onPressStart = (): void => {
    if (phase !== 'idle') return;
    setError(null);
    setTranscript('');
    debugLog('showroom.voice.press-start', {});
    const session = startVoiceRecognition({
      lang: 'ko-KR',
      onUpdate: (t) => setTranscript(t),
      onError: (err) => {
        setError(`음성 인식 오류: ${err.code}`);
        debugLog('showroom.voice.recog-error', { code: err.code, message: err.message });
      },
    });
    if (!session) {
      setError('Web Speech API 미사용 — 브라우저가 미지원');
      return;
    }
    sessionRef.current = session;
    setPhase('recording');
  };

  const onPressEnd = (): void => {
    if (phase !== 'recording') return;
    const session = sessionRef.current;
    if (!session) {
      setPhase('idle');
      return;
    }
    debugLog('showroom.voice.press-end', {});
    void session.stop().then((finalText) => {
      setTranscript(finalText);
      if (finalText.trim().length === 0) {
        // Empty capture — silently reset, no review modal.
        reset();
        return;
      }
      setPhase('review');
    });
  };

  const onConfirm = async (): Promise<void> => {
    if (transcript.trim().length === 0) return;
    if (!config.baseUrl) {
      setError(NEXUS_URL_MISSING);
      return;
    }
    setPhase('submitting');
    setError(null);
    debugLog('showroom.voice.submit', { len: transcript.trim().length });
    const result = await postVoiceIntake({
      baseUrl: config.baseUrl,
      ...(config.token ? { token: config.token } : {}),
      transcript,
    });
    if (!result.ok) {
      setError(`intake 실패: ${result.reason}`);
      setPhase('review');
      debugLog('showroom.voice.error', { status: result.status });
      return;
    }
    toast.success(`📥 음성 메모 저장됨 · intake ${result.intakeId || '(id 없음)'}`);
    debugLog('showroom.voice.ok', { intakeId: result.intakeId });
    // β (BACKLOG-pwa-mobile-readiness §6.1 #3 metric · 2026-05-12) — emit
    // utterance signal after backend confirms intake. transcript content
    // 은 MANUAL §4 PII 정책에 따라 length 만 value 로 (default hash).
    // intakeId = target 으로 STT → KGS 변환률 추적.
    void userIntentLogger.emit({
      surface: 'pwa',
      intent: {
        layer: 'utterance',
        kind: 'pwa.utterance.voice_send',
        target: { kind: 'intake', id: result.intakeId ?? '(unknown)' },
        value: { transcriptLen: transcript.trim().length },
      },
      ...(result.intakeId ? { context: { active_workflow_run_id: result.intakeId } } : {}),
    });
    reset();
  };

  return (
    <ShowroomVoiceIntakeView
      phase={phase}
      transcript={transcript}
      onTranscriptChange={setTranscript}
      error={error}
      apiAvailable={apiAvailable}
      onPressStart={onPressStart}
      onPressEnd={onPressEnd}
      onConfirm={() => { void onConfirm(); }}
      onCancel={reset}
    />
  );
}
