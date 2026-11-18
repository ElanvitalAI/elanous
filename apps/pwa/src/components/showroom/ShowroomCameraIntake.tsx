// CV-3 mobile-readiness #4 · Showroom camera intake (Phase 0.5).
//
// Two-layer split (mirrors HitlBanner / IntentPanel β-1a pattern):
//   - <ShowroomCameraIntakeView />  pure presenter · prop-driven
//   - <ShowroomCameraIntake />      container · file picker +
//                                    upload + intake routing
//
// Renders a Camera icon button next to the existing FileAttach
// in ShowroomInput. Tap → native camera (mobile) or file picker
// (desktop) via `<input capture="environment">`. After capture, a
// preview modal asks the user to choose a route: 'Session 첨부'
// (push to the active broadcast batch) or 'Intake 저장' (POST
// /v1/intake with caption — eligible for KGS extraction).
//
// BACKLOG-pwa-mobile-readiness §2.4

'use client';

import { useRef, useState } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { debugLog } from '@/lib/debug';
import { userIntentLogger } from '@/lib/user-intent-logger';
import { uploadCameraIntake } from '@/lib/camera-intake';
import type { AttachmentMeta } from '@/lib/upload-attachment';
import { NEXUS_URL_MISSING } from '@/lib/nexus-url-missing';

export interface ShowroomCameraIntakeViewProps {
  pendingFile: File | null;
  pendingPreviewUrl: string | null;
  caption: string;
  busy: boolean;
  error: string | null;
  onPickFile: () => void;
  onCaptionChange: (next: string) => void;
  onRouteSession: () => void;
  onRouteIntake: () => void;
  onCancel: () => void;
}

export function ShowroomCameraIntakeView(props: ShowroomCameraIntakeViewProps) {
  const {
    pendingFile,
    pendingPreviewUrl,
    caption,
    busy,
    error,
    onPickFile,
    onCaptionChange,
    onRouteSession,
    onRouteIntake,
    onCancel,
  } = props;
  return (
    <>
      <button
        type="button"
        onClick={onPickFile}
        disabled={busy}
        aria-label="attach photo"
        title="attach photo (camera or file)"
        data-testid="showroom-camera-button"
        className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
      </button>
      {pendingFile && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Camera intake"
          data-testid="showroom-camera-modal"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
        >
          <div className="flex w-[min(calc(100vw-2rem),28rem)] flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">사진 첨부</span>
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                aria-label="cancel"
                data-testid="showroom-camera-cancel"
                className="rounded p-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
              >
                ✕
              </button>
            </div>
            {pendingPreviewUrl && (
              <img
                src={pendingPreviewUrl}
                alt="camera capture preview"
                data-testid="showroom-camera-preview"
                className="max-h-72 w-full rounded-md border border-zinc-200 object-contain dark:border-zinc-800"
              />
            )}
            <textarea
              value={caption}
              onChange={(e) => onCaptionChange(e.target.value)}
              disabled={busy}
              placeholder="사진 설명 (선택 · intake 저장 시 KGS 검색 키워드)"
              rows={2}
              data-testid="showroom-camera-caption"
              className="rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onRouteSession}
                disabled={busy}
                data-testid="showroom-camera-route-session"
                className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
              >
                {busy ? '...' : 'Session 첨부'}
              </button>
              <button
                type="button"
                onClick={onRouteIntake}
                disabled={busy}
                data-testid="showroom-camera-route-intake"
                className="flex-1 rounded-lg border border-emerald-500 bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? '...' : 'Intake 저장'}
              </button>
            </div>
            {error && (
              <div role="alert" data-testid="showroom-camera-error" className="text-xs text-red-600 dark:text-red-400">
                {error}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export interface ShowroomCameraIntakeProps {
  /** Caller hands a callback that adds the attachment to the
   *  current broadcast batch when the user picks 'Session 첨부'. */
  onAttachToSession?: (entry: AttachmentMeta) => void;
}

export function ShowroomCameraIntake({ onAttachToSession }: ShowroomCameraIntakeProps) {
  const { config } = useDaemon();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    if (previewUrl) {
      try { URL.revokeObjectURL(previewUrl); } catch { /* ignore */ }
    }
    setPendingFile(null);
    setPreviewUrl(null);
    setCaption('');
    setBusy(false);
    setError(null);
  };

  const onPickFile = (): void => {
    inputRef.current?.click();
  };

  const onFileSelect = (ev: React.ChangeEvent<HTMLInputElement>): void => {
    const file = ev.target.files?.[0];
    ev.target.value = '';  // re-pick same file fires onChange
    if (!file) return;
    debugLog('showroom.camera.pick', {
      filename: file.name,
      size: file.size,
      type: file.type,
    });
    let url: string | null = null;
    try { url = URL.createObjectURL(file); } catch { /* SSR / no DOM */ }
    setPendingFile(file);
    setPreviewUrl(url);
    setCaption('');
    setError(null);
  };

  const submit = async (route: 'session' | 'intake'): Promise<void> => {
    if (!pendingFile) return;
    if (!config.baseUrl) {
      setError(NEXUS_URL_MISSING);
      return;
    }
    setBusy(true);
    setError(null);
    debugLog('showroom.camera.submit', { route, hasCaption: caption.trim().length > 0 });
    const result = await uploadCameraIntake({
      baseUrl: config.baseUrl,
      ...(config.token ? { token: config.token } : {}),
      file: pendingFile,
      ...(caption.trim() ? { caption } : {}),
      route: { kind: route },
    });
    if (!result.ok) {
      setError(`${result.stage} 실패: ${result.reason}`);
      setBusy(false);
      debugLog('showroom.camera.error', { stage: result.stage, status: result.status });
      return;
    }
    if (result.route === 'session') {
      onAttachToSession?.(result.meta);
      toast.success(`📎 ${result.meta.filename} (${(result.meta.size / 1024).toFixed(1)} kB) · session 첨부됨`);
    } else {
      toast.success(`📥 사진 저장됨 · intake ${result.intakeId || '(id 없음)'}`);
    }
    debugLog('showroom.camera.ok', { route: result.route, id: result.meta.id });
    // β (BACKLOG-pwa-mobile-readiness §6.1 #4 metric · 2026-05-12) — emit
    // gesture signal after upload OK. route 분기 (session vs intake) +
    // caption 유무가 카메라 KGS hit-rate 의 conditioning feature.
    void userIntentLogger.emit({
      surface: 'pwa',
      intent: {
        layer: 'gesture',
        kind: result.route === 'session'
          ? 'pwa.gesture.camera_attach_session'
          : 'pwa.gesture.camera_intake_save',
        target: { kind: 'attachment', id: result.meta.id, label: result.meta.filename },
        value: {
          route: result.route,
          hasCaption: caption.trim().length > 0,
          sizeKb: Math.round(result.meta.size / 1024),
        },
      },
      ...(result.route === 'intake' && result.intakeId
        ? { context: { active_workflow_run_id: result.intakeId } }
        : {}),
    });
    reset();
  };

  return (
    <>
      <ShowroomCameraIntakeView
        pendingFile={pendingFile}
        pendingPreviewUrl={previewUrl}
        caption={caption}
        busy={busy}
        error={error}
        onPickFile={onPickFile}
        onCaptionChange={setCaption}
        onRouteSession={() => { void submit('session'); }}
        onRouteIntake={() => { void submit('intake'); }}
        onCancel={reset}
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onFileSelect}
        data-testid="showroom-camera-input"
      />
    </>
  );
}
