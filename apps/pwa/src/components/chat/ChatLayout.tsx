'use client';

import { HideInPublicCapture } from '@/lib/public-capture';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { Mic, MicOff, MoreHorizontal } from 'lucide-react';
import { useCompactMode } from '@/lib/compact-mode';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { ChatHistory } from './ChatHistory';
import { ChatInput } from './ChatInput';
import { ChatQueueChips } from './ChatQueueChips';
import { clearChatQueue, dequeueChat, enqueueChat, removeChat, type ChatQueueEntry } from '@/lib/chat-queue';
import { ChatDropOverlay } from './ChatDropOverlay';
import { nextDropOverlay, type DropOverlayState } from '@/lib/drop-overlay';
import { SessionPill } from './SessionPill';
import { ChatHud } from './blocks/ChatHud';
import { dispatchHudSegmentEnvelope } from '@/lib/chat-runtime';
import { restorableChatMessages } from '@/lib/session-restore';
import { writeSharePrefill } from '@/lib/share-prefill';
import { BudgetPill } from './BudgetPill';
import { VoiceCostPill } from './VoiceCostPill';
import { VoiceOverlay } from './VoiceOverlay';
import { DebugTapDrawer, type DebugTapLine } from './blocks/DebugTapDrawer';
import { applyFeedbackEnvelope } from '@/lib/feedback-block-accumulator';
import {
  dispatchMeta,
  newMetaMessage,
  newUserMessage,
  runAcpForeignTurnObserver,
  runChatTurnAcp,
  runChatTurnObserver,
  runChatTurnStreaming,
  type ChatBlock,
  type ChatMessage,
  type ChatRuntimeContext,
} from '@/lib/chat-runtime';
import { useVoiceController } from '@/voice/use-voice-controller';
import { useVoiceTts } from '@/voice/use-voice-tts';
import { AskQuestionSheet } from '@/components/ask-user-question/AskQuestionSheet';
import { useAskQuestion } from '@/components/ask-user-question/use-ask-question';
import { ToolApprovalSheet } from '@/components/tool-approval/ToolApprovalSheet';
import { useToolApproval } from '@/components/tool-approval/use-tool-approval';
import type { AcpConnection } from '@/lib/daemon-client';
import { VOICE_DOT_COLOR, VOICE_PHASE_LABEL } from '@/voice/voice-phase-styles';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { debugLog, setDebugForwardFallback } from '@/lib/debug';
import { reduceTurnBusyBanner, type TurnBusyBanner } from '@/lib/turn-busy';
import { uploadAttachments, type AttachmentMeta } from '@/lib/upload-attachment';
import { extractClipboardFiles, extractDroppedFiles, hasDroppedFiles, type ChatFileExtraction } from '@/lib/chat-paste-drop';
import {
  buildPromptUserContentFromAttachments,
  isImageAttachment,
  isProviderUserMessageVisionCapable,
} from '@/lib/attachment-content';

export interface ChatLayoutProps {
  /** PR #4.5 — workspace chat 탭이 SessionPill 의 attach 클릭을
   *  workspace 의 SessionPicker 로 라우팅. 미지정 시 dropdown item 자체
   *  안 보임 (single-tab `/chat` 동작 보존). */
  onAttachRequest?: () => void;
  onForgetRequest?: () => void;
  /** The daemon corrected this conversation's id; keep its mounted transcript. */
  onSessionAdopt?: (id: string) => void;
  /** BACKLOG #3 — workspace tab id forwarded to ChatInput / ChatHistory
   *  for surface snapshot persistence. */
  tabId?: string;
  /** Compact header's conversation navigation, supplied by the standalone chat panel. */
  leading?: ReactNode;
}

