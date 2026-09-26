'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Loader2, MessagesSquare, Mic, MicOff, Sparkles, Square, TerminalSquare, Volume2, VolumeX } from 'lucide-react';
import { toast } from 'sonner';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { ChatHistory } from '@/components/chat/ChatHistory';
import { ChatInput } from '@/components/chat/ChatInput';
import { BudgetPill } from '@/components/chat/BudgetPill';
import { ProviderPicker } from '@/components/chat/ProviderPicker';
import { SessionPill } from '@/components/chat/SessionPill';
import { VoiceCostPill } from '@/components/chat/VoiceCostPill';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { debugLog } from '@/lib/debug';
import type { AttachmentMeta } from '@/lib/upload-attachment';
import type { VoicePhase } from '@/voice/use-voice-controller';
import { useVoiceTts } from '@/voice/use-voice-tts';
import {
  dispatchMeta,
  newMetaMessage,
  newUserMessage,
  type ChatMessage,
  type MetaResult,
} from '@/lib/chat-runtime';
import {
  buildMirroredMessage,
  countDroppedAttachments,
  type ReplMirrorKind,
} from '@/lib/dock-history-mirror';
import { fetchDockHistory } from '@/lib/dock-history-hydrate';

const QUICK_TERMINAL_COMMANDS = [
  ':cwd',
  ':capture',
  ':peers',
  ':tab next',
  ':tab prev',
] as const;
const HISTORY_LIMIT = 200;

export interface TerminalChatDockHandle {
  /** BACKLOG #15 — append a mirrored REPL event into the dock's
   *  history. TerminalPanel forwards `TerminalRepl.onMirror` here. */
  appendMirrored: (event: ReplMirrorKind) => void;
  /** Phase 2 (webterm voice control) — TerminalPanel-owned voice
   *  controller routes STT `final` transcripts here when activeMicSource
   *  === 'dock'. Skips the call when a turn is already in flight (B2
   *  risk mitigation, mirrors ChatLayout `pendingRef`). */
  submitVoiceTranscript: (text: string) => void;
}

/** Phase 2 — voice mirror props from TerminalPanel. Same shape as
 *  ChatInputVoiceProps so dock header mic + ChatInput inline mic can
 *  share state with one controller (mirrors ChatLayout pattern). */
export interface TerminalChatDockVoiceProps {
  active: boolean;
  phase: VoicePhase;
  dotColor: string;
  phaseLabel: string;
  disabled?: boolean;
  /** Click handler for both header + inline mic. TerminalPanel sets
   *  `activeMicSource = 'dock'` *before* toggling so onTranscript routes
   *  the next final to the dock. */
  onToggle: () => void;
}

