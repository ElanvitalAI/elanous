'use client';

// I7 (2026-05-12) — "New from memo" PWA entry surface.
//
// Wires raw memo dump → `POST /v1/intake/pipeline-preview` (FU3 skeleton
// fallback) → per-task swipe deck → "Approve all & register" which
// re-submits with `register: true`. The endpoint runs the full Phase 1
// pipeline (decompose → enrich → categorize → goal_align → multi_spec)
// against an in-memory TaskStore so the user can dogfood the wire
// end-to-end without touching their TOX.
//
// UX (D-I7 A/A/A/A · 2026-05-12):
//   - Mobile-first 1-column swipe deck (mirrors `/sessions` R5.4).
//   - Swipe ←/→/↑/↓ = reject / approve / defer / expand-modal.
//   - Always-confirm: register only fires from explicit "Approve all"
//     button (or one-click 1-tap shortcut). RESEARCH §3 D2.
//   - Skeleton endpoint mode: real LLM/plugin wire lands in FU-I7a/b.
//     Selective register is FU-I7c — for now `register=true` registers
//     every task the pipeline produced (skeleton fallback = 1 task).
//
// Cross-ref:
//   apps/pwa/src/components/intake/MemoIntakeCard.tsx (per-card render)
//   apps/pwa/src/lib/intake-pipeline-api.ts (FU3 endpoint wrapper)
//   apps/pwa/src/lib/swipe-gesture.ts (attachSwipe4)
//   내부 문서
//   내부 문서 `RESEARCH-intake-auto-task-graph-2026-05-11` §4.7

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useDaemon } from '@/components/providers/DaemonProvider';
import { Button } from '@/components/ui/button';
import { debugLog } from '@/lib/debug';
import { attachSwipe4, type SwipeDirection4 } from '@/lib/swipe-gesture';
import {
  IntakePipelineApi,
  flattenToCards,
  type MemoCard,
  type PipelinePreviewResponse,
} from '@/lib/intake-pipeline-api';
import { userIntentLogger } from '@/lib/user-intent-logger';
import { MemoIntakeCard, type CardVerdict } from './MemoIntakeCard';

// FU8 PR #2 (2026-05-12) — fire-and-forget toggle change intent emit.
// Mirrors the reference 3-sink pattern landed in FU8 PR #1 (D8.2 +
// M4-4.2 + M4-6.2): every user-facing selection boundary should
// surface a `userIntentLogger.emit({ ... })` call so Patcher /
// Thinker / dashboards see the choice. PWA-side this is a fetch to
// `/v1/user-intents/emit` — the server then fans into signal-bus
// + JSONL sink + OTel.
function emitToggleChange(toggleId: string, from: boolean, to: boolean, intakeId?: string): void {
  void userIntentLogger.emit({
    surface: 'pwa',
    intent: {
      layer: 'selection',
      kind: 'pwa.selection.toggle_change',
      target: { kind: 'toggle', id: toggleId },
      value: { from, to },
    },
    ...(intakeId ? { context: { active_workflow_run_id: intakeId } } : {}),
  });
}

const PHOTO_ACCEPT = 'image/*';
const PHOTO_FILENAME_FALLBACK = 'memo-photo.jpg';

type SwipeDecision = 'reject' | 'approve' | 'defer' | 'expand';

const DIRECTION_TO_DECISION: Record<SwipeDirection4, SwipeDecision> = {
  left: 'reject',
  right: 'approve',
  up: 'defer',
  down: 'expand',
};

const KEY_TO_DECISION: Record<string, SwipeDecision> = {
  ArrowLeft: 'reject',
  ArrowRight: 'approve',
  ArrowUp: 'defer',
  ArrowDown: 'expand',
  ' ': 'approve',
};

const DECISION_TO_VERDICT: Record<Exclude<SwipeDecision, 'expand'>, CardVerdict> = {
  reject: 'rejected',
  approve: 'approved',
  defer: 'deferred',
};

