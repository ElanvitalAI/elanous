'use client';

// BACKLOG #5 / FEATURE §15.8(?) — worktree visualization panel.
//
// /worktrees route. Shows every git worktree the active repo knows
// about, annotated with which elanous session owns it (alive / dead),
// plus orphaned-session warnings (session JSONs whose worktree dir
// vanished).
//
// Backed by GET /v1/worktrees (5s refetch). Pure read — no
// EnterWorktree / ExitWorktree from this view yet (future PR can
// add cleanup affordances).

import { useState, type ComponentType } from 'react';
import { GitBranch, AlertTriangle, RefreshCw, FolderTree, Activity, Lock, AlertCircle, Trash2 } from 'lucide-react';
import { useOptionalNexusClient } from '@/nexus/hooks/use-nexus-context';
import { useDisposeWorktree, useWorktrees } from '@/nexus/hooks/use-worktrees';
import type { DisposeWorktreeResponse } from '@/nexus/client';
import {
  classifyAndSort,
  formatRelative,
  summarize,
  type WorktreeStatus,
} from './worktree-helpers';

const STATUS_LABEL: Record<WorktreeStatus, string> = {
  orphan: 'Orphan',
  active: 'Active',
  detached: 'Detached',
  idle: 'Idle',
  main: 'Main',
};

const STATUS_CLASS: Record<WorktreeStatus, string> = {
  orphan: 'bg-error/10 text-error',
  active: 'bg-green-600/10 text-green-700',
  detached: 'bg-warning/10 text-warning',
  idle: 'bg-muted text-muted-foreground',
  main: 'bg-primary/10 text-primary',
};

const STATUS_ICON: Record<WorktreeStatus, ComponentType<{ className?: string }>> = {
  orphan: AlertTriangle,
  active: Activity,
  detached: GitBranch,
  idle: FolderTree,
  main: FolderTree,
};

export function WorktreesPanel() {
  const client = useOptionalNexusClient();
  if (!client) {
    return (
      <div className="mx-auto max-w-2xl space-y-2 p-6">
        <h1 className="text-xl font-semibold tracking-tight">Worktrees</h1>
        <p className="text-sm text-muted-foreground">
          Connect to a NEXUS daemon to see active worktrees.
        </p>
      </div>
    );
  }
  return <WorktreesPanelInner />;
}

