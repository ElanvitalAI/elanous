'use client';

import { useEffect, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { DaemonClient } from '@/lib/daemon-client';
import { toPublicText } from './public-text';
import type { DecisionsState, PtyDecision } from './pty-decisions';

type Reader = Pick<DaemonClient, 'snapshotTerminal' | 'streamTerminal'>;

const TONE: Record<PtyDecision['step'], string> = {
  read: 'border-sky-400 bg-sky-500/15 text-sky-200',
  judge: 'border-violet-400 bg-violet-500/15 text-violet-200',
  input: 'border-amber-400 bg-amber-500/15 text-amber-200',
  answer: 'border-teal-400 bg-teal-500/15 text-teal-200',
  recover: 'border-orange-400 bg-orange-500/15 text-orange-200',
  done: 'border-green-400 bg-green-500/15 text-green-200',
};

function DecisionTerminal({ client, terminalId }: { client: Reader; terminalId: string }) {
  const [view, setView] = useState<{ id: string; screen: string | null; message: string | null }>({ id: terminalId, screen: null, message: null });

  useEffect(() => {
    let active = true;
    const terminal = new Terminal({ cols: 110, rows: 40, scrollback: 10000, allowProposedApi: true });
    let ended = false;
    const waiting = () => {
      if (active && !ended) setView((previous) => ended ? previous : { ...previous, message: '터미널 화면을 기다리는 중' });
    };
    const refresh = () => {
      if (!active) return;
      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      for (let row = 0; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        const text = line?.translateToString(true) ?? '';
        // A soft-wrapped row continues the previous source line — join it, no newline (review must-fix · INSIDE1f).
        if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
        else lines.push(text);
      }
      setView({ id: terminalId, screen: toPublicText(lines.join('\n').trimEnd()), message: ended ? 'PTY 가 끝났습니다' : null });
    };
    const replace = (value: string) => {
      const match = /^\[screen (\d+)x(\d+) cursor=\(row (\d+), col (\d+), visible (?:true|false)\)\]\r?\n/.exec(value);
      if (match) {
        const cols = Number(match[1]);
        const rows = Number(match[2]);
        if (cols > 0 && rows > 0 && Number.isSafeInteger(cols) && Number.isSafeInteger(rows)) terminal.resize(cols, rows);
      }
      const body = value.slice(match?.[0].length ?? 0).replace(/\r?\n/g, '\r\n');
      const cursor = match && Number(match[3]) < terminal.rows && Number(match[4]) < terminal.cols
        ? `\x1b[${Number(match[3]) + 1};${Number(match[4]) + 1}H` : '';
      terminal.write(`\x1b[3J\x1b[H\x1b[2J${body}${cursor}`, refresh);
    };
    const append = (chunk: string) => terminal.write(chunk, refresh);
    let dispose: (() => void) | undefined;
    let receivedFrame = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || !polling || ended) return;
      try {
        const result = await client.snapshotTerminal(terminalId, { ansi: true });
        if (!active || !polling || ended) return;
        if (result.status === 'success' && typeof result.screen === 'string') replace(result.screen);
        else if (result.status === 'unknown-pty') {
          ended = true;
          polling = false;
          setView((previous) => ({ ...previous, message: 'PTY 가 끝났습니다' }));
          return;
        } else waiting();
      } catch {
        waiting();
      }
      if (active && polling && !ended) timer = setTimeout(() => { void poll(); }, 800);
    };
    const fallback = () => {
      if (polling || !active || ended) return;
      polling = true;
      void poll();
    };
    setView({ id: terminalId, screen: null, message: null });
    void client.snapshotTerminal(terminalId, { ansi: true }).then((result) => {
      if (active && !ended && !receivedFrame && result.status === 'success' && typeof result.screen === 'string') replace(result.screen);
    }).catch(() => {});
    dispose = client.streamTerminal(terminalId, {}, (ev) => {
      if (!active || ended) return;
      if (ev.type === 'reset' || ev.type === 'screen') { receivedFrame = true; replace(ev.screen); }
      else if (ev.type === 'data') { receivedFrame = true; append(ev.chunk); }
      else if (ev.type === 'end') { ended = true; polling = false; if (timer) clearTimeout(timer); setView((previous) => ({ ...previous, message: 'PTY 가 끝났습니다' })); }
      else if (ev.type === 'status') waiting();
    }, fallback);
    return () => { active = false; polling = false; if (timer) clearTimeout(timer); dispose?.(); terminal.dispose(); };
  }, [client, terminalId]);

  return (
    <section aria-label="자식 터미널" className="min-w-0 rounded-xl border border-slate-600 bg-[#0d0c08] p-5">
      <h2 className="mb-4 font-semibold">자식 터미널 · 읽기 전용</h2>
      {view.id !== terminalId || view.screen === null
        ? <p role="status">{toPublicText(view.id === terminalId && view.message ? view.message : '터미널을 기다리는 중')}</p>
        : <><pre aria-label="터미널 화면" className="min-w-0 overflow-x-auto whitespace-pre font-mono text-[0.7em] leading-[1.35]">{view.screen}</pre>
          {view.message && <p role="status">{toPublicText(view.message)}</p>}</>}
    </section>
  );
}

function Result({ result }: { result: { kind: 'pr' | 'file' | 'text'; ref: string } }) {
  const ref = toPublicText(result.kind === 'file' ? result.ref.split(/[/\\]/).at(-1) ?? '' : result.ref);
  if (result.kind === 'pr' && /^https:\/\/[^\s]+$/i.test(ref)) {
    return <a href={ref} target="_blank" rel="noopener noreferrer" className="underline">{ref}</a>;
  }
  return <span>{ref}</span>;
}

export function PtyDecisionScene({ client, decisions }: { client: Reader; decisions: DecisionsState }) {
  const items = decisions.currentMissionId ? decisions.missions[decisions.currentMissionId] ?? [] : [];
  const latest = items.at(-1);
  const terminalId = latest?.terminalId;
  return (
    <section aria-label="PTY 인텔리전스" className="grid min-w-0 grid-cols-1 gap-6 p-4 text-lg leading-relaxed min-[1440px]:grid-cols-2 min-[1440px]:text-[22px]">
      {terminalId ? <DecisionTerminal key={terminalId} client={client} terminalId={terminalId} />
        : <section aria-label="자식 터미널" className="min-w-0 rounded-xl border border-slate-600 p-5"><h2>자식 터미널</h2><p role="status">터미널을 기다리는 중</p></section>}
      <section aria-label="판단 줄" className="min-w-0 rounded-xl border border-slate-600 p-5">
        <h2 className="mb-5 font-semibold">판단 줄</h2>
        {items.length === 0 ? <p>판단을 기다리는 중</p> : (
          <ol className="space-y-4">
            {items.map((item) => (
              <li key={item.seq} aria-current={item.seq === latest?.seq ? 'step' : undefined}
                className={`min-w-0 break-words rounded-lg border-l-4 p-4 ${TONE[item.step]} ${item.seq === latest?.seq ? 'ring-2 ring-white' : ''}`}>
                <span className="inline-block rounded border border-current px-2 font-semibold">{item.step}</span>
                <p>{toPublicText(item.text)}</p>
                {item.step === 'answer' && <div><p>물음 → {toPublicText(item.detail.question)}</p><p>답 → {toPublicText(item.detail.answer)}</p></div>}
                {item.step === 'recover' && <div><p>막힘 → {toPublicText(item.detail.blocked)}</p><p>처리 → {toPublicText(item.detail.action)}</p></div>}
                {item.step === 'done' && <p>결과 → <Result result={item.detail.result} /></p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