interface Props {
  terminalId: string;
  open: boolean;
  replOpen: boolean;
  onToggleRepl: () => void;
  /** Parent-measured vertical allocation; absent or invalid values keep the legacy CSS budget. */
  height?: number;
  voice?: TerminalChatDockVoiceProps;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function normalizeMetaOutput(raw: string | undefined): string {
  const plain = stripAnsi(raw ?? '').replace(/\r/g, '').trim();
  return plain.length > 0 ? plain : '(no output)';
}

export const TerminalChatDock = forwardRef<TerminalChatDockHandle, Props>(function TerminalChatDock(
  { terminalId, open, replOpen, onToggleRepl, height, voice },
  ref,
) {
  const externalHeight = typeof height === 'number' && Number.isFinite(height) && height > 0
    ? height
    : undefined;
  const { client, config, setConfig, sessionId, setSessionId } = useDaemon();
  const latestSessionIdRef = useRef(sessionId);
  const acpRef = useRef<ReturnType<typeof client.connectAcp> | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentMeta[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  // Phase 2 — voice transcript routing. ref pattern mirrors ChatLayout
  // `handleSubmitRef` (chat.voice.auto-send) so the long-lived voice
  // controller callback always reaches the latest handleSubmit closure
  // (which closes over latest pending/messages each render).
  const latestSubmitRef = useRef<(text: string) => Promise<void>>(async () => {});
  const pendingRef = useRef(false);
  pendingRef.current = pending;

  // ACP streaming Phase C+D (PLAN v1.2 · 2026-05-07) — placeholder id
  // for the in-flight assistant turn. The session/update listener (mounted
  // below) appends each `agent_message_chunk` text fragment into the
  // message with this id. handleSubmit sets it on turn start, clears
  // it in finally. null = no in-flight turn (listener no-ops).
  const currentPlaceholderRef = useRef<string | null>(null);
  // Phase D — TTS wire (chat ChatLayout pattern mirror). voice.active +
  // !ttsMuted gates Web Speech API output. Sentence boundary handled
  // inside useVoiceTts.pushText.
  const [ttsMuted, setTtsMuted] = useState(false);
  const voiceTts = useVoiceTts({
    enabled: Boolean(voice?.active) && !ttsMuted,
    language: 'ko-KR',
  });
  const voiceTtsRef = useRef(voiceTts);
  voiceTtsRef.current = voiceTts;

  useEffect(() => {
    latestSessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    try { acpRef.current?.close(); } catch { /* swallow */ }
    acpRef.current = null;
    if (!open || !sessionId) return undefined;
    acpRef.current = client.connectAcp({ sessionId });
    return () => {
      try { acpRef.current?.close(); } catch { /* swallow */ }
      acpRef.current = null;
    };
  }, [client, open, sessionId]);

  // ACP streaming Phase C (PLAN v1.2 · 2026-05-07) — subscribe to
  // `session/update` notifications on this dock's ACP connection.
  // `agent_message_chunk` content.text fragments append into the
  // current placeholder assistant message; handleSubmit sets/clears
  // currentPlaceholderRef so this listener no-ops between turns.
  // Cross-surface broadcast bonus: when other surfaces send chunks
  // they also arrive here — but we ignore them (placeholder unset)
  // unless we own the in-flight turn. Future P1 work will route
  // foreign-surface chunks into a separate "remote turn" affordance.
  useEffect(() => {
    const acp = acpRef.current;
    if (!acp || !open || !sessionId) return undefined;
    const off = acp.on('sessionUpdate', (frame) => {
      const placeholderId = currentPlaceholderRef.current;
      if (!placeholderId) return;
      const params = frame.params as
        | { sessionId?: string; update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }
        | undefined;
      if (!params || params.sessionId !== sessionId) return;
      const update = params.update;
      if (!update) return;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
        const delta = update.content.text;
        if (delta.length === 0) return;
        setMessages((prev) => prev.map((m) =>
          m.id === placeholderId
            ? { ...m, text: (m.text ?? '') + delta }
            : m,
        ));
        // Phase D — TTS push (delta only; useVoiceTts buffers + speaks on
        // sentence boundary). enabled gate inside the hook means this is
        // safe to call unconditionally; it no-ops when voice/tts off.
        voiceTtsRef.current.pushText(delta);
      }
    });
    return off;
  }, [open, sessionId]);

  // BACKLOG #11 — cross-surface history hydrate. dock open / sessionId
  // 변경 시 daemon-side history 를 한 번 fetch 해서 messages state 를
  // 초기화. 이전에 다른 surface (cli/tg/dc) 에서 진행된 turn 들이
  // dock 안에서도 보이도록. fetchDockHistory 는 404/503/network 모두
  // 조용히 null 반환 — 새 sessionId 또는 NEXUS PR k 이전 상태에서도
  // dock 이 빈 messages 로 정상 작동.
  const hydratedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !sessionId) return;
    if (hydratedSessionRef.current === sessionId) return;
    hydratedSessionRef.current = sessionId;
    let cancelled = false;
    void (async () => {
      const history = await fetchDockHistory(client, sessionId);
      if (cancelled || history === null) return;
      // Replace (not append) — fresh sessionId 변경 시 이전 dock state
      // drop 이 의도. 사용자가 같은 sessionId 안에서 dock 재 mount 면
      // server history 와 in-memory history 가 동일 (latest 200 cap).
      setMessages(history);
    })();
    return () => { cancelled = true; };
  }, [client, open, sessionId]);

  const append = useCallback((msg: ChatMessage): void => {
    setMessages((prev) => [...prev, msg].slice(-HISTORY_LIMIT));
  }, []);

  // BACKLOG #15 — imperative handle so TerminalPanel can forward
  // TerminalRepl events into the dock's unified history without lifting
  // messages state to a parent.
  // Phase 2 (webterm voice) — adds submitVoiceTranscript so the panel-
  // owned useVoiceController can route final STT transcripts here when
  // activeMicSource === 'dock'. ref-based dispatch keeps the handle
  // identity stable across renders (no re-create on handleSubmit
  // identity change).
  useImperativeHandle(ref, () => ({
    appendMirrored: (event: ReplMirrorKind): void => {
      append(buildMirroredMessage(event));
      debugLog('webterm.terminal-chat.mirror', {
        terminalId,
        kind: event.kind,
      });
    },
    submitVoiceTranscript: (text: string): void => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (pendingRef.current) {
        debugLog('webterm.terminal-chat.voice.skip-pending', { len: trimmed.length });
        return;
      }
      debugLog('webterm.terminal-chat.voice.auto-send', { len: trimmed.length });
      void latestSubmitRef.current(trimmed);
    },
  }), [append, terminalId]);

  const ensureAcp = useCallback(() => {
    const sid = latestSessionIdRef.current;
    if (!sid) return null;
    if (acpRef.current) return acpRef.current;
    acpRef.current = client.connectAcp({ sessionId: sid });
    return acpRef.current;
  }, [client]);

  const ctx = useMemo(() => ({
    client,
    sessionId,
    provider: config.provider,
    setSessionId,
    setProvider: (p: string) => setConfig({ provider: p }),
    daemon: { baseUrl: config.baseUrl, ...(config.token ? { token: config.token } : {}) },
    messages,
  }), [client, config.baseUrl, config.provider, config.token, messages, sessionId, setConfig, setSessionId]);

  const handleAttached = useCallback((entries: AttachmentMeta[]): void => {
    setPendingAttachments((prev) => [...prev, ...entries]);
    debugLog('webterm.terminal-chat.attach.queue', {
      terminalId,
      added: entries.length,
      filenames: entries.map((e) => e.filename),
    });
  }, [terminalId]);

  const handleRemoveAttachment = useCallback((id: string): void => {
    setPendingAttachments((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const executeMeta = useCallback(async (line: string): Promise<void> => {
    const meta: MetaResult | null = await dispatchMeta(line, ctx);
    if (meta) {
      if (meta.text === '__CLEAR__') {
        setMessages([]);
      } else {
        append(newMetaMessage(meta.text, terminalId));
      }
      if (meta.newSessionId) setSessionId(meta.newSessionId);
      if (meta.newProvider !== undefined) setConfig({ provider: meta.newProvider });
      return;
    }

    if (!sessionId) {
      append(newMetaMessage('session 미설정', terminalId));
      return;
    }
    const acp = ensureAcp();
    if (!acp) {
      append(newMetaMessage('session 미설정', terminalId));
      return;
    }
    const res = (await acp.send('terminal/repl/exec', {
      sessionId,
      terminalId,
      line,
    })) as {
      output?: string;
      sessionIdChange?: string;
      tabIntent?: 'next' | 'prev' | number;
      injectPath?: string;
      agentChatModeEnter?: boolean;
    } | undefined;
    append(newMetaMessage(normalizeMetaOutput(res?.output), terminalId));
    if (res?.sessionIdChange) setSessionId(res.sessionIdChange);
    if (res?.tabIntent !== undefined) {
      append(newMetaMessage(`tab intent → ${String(res.tabIntent)}`, terminalId));
    }
    if (res?.injectPath) {
      append(newMetaMessage(`captured → ${res.injectPath}`, terminalId));
    }
    if (res?.agentChatModeEnter) {
      append(newMetaMessage('agent chat mode hint — terminal dock already runs plain text as agent turns', terminalId));
    }
  }, [append, ctx, ensureAcp, sessionId, setConfig, setSessionId, terminalId]);

  const triggerAbort = useCallback(async (): Promise<void> => {
    const sid = latestSessionIdRef.current;
    if (!sid || !pendingPrompt) return;
    try {
      const acp = ensureAcp();
      if (!acp) return;
      const res = (await acp.send('terminal/repl/agent/abort', {
        sessionId: sid,
        terminalId,
      })) as { aborted?: boolean } | undefined;
      debugLog('webterm.terminal-chat.abort', {
        terminalId,
        aborted: res?.aborted ?? false,
      });
      append(newMetaMessage(res?.aborted ? 'agent turn aborted' : 'no active agent turn to abort', terminalId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      append(newMetaMessage(`abort failed: ${msg}`, terminalId));
    } finally {
      setPending(false);
      setPendingPrompt(null);
    }
  }, [append, ensureAcp, pendingPrompt, terminalId]);

  const handleSubmit = useCallback(async (text: string): Promise<void> => {
    const attached = pendingAttachments;
    setPendingAttachments([]);

    // BACKLOG #16 — surface silent attachment drops. daemon-side
    // normalizer rejects entries without a `path`; previously this
    // only emitted a debug.log and the user had no signal that some
    // files weren't sent.
    const droppedCount = countDroppedAttachments(attached);
    if (droppedCount > 0) {
      const label = droppedCount === 1
        ? '첨부 1건이 path 누락으로 누락됐습니다'
        : `첨부 ${droppedCount}건이 path 누락으로 누락됐습니다`;
      toast.warning(label);
      append(newMetaMessage(`⚠ ${label}`, terminalId));
      debugLog('webterm.terminal-chat.attach.dropped', {
        terminalId,
        droppedCount,
        totalCount: attached.length,
      });
    }

    if (text.length > 0) append(newUserMessage(text, terminalId));
    if (attached.length > 0) {
      append(newMetaMessage(`📎 attached: ${attached.map((e) => e.filename).join(', ')}`, terminalId));
    }

    const trimmed = text.trim();
    if (!trimmed && attached.length === 0) return;

    setPending(true);
    try {
      if (trimmed.startsWith(':')) {
        await executeMeta(trimmed);
        return;
      }
      if (!sessionId) {
        append(newMetaMessage('session 미설정', terminalId));
        return;
      }
      const acp = ensureAcp();
      if (!acp) {
        append(newMetaMessage('session 미설정', terminalId));
        return;
      }
      setPendingPrompt(trimmed);
      // ACP streaming Phase C+D — pre-allocate the assistant placeholder
      // so the session/update listener has a stable target to append into.
      // Each chunk landing in this placeholder also pushes its delta to
      // useVoiceTts (enabled flag inside the hook gates Web Speech). Final
      // res.agent.markdown is reconciled into the same placeholder below.
      const placeholderId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      currentPlaceholderRef.current = placeholderId;
      append({
        id: placeholderId,
        role: 'assistant',
        text: '',
        timestamp: Date.now(),
        // ⭐ 답도 «어느 터미널»의 답인지 자기가 말한다 — 탭을 바꿔도 안 흔들린다.
        terminalId,
      });
      debugLog('webterm.terminal-chat.turn.start', {
        terminalId,
        sessionId,
        len: trimmed.length,
        attachCount: attached.length,
        placeholderId,
      });
      const res = (await acp.send('terminal/repl/exec', {
        sessionId,
        terminalId,
        line: `:agent ${trimmed}`,
        attachments: attached,
      })) as {
        output?: string;
        agent?: {
          markdown: string;
          modelLabel: string;
          stopReason: string;
          contextLines: number;
        };
      } | undefined;
      if (res?.agent) {
        // Streaming chunks already populated placeholder.text via the
        // session/update listener. Reconcile final markdown (handles the
        // case where streaming was unavailable — vanilla path keeps
        // working) and attach modelLabel/stopReason meta.
        setMessages((prev) => prev.map((m) =>
          m.id === placeholderId
            ? {
                ...m,
                text: m.text && m.text.length >= res.agent!.markdown.length
                  ? m.text
                  : res.agent!.markdown,
                meta: {
                  provider: res.agent!.modelLabel,
                  stopReason: res.agent!.stopReason,
                },
              }
            : m,
        ));
        // Flush remaining buffer (no terminator) so the last partial
        // sentence reaches Web Speech.
        voiceTtsRef.current.flush();
      } else {
        // Non-agent meta path (e.g., :tab next echoed via agent route).
        // Drop the empty placeholder, surface the meta output instead.
        setMessages((prev) => prev.filter((m) => m.id !== placeholderId));
        append(newMetaMessage(normalizeMetaOutput(res?.output), terminalId));
      }
      debugLog('webterm.terminal-chat.turn.end', {
        terminalId,
        hasAgent: !!res?.agent,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Drop placeholder so error shows as a system message (not a half-
      // streamed assistant turn). Cancel TTS in case partials were
      // already speaking.
      const ph = currentPlaceholderRef.current;
      if (ph) setMessages((prev) => prev.filter((m) => m.id !== ph));
      voiceTtsRef.current.cancel();
      append(newMetaMessage(`error: ${msg}`, terminalId));
      toast.error(`terminal chat failed: ${msg}`);
    } finally {
      currentPlaceholderRef.current = null;
      setPending(false);
      setPendingPrompt(null);
    }
  }, [append, ensureAcp, executeMeta, pendingAttachments, sessionId, terminalId]);

  // Phase 2 (webterm voice) — keep the latest handleSubmit reference
  // available to the panel-owned voice controller. Panel calls
  // ref.current.submitVoiceTranscript(text) → this ref fires the
  // handler that closes over current pending/messages state.
  useEffect(() => {
    latestSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  if (!open) return null;

  return (
    <div className="shrink-0 border-t border-border bg-background/95">
      <div className="flex items-center gap-2 border-b border-border/80 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary">
            <MessagesSquare className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">Terminal Chat Dock</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {terminalId} · plain text = contextual agent turn · <code className="rounded bg-muted px-1">:commands</code> stay local
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Phase 2 (webterm voice control · PLAN v1.1) — header mic
              toggle. Panel sets activeMicSource='dock' before this
              fires so STT finals route into submitVoiceTranscript. */}
          {voice && (
            <button
              type="button"
              onClick={voice.onToggle}
              disabled={voice.disabled}
              title={voice.disabled ? '마이크 사용 불가 (insecure context 등)' : voice.phaseLabel}
              data-elanous-action="webterm-voice-toggle-dock"
              aria-pressed={voice.active}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px]',
                voice.active
                  ? 'border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-100'
                  : 'border-border hover:bg-accent',
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
              <span className="hidden sm:inline">{voice.phaseLabel}</span>
            </button>
          )}
          {/* Phase D — TTS mute toggle. Only meaningful when voice is
              active (else hook is no-op anyway). Hidden when Web Speech
              unsupported so we don't show a dead button. */}
          {voice && voice.active && voiceTts.supported && (
            <button
              type="button"
              onClick={() => {
                if (!ttsMuted) voiceTtsRef.current.cancel();
                setTtsMuted((m) => !m);
              }}
              title={ttsMuted ? '음성 응답 켜기' : '음성 응답 끄기'}
              data-elanous-action="webterm-tts-mute-toggle"
              aria-pressed={ttsMuted}
              className={cn(
                'inline-flex h-7 items-center justify-center rounded-md border px-2 text-[11px]',
                ttsMuted
                  ? 'border-border bg-muted text-muted-foreground'
                  : 'border-fuchsia-300 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-700 dark:bg-fuchsia-950/40 dark:text-fuchsia-100',
              )}
            >
              {ttsMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </button>
          )}
          <SessionPill />
          <BudgetPill />
          {/* PP-V-2 webterm (BACKLOG-webterm §3.1 · 2026-05-07) — month-to-date
              STT/TTS USD pill mirror of /chat header. PR #1891 컴포넌트 재사용 ·
              daemon URL 미설정 시 자동 hidden. */}
          <VoiceCostPill />
          <ProviderPicker />
          {pendingPrompt && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void triggerAbort()}
              title="abort active terminal-context agent turn"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </Button>
          )}
          <div className="relative">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setQuickOpen((v) => !v)}
              aria-label="terminal quick commands"
              title="terminal quick commands"
            >
              <Sparkles className="h-3.5 w-3.5" />
            </Button>
            {quickOpen && (
              <div className="absolute right-0 top-full z-40 mt-1 w-44 rounded-md border border-border bg-popover p-1 shadow-md">
                {QUICK_TERMINAL_COMMANDS.map((cmd) => (
                  <button
                    key={cmd}
                    type="button"
                    className="block w-full rounded px-2 py-1 text-left font-mono text-[11px] hover:bg-accent"
                    onClick={() => {
                      setQuickOpen(false);
                      void handleSubmit(cmd);
                    }}
                  >
                    {cmd}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            variant={replOpen ? 'secondary' : 'outline'}
            size="sm"
            onClick={onToggleRepl}
            title={replOpen ? 'hide command strip' : 'show command strip'}
          >
            <TerminalSquare className="h-3.5 w-3.5" />
            {replOpen ? 'REPL on' : 'REPL off'}
          </Button>
        </div>
      </div>
      {pendingPrompt && (
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="truncate">
            terminal-context agent turn in progress
            {pendingPrompt.length > 0 ? ` · ${pendingPrompt.slice(0, 120)}${pendingPrompt.length > 120 ? '…' : ''}` : ''}
          </span>
        </div>
      )}
      <div
        className={cn(
          'grid grid-rows-[1fr_auto]',
          externalHeight === undefined ? 'h-[clamp(160px,30vh,360px)] min-h-[200px]' : undefined,
        )}
        {...(externalHeight === undefined ? {} : { style: { height: externalHeight } })}
      >
        <ChatHistory messages={messages} pending={pending} tabId={`dock-${terminalId}`} />
        <ChatInput
          onSubmit={handleSubmit}
          disabled={pending}
          attachments={pendingAttachments}
          onAttached={handleAttached}
          onRemoveAttachment={handleRemoveAttachment}
          tabId={`dock-${terminalId}`}
          {...(voice ? { voice } : {})}
        />
      </div>
    </div>
  );
});
