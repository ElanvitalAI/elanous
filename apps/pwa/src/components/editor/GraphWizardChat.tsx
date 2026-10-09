'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuietSurface } from '@/lib/quiet-surface';
import { toYaml, type CanvasGraph } from './graph-canvas-model';
import type { GraphWizardSteps } from '@/nexus/client';
import {
  WIZARD_EXAMPLES, WIZARD_UNSUPPORTED, askWizard, baseReasonLine, draftStatusLine, mergeWizardGraph, userMovedNodes, wizardPhase, wizardRequest,
  type WizardClient, type WizardDiff, type WizardTurn,
} from './graph-wizard';

/** GRAPH-WIZARD — the «말로 만들기» chat docked to the canvas (대표 10-08: «채팅창이 뜨고 거기에 원하는 것을
 *  발화를 쭉 치면 원하는 노드와 간선이 쭉 만들어진다»). Each message sends the current canvas YAML and the
 *  recent turns; the reply replaces the canvas in place, and every applied turn keeps the canvas it replaced
 *  so «되돌리기» can put it back. */

type Message =
  | { id: number; role: 'user'; text: string; undone?: boolean }
  | {
    id: number; role: 'assistant'; text: string; tone: 'ok' | 'warn' | 'error';
    status?: string; issues?: string[]; parseError?: string; baseLine?: string;
    /** The canvas before this turn was applied — present only when the turn changed the canvas. */
    before?: CanvasGraph | null; applied?: boolean; undone?: boolean; prompt?: string;
    /** The user message this answers — undo greys out (and drops from `history`) the whole turn. */
    userId?: number;
    /** The wizard's own last layout before this turn — undo puts it back so «did the user move nodes» stays true. */
    laidBefore?: CanvasGraph | null;
    /** The steps this turn's graph came with — undo of a later turn puts them back. */
    steps?: GraphWizardSteps;
  };

type NewMessage = Message extends infer M ? M extends Message ? Omit<M, 'id'> : never : never;

export interface CanvasSnapshot { graph: CanvasGraph; yaml: string }

const FIX_PROMPT = '검증 오류를 고쳐줘';

