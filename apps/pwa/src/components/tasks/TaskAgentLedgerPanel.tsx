'use client';

import { useEffect, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';

interface LedgerTask {
  level: 'task';
  id: string;
  title: string;
  ledger?: {
    runId: string | null;
    pr: number | null;
    lastStatus: string;
    exitReason: string | null;
  };
}

interface BoardNode {
  level: 'project' | 'goal' | 'milestone' | 'task';
  id: string;
  title: string;
  children?: BoardNode[];
  ledger?: LedgerTask['ledger'];
}

type BoardState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; tasks: LedgerTask[] };

function taskCards(nodes: readonly BoardNode[]): LedgerTask[] {
  return nodes.flatMap((node) => node.level === 'task'
    ? [{ level: 'task' as const, id: node.id, title: node.title, ledger: node.ledger }]
    : taskCards(node.children ?? []));
}

export function TaskAgentLedgerPanel() {
  const { config } = useDaemon();
  const [state, setState] = useState<BoardState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    if (!config.baseUrl) {
      setState({ kind: 'error', message: 'NEXUS 연결이 설정되지 않았습니다.' });
      return;
    }
    const load = async () => {
      try {
        const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/api/task-agent/board`, {
          headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: unknown = await response.json();
        if (!data || typeof data !== 'object' || !('board' in data) || !Array.isArray(data.board)) {
          throw new Error('잘못된 보드 응답');
        }
        if (!cancelled) setState({ kind: 'ready', tasks: taskCards(data.board as BoardNode[]) });
      } catch (error) {
        if (!cancelled) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [config.baseUrl, config.token]);

  return (
    <section aria-label="Task agent ledger" className="space-y-4 rounded-2xl border border-border bg-card p-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">과제 원장</h1>
        <p className="text-sm text-muted-foreground">Task agent의 읽기 전용 과제 카드</p>
      </header>
      {state.kind === 'loading' && <p role="status" className="text-sm text-muted-foreground">과제 원장 불러오는 중…</p>}
      {state.kind === 'error' && <p role="alert" className="text-sm text-destructive">과제 원장 조회 실패: {state.message}</p>}
      {state.kind === 'ready' && (state.tasks.length === 0
        ? <p role="status" className="text-sm text-muted-foreground">과제 원장이 비어 있습니다.</p>
        : <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {state.tasks.map((task) => (
              <li key={task.id} className="min-w-0 space-y-2 rounded-xl border border-border bg-background p-4">
                <h2 className="break-words text-sm font-semibold">{task.title}</h2>
                <dl className="space-y-1 break-all text-xs text-muted-foreground">
                  <div><dt className="inline">runId: </dt><dd className="inline">{task.ledger?.runId ?? '—'}</dd></div>
                  <div><dt className="inline">PR: </dt><dd className="inline">{task.ledger?.pr != null ? `#${task.ledger.pr}` : '—'}</dd></div>
                  <div><dt className="inline">마지막 상태: </dt><dd className="inline">{task.ledger?.lastStatus ?? '—'}</dd></div>
                  <div><dt className="inline">종료 이유: </dt><dd className="inline">{task.ledger?.exitReason ?? '—'}</dd></div>
                </dl>
              </li>
            ))}
          </ul>)}
    </section>
  );
}
