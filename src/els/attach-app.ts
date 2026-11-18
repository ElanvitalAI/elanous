// els app view (ELS-ATTACH-VIEW stage 3): the herdr-shaped screen. Left: workspaces and their panes with status marks;
// middle: the selected pane live (colours, cursor); bottom: one status line. The terminal, the socket and the clock come in
// as `deps`, so the same logic runs under a real terminal and under tests. The app is a client: closing it (ctrl+b q)
// leaves the server and every pane as they were.

import { basename } from 'node:path';
import type { AttachFrame, AttachHandlers, Attached } from './attach-client.js';
import { createKeyRouter, type KeyAction } from './attach-keys.js';
import { buildSidebar, composeView, parsePaneRows, SIDEBAR_HELP, sidebarWidthFor, type PaneRow } from './attach-view.js';
import { withNewDefaults } from './cli-args.js';
import type { ElsResult } from './core.js';
import type { ElsRequest } from './server.js';

export interface AttachAppDeps {
  readonly request: (request: ElsRequest) => Promise<ElsResult>;
  readonly attach: (pane: string, size: { cols: number; rows: number }, handlers: AttachHandlers) => Attached;
  readonly write: (text: string) => void;
  readonly size: () => { cols: number; rows: number };
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly pollMs: number;
  /** What a chat pane runs: this install's `elanous` (the same program `eln` is). */
  readonly chatCommand: readonly string[];
  /** The view's own memory (side list open or closed, the last pane) — read once at start, written when it changes. */
  readonly memory: { readonly load: () => { sidebar?: boolean; lastPane?: string }; readonly save: (state: { sidebar: boolean; lastPane?: string }) => void };
  /** `--side` / `--no-side`; absent = what was remembered, else open (els) */
  readonly sidebar?: boolean;
}

export interface AttachApp {
  /** Resolves with the process exit code and an optional line for stderr when the app ends. */
  readonly done: Promise<{ code: number; message: string }>;
  readonly start: (pane?: string) => Promise<void>;
  /** Decoded key text from the terminal. */
  readonly key: (text: string) => void;
  readonly resized: () => void;
}

type Confirm = { readonly what: 'close' | 'close-workspace'; readonly target: string; readonly prompt: string };

