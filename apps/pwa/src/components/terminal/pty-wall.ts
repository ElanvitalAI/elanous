// 터미널 나란히(드라이브 RFC ⑥ 2단계) — 칸 고르기 · 에이전트 표식 · 의도 띠(순수 · 시험 대상).
// 의도 띠 = 그 PTY 를 «모는 두뇌»의 `harness.decision` 최근 줄: 같은 런(runId) ⊕ 어디로(target)가 그 PTY 인 판단.

import type { DaemonTerminalSummary } from '@/lib/daemon-client';

export interface DecisionRow { ts: string; data?: Record<string, unknown> | null }
export interface Intent { ts: string; kind: string; what: string; why: string | null; target: string | null }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

const AGENT_NAME: Record<string, string> = { codex: 'codex', claude: 'claude', gemini: 'gemini', grok: 'grok', self: 'elanous', mission: 'elanous 미션', shell: '셸', pty: 'PTY' };

/** «에이전트: codex · 런 8e1f…» — 종류가 없으면 PTY. */
export function agentLabel(t: Pick<DaemonTerminalSummary, 'kind' | 'runId' | 'externalToolName'>): string {
  const name = (t.externalToolName && AGENT_NAME[t.externalToolName]) || (t.kind && AGENT_NAME[t.kind]) || t.externalToolName || t.kind || 'PTY';
  return `에이전트: ${name}${t.runId ? ` · 런 ${t.runId.replace(/^run-/, '').slice(0, 8)}` : ''}`;
}

/** 기본 칸 — 살아 있는 PTY 중 에이전트(codex·claude·self·mission)를 먼저, 최대 3. */
export function defaultWall(rows: readonly DaemonTerminalSummary[], max = 3): string[] {
  const alive = rows.filter((r) => r.alive);
  const agents = alive.filter((r) => r.kind && ['codex', 'claude', 'self', 'mission', 'gemini', 'grok'].includes(r.kind));
  const rest = alive.filter((r) => !agents.includes(r));
  return [...agents, ...rest].slice(0, max).map((r) => r.id);
}

/** URL `?wall=a,b,c` ↔ 칸 목록(최대 3). */
export function wallFromSearch(search: string): string[] {
  const raw = new URLSearchParams(search).get('wall');
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 3) : [];
}

/** 그 PTY 의 최근 판단 — 같은 런, 또는 어디로가 그 PTY id. 최신이 앞. */
export function intentsFor(t: Pick<DaemonTerminalSummary, 'id' | 'runId'>, rows: readonly DecisionRow[], limit = 3): Intent[] {
  return rows
    .filter((r) => {
      const d = r.data ?? {};
      return (!!t.runId && d.runId === t.runId) || d.target === t.id || d.shard === t.id;
    })
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, limit)
    .map((r) => {
      const d = r.data ?? {};
      return { ts: r.ts, kind: (str(d.kind) ?? 'PLAN').toUpperCase(), what: str(d.what) ?? '(판단)', why: str(d.reason) ?? str(d.why) ?? str(d.purpose), target: str(d.target) };
    });
}