export function GraphWizardChat({
  client, current, laid, onApply, onRestore, initialPrompt, packId, className = '',
}: {
  client: WizardClient;
  /** The canvas as it stands right now (null/empty → the first message creates). */
  current: () => CanvasSnapshot | null;
  /** The canvas as it stood right after the last wizard turn/undo (from the canvas itself). Without it the chat
   *  remembers what it sent — enough when nothing transforms the layout in between. */
  laid?: () => CanvasGraph | null;
  /** `autoLayout` — the whole graph was laid out afresh (the canvas may turn it for a phone-width view). */
  /** `labels` — v2 Korean node names (absent on older daemons). */
  onApply: (graph: CanvasGraph, added: WizardDiff, autoLayout?: boolean, labels?: Record<string, string>, steps?: GraphWizardSteps) => void;
  /** `steps` — the wizard steps of the turn the canvas goes back to (none when it goes back to before any). */
  onRestore: (graph: CanvasGraph | null, steps?: GraphWizardSteps) => void;
  /** Sent once on mount — the prompt typed on the entry card before the canvas opened. */
  initialPrompt?: string;
  packId?: string;
  className?: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<{ startedAt: number; controller: AbortController } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const nextId = useRef(1);
  const listRef = useRef<HTMLOListElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const sentInitial = useRef(false);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  /** The graph as the wizard last laid it out — when the canvas still matches it, the next turn re-lays it all. */
  const lastLaid = useRef<CanvasGraph | null>(null);
  // The install banner (and any other chrome that would cover the canvas) waits while the chat is open.
  useQuietSurface('graph-wizard');

  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - pending.startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  useEffect(() => {
    const list = listRef.current;
    if (list && typeof list.scrollTo === 'function') list.scrollTo({ top: list.scrollHeight });
  }, [messages, pending, collapsed]);

  function push(message: NewMessage) {
    const id = nextId.current++;
    setMessages((all) => [...all, { ...message, id } as Message]);
    return id;
  }

  /** `base` overrides the live canvas when the caller just restored one (React has not re-rendered yet). */
  async function send(raw: string, base?: CanvasSnapshot | null, before?: number) {
    const prompt = raw.trim();
    if (pending) return;
    if (!prompt) {
      push({ role: 'assistant', text: '무엇을 만들지 한 줄로 적어 주세요.', tone: 'warn' });
      return;
    }
    const snapshot = base !== undefined ? base : current();
    const empty = !snapshot || snapshot.graph.nodes.length === 0;
    // Undone turns are not part of the conversation any more — the canvas no longer reflects them.
    const turns: WizardTurn[] = messagesRef.current
      .filter((message) => !message.undone && (before === undefined || message.id < before))
      .map((message) => ({ role: message.role, text: message.text }));
    const userId = push({ role: 'user', text: prompt });
    setInput('');
    const controller = new AbortController();
    setPending({ startedAt: Date.now(), controller });
    try {
      const outcome = await askWizard(client, { ...wizardRequest(prompt, empty ? null : snapshot!.yaml, turns), ...(packId ? { packId } : {}) }, controller.signal);
      if (outcome.kind === 'cancelled') { push({ role: 'assistant', text: '취소했습니다 — 캔버스는 그대로입니다.', tone: 'warn' }); return; }
      if (outcome.kind === 'unsupported') { push({ role: 'assistant', text: WIZARD_UNSUPPORTED, tone: 'error' }); return; }
      if (outcome.kind === 'empty') { push({ role: 'assistant', text: '무엇을 만들지 한 줄로 적어 주세요.', tone: 'warn' }); return; }
      if (outcome.kind === 'error') { push({ role: 'assistant', text: `만들기 실패: ${outcome.message}`, tone: 'error' }); return; }
      const previous = empty ? null : snapshot!.graph;
      const laidBefore = laid ? laid() : lastLaid.current;
      if (outcome.graph) {
        const keepPositions = userMovedNodes(laidBefore, previous);
        const merged = mergeWizardGraph(previous, outcome.graph, { keepPositions });
        onApply(merged.graph, merged.added, !keepPositions, outcome.labels, outcome.steps);
        // Phone widths: fold the sheet to its one-line bar so the canvas — the point of the turn — is visible.
        if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 1023.98px)').matches) setCollapsed(true);
        lastLaid.current = merged.graph;
      }
      push({
        role: 'assistant',
        text: outcome.summary ?? (empty ? '그래프 초안을 만들었습니다.' : '그래프를 고쳤습니다.'),
        tone: outcome.ok ? 'ok' : outcome.graph ? 'warn' : 'error',
        status: draftStatusLine(outcome),
        ...(baseReasonLine(outcome) ? { baseLine: baseReasonLine(outcome)! } : {}),
        ...(outcome.issues.length ? { issues: outcome.issues } : {}),
        ...(outcome.parseError ? { parseError: outcome.parseError } : {}),
        ...(outcome.graph ? { before: previous, applied: true, laidBefore, ...(outcome.steps ? { steps: outcome.steps } : {}) } : {}),
        prompt, userId,
      });
    } finally {
      setPending(null);
    }
  }

  function undo(id: number) {
    const target = messagesRef.current.find((message) => message.id === id);
    if (!target || target.role !== 'assistant' || !target.applied || target.undone) return;
    const earlier = [...messagesRef.current].reverse().find((message) => message.role === 'assistant' && message.applied && !message.undone && message.id < id);
    onRestore(target.before ?? null, earlier && earlier.role === 'assistant' ? earlier.steps : undefined);
    lastLaid.current = target.laidBefore ?? null;
    // Undoing a turn also undoes every later turn — the canvas is back to before it, and the conversation too.
    const from = target.userId ?? id;
    setMessages((all) => all.map((message) => message.id >= from ? { ...message, undone: true } : message));
  }

  function remake(id: number) {
    const target = messagesRef.current.find((message) => message.id === id);
    if (!target || target.role !== 'assistant' || !target.prompt) return;
    const base = target.applied ? (target.before ? { graph: target.before, yaml: toYaml(target.before) } : null) : undefined;
    undo(id);
    const extra = input.trim();
    void send(extra ? `${target.prompt}\n추가 지시: ${extra}` : target.prompt, base, target.userId ?? id);
  }

  function fixAgain() {
    setInput(FIX_PROMPT);
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (!initialPrompt || sentInitial.current) return;
    sentInitial.current = true;
    void send(initialPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt]);

  const latestText = [...messages].reverse().find((message) => message.role === 'assistant')?.text ?? '';
  const latestApplied = [...messages].reverse().find((message) => message.role === 'assistant' && message.applied && !message.undone)?.id;

  return (
    <aside aria-label="말로 만들기" data-testid="graph-wizard-chat"
      className={`flex min-h-0 shrink-0 flex-col border-border bg-background ${collapsed ? '' : 'max-lg:h-[38vh]'} max-lg:border-t lg:h-auto lg:w-[360px] lg:shrink-0 lg:border-l ${className}`}>
      <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm">
        <strong className="shrink-0">말로 만들기</strong>
        {collapsed && latestText
          ? <span data-testid="wizard-collapsed-line" className="min-w-0 truncate text-xs text-muted-foreground lg:hidden">{latestText}</span>
          : null}
        <span className={`text-xs text-muted-foreground ${collapsed && latestText ? 'max-lg:hidden' : ''}`}>말하면 노드와 간선이 생깁니다</span>
        <button type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}
          className="ml-auto shrink-0 whitespace-nowrap rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted lg:hidden">{collapsed ? '펼치기' : '접기'}</button>
      </header>
      <div className={`flex min-h-0 flex-1 flex-col ${collapsed ? 'max-lg:hidden' : ''}`}>
        <ol ref={listRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2 text-sm" aria-live="polite">
          {messages.length === 0 && (
            <li className="text-xs text-muted-foreground">
              <p>만들고 싶은 일을 한 줄로 적으세요. 이어서 말하면 지금 그래프를 고칩니다.</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {WIZARD_EXAMPLES.map((example) => (
                  <button key={example} type="button" onClick={() => { void send(example); }} disabled={pending !== null}
                    className="rounded-full border border-border px-2.5 py-1 text-left text-foreground hover:bg-muted disabled:opacity-50">{example}</button>
                ))}
              </div>
            </li>
          )}
          {messages.map((message) => message.role === 'user' ? (
            <li key={message.id} data-role="user" className={`max-w-[85%] self-end whitespace-pre-wrap break-words rounded-lg bg-primary/15 px-3 py-1.5 text-foreground ${message.undone ? 'opacity-50 line-through decoration-muted-foreground/60' : ''}`}>{message.text}</li>
          ) : (
            <li key={message.id} data-role="assistant" data-tone={message.tone}
              className={`rounded-lg border px-3 py-1.5 ${message.undone ? 'opacity-50' : ''} ${message.tone === 'ok' ? 'border-emerald-500/40' : message.tone === 'warn' ? 'border-amber-500/40' : 'border-red-500/40'}`}>
              <p className={message.tone === 'error' ? 'text-red-500' : 'text-foreground'}>{message.text}</p>
              {message.status && <p data-testid="wizard-status" className={`mt-0.5 text-xs ${message.tone === 'ok' ? 'text-emerald-500' : 'text-amber-500'}`}>{message.tone === 'ok' ? '✓ ' : '✗ '}{message.status}</p>}
              {message.baseLine && <p data-testid="wizard-base" className="mt-0.5 text-xs text-muted-foreground">{message.baseLine}</p>}
              {message.parseError && <p className="mt-0.5 text-xs text-red-500">초안을 캔버스에 올리지 못했습니다: {message.parseError}</p>}
              {message.issues && (
                <ul data-testid="wizard-issues" className="mt-1 list-disc pl-5 text-xs text-red-500">
                  {message.issues.map((issue, index) => <li key={index}>{issue}</li>)}
                </ul>
              )}
              {message.undone && <p className="mt-0.5 text-xs text-muted-foreground">되돌림</p>}
              <div className="mt-1 flex flex-wrap gap-1.5 text-xs">
                {message.applied && !message.undone && (
                  <button type="button" onClick={() => undo(message.id)} disabled={pending !== null}
                    title={message.id === latestApplied ? '이 답 전의 캔버스로' : '이 답과 그 뒤의 답을 모두 되돌립니다'}
                    className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50">되돌리기</button>
                )}
                {message.prompt && !message.undone && (
                  <button type="button" onClick={() => remake(message.id)} disabled={pending !== null}
                    title="이 답을 되돌리고 같은 말(+ 입력창의 추가 지시)로 다시 만듭니다"
                    className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50">다시 만들기</button>
                )}
                {message.issues && !message.undone && (
                  <button type="button" onClick={fixAgain} disabled={pending !== null}
                    className="rounded border border-amber-500/50 px-2 py-0.5 text-amber-500 hover:bg-amber-500/10 disabled:opacity-50">고쳐서 다시</button>
                )}
              </div>
            </li>
          ))}
          {pending && (
            <li role="status" data-testid="wizard-pending" className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                <span data-testid="wizard-phase" className="text-foreground">{wizardPhase(elapsed)}</span>
                <span className="tabular-nums">{elapsed}초</span>
                <button type="button" onClick={() => pending.controller.abort()} className="ml-auto rounded border border-border px-2 py-0.5 text-foreground hover:bg-muted">취소</button>
              </div>
              {/* An estimate, not a measurement: the API answers once (usually 10–30 s) — the bar never reaches the end by itself. */}
              <div className="mt-1.5 h-1 overflow-hidden rounded bg-muted" aria-hidden>
                <div className="h-full rounded bg-primary transition-[width] duration-1000 ease-linear" style={{ width: `${Math.min(92, Math.round(100 * (1 - Math.exp(-elapsed / 15))))}%` }} />
              </div>
            </li>
          )}
        </ol>
        <form className="flex items-end gap-2 border-t border-border px-3 py-2"
          onSubmit={(event) => { event.preventDefault(); void send(input); }}>
          <textarea ref={inputRef} aria-label="만들고 싶은 일" value={input} rows={2} placeholder="예: 매일 아침 AI 뉴스 요약해서 텔레그램으로"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(input); } }}
            className="min-h-[2.5rem] flex-1 resize-none rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground" />
          <button type="submit" disabled={pending !== null}
            className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">만들기</button>
        </form>
      </div>
    </aside>
  );
}

