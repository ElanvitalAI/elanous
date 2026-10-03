'use client';

import { useEffect, useRef, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { debugLog } from '@/lib/debug';
import { fetchChatConfig, sendChatMessage, type HostedChatConfig } from '@/lib/hosted-chat-runtime';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; config: HostedChatConfig }
  | { kind: 'unavailable' }
  | { kind: 'forbidden' };

type Message = { id: string; role: 'user' | 'assistant'; text: string; pending?: boolean };

const NO_TRIGGER = '이 워크플로에는 채팅 트리거가 없습니다';
const NO_PERMISSION = '미리보기 권한이 없습니다 — 채팅 트리거의 hostedUi 설정을 확인하세요';

export function ChatPreviewPanel({ workflow, onClose }: { workflow: string; onClose: () => void }) {
  const { config } = useDaemon();
  const [sessionId] = useState(() => crypto.randomUUID());
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const request = useRef<AbortController | null>(null);
  const nextId = useRef(0);
  const origin = config.baseUrl.replace(/\/$/, '');

  useEffect(() => {
    live.current = true;
    let cancelled = false;
    setLoad({ kind: 'loading' });
    void fetchChatConfig(workflow, { origin })
      .then((chatConfig) => {
        if (cancelled) return;
        if (!chatConfig?.path) {
          setLoad({ kind: 'unavailable' });
          debugLog('workflows.chat-preview', { workflow, outcome: 'no-trigger', chars: 0 });
          return;
        }
        setLoad({ kind: 'ready', config: chatConfig });
        debugLog('workflows.chat-preview', { workflow, outcome: 'ready', chars: 0 });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const forbidden = err instanceof Error && /^chat-config (401|403)\b/.test(err.message);
        setLoad({ kind: forbidden ? 'forbidden' : 'unavailable' });
        debugLog('workflows.chat-preview', { workflow, outcome: forbidden ? 'forbidden' : 'config-error', chars: 0 });
      });
    return () => {
      cancelled = true;
      live.current = false;
      request.current?.abort();
    };
  }, [workflow, origin]);

  const send = async () => {
    if (load.kind !== 'ready' || sending || !input.trim()) return;
    const text = input.trim();
    const userId = `u-${nextId.current++}`;
    const answerId = `a-${nextId.current++}`;
    const controller = new AbortController();
    request.current = controller;
    setMessages((prev) => [...prev, { id: userId, role: 'user', text }, { id: answerId, role: 'assistant', text: '', pending: true }]);
    setInput('');
    setError(null);
    setSending(true);
    let answer = '';
    try {
      const result = await sendChatMessage({
        origin,
        chatPath: load.config.path,
        message: text,
        sessionId,
        bearer: config.token,
        streaming: load.config.streaming,
        signal: controller.signal,
      });
      if (result.kind === 'buffered') {
        answer = result.response;
      } else {
        for await (const frame of result.frames) {
          if (!live.current) break;
          if (frame.event === 'token') {
            answer += frame.data;
            setMessages((prev) => prev.map((m) => m.id === answerId ? { ...m, text: answer } : m));
          } else if (frame.event === 'done') {
            try {
              const final = JSON.parse(frame.data) as { response?: unknown };
              if (typeof final.response === 'string') answer = final.response;
            } catch { /* keep streamed tokens */ }
            break;
          } else if (frame.event === 'error') {
            throw new Error('chat stream error');
          }
        }
      }
      if (live.current) {
        setMessages((prev) => prev.map((m) => m.id === answerId ? { ...m, text: answer, pending: false } : m));
        debugLog('workflows.chat-preview', { workflow, outcome: 'sent', chars: answer.length });
      }
    } catch (err) {
      if (live.current) {
        const forbidden = err instanceof Error && /^chat (401|403)\b/.test(err.message);
        setMessages((prev) => prev.filter((m) => m.id !== answerId));
        setError(forbidden ? NO_PERMISSION : '메시지를 보내지 못했습니다');
        debugLog('workflows.chat-preview', { workflow, outcome: forbidden ? 'forbidden' : 'send-error', chars: 0 });
      }
    } finally {
      if (live.current) setSending(false);
      if (request.current === controller) request.current = null;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium">대화 미리보기</h2>
        <button type="button" onClick={onClose} aria-label="대화 미리보기 닫기" className="text-xs text-text-tertiary hover:text-text-primary">닫기</button>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm" aria-live="polite">
        {load.kind === 'loading' && <p className="text-text-tertiary">채팅을 불러오는 중…</p>}
        {load.kind === 'unavailable' && <p role="status">{NO_TRIGGER}</p>}
        {load.kind === 'forbidden' && <p role="alert" className="text-error">{NO_PERMISSION}</p>}
        {messages.map((m) => (
          <div key={m.id} className="break-words">
            <span className="text-xs text-text-tertiary">{m.role === 'user' ? '나' : '답변'}{m.pending ? ' · 입력 중…' : ''}</span>
            <p className="whitespace-pre-wrap">{m.text}</p>
          </div>
        ))}
        {error && <p role="alert" className="text-error">{error}</p>}
      </div>
      {load.kind === 'ready' && (
        <form className="flex gap-2 border-t border-border p-3" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <input type="text" aria-label="대화 메시지" value={input} onChange={(event) => setInput(event.target.value)} disabled={sending} className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-sm" />
          <button type="submit" disabled={sending || !input.trim()} className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50">보내기</button>
        </form>
      )}
    </div>
  );
}