export function ChatLayout(props: ChatLayoutProps = {}) {
  const { compact } = useCompactMode();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!moreRef.current || !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [moreOpen]);
  useEffect(() => { if (!compact) setMoreOpen(false); }, [compact]);
  const { client, config, sessionId, setSessionId } = useDaemon();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; id: number }>();
  const [pending, setPending] = useState(false);
  const [queue, setQueue] = useState<ChatQueueEntry[]>([]);
  const queueRef = useRef<ChatQueueEntry[]>([]);
  const queueSessionRef = useRef(sessionId);
  const currentSessionRef = useRef(sessionId);
  const adoptedSessionRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const nextQueueId = useRef(0);
  const turnActiveRef = useRef(false);
  const [turnCompleted, setTurnCompleted] = useState<{ generation: number; sessionId: string | null } | null>(null);
  // Hide the previous session's chips even in the first committed render.
  // Only change the queue and its generation after the new session commits.
  const visibleQueue = queueSessionRef.current !== sessionId && adoptedSessionRef.current !== sessionId ? [] : queue;
  useLayoutEffect(() => {
    currentSessionRef.current = sessionId;
    if (queueSessionRef.current === sessionId) return;
    if (adoptedSessionRef.current !== sessionId) {
      sessionGenerationRef.current++;
      queueRef.current = [];
      setQueue([]);
    }
    queueSessionRef.current = sessionId;
    adoptedSessionRef.current = null;
  }, [sessionId]);
  const updateQueue = (next: ChatQueueEntry[]): void => {
    queueRef.current = next;
    setQueue(next);
  };
  const [turnBusyBanner, setTurnBusyBanner] = useState<TurnBusyBanner | null>(null);
  // Phase B-3 (PWA chat streaming · 2026-05-06) — Stop button + Esc
  // abort wire. Holds the AbortController for the in-flight turn so
  // the user can cancel mid-stream; null when no turn is running.
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  // WT-N-1b/2b — attachment queue: each upload via Camera/File buttons
  // pushes its meta here; submit drains it into the user text and the
  // message body so the LLM sees both the path list and any caption.
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentMeta[]>([]);
  const [dropOverlay, setDropOverlay] = useState<DropOverlayState>({ visible: false, depth: 0 });

  useEffect(() => {
    const onDragEnd = (): void => setDropOverlay((state) => nextDropOverlay(state, 'end', false));
    window.addEventListener('dragend', onDragEnd);
    return () => window.removeEventListener('dragend', onDragEnd);
  }, []);

  // Phase B-4 follow-up — local turn dedupe ref. The observer
  // (mounted on the same sessionId) sees the same SSE wire that the
  // local POST stream consumes; the ref tells the observer to drop
  // events while the local handler is mid-stream so we don't render
  // two placeholders for the same turn. Set on POST start, cleared
  // in the finally block. Use a ref (not state) because the
  // observer's dedupe gate fires inside an SSE callback that
  // captured the closure at mount time — state reads would be stale.
  const localTurnInFlightRef = useRef(false);
  // CV-1 (PLAN v1.2 §5 · 2026-05-07) — SSE observer's active foreign
  // placeholder id. The ACP foreign-turn observer reads this to drop
  // ACP fanout when the SSE path is already mirroring a foreign chat
  // tab's turn (cross-tab dual placeholder avoidance). Set inside SSE
  // onPlaceholder, cleared in onFinalize/onError. Webterm `:agent`
  // turns never set this (they don't fanout to chatEventBus), so ACP
  // listener owns those exclusively.
  const remoteSseTurnPlaceholderRef = useRef<string | null>(null);
  // CV-1b (2026-05-07) — long-lived ACP connection ref. The CV-1a
  // useEffect mounts the WebSocket on sessionId/baseUrl change; the ref
  // exposes the live instance to handleSubmit so chat's self-turn
  // routes via `runChatTurnAcp` (ACP `session/prompt` RPC + chunks
  // listener) instead of REST `/v1/prompt/stream`. cleanup nulls it.
  const acpRef = useRef<ReturnType<typeof client.connectAcp> | null>(null);
  // M4 of PLAN-ask-user-question-cross-surface-2026-05-13 — mirror the
  // acpRef into state so the AskQuestion hook re-registers its handlers
  // when the connection is replaced (reconnect path). useAskQuestion is
  // a React hook that needs a dep — `acpRef.current` is stale within
  // useEffect bodies.
  const [acpForAsk, setAcpForAsk] = useState<AcpConnection | null>(null);

  // M6 PR 2 (PLAN-rich-dev-feedback-multi-surface · 2026-05-13) —
  // debug-tap opt-in. Read once from URL at mount so users can flip
  // the drawer on by visiting `/chat?debug-tap=on`; subsequent state
  // is owned by `drawerOpen` (user can close the drawer without
  // navigating away). The boolean propagates through every
  // `runChatTurnStreaming` call so the daemon-side bridge activates
  // per-turn, mirroring matching debug.log events back as `debug.line`
  // envelopes. Guarded for SSR (window may be undefined).
  const debugTapInitiallyOn = useMemo<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('debug-tap') === 'on';
    } catch {
      return false;
    }
  }, []);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(debugTapInitiallyOn);

  // Flatten debug.line entries across every assistant message in
  // chronological turn order. The accumulator stores them in a
  // per-message `debug_session` block (one block per turn, ring-capped
  // at 200 lines); the drawer wants a single ordered list across the
  // entire conversation so the user sees turn N's daemon trace right
  // below turn N-1's. We rely on message insertion order — placeholders
  // are appended on `turn-begin` and finalized in-place. `seq` resets
  // per turn (each per-turn bridge has its own SeqTracker), so the
  // drawer uses (loggedAt, seq, idx) as the React key.
  const debugLines = useMemo<DebugTapLine[]>(() => {
    const out: DebugTapLine[] = [];
    for (const m of messages) {
      if (!Array.isArray(m.blocks)) continue;
      for (const b of m.blocks) {
        if (b.kind !== 'debug_session') continue;
        for (const line of b.lines) {
          out.push({
            seq: line.seq,
            category: line.category,
            event: line.event,
            ...(line.data !== undefined ? { data: line.data } : {}),
            loggedAt: line.loggedAt,
          });
        }
      }
    }
    return out;
  }, [messages]);

  // Phase 1 (PWA chat ↔ voice 일원화 · 2026-05-07) — voice controller
  // wires the daemon STT WS to the chat layout. Q2=B2 = auto-send: each
  // STT `final` transcript fires `handleSubmit` immediately (TUI voice
  // mode mirror). Two refs keep the closures honest:
  //   • handleSubmitRef — `handleSubmit` is recreated each render
  //     (closes over latest pending/messages); the ref captures the
  //     latest reference so the long-lived socket callback always
  //     reaches the current handler.
  //   • pendingRef — drops voice transcripts that arrive while a turn
  //     is already streaming (B2 risk mitigation: STT misfire during
  //     LLM thinking should not double-submit).
  const handleSubmitRef = useRef<(text: string, queued?: boolean) => Promise<void>>(async () => {});
  const pendingRef = useRef(false);
  pendingRef.current = pending;
  // FU PP-V-1 — voice.toggle 의 latest closure 를 보관할 ref. 본 ref
  // 는 useVoiceController 호출 직후 (= line 119) sync 되고, global
  // keydown 리스너 (Cmd+Shift+M) 가 호출. 양쪽이 분리된 useEffect /
  // useVoiceController 사이에 선언이 들어가야 TS scope 가 정합.
  const voiceToggleRef = useRef<() => Promise<void>>(async () => {});

  const wsUrl = client.voiceWsUrl();
  const handleVoiceTranscript = useCallback((text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (pendingRef.current) {
      debugLog('chat.voice.skip-pending', { len: trimmed.length });
      return;
    }
    debugLog('chat.voice.auto-send', { len: trimmed.length });
    void handleSubmitRef.current(trimmed);
  }, []);
  const voice = useVoiceController({
    wsUrl,
    ...(config.token ? { token: config.token } : {}),
    onTranscript: handleVoiceTranscript,
  });
  const voiceConfigured = Boolean(config.baseUrl);
  // FU PP-V-1 — sync latest voice.toggle into the long-lived ref so
  // the global keyboard shortcut listener calls the current closure.
  voiceToggleRef.current = () => voice.toggle();

  // Phase 5 (PWA chat ↔ voice 일원화 · 2026-05-07) — assistant
  // streaming 텍스트 → Web Speech API 음성 출력. mute toggle 상태가
  // false (= 음소거 OFF) AND voice 가 active 일 때만 발화. Q6=F2-lite
  // (server-side bridge wire 는 BACKLOG · 본 phase 의 use-voice-tts.ts
  // header note 참고).
  const [ttsMuted, setTtsMuted] = useState(false);
  const voiceTts = useVoiceTts({
    enabled: voice.active && !ttsMuted,
    language: 'ko-KR',
  });

  const handleStop = useCallback((): void => {
    abortController?.abort();
    debugLog('webterm.chat.stop', { had: !!abortController });
  }, [abortController]);

  // Phase B-3 — global Esc binding. Only active while a turn is
  // running. Excludes Esc when typing in inputs/textareas so the
  // user can still clear typed text without aborting the turn (the
  // composer handles its own Esc semantics elsewhere).
  useEffect(() => {
    if (!abortController) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      const target = ev.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) {
        return;
      }
      ev.preventDefault();
      handleStop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [abortController, handleStop]);

  // Voice 일원화 FU PP-V-1 (2026-05-07) — 외장 키보드 push-to-toggle.
  // Q5=E3 deferred 후속. **Cmd/Ctrl + Shift + M** = mic toggle (Mac
  // Cmd · Win/Linux Ctrl 둘 다 받음). modifier 동반 chord 라 textarea
  // 안에서도 충돌 없음 (e.g. "M" 입력은 modifier 없이 가능). webterm
  // 트랙은 별도 세션이 같은 chord 를 dock 안에서 매핑할 예정.
  // ttsToggle (Volume2) 도 동일 chord 의 자연 확장으로 남겨두지 않음 —
  // 본 phase 는 mic 한 가지만, 사용자 dogfood 후 chord 확장 결정.
  // voiceToggleRef 는 위 (handleSubmitRef/pendingRef 옆) 에서 선언.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key.toLowerCase() !== 'm') return;
      if (!ev.shiftKey) return;
      if (!ev.metaKey && !ev.ctrlKey) return;
      // Browser default — Chrome/Safari Cmd+Shift+M opens window menu
      // on macOS; we own the chord here for mic toggle.
      ev.preventDefault();
      debugLog('chat.voice.shortcut.toggle');
      void voiceToggleRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleAttached = useCallback((entries: AttachmentMeta[]): void => {
    setPendingAttachments((prev) => [...prev, ...entries]);
    debugLog('webterm.chat.attach.queue', {
      added: entries.length,
      filenames: entries.map((e) => e.filename),
    });
  }, []);

  const uploadTransferFiles = async ({ files, tooLarge, tooMany }: ChatFileExtraction): Promise<void> => {
    if (tooLarge) toast.error(`${tooLarge} files exceed the 20 MB attachment limit`);
    if (tooMany) toast.error(`${tooMany} files exceed the 10-file attachment limit`);
    if (files.length === 0) return;
    if (!config.baseUrl) {
      toast.error('Daemon URL 미설정 — Settings 에서 입력');
      return;
    }
    const results = await uploadAttachments(files, {
      baseUrl: config.baseUrl,
      ...(config.token ? { token: config.token } : {}),
    });
    const successes = results.filter((result) => result.ok).map((result) => result.meta);
    const failures = results.filter((result) => !result.ok);
    if (successes.length) {
      handleAttached(successes);
      toast.success(successes.length === 1 ? `📎 ${successes[0]!.filename}` : `📎 ${successes.length} files attached`);
    }
    if (failures.length) {
      toast.error(failures.length === 1
        ? `업로드 실패: ${failures[0]!.reason.slice(0, 80)}`
        : `${failures.length} 파일 업로드 실패`);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const extracted = extractClipboardFiles(event.clipboardData, Date.now());
    if (extracted.files.length === 0 && extracted.tooLarge === 0 && extracted.tooMany === 0) return;
    event.preventDefault();
    void uploadTransferFiles(extracted);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    setDropOverlay((state) => nextDropOverlay(state, 'enter', hasDroppedFiles(event.dataTransfer)));
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    setDropOverlay((state) => nextDropOverlay(state, 'leave', hasDroppedFiles(event.dataTransfer)));
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (hasDroppedFiles(event.dataTransfer)) event.preventDefault();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDropOverlay((state) => nextDropOverlay(state, 'drop', hasDroppedFiles(event.dataTransfer)));
    const extracted = extractDroppedFiles(event.dataTransfer);
    if (extracted.files.length === 0 && extracted.tooLarge === 0 && extracted.tooMany === 0) return;
    event.preventDefault();
    void uploadTransferFiles(extracted);
  };

  // Service Worker Phase 2 — when /share/ redirects to /chat?shared=1
  // it has already uploaded files to the daemon and stashed the
  // resulting AttachmentMeta[] under SHARE_ATTACHMENTS_KEY. Drain it
  // once on mount so the user sees the chips ready to send. The flag
  // is sessionStorage-scoped so a deep-link reload doesn't re-pop.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.sessionStorage.getItem('elanous.pwa.shareAttachments');
      if (!raw) return;
      window.sessionStorage.removeItem('elanous.pwa.shareAttachments');
      const parsed = JSON.parse(raw) as AttachmentMeta[];
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      setPendingAttachments((prev) => [...prev, ...parsed]);
      const labels = parsed.length === 1
        ? `1 file shared from another app`
        : `${parsed.length} files shared from another app`;
      toast.success(labels);
      debugLog('pwa.chat.share-attachments.consume', { count: parsed.length });
    } catch (e) {
      debugLog('pwa.chat.share-attachments.parse-failed', {
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  // P3(2026-07-12): 구 S3b 핸드오프 seed(sessionStorage 전사 복사) 제거 —
  // writer 0(stash 경로는 R5 전환 때 소거)에 R4 복원 seed 와 이중이었다.
  // 이어가기 = setSessionId + R4 시각 seed + 데몬 R5 read-through 단일 경로
  // (S4 "진짜 이어감 ≠ 복사" 계약).

  // 세션 복원(R4 · 2026-07-09) — 마운트/세션 전환 시 on-disk 저장소에서 대화를
  // 다시 불러와 seed. PWA 챗은 이제 ~/.elanous/sessions 로 write-through(R3) 되므로
  // 탭 이동 후 돌아와도 리셋되지 않는다. 진행 중 메시지는 덮지 않음.
  const restoredRef = useRef<string>('');
  useEffect(() => {
    if (!sessionId || restoredRef.current === sessionId) return;
    restoredRef.current = sessionId;
    let alive = true;
    void (async () => {
      try {
        const r = await client.fetchJson<{ ok?: boolean; messages?: { role: string; content: string }[] }>(
          `/v1/sessions/store/${encodeURIComponent(sessionId)}?ifExists=1`,
        );
        if (!alive || !r?.messages || r.messages.length === 0) return;
        setMessages((prev) => {
          if (prev.length > 0) return prev; // 진행 턴 보존
          // ⛔⭐ 선별은 `session-restore.ts` 가 한다 — 여기 인라인으로 두면 시험이 못 문다.
          //   📏 2026-08-22: 이 자리가 `[tool_use]`/`[tool_result]` 를 «그대로» 그려서
          //     복원된 화면의 **69%(472 중 327줄)** 가 그 글자였다.
          return restorableChatMessages(r.messages!, Date.now());
        });
      } catch { /* 저장소에 없으면(신규 세션) 무시 */ }
    })();
    return () => { alive = false; };
  }, [sessionId, client]);

  const handleRemoveAttachment = useCallback((id: string): void => {
    setPendingAttachments((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const ctx: ChatRuntimeContext = {
    client,
    sessionId,
    provider: config.provider,
    setSessionId,
    daemon: { baseUrl: config.baseUrl, ...(config.token ? { token: config.token } : {}) },
    messages,
  };

  const append = (msg: ChatMessage): void => {
    setMessages((prev) => [...prev, msg]);
  };

  const executeTurn = async (text: string, queued = false): Promise<void> => {
    setTurnBusyBanner((previous) => reduceTurnBusyBanner(previous, { kind: 'turn-begin' }));
    debugLog('webterm.chat.input', {
      len: text.length,
      attachCount: pendingAttachments.length,
    });

    // P-3 §6.9 (2026-05-07) — multi-part user content path. When the
    // queue carries an image AND the active provider is vision-capable
    // (composer-side heuristic; daemon-side gate is authoritative), we
    // ship a `userContent` ContentBlock[] so the image bytes reach the
    // LLM intact. Non-image attachments and the legacy [attached]
    // <path> hint stay on the text path so existing fs-tool flows keep
    // working. When the model can't take vision input (Q3=B), the user
    // sees a toast + the queue is drained (skip) — they can switch to
    // a vision model and re-attach.
    const attached = queued ? [] : pendingAttachments;
    if (!queued) setPendingAttachments([]);
    const imageAttachments = attached.filter(isImageAttachment);
    const nonImageAttachments = attached.filter((e) => !isImageAttachment(e));
    const visionCapable = isProviderUserMessageVisionCapable(config.provider);
    const willShipImages = imageAttachments.length > 0 && visionCapable;
    if (imageAttachments.length > 0 && !visionCapable) {
      // Q3=B — UI toast for the non-vision case. Image bytes are
      // dropped from this turn (kept implicit by not building the
      // userContent block). User can switch model + re-attach for
      // the next turn.
      toast.warning(
        `이 모델은 이미지 입력을 지원하지 않습니다 — ${imageAttachments.length}개 이미지가 무시됩니다. (vision 모델로 전환 후 재첨부)`,
      );
    }
    // Non-image attachments still surface as `[attached] <path>` lines
    // so the agent can fs-read them; this preserves the pre-P-3 flow
    // for documents / archives / data files.
    const attachLines = nonImageAttachments
      .map((e) => (e.path ? `[attached] ${e.path}` : ''))
      .filter((line) => line.length > 0);
    const composedText = attachLines.length > 0
      ? `${attachLines.join('\n')}\n\n${text}`.trimEnd()
      : text;
    // Build the multi-part block list when we have images to ship.
    // Q1=B order: text first, then images. Each image fetch is the
    // composer's responsibility — bytes flow through the daemon
    // /v1/attachments endpoint so daemon and LLM see the same payload.
    let userContentBlocks: Awaited<
      ReturnType<typeof buildPromptUserContentFromAttachments>
    > = null;
    if (willShipImages && config.baseUrl) {
      try {
        userContentBlocks = await buildPromptUserContentFromAttachments(
          composedText,
          imageAttachments,
          { baseUrl: config.baseUrl, token: config.token },
        );
      } catch (err) {
        // Fall back to text-only path on conversion failure — the
        // user still gets a turn instead of a hard error.
        const msg = err instanceof Error ? err.message : String(err);
        debugLog('webterm.chat.attach.contentblock.error', { msg });
        toast.error(`이미지 첨부 변환 실패 — 텍스트만 전송: ${msg}`);
        userContentBlocks = null;
      }
    }

    // Display message: keep the user-typed text in the chat history
    // and surface attachment chips as a meta line so the user can see
    // exactly what was sent without polluting their own message body.
    if (text.length > 0) append(newUserMessage(text));
    if (attached.length > 0) {
      append(newMetaMessage(`📎 attached: ${attached.map((e) => e.filename).join(', ')}`));
    }

    // Meta commands: only dispatch on the user-typed text (attachments
    // don't change meta semantics — `:help` with files attached still
    // means show help).
    const meta = text ? await dispatchMeta(text, ctx) : null;
    if (meta) {
      if (meta.text === '__CLEAR__') {
        setMessages([]);
      } else {
        append(newMetaMessage(meta.text));
      }
      if (meta.newSessionId) {
        sessionGenerationRef.current++;
        updateQueue(clearChatQueue());
        queueSessionRef.current = meta.newSessionId;
        currentSessionRef.current = meta.newSessionId;
        setSessionId(meta.newSessionId);
      }
      return;
    }

    if (!config.baseUrl) {
      append(newMetaMessage('error: daemon baseUrl not configured. Visit /settings.'));
      return;
    }

    setPending(true);
    // Phase B-4 follow-up — flag the local turn so the observer
    // mounted on this same sessionId (multi-tab fanout) drops the
    // duplicate event stream. Cleared in the finally block below.
    localTurnInFlightRef.current = true;
    // Phase B-1 (PWA chat streaming · 2026-05-06) — insert a
    // placeholder assistant message and grow its text from each
    // SSE `text-delta`. id stays stable so React preserves the bubble
    // across renders; we replace it with the finalized message on
    // success so meta (stopReason / provider) lands.
    const placeholderId = `m-stream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const placeholder: ChatMessage = {
      id: placeholderId,
      role: 'assistant',
      text: '',
      timestamp: Date.now(),
      meta: { provider: config.provider },
    };
    append(placeholder);
    // Phase B-3 — own AbortController for this turn so Stop / Esc
    // can fire abort mid-stream. Daemon SSE handler `cancel` aborts
    // the per-turn LLM controller server-side once the fetch closes.
    const ac = new AbortController();
    setAbortController(ac);
    // Phase 5 (voice 일원화) — TTS delta tracker. onPartial 콜백이
    // cumulative text 를 주므로 pushText 에는 직전 호출 이후의
    // delta 만 보내야 sentence boundary 가 중복 계산되지 않는다.
    let lastTtsLen = 0;
    // CV-1b (PLAN v1.2 §5 · 2026-05-07) — chat self-turn path selection.
    //   • ACP path (preferred · runChatTurnAcp): chat 의 자기 turn 이 ACP
    //     `session/prompt` RPC + chunks listener. webterm dock 과 같은
    //     architecture, daemon-side 의 단일 broadcast pipeline 활용.
    //   • SSE fallback (legacy · runChatTurnStreaming): sessionId 미발급
    //     상태 (첫 turn 전 handshake 미완) 또는 ACP useEffect 가 mount
    //     실패 (config.baseUrl 변경 race) 시 안전망. Q4=D1 결정 — CV-2
    //     에서 SSE handler 자체 제거 시 fallback 도 함께 제거.
    const acpInst = acpRef.current;
    const useAcpPath = Boolean(acpInst && sessionId && config.baseUrl);
    // Keep the turn's own lease across the session-adoption effect cleanup.
    // The handshake may replace a stale stored id before session/prompt starts.
    let turnAcp: AcpConnection | null = null;
    debugLog('webterm.chat.runturn.path', { useAcpPath, hasAcp: !!acpInst, hasSession: !!sessionId });
    const onPartial = (full: string): void => {
      setMessages((prev) =>
        prev.map((m) => (m.id === placeholderId ? { ...m, text: full } : m)),
      );
      // Phase 5 — assistant streaming 텍스트 delta 를 TTS 큐에 추가.
      // enabled 가 false (voice off / mute on) 일 때 hook 내부에서 no-op.
      if (full.length > lastTtsLen) {
        voiceTts.pushText(full.slice(lastTtsLen));
        lastTtsLen = full.length;
      }
    };
    const onPartialBlocks = (blocks: ChatBlock[]): void => {
      // Phase B-2/B-3 — mid-stream blocks (image · tool_use pill) attach
      // to the placeholder so users see them live. Final message replaces
      // the placeholder anyway, but this keeps the bubble live while the
      // agent finishes thinking.
      setMessages((prev) =>
        prev.map((m) => (m.id === placeholderId ? { ...m, blocks } : m)),
      );
    };
    try {
      if (useAcpPath) turnAcp = client.connectAcp({ sessionId });
      const { message, newSessionId } = useAcpPath
        ? await runChatTurnAcp(turnAcp!, composedText, {
            ...ctx,
            sessionId: (await turnAcp!.ready) || sessionId,
          }, {
            signal: ac.signal,
            ...(userContentBlocks ? { userContent: userContentBlocks } : {}),
            onPartial,
            onPartialBlocks,
          })
        : await runChatTurnStreaming(composedText, ctx, {
            signal: ac.signal,
            ...(userContentBlocks ? { userContent: userContentBlocks } : {}),
            ...(drawerOpen ? { debugTap: true } : {}),
            onPartial,
            onPartialBlocks,
            onError: (info) => setTurnBusyBanner((previous) => reduceTurnBusyBanner(previous, {
              kind: 'error',
              payload: info,
            })),
          });
      setTurnBusyBanner((previous) => reduceTurnBusyBanner(previous, { kind: 'turn-end' }));
      // Replace the placeholder bubble with the finalized message so
      // meta (stopReason) attaches without a flicker.
      setMessages((prev) =>
        prev.map((m) => (m.id === placeholderId ? message : m)),
      );
      if (newSessionId && newSessionId !== sessionId && currentSessionRef.current === sessionId) {
        adoptedSessionRef.current = newSessionId;
        currentSessionRef.current = newSessionId;
        setSessionId(newSessionId);
      }
      // Phase 5 — turn 종료 시 buffer 잔여 텍스트를 마지막 sentence
      // 로 flush. 사용자가 마지막 한 문장을 못 듣고 끊기는 회귀 회피.
      voiceTts.flush();
    } catch (err) {
      const aborted = ac.signal.aborted;
      const msg = err instanceof Error ? err.message : String(err);
      // Phase 5 — turn 중단 (사용자 Stop / 네트워크 오류) 시 진행 중
      // 발화 + 큐 모두 취소. 다음 turn 으로 이전 잔여물이 새지 않게.
      voiceTts.cancel();
      if (aborted) {
        // User-driven cancel — preserve whatever streamed so far +
        // tag the bubble with a stopReason so the meta line shows
        // "aborted" instead of "end_turn". No toast, no error line.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholderId
              ? { ...m, meta: { ...m.meta, stopReason: 'aborted' } }
              : m,
          ),
        );
        debugLog('webterm.chat.runturn.stream.abort', { reason: msg });
      } else {
        // Drop the placeholder bubble on real error — the meta error
        // line below carries the diagnostic.
        setMessages((prev) => prev.filter((m) => m.id !== placeholderId));
        append(newMetaMessage(`error: ${msg}`));
        toast.error(`chat failed: ${msg}`);
        // ⛔⭐⭐⭐ **사용자가 보는 실패를 «관측에도» 남긴다.**
        //   📏 2026-08-22 실측(19차 `[F]` 라이브): 화면엔 `error: socket closed: 1006` 이 떴는데
        //   ***`elanous logs` 에는 이 갈래의 흔적이 «하나도» 없었다*** — 바로 위 중단 갈래는 내는데
        //   ***「진짜 실패」만 조용했다.*** 🔑 사람은 겪고 있는데 관측은 「아무 일 없다」고 말한다.
        //   ⭐ 접미사 `error` 가 서버 severity 를 error 로 올린다(`deriveForwardLevel`).
        debugLog('webterm.chat.runturn.error', { reason: msg, useAcpPath });
      }
    } finally {
      turnAcp?.close();
      setPending(false);
      setAbortController(null);
      localTurnInFlightRef.current = false;
    }
  };
  const handleSubmit = async (text: string, queued = false): Promise<void> => {
    if (turnActiveRef.current || (!queued && queueRef.current.length > 0)) {
      if (!queued && (pendingAttachments.length > 0 || /^[\s]*[:/]/.test(text))) {
        toast.info('답이 끝난 뒤 보내 주세요');
        setComposerPrefill((previous) => ({ text, id: (previous?.id ?? 0) + 1 }));
        return;
      }
      const result = enqueueChat(queueRef.current, { id: ++nextQueueId.current, text });
      if (result.error) {
        toast.info(result.error);
        setComposerPrefill((previous) => ({ text, id: (previous?.id ?? 0) + 1 }));
      } else {
        updateQueue(result.queue);
      }
      return;
    }
    turnActiveRef.current = true;
    const turnGeneration = sessionGenerationRef.current;
    const turnSessionId = currentSessionRef.current;
    try {
      await executeTurn(text, queued);
    } finally {
      turnActiveRef.current = false;
      if (turnGeneration !== sessionGenerationRef.current) {
        debugLog('webterm.chat.queue.session-changed', { turnSessionId, currentSessionId: currentSessionRef.current });
      }
      setTurnCompleted({ generation: sessionGenerationRef.current, sessionId: currentSessionRef.current });
    }
  };

  // One completion starts at most one next turn; the lock also covers the render gap before pending updates.
  useEffect(() => {
    if (turnActiveRef.current || queueRef.current.length === 0 ||
        !turnCompleted || turnCompleted.generation !== sessionGenerationRef.current ||
        turnCompleted.sessionId !== sessionId) return;
    const { entry, queue: remaining } = dequeueChat(queueRef.current);
    if (!entry) return;
    updateQueue(remaining);
    void handleSubmitRef.current(entry.text, true);
  }, [turnCompleted]);

  // Phase 1 (voice 일원화) — sync the latest handleSubmit reference
  // into the long-lived ref the voice controller's onTranscript reads.
  // Runs every render to track the closure of pending / messages /
  // pendingAttachments etc.
  handleSubmitRef.current = handleSubmit;

  useEffect(() => {
    setTurnBusyBanner((previous) => reduceTurnBusyBanner(previous, { kind: 'session-change' }));
  }, [sessionId]);

  // Phase B-4 follow-up (PWA chat streaming · 2026-05-06) — observer
  // for cross-tab consistency. Subscribes to the daemon chat-event
  // bus for the current sessionId; foreign turns (other tabs / other
  // clients posting to the same session) materialize as fresh
  // assistant placeholders here. Dedupe guard on
  // `localTurnInFlightRef` ensures the observer drops events that
  // duplicate the local POST stream (own-tab fanout). On sessionId
  // change the prior subscription is disposed and a fresh one mounts.
  useEffect(() => {
    if (!sessionId) return;
    if (!config.baseUrl) return;
    const dispose = runChatTurnObserver(client, sessionId, {
      isLocalTurnInFlight: () => localTurnInFlightRef.current,
      provider: config.provider,
      onPlaceholder: ({ sessionId: turnSessionId }) => {
        setTurnBusyBanner((previous) => reduceTurnBusyBanner(previous, { kind: 'turn-begin' }));
        const id = `m-obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const placeholder: ChatMessage = {
          id,
          role: 'assistant',
          text: '',
          timestamp: Date.now(),
          meta: { provider: config.provider },
        };
        debugLog('webterm.chat.observer.placeholder', { id, turnSessionId });
        setMessages((prev) => [...prev, placeholder]);
        // CV-1 — SSE observer owns this turn's bubble; ACP listener
        // drops fanout for the same chunks (dual placeholder avoidance).
        remoteSseTurnPlaceholderRef.current = id;
        return id;
      },
      onPartialBlocks: (placeholderId, blocks) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === placeholderId ? { ...m, blocks } : m)),
        );
      },
      onFinalize: (placeholderId, finalMessage) => {
        setTurnBusyBanner((previous) => reduceTurnBusyBanner(previous, { kind: 'turn-end' }));
        setMessages((prev) =>
          prev.map((m) => (m.id === placeholderId ? finalMessage : m)),
        );
        if (remoteSseTurnPlaceholderRef.current === placeholderId) {
          remoteSseTurnPlaceholderRef.current = null;
        }
      },
      onError: (placeholderId, info) => {
        setTurnBusyBanner((previous) => reduceTurnBusyBanner(previous, {
          kind: 'error',
          payload: info,
        }));
        debugLog('webterm.chat.observer.error', {
          placeholderId,
          error: info.error,
        });
        // Tag the bubble so the user sees the failure mode without
        // wholesale dropping the partial render.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholderId
              ? {
                  ...m,
                  meta: { ...m.meta, stopReason: info.error },
                }
              : m,
          ),
        );
        if (remoteSseTurnPlaceholderRef.current === placeholderId) {
          remoteSseTurnPlaceholderRef.current = null;
        }
      },
    });
    return () => {
      dispose();
    };
  }, [client, sessionId, config.baseUrl, config.provider]);

  // Rich-dev-feedback opportunistic followup §6.2 #3 (2026-05-13) —
  // long-lived agent.status subscription. Mounts on sessionId/baseUrl
  // change so external CLI agent (claude-code / codex / future ACP)
  // transitions hydrate `<StatusChip>` in the latest assistant
  // message. accumulator routes `agent.status` envelopes into the
  // active message's blocks (same shape as M2 ThinkingBridge envelopes).
  // Currently the daemon-side source is the optional
  // `agentStatusStore` passed to `runNexus` — sub stays dormant
  // until a writer connects, then auto-activates with zero PWA-side
  // changes.
  useEffect(() => {
    if (!sessionId) return;
    if (!config.baseUrl) return;
    // ⛔⭐⭐⭐ **두 구독을 «한 연결»로** — 19차 `[F]`. 각각 열면 끝나지 않는 연결이 둘이 되고,
    //   그것이 브라우저 HTTP/1.1 한도(6)를 밀어 ***관측·위젯이 조용히 굶는다***(실측).
    //   서버가 `?topics=a,b` 를 이미 지원하므로 한 번 열고 `tee()` 로 갈라 준다.
    const dispose = client.subscribeChatFeedbackEvents(sessionId, {
      agentStatus: {
      onFeedback: (env) => {
        // Same accumulator path as runChatTurnStreaming's onFeedback:
        // merge into the latest assistant message's blocks. We attach
        // to whichever assistant message is most recently appended
        // (placeholder or finalized) so the chip lives next to the
        // current turn's text.
        setMessages((prev) => {
          if (prev.length === 0) return prev;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i]!.role !== 'assistant') continue;
            const m = prev[i]!;
            const blocks: ChatBlock[] = Array.isArray(m.blocks) ? [...m.blocks] : [];
            const result = applyFeedbackEnvelope(blocks, env);
            if (result !== 'applied') return prev;
            const updated: ChatMessage = { ...m, blocks };
            return [...prev.slice(0, i), updated, ...prev.slice(i + 1)];
          }
          return prev;
        });
      },
      onError: (info) => {
        debugLog('webterm.agent-status.error', info);
      },
      },
      // PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M4 — HUD 세그먼트는
      // 메시지 목록을 안 건드리고 프로세스 전역 HUD 스토어로 간다(헤더 스트립).
      hudSegment: {
        onFeedback: (env) => dispatchHudSegmentEnvelope(env),
        onError: (info) => {
          debugLog('webterm.hud-segment.error', info);
        },
      },
    });
    return () => {
      dispose();
    };
  }, [client, sessionId, config.baseUrl]);

  // CV-1 (PLAN v1.2 §5 · 2026-05-07) — ACP foreign-turn observer.
  // Mounts an ACP WebSocket on the active sessionId and surfaces turns
  // started on **other surfaces** (webterm `:agent`, TUI, multi-agent
  // broadcasters) as fresh assistant placeholders. The SSE observer
  // above only sees turns that publish into the daemon `chatEventBus`
  // (chat REST `/v1/prompt/stream`); webterm `:agent` does not, so
  // ACP is the only path to mirror those.
  //
  // Dedupe gates (Q1=A1):
  //   • localTurnInFlightRef — chat tab's own POST; SSE owns the
  //     bubble and the ACP broadcaster fires the same chunks (dual-
  //     emit). Drop ACP fanout.
  //   • remoteSseTurnPlaceholderRef — SSE observer is mid-bubble for
  //     a foreign chat tab's turn; drop ACP fanout to avoid dual
  //     placeholders.
  // Webterm `:agent` turns hit neither gate, so ACP listener is the
  // exclusive owner of those bubbles.
  //
  // Turn boundary — webterm `:agent` does NOT broadcast turn-end, so
  // the foreign-turn observer arms an idle timer per chunk (default
  // 3s). On expiration the placeholder is considered finalized and
  // stays in history as a regular message; subsequent foreign turns
  // get a fresh placeholder.
  useEffect(() => {
    if (!sessionId) return;
    if (!config.baseUrl) return;
    let acp: ReturnType<typeof client.connectAcp> | null = null;
    try {
      // Multi-surface entry (CV-1 Phase E follow-up · 2026-05-07) —
      // pass `onSession` so the daemon-issued sid (from session/load
      // success OR session/new fallback) flows back into the
      // DaemonProvider's localStorage. Without this writeback, every
      // PWA tab races a stale localStorage sid; second tab can't
      // adopt the first tab's freshly-minted session.
      acp = client.connectAcp({
        sessionId,
        onSession: (issued) => {
          if (issued && issued !== sessionId) {
            debugLog('webterm.chat.acp.session-adopt', {
              previous: sessionId,
              issued,
            });
            if (currentSessionRef.current !== sessionId) return;
            adoptedSessionRef.current = issued;
            currentSessionRef.current = issued;
            props.onSessionAdopt?.(issued);
            setSessionId(issued);
          }
        },
      });
    } catch (e) {
      debugLog('webterm.chat.acp.connect-failed', { reason: String(e) });
      return;
    }
    acpRef.current = acp;
    setAcpForAsk(acp);
    // ⛔⭐⭐⭐⭐ **관측의 «대체 통로»를 연다** — 19차 `[F]` · 2026-08-22 실측.
    //   HTTP 가 굶으면(SSE 가 커넥션 한도를 먹으면) `POST /v1/debug-logs/batch` 가 영영 큐에 서고
    //   ***관측이 통째로 사라진다.*** 그때 ***이 WebSocket 은 멀쩡히 돌고 있었다*** — 채팅이 됐다.
    //   🔑 제1원칙: 판정 결과가 흐르는 채널은 그 판정의 대상이 쓸 수 없어야 한다.
    //   ⚠️ 폴백일 뿐이다 — 정상 경로는 여전히 HTTP 다(배치·백프레셔가 거기 있다).
    const acpForFallback = acp;
    setDebugForwardFallback(async (body) => {
      const parsed = JSON.parse(body) as { records: unknown[] };
      await acpForFallback.send('elanous/debug-logs/ingest', { records: parsed.records });
      return true;
    });
    const dispose = runAcpForeignTurnObserver(acp, sessionId, {
      isLocalTurnInFlight: () => localTurnInFlightRef.current,
      isRemoteSseTurnInFlight: () => remoteSseTurnPlaceholderRef.current !== null,
      onPlaceholder: ({ sessionId: turnSessionId }) => {
        setTurnBusyBanner((previous) => reduceTurnBusyBanner(previous, { kind: 'turn-begin' }));
        const id = `m-acp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const placeholder: ChatMessage = {
          id,
          role: 'assistant',
          text: '',
          timestamp: Date.now(),
          meta: { provider: config.provider },
        };
        debugLog('webterm.chat.acp.foreign-placeholder', { id, turnSessionId });
        setMessages((prev) => [...prev, placeholder]);
        return id;
      },
      onPartialBlocks: (placeholderId, blocks) => {
        // Mirror the SSE observer's text/blocks split: legacy `.text`
        // when only the streaming text grows; `.blocks` once any non-
        // text block (image / tool_use) lands.
        const textBlock = blocks.find((b) => b.kind === 'text') as
          | Extract<ChatBlock, { kind: 'text' }>
          | undefined;
        const hasNonTextBlock = blocks.some(
          (b) => b.kind === 'image' || b.kind === 'tool_use',
        );
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholderId
              ? {
                  ...m,
                  ...(textBlock ? { text: textBlock.text } : {}),
                  ...(hasNonTextBlock ? { blocks } : {}),
                }
              : m,
          ),
        );
      },
      onFinalize: (placeholderId) => {
        debugLog('webterm.chat.acp.foreign-finalize', { placeholderId });
      },
    });
    return () => {
      dispose();
      // ⛔ 연결이 죽은 뒤에도 폴백이 남아 있으면 «죽은 통로»로 보내며 조용히 실패한다.
      setDebugForwardFallback(null);
      try { acp?.close(); } catch { /* swallow */ }
      if (acpRef.current === acp) acpRef.current = null;
      setAcpForAsk(null);
    };
  }, [client, sessionId, config.baseUrl, config.provider]);

  // An inbound AskUserQuestion's "Chat about this" action fills the
  // mounted composer as well as the shared one-shot handoff.
  const askQuestion = useAskQuestion({
    acp: acpForAsk,
    onComposerPrefill: (req) => {
      const first = req.questions[0];
      if (!first) return;
      const prefill = `[ Q: ${first.question.trim()} ]\n\n`;
      writeSharePrefill(prefill);
      setComposerPrefill((previous) => ({ text: prefill, id: (previous?.id ?? 0) + 1 }));
      toast.info('💬 입력 영역에 질문 prefill 됨 (Chat about this)');
    },
  });

  const toolApproval = useToolApproval({ acp: acpForAsk, sessionId });

  const voiceButton = (
    <button
      type="button"
      onClick={() => void voice.toggle()}
      disabled={!voiceConfigured}
      title={
        !voiceConfigured
          ? 'daemon URL 미설정 — Settings 에서 Base URL 입력'
          : voice.errorMsg ?? VOICE_PHASE_LABEL[voice.phase]
      }
      data-elanous-action="chat-voice-toggle"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
        voice.active
          ? 'border-rose-500/40 bg-rose-500/10 text-rose-600 hover:bg-rose-500/20'
          : 'border-border bg-background text-foreground hover:bg-muted',
        !voiceConfigured && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          VOICE_DOT_COLOR[voice.phase],
          (voice.phase === 'listening' || voice.phase === 'speaking') && 'animate-pulse',
        )}
        aria-hidden
      />
      {voice.active ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
      <span className="hidden sm:inline">{VOICE_PHASE_LABEL[voice.phase]}</span>
    </button>
  );

  return (
    <div className="relative flex h-full flex-col" onPaste={handlePaste} onDragEnter={handleDragEnter} onDragLeave={handleDragLeave} onDragOver={handleDragOver} onDrop={handleDrop}>
      {dropOverlay.visible && <ChatDropOverlay />}
      {compact ? (
        <div data-elanous-chat-compact-header="" className="flex h-11 max-h-11 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-background px-3 whitespace-nowrap">
          {props.leading && <div className="shrink-0">{props.leading}</div>}
          <div className="min-w-0 flex-1 [&>div]:min-w-0 [&>div]:max-w-full [&>div>div:first-child]:min-w-0 [&>div>div:first-child]:max-w-full [&>div>div:first-child]:overflow-hidden [&>div>div:first-child>span:last-child]:shrink-0 [&>div>div:first-child_span]:min-w-0 [&>div>div:first-child_span]:truncate [&>div>div[role=menu]]:max-w-[calc(100vw-4rem)]">
            <SessionPill
              sessionId={sessionId}
              {...(props.onAttachRequest ? { onAttachRequest: props.onAttachRequest } : {})}
              {...(props.onForgetRequest ? { onForgetRequest: props.onForgetRequest } : {})}
            />
          </div>
          <div ref={moreRef} className="relative shrink-0">
            <button type="button" aria-label="채팅 더보기" aria-expanded={moreOpen} aria-controls="chat-header-more" onClick={() => setMoreOpen((open) => !open)} className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted">
              <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
            </button>
            {moreOpen && (
              <div id="chat-header-more" className="absolute right-0 top-full z-50 mt-1 flex max-w-[calc(100vw-1.5rem)] flex-col gap-2 rounded-lg border border-border bg-popover p-3 shadow-lg">
                <HideInPublicCapture><BudgetPill /></HideInPublicCapture>
                <HideInPublicCapture><VoiceCostPill /></HideInPublicCapture>
                {voiceButton}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4 py-2">
          <div className="flex items-center gap-2">
            <SessionPill
              sessionId={sessionId}
              {...(props.onAttachRequest ? { onAttachRequest: props.onAttachRequest } : {})}
              {...(props.onForgetRequest ? { onForgetRequest: props.onForgetRequest } : {})}
            />
            <HideInPublicCapture><BudgetPill /></HideInPublicCapture>
            <HideInPublicCapture><VoiceCostPill /></HideInPublicCapture>
          </div>
          <div className="flex items-center gap-2">{voiceButton}</div>
        </div>
      )}
      {/* PLAN-chat-hud-multi-surface-port-2026-05-13 §4 M4 — HUD strip.
          Empty-state renders nothing, so this row is invisible until the
          daemon mirror (M3) pushes its first segment. */}
      <ChatHud />
      {/* Phase 3 (voice 일원화) — relative + flex column wrapper 가
          VoiceOverlay 의 absolute positioning 컨텍스트 + ChatHistory 의
          flex-1 sizing 을 동시에 만족. voice 활성 시 overlay 가 fade-in. */}
      <div className="relative flex flex-1 min-h-0 flex-col">
        <ChatHistory messages={messages} pending={pending} {...(props.tabId ? { tabId: props.tabId } : {})} />
        {turnBusyBanner && (
          <div
            role="alert"
            className="mx-4 mb-3 flex shrink-0 items-start justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground"
            data-elanous-turn-busy-banner=""
          >
            <div>
              <p className="font-medium">This session is busy</p>
              <p className="text-muted-foreground">{turnBusyBanner.message}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {turnBusyBanner.holder
                  ? `Current input holder: ${turnBusyBanner.holder}`
                  : 'The current input holder is not available.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setTurnBusyBanner(null)}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-amber-500/10 hover:text-foreground"
              aria-label="Dismiss busy-session notice"
            >
              Dismiss
            </button>
          </div>
        )}
        <VoiceOverlay
          active={voice.active}
          phase={voice.phase}
          errorMsg={voice.errorMsg}
          onToggle={() => void voice.toggle()}
          ttsSupported={voiceTts.supported}
          ttsMuted={ttsMuted}
          onTtsToggle={() => setTtsMuted((m) => !m)}
          onInterrupt={() => {
            // BI-1 manual barge-in (Phase D · 2026-05-09) — local TTS
            // playback cancel + UPSTREAM_INTERRUPT to daemon. Also clear
            // the chat-side voiceTts queue so a sentence-stream that
            // started rendering doesn't keep playing.
            try { voiceTts.cancel(); } catch { /* swallow */ }
            voice.interrupt();
          }}
        />
      </div>
      {pending && abortController && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-muted/30 px-4 py-1.5 text-xs">
          <span className="text-muted-foreground">streaming…</span>
          <button
            type="button"
            onClick={handleStop}
            className="rounded border border-border bg-background px-2 py-0.5 font-mono hover:bg-muted"
            data-elanous-action="chat-stop"
            title="Stop the running turn (Esc)"
          >
            Stop ⎋
          </button>
        </div>
      )}
      <ChatQueueChips
        queue={visibleQueue}
        onRemove={(id) => updateQueue(removeChat(queueRef.current, id))}
        onClear={() => updateQueue(clearChatQueue())}
      />
      <ChatInput
        onSubmit={handleSubmit}
        prefill={composerPrefill}
        attachments={pendingAttachments}
        onAttached={handleAttached}
        onRemoveAttachment={handleRemoveAttachment}
        voice={{
          active: voice.active,
          phase: voice.phase,
          dotColor: VOICE_DOT_COLOR[voice.phase],
          phaseLabel: VOICE_PHASE_LABEL[voice.phase],
          disabled: !voiceConfigured,
          onToggle: () => void voice.toggle(),
        }}
        {...(props.tabId ? { tabId: props.tabId } : {})}
        onListFiles={acpForAsk && sessionId
          ? async (query) => {
              // PWA Phase 2·A — daemon ACP `elanous/fs/list` 호출.
              const result = await acpForAsk.send('elanous/fs/list', {
                sessionId,
                query,
                limit: 50,
              }) as { cwd?: string; entries?: Array<{ name?: string; isDir?: boolean; relPath?: string }> };
              const entries = (result.entries ?? [])
                .filter((e): e is { name: string; isDir: boolean; relPath: string } =>
                  typeof e?.name === 'string' && typeof e?.isDir === 'boolean' && typeof e?.relPath === 'string')
                .map((e) => ({ name: e.name, isDir: e.isDir, relPath: e.relPath }));
              return { cwd: result.cwd ?? '', entries };
            }
          : undefined}
        onListSkills={acpForAsk && sessionId
          ? async (query) => {
              const result = await acpForAsk.send('elanous/skills/list', {
                sessionId,
                query,
              }) as { entries?: Array<{ name?: string; description?: string }> };
              const entries = (result.entries ?? [])
                .filter((e): e is { name: string; description: string } =>
                  typeof e?.name === 'string' && typeof e?.description === 'string')
                .map((e) => ({ name: e.name, description: e.description }));
              return { entries };
            }
          : undefined}
      />
      {/* M6 PR 2 — debug-tap drawer. Mounts only when the URL opted in
          via `?debug-tap=on`; close button collapses it AND turns off
          debug-tap for subsequent turns (drawerOpen drives the runtime
          flag too). Small reopen handle appears when closed so the
          user can re-expand without navigating. */}
      {debugTapInitiallyOn && (
        <>
          <DebugTapDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            lines={debugLines}
          />
          {!drawerOpen && (
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              data-elanous-debug-tap-reopen=""
              className={cn(
                'fixed bottom-3 right-3 z-40 rounded-full border border-border bg-card px-3 py-1.5',
                'text-[11px] font-mono text-muted-foreground shadow hover:bg-muted hover:text-foreground',
              )}
              aria-label="Reopen debug drawer"
              title="Reopen Debug Tap drawer"
            >
              ⌁ debug ({debugLines.length})
            </button>
          )}
        </>
      )}
      {/* M4 of PLAN-ask-user-question-cross-surface-2026-05-13 — modal
          for inbound `elanous/ask/request`. `pendingRequest` 가 non-null
          일 때만 Dialog open · close 는 cancel/submit 시 자동. */}
      <AskQuestionSheet
        request={askQuestion.pendingRequest}
        onSubmit={askQuestion.submit}
        onCancel={askQuestion.cancel}
        onChatAboutThis={askQuestion.chatAboutThis}
      />
      <ToolApprovalSheet
        request={toolApproval.pendingRequest}
        receivedAt={toolApproval.receivedAt}
        onChoose={toolApproval.choose}
        onCancel={toolApproval.cancel}
      />
    </div>
  );
}