/** The prominent «말로 만들기» entry above the graph list — one line, example chips, «만들기». */
export function GraphWizardEntry({ onStart }: { onStart: (prompt: string) => void }) {
  const [text, setText] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  function start(value: string) {
    if (!value.trim()) { setHint('무엇을 만들지 한 줄로 적어 주세요.'); return; }
    setHint(null);
    onStart(value.trim());
  }
  return (
    <section aria-label="말로 만들기" data-testid="graph-wizard-entry" className="border-b border-border bg-primary/5 px-4 py-3">
      <h2 className="text-sm font-semibold">말로 만들기</h2>
      <p className="text-xs text-muted-foreground">하고 싶은 일을 말하면 그래프 초안이 생깁니다. 이어서 말하며 고치세요.</p>
      <form className="mt-2 flex flex-col gap-2 min-[640px]:flex-row min-[640px]:items-end" onSubmit={(event) => { event.preventDefault(); start(text); }}>
        <textarea aria-label="만들고 싶은 일" value={text} rows={2} onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); start(text); } }}
          placeholder="예: PR 리뷰하고 문제 없으면 머지"
          className="min-h-[2.5rem] flex-1 resize-none rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground" />
        <button type="submit" className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground">만들기</button>
      </form>
      {hint && <p role="status" className="mt-1 text-xs text-amber-500">{hint}</p>}
      <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
        {WIZARD_EXAMPLES.map((example) => (
          <button key={example} type="button" onClick={() => start(example)}
            className="rounded-full border border-border px-2.5 py-1 hover:bg-muted">{example}</button>
        ))}
      </div>
    </section>
  );
}