const PLACEHOLDER =
  '- 스크린 레코딩 능력 흡수\n     https://github.com/siddharthvaddem/openscreen\n- 이미지 바로 보기 안 되는 이유 분석\n\n==== 다이어그램 강화 ====\n위젯 surface · Mermaid · DrawIO repo 확인';

export function MemoIntakePreview({
  initialMemo,
  onClose,
}: {
  initialMemo?: string;
  onClose?: () => void;
} = {}) {
  const { client } = useDaemon();
  const api = useMemo(() => new IntakePipelineApi(client), [client]);

  const [rawText, setRawText] = useState(initialMemo ?? '');
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<PipelinePreviewResponse | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, CardVerdict>>({});
  const [topIndex, setTopIndex] = useState(0);
  const [expanded, setExpanded] = useState<MemoCard | null>(null);
  const [registered, setRegistered] = useState<{ missions: number; tasks: number; skipped: number } | null>(null);
  // FU-I7e — refinement nudge surface.
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineHint, setRefineHint] = useState('');
  // FU-I7f — photo OCR intake.
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  // FU-I7a — real LLM toggle. Default off so first dogfood matches
  // the skeleton walkthrough; users flip on to test real decomposition
  // (requires a configured LLM host in ~/.elanous/config.json).
  const [useRealLlm, setUseRealLlm] = useState(false);
  // FU-I7c — real-register toggle. Default off — the in-memory store
  // path keeps the cards UI safe for first dogfood. Flipping on routes
  // Register to /v1/intake/pipeline-commit which writes to the user's
  // real ~/.elanous/tasks/tasks.db + persists workflow YAMLs.
  const [commitToTox, setCommitToTox] = useState(false);
  // FU-I7b — enrich plugin toggle. Default off — the I2 phase emits
  // per-row "no plugin" diagnostics. Flipping on activates the URL
  // fetch + gh repo view plugins (keyword still stub). Independent of
  // LLM toggle so the user can dogfood enrichment alone.
  const [useRealEnrich, setUseRealEnrich] = useState(false);

  const cards = useMemo(
    () => (response ? flattenToCards(response.decomposition.missions) : []),
    [response],
  );

  // FU-I7d — derive per-verdict tallies + the whitelist that goes to
  // the endpoint on commit. "approved" goes in; "rejected" / "deferred"
  // stay out; "pending" cards are treated as approved iff the user
  // never swiped anything (the "express" path = first-time submit).
  const tallies = useMemo(() => {
    const t = { approved: 0, rejected: 0, deferred: 0, pending: 0 };
    for (const card of cards) {
      const v = verdicts[card.task.taskKey] ?? 'pending';
      t[v] += 1;
    }
    return t;
  }, [cards, verdicts]);
  const anySwiped = tallies.approved + tallies.rejected + tallies.deferred > 0;
  const approvedTaskKeys = useMemo(
    () => cards.filter((c) => verdicts[c.task.taskKey] === 'approved').map((c) => c.task.taskKey),
    [cards, verdicts],
  );

  const reset = useCallback((): void => {
    setResponse(null);
    setVerdicts({});
    setTopIndex(0);
    setExpanded(null);
    setRegistered(null);
    setRefineOpen(false);
    setRefineHint('');
    onClose?.();
  }, [onClose]);

  const handlePhotoPick = useCallback((): void => {
    photoInputRef.current?.click();
  }, []);

  const handlePhotoChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = e.target.files?.[0];
      // Reset the input so picking the same file twice still fires
      // onChange (browsers suppress repeated picks otherwise).
      e.target.value = '';
      if (!file) return;
      debugLog('intake.memo-preview.photo.pick', {
        name: file.name, size: file.size, type: file.type,
      });
      setOcrBusy(true);
      try {
        const res = await api.submitPhotoOcr(file, file.name || PHOTO_FILENAME_FALLBACK);
        const ocrText = (res.markdown ?? '').trim();
        if (!ocrText) {
          toast.error('OCR 결과가 비어 있습니다 — 사진을 다시 찍거나 다른 이미지를 선택하세요.');
          return;
        }
        setRawText((prev) => {
          if (!prev.trim()) return ocrText;
          return `${ocrText}\n\n---\n\n${prev}`;
        });
        toast.success(`OCR 추가됨 (provider=${res.provider} · ${ocrText.length}자) — 수정 후 Run preview 누르세요.`);
      } catch (err) {
        toast.error(`OCR 실패: ${err instanceof Error ? err.message : err}`);
        debugLog('intake.memo-preview.photo.error', { err: String(err) });
      } finally {
        setOcrBusy(false);
      }
    },
    [api],
  );

  const handleRefine = useCallback(async (): Promise<void> => {
    const trimmedMemo = rawText.trim();
    const trimmedHint = refineHint.trim();
    if (!trimmedMemo || !trimmedHint || !response) return;
    debugLog('intake.memo-preview.refine', { hintLen: trimmedHint.length, useRealLlm });
    setBusy(true);
    setExpanded(null);
    setRegistered(null);
    try {
      const res = await api.preview({
        rawText: trimmedMemo,
        refinementHint: trimmedHint,
        priorDecomposition: { missions: response.decomposition.missions },
        ...(useRealLlm ? { useRealLlm: true } : {}),
        ...(useRealEnrich ? { useRealEnrich: true } : {}),
      });
      setResponse(res);
      // Refinement spawns a new decomposition with fresh mission/task
      // ids — wipe verdicts so the user re-decides on the new cards.
      setVerdicts({});
      setTopIndex(0);
      setRefineHint('');
      setRefineOpen(false);
    } catch (err) {
      toast.error(`refine failed: ${err instanceof Error ? err.message : err}`);
      debugLog('intake.memo-preview.refine.error', { err: String(err) });
    } finally {
      setBusy(false);
    }
  }, [api, rawText, refineHint, response, useRealLlm, useRealEnrich]);

  const handleSubmit = useCallback(async (): Promise<void> => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    debugLog('intake.memo-preview.submit', { length: trimmed.length, useRealLlm, useRealEnrich });
    setBusy(true);
    setExpanded(null);
    setRegistered(null);
    try {
      const res = await api.preview({
        rawText: trimmed,
        ...(useRealLlm ? { useRealLlm: true } : {}),
        ...(useRealEnrich ? { useRealEnrich: true } : {}),
      });
      setResponse(res);
      setVerdicts({});
      setTopIndex(0);
    } catch (err) {
      toast.error(`pipeline preview failed: ${err instanceof Error ? err.message : err}`);
      debugLog('intake.memo-preview.error', { err: String(err) });
    } finally {
      setBusy(false);
    }
  }, [api, rawText, useRealLlm, useRealEnrich]);

  const dispatchDecision = useCallback(
    (decision: SwipeDecision): void => {
      if (!cards.length || topIndex >= cards.length) return;
      const card = cards[topIndex]!;
      debugLog('intake.memo-preview.decision', {
        taskKey: card.task.taskKey, decision,
      });
      if (decision === 'expand') {
        setExpanded(card);
        return;
      }
      setVerdicts((prev) => ({ ...prev, [card.task.taskKey]: DECISION_TO_VERDICT[decision] }));
      setTopIndex((idx) => Math.min(idx + 1, cards.length));
    },
    [cards, topIndex],
  );

  const approveAllPending = useCallback((): void => {
    if (!cards.length) return;
    debugLog('intake.memo-preview.approve-all-pending', { count: tallies.pending });
    setVerdicts((prev) => {
      const next = { ...prev };
      for (const card of cards) {
        if ((next[card.task.taskKey] ?? 'pending') === 'pending') {
          next[card.task.taskKey] = 'approved';
        }
      }
      return next;
    });
  }, [cards, tallies.pending]);

  const handleRegister = useCallback(async (): Promise<void> => {
    const trimmed = rawText.trim();
    if (!trimmed) return;
    // FU-I7d express path — when the user hasn't swiped anything yet,
    // omit includeTaskKeys so the endpoint commits every task (the
    // pre-FU default). Otherwise honour the per-card verdict by
    // sending only the approved set.
    const includeTaskKeys = anySwiped ? approvedTaskKeys : undefined;
    if (anySwiped && approvedTaskKeys.length === 0) {
      toast.error('승인된 카드가 없습니다 — 카드를 → 스와이프해서 승인하세요.');
      return;
    }
    debugLog('intake.memo-preview.register.submit', {
      length: trimmed.length,
      mode: anySwiped ? 'selective' : 'express',
      includeCount: includeTaskKeys?.length ?? null,
      useRealLlm,
      commitToTox,
    });
    setBusy(true);
    try {
      // FU-I7c — when commitToTox is on, hit the new endpoint that
      // writes to the user's real ~/.elanous/tasks/tasks.db; otherwise
      // continue using preview-with-register against the in-memory
      // store. The two endpoints return the same shape.
      const reqBody = {
        rawText: trimmed,
        ...(includeTaskKeys ? { includeTaskKeys } : {}),
        ...(useRealLlm ? { useRealLlm: true } : {}),
        ...(useRealEnrich ? { useRealEnrich: true } : {}),
      };
      const res = commitToTox
        ? await api.commit(reqBody)
        : await api.preview({ ...reqBody, register: true });
      setResponse(res);
      const reg = res.register;
      if (reg) {
        const skipped = reg.skippedTaskKeys?.length ?? 0;
        setRegistered({ missions: reg.missionIds.length, tasks: reg.taskIds.length, skipped });
        const skippedSuffix = skipped > 0 ? ` · ${skipped} skipped` : '';
        const destLabel = commitToTox ? '~/.elanous/tasks/tasks.db' : 'in-memory';
        toast.success(`registered ${reg.missionIds.length} mission${reg.missionIds.length === 1 ? '' : 's'} · ${reg.taskIds.length} task${reg.taskIds.length === 1 ? '' : 's'} (${destLabel})${skippedSuffix}`);
      } else {
        toast.error('register skipped — endpoint returned no register payload');
      }
    } catch (err) {
      toast.error(`register failed: ${err instanceof Error ? err.message : err}`);
      debugLog('intake.memo-preview.register.error', { err: String(err) });
    } finally {
      setBusy(false);
    }
  }, [api, rawText, anySwiped, approvedTaskKeys, useRealLlm, commitToTox, useRealEnrich]);

  return (
    <section className="mx-auto flex max-w-md flex-col gap-4 p-4" data-testid="memo-intake-preview">
      <header className="space-y-1">
        <h2 className="font-heading text-lg font-medium">New from memo</h2>
        <p className="text-xs text-muted-foreground">
          Raw memo dump → 자동 task graph. ←/→/↑/↓ swipe = 거절/승인/잠시 멈춤/펼치기.
        </p>
        {/* FU8 PR #2 (2026-05-12) — affirmative toggle labels. The
            label text is constant ("Enable …") regardless of state;
            checked state is communicated by the `strong` colour
            emphasis + the descriptive sentence after the em-dash.
            Every change emits a `pwa.selection.toggle_change` intent
            so dashboards see the dogfood signal. */}
        <label
          data-testid="memo-intake-llm-toggle"
          className="flex items-center gap-2 text-[10px] text-muted-foreground"
        >
          <input
            type="checkbox"
            checked={useRealLlm}
            onChange={(e) => {
              const next = e.target.checked;
              emitToggleChange('use-real-llm', useRealLlm, next, response?.intakeId);
              setUseRealLlm(next);
            }}
            disabled={busy || ocrBusy}
            data-testid="memo-intake-llm-toggle-input"
          />
          <span>
            <strong className={useRealLlm ? 'text-foreground' : ''}>Enable Real LLM</strong>
            {' '}
            — {useRealLlm
              ? '실 streamLLM 호출 (provider 는 ~/.elanous/config.json · user-config 우선)'
              : 'LLM 미호출 · skeleton fallback · pipeline 흐름 + cards 렌더만 검증'}
          </span>
        </label>
        <label
          data-testid="memo-intake-enrich-toggle"
          className="flex items-center gap-2 text-[10px] text-muted-foreground"
        >
          <input
            type="checkbox"
            checked={useRealEnrich}
            onChange={(e) => {
              const next = e.target.checked;
              emitToggleChange('use-real-enrich', useRealEnrich, next, response?.intakeId);
              setUseRealEnrich(next);
            }}
            disabled={busy || ocrBusy}
            data-testid="memo-intake-enrich-toggle-input"
          />
          <span>
            <strong className={useRealEnrich ? 'text-foreground' : ''}>Enable Real enrich</strong>
            {' '}
            — {useRealEnrich
              ? 'URL fetch + gh repo view 호출 (keyword crawl 은 stub · FU-I7b.2)'
              : '모든 enrichment 가 per-row "no plugin" diag · 외부 HTTP 호출 0'}
          </span>
        </label>
        <label
          data-testid="memo-intake-commit-toggle"
          className="flex items-center gap-2 text-[10px] text-muted-foreground"
        >
          <input
            type="checkbox"
            checked={commitToTox}
            onChange={(e) => {
              const next = e.target.checked;
              emitToggleChange('commit-to-tox', commitToTox, next, response?.intakeId);
              setCommitToTox(next);
            }}
            disabled={busy || ocrBusy}
            data-testid="memo-intake-commit-toggle-input"
          />
          <span>
            <strong className={commitToTox ? 'text-rose-700 dark:text-rose-400' : ''}>Commit to real TOX</strong>
            {' '}
            — {commitToTox
              ? 'Register 가 ~/.elanous/tasks/tasks.db 에 실 mission/task 쓰기 + workflow YAML 디스크 저장 (되돌릴 수 없음)'
              : 'Register 가 in-memory store 만 사용 · 사용자 TOX 미터치'}
          </span>
        </label>
      </header>

      <textarea
        value={rawText}
        onChange={(e) => setRawText(e.target.value)}
        placeholder={PLACEHOLDER}
        rows={6}
        disabled={busy}
        data-testid="memo-intake-textarea"
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={busy || ocrBusy || !rawText.trim()}
          data-testid="memo-intake-submit"
        >
          {busy && !response ? 'Running…' : 'Run preview'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={handlePhotoPick}
          disabled={busy || ocrBusy}
          data-testid="memo-intake-photo"
          aria-label="upload photo for OCR"
          title="사진 / 화이트보드 / post-it → OCR → memo"
        >
          {ocrBusy ? '⏳ OCR…' : '📷 Photo'}
        </Button>
        <input
          ref={photoInputRef}
          type="file"
          accept={PHOTO_ACCEPT}
          capture="environment"
          className="hidden"
          data-testid="memo-intake-photo-input"
          onChange={(e) => void handlePhotoChange(e)}
        />
        {response && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={reset}
            disabled={busy}
            data-testid="memo-intake-reset"
          >
            Reset
          </Button>
        )}
      </div>

      {response && (
        <PipelineSummary res={response} registered={registered} />
      )}

      {response && registered === null && (
        <RefineBlock
          open={refineOpen}
          hint={refineHint}
          busy={busy}
          onToggle={() => setRefineOpen((v) => !v)}
          onHintChange={setRefineHint}
          onSubmit={() => void handleRefine()}
        />
      )}

      {response && cards.length > 0 && (
        <MemoCardDeck
          cards={cards}
          verdicts={verdicts}
          topIndex={topIndex}
          onSwipe={dispatchDecision}
        />
      )}

      {response && cards.length > 0 && (
        <VerdictTallyRow tallies={tallies} total={cards.length} />
      )}

      {response && cards.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={approveAllPending}
            disabled={busy || tallies.pending === 0 || registered !== null}
            data-testid="memo-intake-approve-pending"
          >
            {`Approve all pending (${tallies.pending})`}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleRegister()}
            disabled={busy || registered !== null || (anySwiped && approvedTaskKeys.length === 0)}
            data-testid="memo-intake-register"
          >
            {registered
              ? `Registered ✓ (${registered.tasks} tasks)`
              : busy
                ? 'Registering…'
                : anySwiped
                  ? `Register approved (${approvedTaskKeys.length})`
                  : `Register all (${cards.length})`}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            {`${topIndex} / ${cards.length} reviewed`}
          </span>
        </div>
      )}

      {expanded && <ExpandModal card={expanded} onClose={() => setExpanded(null)} />}
    </section>
  );
}