function WorktreesPanelInner() {
  const { data, isLoading, error, refetch, isFetching } = useWorktrees();
  const dispose = useDisposeWorktree();
  const [lastResult, setLastResult] = useState<{ path: string; result: DisposeWorktreeResponse } | null>(null);
  const repoRoot = data?.repoRoot ?? null;
  const worktrees = data?.worktrees ?? [];
  const orphanedSessions = data?.orphanedSessions ?? [];
  const rows = classifyAndSort(worktrees);
  const summary = summarize(rows);
  const now = Date.now();

  // Confirm + post. We use the browser's native confirm() for v1 —
  // the panel already lives behind the same-origin guard, and a
  // worktree dispose is a meaningful enough action that the modal
  // dialog beats a custom toast confirm. Force toggle is exposed on
  // a per-action basis (locked / dirty worktrees prompt the user
  // with --force).
  const handleDispose = async (path: string, opts: { force?: boolean; locked?: boolean } = {}) => {
    const force = opts.force === true;
    const prompt = force
      ? `Force-remove this worktree (will discard local changes)?\n\n${path}`
      : opts.locked
        ? `This worktree is locked. Removing it will fail unless you force.\nProceed with --force?\n\n${path}`
        : `Remove this worktree?\n\n${path}`;
    if (typeof window !== 'undefined' && !window.confirm(prompt)) return;
    const result = await dispose.mutateAsync({ path, force: force || opts.locked === true });
    setLastResult({ path, result });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="space-y-1">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <FolderTree className="h-5 w-5" />
            Worktrees
          </h1>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh worktrees"
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-surface-elevated disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
        {repoRoot ? (
          <p className="text-[11px] font-mono text-muted-foreground">{repoRoot}</p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            No repository found. Set <code className="font-mono">harness.defaultRepo</code> (absolute path) in Settings, or start NEXUS inside a checkout.
          </p>
        )}
      </header>

      {error && (
        <p className="flex items-center gap-1 text-[11px] text-error">
          <AlertCircle className="h-3 w-3" />
          {error instanceof Error ? error.message : 'Failed to load worktrees'}
        </p>
      )}

      {isLoading && !data && (
        <p className="text-[11px] text-muted-foreground">Querying /v1/worktrees…</p>
      )}

      {data && (
        <SummaryStrip summary={summary} />
      )}

      {lastResult && (
        <div
          data-testid="worktree-dispose-result"
          data-result-status={lastResult.result.ok ? 'ok' : 'error'}
          className={`rounded-md border px-2.5 py-1.5 text-[11px] ${
            lastResult.result.ok
              ? 'border-green-600/40 bg-green-600/5 text-green-700'
              : 'border-error/40 bg-error/5 text-error'
          }`}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span>
              {lastResult.result.ok
                ? `${lastResult.result.action === 'orphan-session-cleanup' ? 'Cleared orphan session' : 'Removed worktree'} — ${lastResult.path}`
                : `Dispose failed — ${lastResult.result.error ?? 'unknown error'}`}
              {lastResult.result.detail && (
                <span className="ml-1 font-mono text-[10px] opacity-80">({lastResult.result.detail})</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => setLastResult(null)}
              className="text-[10px] underline opacity-70 hover:opacity-100"
            >
              dismiss
            </button>
          </div>
        </div>
      )}

      {data && rows.length > 0 && (
        <section data-testid="worktree-list" className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full text-[11px]">
            <thead className="bg-surface-elevated">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Status</th>
                <th className="px-2 py-1.5 text-left font-medium">Branch</th>
                <th className="px-2 py-1.5 text-left font-medium">Path</th>
                <th className="px-2 py-1.5 text-left font-medium">SHA</th>
                <th className="px-2 py-1.5 text-left font-medium">Owner</th>
                <th className="px-2 py-1.5 text-left font-medium">Entered</th>
                <th className="px-2 py-1.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ view, status }) => {
                const Icon = STATUS_ICON[status];
                return (
                  <tr
                    key={view.path}
                    data-testid={`worktree-row-${view.path}`}
                    data-status={status}
                    className="border-t border-border"
                  >
                    <td className="px-2 py-1.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${STATUS_CLASS[status]}`}
                      >
                        <Icon className="h-3 w-3" />
                        {STATUS_LABEL[status]}
                      </span>
                      {view.isLocked && (
                        <span title="locked" className="ml-1 inline-flex items-center text-warning">
                          <Lock className="h-3 w-3" />
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 font-mono">{view.branch ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{view.path}</td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">{view.sha.slice(0, 7)}</td>
                    <td className="px-2 py-1.5">
                      {view.session ? (
                        <span
                          className={`text-[10px] ${view.session.alive ? 'text-foreground' : 'text-error'}`}
                        >
                          pid {view.session.sessionId}
                          {view.session.alive ? ' (alive)' : ' (dead — orphan)'}
                        </span>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-[10px] text-muted-foreground">
                      {view.session ? formatRelative(now, view.session.enteredAt) : ''}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {view.isMain ? (
                        <span className="text-[10px] text-muted-foreground">—</span>
                      ) : (
                        <button
                          type="button"
                          data-testid={`dispose-worktree-${view.path}`}
                          onClick={() => handleDispose(view.path, { locked: view.isLocked })}
                          disabled={dispose.isPending}
                          className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-error hover:bg-error/10 disabled:opacity-50"
                          aria-label={`Dispose worktree ${view.path}`}
                        >
                          <Trash2 className="h-3 w-3" />
                          Dispose
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {data && rows.length === 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="worktree-empty">
          No worktrees registered.
        </p>
      )}

      {data && orphanedSessions.length > 0 && (
        <section data-testid="orphaned-sessions" className="space-y-1">
          <h2 className="flex items-center gap-1 text-sm font-medium text-warning">
            <AlertTriangle className="h-4 w-4" />
            Orphaned sessions ({orphanedSessions.length})
          </h2>
          <p className="text-[10px] text-muted-foreground">
            Worktree directory was removed (e.g., via <code>git worktree remove</code>)
            but the session JSON wasn&apos;t cleaned. Boot-time stale-cleanup will reap
            these the next time NEXUS restarts.
          </p>
          <ul className="space-y-1 text-[11px]">
            {orphanedSessions.map((s) => (
              <li
                key={s.sessionId}
                data-testid={`orphan-session-${s.sessionId}`}
                className="rounded-md border border-warning/40 bg-warning/5 px-2 py-1.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div>
                    <span className="font-mono">pid {s.sessionId}</span>{' '}
                    <span className="text-muted-foreground">
                      ({s.alive ? 'alive (unusual)' : 'dead'})
                    </span>
                  </div>
                  <button
                    type="button"
                    data-testid={`cleanup-orphan-${s.sessionId}`}
                    onClick={() => handleDispose(s.worktreePath)}
                    disabled={dispose.isPending}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-error hover:bg-error/10 disabled:opacity-50"
                    aria-label={`Clear orphan session ${s.sessionId}`}
                  >
                    <Trash2 className="h-3 w-3" />
                    Cleanup
                  </button>
                </div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  branch <strong>{s.branch}</strong> · {s.worktreePath}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SummaryStrip({ summary }: { summary: ReturnType<typeof summarize> }) {
  const items: { label: string; value: number; cls: string }[] = [
    { label: 'Total', value: summary.total, cls: 'text-foreground' },
    { label: 'Active', value: summary.active, cls: 'text-green-700' },
    { label: 'Orphan', value: summary.orphan, cls: 'text-error' },
    { label: 'Idle', value: summary.idle, cls: 'text-muted-foreground' },
    { label: 'Detached', value: summary.detached, cls: 'text-warning' },
  ];
  return (
    <div data-testid="worktree-summary" className="flex flex-wrap items-baseline gap-3 text-[11px]">
      {items.map((it) => (
        <span key={it.label} className="flex items-baseline gap-1">
          <span className="text-muted-foreground">{it.label}</span>
          <span className={`font-medium ${it.cls}`}>{it.value}</span>
        </span>
      ))}
    </div>
  );
}