export function createAttachApp(deps: AttachAppDeps): AttachApp {
  const router = createKeyRouter();
  let rows: PaneRow[] = [];
  let selected: string | undefined;
  const remembered = deps.memory.load();
  let sidebarOpen = deps.sidebar ?? remembered.sidebar ?? true;
  let frame = '';
  let note = '';
  let confirm: Confirm | undefined;
  let attached: Attached | undefined;
  let generation = 0;
  let timer: unknown;
  let finished = false;
  let resolveDone: (result: { code: number; message: string }) => void = () => {};
  const done = new Promise<{ code: number; message: string }>((resolve) => { resolveDone = resolve; });

  const paneSize = (): { cols: number; rows: number } => {
    const { cols, rows: height } = deps.size();
    const left = sidebarWidthFor(cols, sidebarOpen);
    return { cols: Math.max(10, cols - (left ? left + 1 : 0)), rows: Math.max(3, height - 1) };
  };
  const remember = (): void => {
    try { deps.memory.save({ sidebar: sidebarOpen, ...(selected ? { lastPane: selected } : {}) }); } catch { /* the view works without its memory */ }
  };
  const current = (): PaneRow | undefined => rows.find((row) => row.pane === selected);

  const statusText = (): string => {
    if (confirm) return ` ${confirm.prompt} · y 확인 · 다른 키 취소 `;
    const row = current();
    const where = row ? `${row.workspace} ▸ ${row.title} · ${row.state}` : 'pane 없음 — ctrl+b c 로 새 pane';
    return ` ${where}${note ? ` · ${note}` : ''} · ctrl+b ? 도움말 · q 분리 `;
  };
  const render = (): void => {
    if (finished) return;
    const { cols, rows: height } = deps.size();
    const width = sidebarWidthFor(cols, sidebarOpen);
    deps.write(composeView({ cols, rows: height, sidebar: width ? buildSidebar(rows, selected, width, height - 1) : null, frame, status: statusText() }));
  };
  const finish = (code: number, message: string): void => {
    if (finished) return;
    finished = true;
    deps.clearInterval(timer);
    generation++;
    attached?.detach();
    resolveDone({ code, message });
  };

  const select = (pane: string | undefined): void => {
    if (finished || (pane === selected && attached)) return;      // after the app ended nothing attaches or is remembered
    generation++;
    const mine = generation;
    attached?.detach();
    attached = undefined;
    selected = pane;
    frame = '';
    remember();
    if (pane) {
      attached = deps.attach(pane, paneSize(), {
        onFrame: (next: AttachFrame) => { if (mine === generation) { frame = next.screen; render(); } },
        onEnd: (code, reason) => {
          if (mine !== generation) return;
          attached = undefined;
          if (reason === 'pane exited') { note = 'pane 종료됨'; render(); return; }
          if (code !== 0 && /no els server|closed the connection|did not answer/.test(reason)) { finish(1, reason); return; }
          void refresh();
        },
      });
    }
    render();
  };

  /** Re-read the list; keep the selection when its pane still exists, else the neighbour that took its place. */
  const refresh = async (): Promise<void> => {
    const answer = await deps.request({ op: 'ls' });
    if (finished) return;
    if (answer.exitCode !== 0) { finish(1, answer.message); return; }
    const before = rows;
    rows = parsePaneRows(answer.message);
    // Clean-up policy: a pane that has exited is history. The one on screen stays until the selection leaves it (its last
    // screen is the point of looking); every other exited pane — left over from an earlier session — is closed.
    const leftovers = rows.filter((row) => row.state === 'exited' && row.pane !== selected);
    if (leftovers.length > 0) {
      for (const row of leftovers) await deps.request({ op: 'close', pane: row.pane });
      if (finished) return;
      const again = await deps.request({ op: 'ls' });
      if (again.exitCode === 0) rows = parsePaneRows(again.message);
    }
    if (selected && !rows.some((row) => row.pane === selected)) {
      const was = before.findIndex((row) => row.pane === selected);
      select(rows[Math.min(Math.max(was, 0), rows.length - 1)]?.pane);
      return;
    }
    if (!selected && rows.length > 0) {
      // First view: the pane it was left on, else the first one still running.
      select(rows.find((row) => row.pane === remembered.lastPane && row.state !== 'exited')?.pane ?? rows.find((row) => row.state !== 'exited')?.pane ?? rows[0]!.pane);
      return;
    }
    render();
  };

  const move = (step: number): void => {
    if (rows.length === 0) return;
    const at = Math.max(0, rows.findIndex((row) => row.pane === selected));
    select(rows[(at + step + rows.length) % rows.length]!.pane);
  };
  const nextWorkspace = (): void => {
    const row = current();
    if (!row || rows.length === 0) return;
    const order = [...new Set(rows.map((entry) => entry.wsId))];
    const next = order[(order.indexOf(row.wsId) + 1) % order.length];
    select(rows.find((entry) => entry.wsId === next)?.pane);
  };

  const create = async (workspace: string | undefined, what: { command: readonly string[]; title: string } = { command: [], title: '' }): Promise<void> => {
    const input = withNewDefaults({ command: [...what.command], ...(workspace ? { ws: workspace } : {}), ...(what.title ? { title: what.title } : {}) }, deps.env, deps.cwd);
    const made = await deps.request({ op: 'new', ...input });
    if (finished) return;                                         // ctrl+b q while the server was answering: done means done
    if (made.exitCode !== 0) { note = made.message; render(); return; }
    const pane = (JSON.parse(made.message) as { pane: string }).pane;
    await refresh();
    if (finished) return;
    select(pane);
  };
  const freshWorkspaceName = (): string => {
    const base = basename(deps.cwd) || 'els';
    const taken = new Set(rows.map((row) => row.workspace));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  };

  const act = (action: KeyAction, n?: number): void => {
    note = '';
    const row = current();
    switch (action) {
      case 'detach': finish(0, ''); return;
      case 'next': move(1); return;
      case 'previous': move(-1); return;
      case 'next-workspace': nextWorkspace(); return;
      case 'goto': if (n !== undefined && rows[n - 1]) select(rows[n - 1]!.pane); return;
      case 'toggle-sidebar': sidebarOpen = !sidebarOpen; remember(); attached?.resize(paneSize().cols, paneSize().rows); render(); return;
      case 'new-chat': void create(row?.workspace, { command: deps.chatCommand, title: 'elanous' }); return;
      case 'new': void create(row?.workspace); return;
      case 'new-workspace': void create(freshWorkspaceName()); return;
      case 'close': if (row) { confirm = { what: 'close', target: row.pane, prompt: `pane «${row.title}» 닫기?` }; render(); } return;
      case 'close-workspace': if (row) { confirm = { what: 'close-workspace', target: row.wsId, prompt: `작업공간 «${row.workspace}» 와 그 안의 pane 모두 닫기?` }; render(); } return;
      case 'help': note = SIDEBAR_HELP; render(); return;
    }
  };

  const settle = async (pending: Confirm): Promise<void> => {
    const answer = await deps.request(pending.what === 'close' ? { op: 'close', pane: pending.target } : { op: 'close-workspace', ws: pending.target });
    if (finished) return;
    if (answer.exitCode !== 0) note = answer.message;
    await refresh();
  };

  return {
    done,
    async start(pane) {
      try {
        timer = deps.setInterval(() => { refresh().catch((error: unknown) => finish(1, `els: ${error instanceof Error ? error.message : String(error)}`)); }, deps.pollMs);
        await refresh();
        if (finished) return;
        if (pane) select(pane);
        else if (rows.length === 0) await create(undefined);     // an empty server opens with one shell, like herdr's first workspace
      } catch (error) { finish(1, `els: ${error instanceof Error ? error.message : String(error)}`); }
    },
    key(text) {
      if (finished) return;
      for (const event of router.feed(text)) {
        if (confirm) {
          const pending = confirm;
          confirm = undefined;
          if (event.kind === 'input' && event.bytes[0] === 'y') void settle(pending);
          else { note = '취소'; render(); }
          continue;
        }
        if (event.kind === 'input') attached?.input(event.bytes);
        else if (event.kind === 'action') act(event.action, event.n);
        else { note = `ctrl+b ${event.key} 는 아직 없음`; render(); }
      }
    },
    resized() { const size = paneSize(); attached?.resize(size.cols, size.rows); render(); },
  };
}