interface SummaryProps {
  res: PipelinePreviewResponse;
  registered: { missions: number; tasks: number; skipped: number } | null;
}

interface VerdictTallyProps {
  tallies: { approved: number; rejected: number; deferred: number; pending: number };
  total: number;
}

function VerdictTallyRow({ tallies, total }: VerdictTallyProps) {
  return (
    <div
      data-testid="memo-intake-tally"
      className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground"
    >
      <span className="font-medium">{total} 카드</span>
      <span data-testid="memo-tally-approved" className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-700 ring-1 ring-emerald-500/30">
        ✓ {tallies.approved}
      </span>
      <span data-testid="memo-tally-rejected" className="rounded-full bg-rose-500/15 px-2 py-0.5 text-rose-700 ring-1 ring-rose-500/30">
        ✗ {tallies.rejected}
      </span>
      <span data-testid="memo-tally-deferred" className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-700 ring-1 ring-amber-500/30">
        ⏸ {tallies.deferred}
      </span>
      <span data-testid="memo-tally-pending" className="rounded-full bg-muted px-2 py-0.5 ring-1 ring-border">
        … {tallies.pending}
      </span>
    </div>
  );
}

interface RefineBlockProps {
  open: boolean;
  hint: string;
  busy: boolean;
  onToggle: () => void;
  onHintChange: (v: string) => void;
  onSubmit: () => void;
}

