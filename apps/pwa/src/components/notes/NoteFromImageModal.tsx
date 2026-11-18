'use client';

// R-OCR.2.2 (2026-05-09) — review modal for the camera → OCR →
// markdown note flow.
//
// Phase machine (single source of truth):
//   idle    — modal closed (or no image yet)
//   ocr     — POST /v1/notes/from-image in flight · spinner UI
//   review  — markdown editable · polishMode toggle · Save / Cancel
//   saving  — POST /v1/notes/save in flight · spinner UI
//   saved   — terminal · toast + auto-close
//   error   — terminal · message + Retry / Close
//
// Owners:
//   - The PARENT (e.g., SaveAsNoteButton) picks the image and toggles
//     `open=true` — this modal handles every transition after that.
//   - On Cancel / Close, the modal calls `onClose()` and resets local
//     state so the next open starts clean. The image blob lives in
//     props so the parent decides when to discard.
//
// Cross-ref:
//   src/nexus/api/notes-from-image.ts (R-OCR.1 endpoint)
//   src/nexus/api/notes-save.ts (R-OCR.3 endpoint)
//   내부 문서 `ROADMAP-pwa-pre-ios-gap-2026-05-09` §R-OCR.2

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { debugLog } from '@/lib/debug';
import { loadOcrPrefs } from '@/lib/ocr-prefs';
import { NEXUS_URL_MISSING, NEXUS_URL_MISSING_SHORT } from '@/lib/nexus-url-missing';

export type NoteFromImagePhase =
  | 'idle' | 'ocr' | 'review' | 'saving' | 'saved' | 'error';

export type NotePolishMode = 'minimal' | 'enrich';

interface OcrResponse {
  ok: true;
  markdown: string;
  provider: string;
  polishMode: NotePolishMode;
  usedLlmPolish: boolean;
  costEstimate: { ocrUsd: number; polishUsd: number };
}

interface SaveResponse {
  ok: true;
  knowledgeId: string;
  vaultLabel: string;
  savedAt: string;
}

interface Props {
  open: boolean;
  /** Image blob to OCR + save. When null while open=true, the modal
   *  shows the empty state (parent forgot to pass — defensive). */
  image: Blob | null;
  /** Filename hint forwarded to the OCR endpoint (Upstage uses the
   *  extension to pick a parser). Defaults to 'photo.jpg'. */
  filename?: string;
  onClose: () => void;
}

