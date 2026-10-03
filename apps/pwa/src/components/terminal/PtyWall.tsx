'use client';

// 터미널 나란히(드라이브 RFC ⑥ 2단계 · 🅢 재분배) — elanous ↔ codex ↔ claude 를 2~3칸으로 동시에 본다.
// 칸마다 에이전트 표식 ⊕ 의도 띠(그 PTY 를 모는 `harness.decision` 최근 줄: 무엇·왜·어디로) ⊕ 실시간 화면(PtyLiveView · #21549 스트림).
// 판단은 벽 전체가 «한 번» 묻고(연합 · 5초) 칸이 나눠 쓴다 — 칸마다 묻지 않는다.

import { useEffect, useMemo, useState } from 'react';
import type { DaemonClient, DaemonTerminalSummary } from '@/lib/daemon-client';
import { maskRowsForPublic } from '@/lib/live-public';
import type { LogRow } from '@/nexus/client';
import { PtyLiveViewLazy as PtyLiveView } from './PtyLiveView.lazy';
import { agentLabel, defaultWall, intentsFor, type DecisionRow } from './pty-wall';

const KIND_TEXT: Record<string, string> = { PLAN: 'text-sky-400', ROUTE: 'text-violet-400', VERIFY: 'text-amber-400', HEAL: 'text-emerald-400', ESCALATE: 'text-rose-400', SHIP: 'text-green-400' };

export function PtyWall({ rows, client, initial, onClose, stage = false }: { rows: DaemonTerminalSummary[]; client: DaemonClient; initial: string[]; onClose: () => void; stage?: boolean }) {
  const [ids, setIds] = useState<string[]>(initial);
  useEffect(() => { if (ids.length === 0 && rows.length) setIds(defaultWall(rows)); }, [rows, ids.length]);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (ids.length) p.set('wall', ids.join(',')); else p.delete('wall');
    window.history.replaceState(null, '', `${window.location.pathname}?${p.toString()}`);
  }, [ids]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await client.fetchJson<{ logs?: DecisionRow[] }>('/v1/logs?category=harness.decision&store=@active&since=6h&limit=300');
        if (alive) setDecisions(r.logs ?? []);
      } catch { /* 옛 데몬 — 띠에 «판단 없음» */ }
    };
    void load();
    const h = window.setInterval(() => { if (!document.hidden) void load(); }, 5_000);
    return () => { alive = false; window.clearInterval(h); };
  }, [client]);
  // «공개 캡처»(`?capture=public` · 티저·블로그 녹화) — 의도 띠의 계정 이름·잔량·홈 경로를 Live 와 같은 규칙으로 가린다. 주소는 마운트 뒤에 읽는다(#418).
  const [publicCapture, setPublicCapture] = useState(false);
  useEffect(() => { if (new URLSearchParams(window.location.search).get('capture') === 'public') setPublicCapture(true); }, []);
  const shown = useMemo<DecisionRow[]>(() => (publicCapture
    ? maskRowsForPublic(decisions.map((d) => ({ ts: d.ts, category: 'harness.decision', event: 'decision', data: d.data ?? null }) as LogRow))
    : decisions), [decisions, publicCapture]);
  const picked = useMemo(() => ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is DaemonTerminalSummary => !!r), [ids, rows]);
  const toggle = (id: string) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-3)));

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#0b0a07]" aria-label="터미널 나란히" data-pty-wall>
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-700 px-3 py-2 text-xs text-zinc-200">
        <span className="font-medium">나란히 · {picked.length}/3</span>
        {rows.filter((r) => r.alive).slice(0, 14).map((r) => (
          <button key={`${r.sourceRoot?.dbPath ?? ''}:${r.id}`} type="button" onClick={() => toggle(r.id)} aria-pressed={ids.includes(r.id)}
            className={`rounded-full border px-2 py-0.5 font-mono ${ids.includes(r.id) ? 'border-emerald-500 bg-emerald-900/40 text-emerald-200' : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'}`} data-pty-wall-chip={r.id}>
            {r.kind ?? 'pty'} · {r.nickname || r.id}
          </button>
        ))}
        <button type="button" onClick={onClose} className="ml-auto rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800" aria-label="나란히 닫기">닫기</button>
      </header>
      {picked.length === 0 ? (
        <p className="p-6 text-sm text-zinc-400">위에서 PTY 를 1~3개 고르세요 — 살아 있는 에이전트 PTY 가 없으면 비어 있습니다.</p>
      ) : (
        <div className={`grid min-h-0 flex-1 gap-1 p-1 ${picked.length === 1 ? 'grid-cols-1' : picked.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {picked.map((t) => {
            const intent = intentsFor(t, shown, 2);
            return (
              <div key={`${t.sourceRoot?.dbPath ?? ''}:${t.id}`} className="flex min-h-0 flex-col overflow-hidden rounded border border-zinc-800" data-pty-wall-pane={t.id}>
                <div className="flex items-center gap-2 bg-zinc-900 px-2 py-1 text-[11px]">
                  <span className="rounded bg-violet-900/50 px-1.5 py-0.5 text-violet-200" data-pty-agent>{agentLabel(t)}</span>
                  <span className="truncate font-mono text-zinc-500">{t.id}</span>
                </div>
                <div className={`min-h-[38px] border-b border-zinc-800 bg-zinc-950/80 px-2 py-1 ${stage ? 'text-sm' : 'text-[11px]'}`} aria-label="의도 띠" data-pty-intent>
                  {intent.length === 0 ? <span className="text-zinc-500">이 PTY 를 모는 판단 신호 없음(사람이 모는 PTY 거나 MAX 계측 꺼짐)</span> : intent.map((i) => (
                    <div key={`${i.ts}-${i.what}`} className="truncate">
                      <span className={`font-mono ${KIND_TEXT[i.kind] ?? 'text-zinc-300'}`}>{i.kind}</span>{' '}
                      <span className="text-zinc-100">{i.what}</span>
                      {i.why && <span className="text-zinc-400"> · 왜: {i.why}</span>}
                      {i.target && <span className="text-zinc-500"> → {i.target}</span>}
                    </div>
                  ))}
                </div>
                <div className="min-h-0 flex-1"><PtyLiveView terminal={t} client={client} onClose={() => toggle(t.id)} /></div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