function RefineBlock({ open, hint, busy, onToggle, onHintChange, onSubmit }: RefineBlockProps) {
  return (
    <div data-testid="memo-intake-refine" className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onToggle}
        disabled={busy}
        data-testid="memo-intake-refine-toggle"
        className="text-xs"
      >
        {open ? '↓ Hide refine' : '↻ Refine decomposition'}
      </Button>
      {open && (
        <div className="space-y-2 rounded-lg border border-dashed border-border bg-card/30 p-3">
          <p className="text-[10px] text-muted-foreground">
            LLM 에 다시 prompt — 원본 memo + 이전 분해 + hint 를 함께 보냅니다. 결과 카드의 verdict 는 초기화됩니다.
          </p>
          <textarea
            value={hint}
            onChange={(e) => onHintChange(e.target.value)}
            placeholder={'예: "missions 더 작게" · "P0 만 남겨" · "t-9 ~ t-11 을 하나로 합쳐"'}
            rows={2}
            disabled={busy}
            data-testid="memo-intake-refine-textarea"
            className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-xs shadow-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button
            type="button"
            size="sm"
            onClick={onSubmit}
            disabled={busy || !hint.trim()}
            data-testid="memo-intake-refine-submit"
          >
            {busy ? 'Refining…' : 'Re-run with hint'}
          </Button>
        </div>
      )}
    </div>
  );
}