export function NoteFromImageModal({
  open,
  image,
  filename = 'photo.jpg',
  onClose,
}: Props) {
  const { config } = useDaemon();
  const [phase, setPhase] = useState<NoteFromImagePhase>('idle');
  const [markdown, setMarkdown] = useState<string>('');
  // Selected = the dropdown state (what the user wants to apply).
  // Applied = what actually ran on the current `markdown` content,
  // derived from the server's `usedLlmPolish` flag. The save POST
  // forwards APPLIED, not selected, so the saved frontmatter doesn't
  // claim 'enrich' when the LLM polish callable wasn't wired and the
  // server silently degraded to minimal (R-OCR.1.4 truth-in-metadata).
  const [polishMode, setPolishMode] = useState<NotePolishMode>('minimal');
  const [appliedPolishMode, setAppliedPolishMode] = useState<NotePolishMode>('minimal');
  // R-OCR.5 (2026-05-09) — when on, the OCR request adds
  // `strengths=context-aware,diagrams` so the registry picks the
  // LLM Vision provider over Upstage. Server logs the actual provider
  // chosen; we surface it via `provider` below.
  // Phase B (2026-05-09) — initial state read from OcrPrefs (Settings
  // card). loadOcrPrefs is SSR-safe (returns defaults outside browser).
  const initialPrefs = loadOcrPrefs();
  const [useLlmVision, setUseLlmVision] = useState<boolean>(initialPrefs.defaultUseLlmVision);
  // R-OCR follow-up (2026-05-09) — 손글씨 우선시 strength. Both
  // Upstage + LLM Vision declare 'handwriting' as a strength; the
  // registry's match scoring boosts whichever already qualifies for
  // the rest of the requirements (image input · markdown output ·
  // korean). Independent of the LLM Vision toggle — handwriting
  // photos benefit from the boost regardless of which provider runs.
  const [preferHandwriting, setPreferHandwriting] = useState<boolean>(initialPrefs.defaultPreferHandwriting);
  const [provider, setProvider] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  // Track whether the user edited the markdown vs. the OCR raw — used
  // for R-OCR.4 metric input (polish edit rate). Local-only for now;
  // the metric collector reads it via a debug event when wired.
  const [originalMarkdown, setOriginalMarkdown] = useState<string>('');

  // Reset state when the modal closes (parent flipped open=false) so
  // a re-open starts from idle.
  useEffect(() => {
    if (!open) {
      setPhase('idle');
      setMarkdown('');
      setOriginalMarkdown('');
      setProvider('');
      setErrorMsg('');
      setPolishMode('minimal');
      setAppliedPolishMode('minimal');
      // Reset to user's saved prefs default · NOT hard-coded false.
      // Reading prefs on each close keeps the modal in sync with
      // Settings changes that landed mid-session.
      const fresh = loadOcrPrefs();
      setUseLlmVision(fresh.defaultUseLlmVision);
      setPreferHandwriting(fresh.defaultPreferHandwriting);
    }
  }, [open]);

  // Kick OCR when the modal opens with an image. The fetch call is
  // wrapped here (not in the click handler) so re-open with a fresh
  // image always re-runs OCR — important for the polishMode change
  // re-OCR flow below.
  useEffect(() => {
    if (!open || !image) return;
    if (phase !== 'idle') return;
    void runOcr(polishMode);
    // We want this effect to run exactly once per "open with image"
    // transition. polishMode changes are handled by the explicit Re-OCR
    // button, not this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, image]);

  async function runOcr(
    mode: NotePolishMode,
    vision: boolean = useLlmVision,
    handwriting: boolean = preferHandwriting,
  ): Promise<void> {
    if (!image) return;
    if (!config.baseUrl) {
      setErrorMsg(NEXUS_URL_MISSING);
      setPhase('error');
      return;
    }
    setPhase('ocr');
    setErrorMsg('');
    const form = new FormData();
    form.append('image', image, filename);
    form.append('polishMode', mode);
    // R-OCR.5 — LLM Vision toggle. When on, we add capability strengths
    // that match LLMVisionProvider's declared strengths so the registry
    // pick scoring favors it over Upstage.
    // R-OCR follow-up — 손글씨 toggle independently appends 'handwriting'
    // (both Upstage + LLM Vision declare it). Combined with vision,
    // both sets land in one comma-separated value.
    const strengthList: string[] = [];
    if (vision) strengthList.push('context-aware', 'diagrams');
    if (handwriting) strengthList.push('handwriting');
    if (strengthList.length > 0) {
      form.append('strengths', strengthList.join(','));
    }
    debugLog('notes.ocr.start', { polishMode: mode, vision, handwriting, filename, size: image.size });
    try {
      const res = await fetch(`${config.baseUrl}/v1/notes/from-image`, {
        method: 'POST',
        body: form,
        ...(config.token ? { headers: { authorization: `Bearer ${config.token}` } } : {}),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        setErrorMsg(`OCR 실패 (HTTP ${res.status}) ${detail.slice(0, 160)}`);
        setPhase('error');
        debugLog('notes.ocr.error', { status: res.status, detail: detail.slice(0, 200) });
        return;
      }
      const body = (await res.json()) as OcrResponse;
      // Truth-in-metadata: applied = the mode that ACTUALLY ran. When
      // the server's polish callable isn't wired, an `enrich` request
      // silently degrades to minimal raw OCR (`usedLlmPolish: false`).
      // Tracking applied separately from selected stops Save from
      // writing a misleading `polishMode: enrich` frontmatter on
      // content that's actually raw Upstage output.
      const applied: NotePolishMode = body.usedLlmPolish ? body.polishMode : 'minimal';
      // 2026-05-09 dogfood — empty markdown = OCR ran but nothing
      // recognized (blank image · no text · low quality).
      if (body.markdown.trim().length === 0) {
        setErrorMsg(
          body.usedLlmPolish
            ? '이미지에서 텍스트를 추출하지 못했습니다. 다른 사진으로 다시 시도해주세요.'
            : '이미지에서 텍스트를 추출하지 못했습니다. 다른 사진을 사용하거나 polishMode를 \'enrich\'로 바꾸어 LLM polish를 시도해주세요.',
        );
        setPolishMode(body.polishMode);
        setAppliedPolishMode(applied);
        setProvider(body.provider);
        setPhase('error');
        debugLog('notes.ocr.empty', {
          provider: body.provider,
          requested: mode,
          applied,
          usedLlmPolish: body.usedLlmPolish,
        });
        return;
      }
      setMarkdown(body.markdown);
      setOriginalMarkdown(body.markdown);
      setProvider(body.provider);
      setPolishMode(body.polishMode);
      setAppliedPolishMode(applied);
      setPhase('review');
      debugLog('notes.ocr.ok', {
        provider: body.provider,
        requested: mode,
        applied,
        usedLlmPolish: body.usedLlmPolish,
        chars: body.markdown.length,
      });
    } catch (e) {
      setErrorMsg(`OCR 실패: ${String(e instanceof Error ? e.message : e)}`);
      setPhase('error');
      debugLog('notes.ocr.exception', { reason: String(e) });
    }
  }

  async function runSave(): Promise<void> {
    if (!config.baseUrl) {
      setErrorMsg(NEXUS_URL_MISSING_SHORT);
      setPhase('error');
      return;
    }
    const edited = markdown !== originalMarkdown;
    setPhase('saving');
    debugLog('notes.save.start', {
      provider,
      selectedPolishMode: polishMode,
      appliedPolishMode,
      edited,
      chars: markdown.length,
    });
    // Saved-after-edit event so R-OCR.4 can compute the polish edit
    // rate (edits / saves). Fire-and-forget · failure is inert.
    if (edited) postMetricEvent('edit');
    try {
      const res = await fetch(`${config.baseUrl}/v1/notes/save`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({
          markdown,
          sourceProvider: provider,
          // appliedPolishMode (not the dropdown state) so the saved
          // frontmatter reflects what actually ran on this content.
          polishMode: appliedPolishMode,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        setErrorMsg(`저장 실패 (HTTP ${res.status}) ${detail.slice(0, 160)}`);
        setPhase('error');
        debugLog('notes.save.error', { status: res.status, detail: detail.slice(0, 200) });
        return;
      }
      const body = (await res.json()) as SaveResponse;
      setPhase('saved');
      toast.success(`📝 저장됨 — ${body.vaultLabel} · ${body.knowledgeId}`);
      debugLog('notes.save.ok', { knowledgeId: body.knowledgeId, vaultLabel: body.vaultLabel });
      // Auto-close after a short visual confirmation so the dock
      // returns to idle quickly. Caller can re-open immediately.
      setTimeout(onClose, 400);
    } catch (e) {
      setErrorMsg(`저장 실패: ${String(e instanceof Error ? e.message : e)}`);
      setPhase('error');
      debugLog('notes.save.exception', { reason: String(e) });
    }
  }

  /** R-OCR.4 metric event POST — fire-and-forget. Server can't see
   *  cancel/edit/discard, so the modal forwards them. We do NOT await
   *  the response because failure is inert (the snapshot just won't
   *  reflect this event; the user-facing flow is unaffected). */
  function postMetricEvent(type: 'cancel' | 'edit' | 'discard'): void {
    if (!config.baseUrl) return;
    void fetch(`${config.baseUrl}/v1/metrics/notes-event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ type, polishMode }),
    }).catch(() => { /* swallow — metric loss is not user-visible */ });
  }

  function onCancel(): void {
    const edited = markdown !== originalMarkdown;
    debugLog('notes.cancel', {
      phase,
      edited,
      chars: markdown.length,
    });
    // Two distinct events: 'cancel' = user closed pre-save (incl.
    // mid-OCR aborts); 'discard' = additionally fired when the user
    // edited but threw the result away (signal for R-OCR.4 polish
    // edit rate v.s. discard-after-edit rate).
    postMetricEvent('cancel');
    if (edited && phase === 'review') {
      postMetricEvent('discard');
    }
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>사진 → 마크다운 노트</DialogTitle>
          <DialogDescription>
            OCR 로 추출한 본문을 검토 + 편집 후 저장합니다.
          </DialogDescription>
        </DialogHeader>

        {phase === 'ocr' && (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>OCR 인식 중…</span>
          </div>
        )}

        {phase === 'saving' && (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>저장 중…</span>
          </div>
        )}

        {phase === 'saved' && (
          <div className="flex items-center justify-center py-12 text-emerald-600">
            ✓ 저장 완료
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-3 py-4">
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {errorMsg}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onCancel}>닫기</Button>
              {image && (
                <Button onClick={() => runOcr(polishMode)}>다시 시도</Button>
              )}
            </div>
          </div>
        )}

        {phase === 'review' && (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>provider: <code>{provider || '?'}</code></span>
                <span>·</span>
                <label className="flex items-center gap-1">
                  polish:
                  <select
                    value={polishMode}
                    onChange={(e) => {
                      const next = e.target.value as NotePolishMode;
                      setPolishMode(next);
                      // Auto Re-OCR on dropdown change so the markdown
                      // reflects the requested mode without an extra
                      // user click. Skips when next === appliedPolishMode
                      // (already up to date).
                      if (next !== appliedPolishMode) void runOcr(next);
                    }}
                    className="rounded border border-input bg-background px-1 py-0.5"
                    aria-label="polish mode"
                  >
                    <option value="minimal">minimal (raw)</option>
                    <option value="enrich">enrich (polished)</option>
                  </select>
                </label>
                <span>·</span>
                {/* R-OCR.5 — LLM Vision toggle. Auto Re-OCR on flip
                    so the user sees the new provider's output without
                    an extra click. */}
                <label className="flex items-center gap-1" title="LLM 비전 우선시 — 더 정확하지만 느림 + 비쌈">
                  <input
                    type="checkbox"
                    checked={useLlmVision}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setUseLlmVision(next);
                      void runOcr(polishMode, next, preferHandwriting);
                    }}
                    aria-label="prefer LLM vision"
                  />
                  LLM 비전
                </label>
                <span>·</span>
                {/* R-OCR follow-up — 손글씨 strength toggle. Independent
                    of LLM Vision; both sets land in the same `strengths`
                    field. The registry boosts a provider's score per
                    matching strength so handwriting + LLM-Vision
                    combined picks LLMVisionProvider strongly. */}
                <label className="flex items-center gap-1" title="손글씨 우선시 — handwriting strength 추가 (registry 점수 boost)">
                  <input
                    type="checkbox"
                    checked={preferHandwriting}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setPreferHandwriting(next);
                      void runOcr(polishMode, useLlmVision, next);
                    }}
                    aria-label="prefer handwriting"
                  />
                  손글씨
                </label>
                <span>·</span>
                {/* Truth indicator: shows what actually ran on the
                    current markdown. Diverges from the dropdown when
                    enrich was requested but the polish callable wasn't
                    wired (server degraded silently). */}
                <span data-testid="notes-applied-polish">
                  applied: <code>{appliedPolishMode}</code>
                  {polishMode === 'enrich' && appliedPolishMode === 'minimal' && (
                    <span className="ml-1 text-amber-600">(LLM polish 비활성)</span>
                  )}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-xs"
                  onClick={() => runOcr(polishMode)}
                  aria-label="re-run OCR"
                >
                  Re-OCR
                </Button>
              </div>
              <textarea
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                rows={12}
                placeholder="markdown 본문…"
                aria-label="markdown editor"
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onCancel}>취소</Button>
              <Button
                onClick={() => void runSave()}
                disabled={markdown.trim().length === 0}
              >
                저장
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