function PipelineSummary({ res, registered }: SummaryProps) {
  return (
    <div
      data-testid="memo-intake-summary"
      className="space-y-1 rounded-lg border border-dashed border-border bg-card/50 p-3 text-xs text-muted-foreground"
    >
      <p>
        intake <code data-testid="memo-intake-id" className="rounded bg-muted px-1 text-foreground">{res.intakeId}</code>
        {' · '}
        {res.decomposition.fallback ? 'skeleton fallback' : 'live'}
      </p>
      <p>
        {res.decomposition.missionCount} mission{res.decomposition.missionCount === 1 ? '' : 's'} ·{' '}
        {res.decomposition.taskCount} task{res.decomposition.taskCount === 1 ? '' : 's'} ·{' '}
        workflow-eligible {res.categorize.counts.workflowEligible}/{res.categorize.counts.total} ·{' '}
        deps {res.align.dependencyCount}
      </p>
      {registered && (
        <p data-testid="memo-intake-registered" className="text-emerald-600 dark:text-emerald-400">
          ✓ registered {registered.missions} mission{registered.missions === 1 ? '' : 's'} · {registered.tasks} task{registered.tasks === 1 ? '' : 's'} (in-memory)
          {registered.skipped > 0 ? ` · ${registered.skipped} skipped` : ''}
        </p>
      )}
    </div>
  );
}

interface DeckProps {
  cards: readonly MemoCard[];
  verdicts: Record<string, CardVerdict>;
  topIndex: number;
  onSwipe: (decision: SwipeDecision) => void;
}

function MemoCardDeck({ cards, verdicts, topIndex, onSwipe }: DeckProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onSwipeRef = useRef(onSwipe);
  useEffect(() => { onSwipeRef.current = onSwipe; }, [onSwipe]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    return attachSwipe4(el, {
      onSwipe: (dir) => onSwipeRef.current(DIRECTION_TO_DECISION[dir]),
    });
  }, []);

  useEffect(() => {
    if (topIndex >= cards.length) return;
    const onKey = (e: KeyboardEvent): void => {
      const decision = KEY_TO_DECISION[e.key];
      if (!decision) return;
      e.preventDefault();
      onSwipeRef.current(decision);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [topIndex, cards.length]);

  if (topIndex >= cards.length) {
    return (
      <div
        data-testid="memo-deck-empty"
        className="flex h-72 items-center justify-center rounded-2xl border border-dashed border-border text-sm text-muted-foreground"
      >
        모든 카드 검토 완료 — 아래 "Approve all & Register" 를 눌러 등록.
      </div>
    );
  }

  const visible = cards.slice(topIndex, topIndex + 3);
  return (
    <div
      ref={containerRef}
      data-testid="memo-deck"
      data-top-index={topIndex}
      role="region"
      aria-label="memo intake card deck · 좌우 = 거절/승인 · 위 = 잠시 멈춤 · 아래 = 펼치기"
      tabIndex={0}
      className="relative h-80 select-none touch-none"
    >
      {visible.map((c, i) => (
        <MemoIntakeCard
          key={c.task.taskKey}
          card={c}
          verdict={verdicts[c.task.taskKey] ?? 'pending'}
          active={i === 0}
          stackIndex={i}
        />
      ))}
      <div
        data-testid="memo-deck-progress"
        className="absolute -bottom-6 left-0 right-0 text-center text-[10px] text-muted-foreground"
      >
        {topIndex + 1} / {cards.length}
      </div>
    </div>
  );
}

function ExpandModal({ card, onClose }: { card: MemoCard; onClose: () => void }) {
  const { task } = card;
  return (
    <div
      data-testid="memo-card-expand"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md space-y-3 rounded-2xl border border-border bg-card p-5 shadow-xl"
      >
        <header className="space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{card.missionTitle}</p>
          <h3 className="font-heading text-base font-medium">{task.title}</h3>
        </header>
        <p className="text-sm text-foreground">{task.intent}</p>
        {(task.urls.length > 0 || task.keywords.length > 0 || task.refs.length > 0) && (
          <div className="space-y-1 text-xs text-muted-foreground">
            {task.urls.length > 0 && (
              <p data-testid="memo-card-expand-urls">URLs: {task.urls.join(' · ')}</p>
            )}
            {task.keywords.length > 0 && (
              <p data-testid="memo-card-expand-keywords">Keywords: {task.keywords.join(' · ')}</p>
            )}
            {task.refs.length > 0 && (
              <p data-testid="memo-card-expand-refs">Refs: {task.refs.join(' · ')}</p>
            )}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground">
          {task.category} · {task.priority} priority · {task.workflowEligible ? 'workflow' : 'no-workflow'} · confidence {task.confidence}
        </p>
        <div className="flex justify-end pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={onClose} data-testid="memo-card-expand-close">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
