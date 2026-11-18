// els app view (ELS-ATTACH-VIEW stage 3): the herdr-shaped screen. Left: workspaces and their panes with status marks;
// middle: the selected pane live (colours, cursor); bottom: one status line. The terminal, the socket and the clock come in
// as `deps`, so the same logic runs under a real terminal and under tests. The app is a client: closing it (ctrl+b q)
// leaves the server and every pane as they were.

import { basename } from 'node:path';
import type { AttachFrame, AttachHandlers, Attached } from './attach-client.js';
import { createKeyRouter, type KeyAction } from './attach-keys.js';
import { composeView, parsePaneRows, parseRemoteRows, SIDEBAR_HELP, sidebarWidthFor, type PaneRow } from './attach-view.js';
import { buildSpaceList, buildTabRow, withCommands } from './space-tabs-view.js';
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
  /**
   * The panes of other hosts (registered els hosts and `herdr`), read-only: the federated list and the federated read.
   * They join the same left list under «⇄host …»; selecting one shows its screen (polled), typing into it is refused
   * (input goes through `els do`). Absent = a local-only view.
   */
  readonly remote?: { readonly list: () => Promise<ElsResult>; readonly read: (address: string) => Promise<ElsResult> };
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
  let rows: PaneRow[] = [];                                      // this host's panes, from the owner
  let remoteRows: PaneRow[] = [];                                // other hosts' panes, from the federated list (cached)
  let lastLocal = deps.memory.load().lastPane;                    // the last LOCAL pane: a remote selection is not remembered
  let remoteBusy = false;
  let remoteStatus = '';
  let readError = '';                                            // the last remote read failure (its own status channel, apart from `note`)
  let readSeq = 0;                                               // the newest remote read; an older answer never paints over it
  let selected: string | undefined;
  let wrapped = false;                                           // ELS-ONE-SPACE: `w` wrapped this space's tab cycle — the next `w` steps to the next space
  let lsAnswer = '';                                             // the last `els ls` answer (each pane's command → its tab emoji)
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
    // ELS-ONE-SPACE: one row for the tab row over the pane whenever there is a pane to show.
    const tabRow = everyRow().length > 0 ? 1 : 0;
    return { cols: Math.max(10, cols - (left ? left + 1 : 0)), rows: Math.max(3, height - 1 - tabRow) };
  };
  const remember = (): void => {
    if (selected && !remoteRows.some((row) => row.pane === selected)) lastLocal = selected;
    try { deps.memory.save({ sidebar: sidebarOpen, ...(lastLocal ? { lastPane: lastLocal } : {}) }); } catch { /* the view works without its memory */ }
  };
  const everyRow = (): PaneRow[] => [...rows, ...remoteRows];
  const current = (): PaneRow | undefined => everyRow().find((row) => row.pane === selected);

  const statusText = (): string => {
    if (confirm) return ` ${confirm.prompt} · y 확인 · 다른 키 취소 `;
    const row = current();
    const where = row ? `${row.workspace} ▸ ${row.title} · ${row.state}${row.remote ? ' · 읽기 전용' : ''}` : 'pane 없음 — ctrl+b c 로 새 pane';
    return ` ${remoteStatus ? `${remoteStatus} · ` : ''}${where}${note ? ` · ${note}` : ''}${readError ? ` · ${readError}` : ''} · ctrl+b ? 도움말 · q 분리 `;
  };
  const render = (): void => {
    if (finished) return;
    const { cols, rows: height } = deps.size();
    const width = sidebarWidthFor(cols, sidebarOpen);
    // ELS-ONE-SPACE (대표 11-18): left = the spaces folded (no pane lines, no headings); top = the selected space's tabs.
    const shown = withCommands(everyRow(), lsAnswer);
    const tabs = buildTabRow(shown, selected, Math.max(10, cols - (width ? width + 1 : 0)));
    deps.write(composeView({ cols, rows: height, sidebar: width ? buildSpaceList(shown, selected, width, height - 1) : null, frame, status: statusText(),
      ...(tabs.line !== undefined ? { tabRow: tabs.line } : {}) }));
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
    wrapped = false;                                             // any move other than the wrap itself ends the wrap
    generation++;
    const mine = generation;
    attached?.detach();
    attached = undefined;
    selected = pane;
    frame = '';
    readError = '';
    remember();
    if (pane && remoteRows.some((row) => row.pane === pane)) {
      void showRemote(mine);                                    // read-only: a polled screen, no live attach
    } else if (pane) {
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

  /**
   * Paint the selected other-host pane: one federated read, shown as the centre screen. A stale answer — the selection moved, or
   * a newer read was started before this one came back — is dropped. A refusal AND a throw are shown the same way: a blank
   * screen and the reason in `readError`, a channel of its own so a poll never wipes a note the person is reading.
   */
  const showRemote = async (mine: number): Promise<void> => {
    const row = current();
    if (!deps.remote || !row?.remote) return;
    const request = ++readSeq;
    let answer: ElsResult;
    try { answer = await deps.remote.read(row.pane); }
    catch (error) { answer = { exitCode: 1, message: `els: ${error instanceof Error ? error.message : String(error)}` }; }
    if (finished || mine !== generation || request !== readSeq) return;
    if (answer.exitCode === 0) { frame = answer.message; readError = ''; } else { frame = ''; readError = answer.message; }
    render();
  };
  /** The other hosts' panes are gone (the list failed or threw): no stale rows, and a remote selection moves to a local pane. */
  const dropRemote = (): void => {
    remoteRows = [];
    readError = '';
    if (selected && !everyRow().some((row) => row.pane === selected)) select(rows.find((row) => row.state !== 'exited')?.pane ?? rows[0]?.pane);
    else render();
  };
  /** Re-read the other hosts' panes (own guard and cadence: a host that is down for 2 s must not slow the local list). */
  const refreshRemote = async (): Promise<void> => {
    if (!deps.remote || remoteBusy || finished) return;
    remoteBusy = true;
    try {
      let answer: ElsResult;
      try { answer = await deps.remote.list(); }
      catch (error) { answer = { exitCode: 1, message: `els: ${error instanceof Error ? error.message : String(error)}` }; }
      if (finished) return;
      if (answer.exitCode !== 0) { remoteStatus = '원격 목록 확인 불가'; dropRemote(); return; }
      try {
        const parsed = JSON.parse(answer.message) as { hosts?: unknown };
        remoteStatus = Array.isArray(parsed?.hosts) ? parsed.hosts
          .filter((host: unknown): host is { name: string; reach: string } => !!host && typeof host === 'object'
            && typeof (host as { name?: unknown }).name === 'string'
            && /^[a-zA-Z0-9._-]+$/.test((host as { name: string }).name)
            && (host as { reach?: unknown }).reach === 'down')
          .map((host: { name: string }) => `⇄${host.name} ?`).join(' · ') : '';
      } catch { remoteStatus = '원격 목록 확인 불가'; }
      remoteRows = parseRemoteRows(answer.message);
      if (selected && !everyRow().some((row) => row.pane === selected)) { select(rows.find((row) => row.state !== 'exited')?.pane ?? rows[0]?.pane); return; }
      if (current()?.remote) await showRemote(generation); else render();
    } finally { remoteBusy = false; }
  };

  /** Re-read the list; keep the selection when its pane still exists, else the neighbour that took its place. */
  const refresh = async (): Promise<void> => {
    const answer = await deps.request({ op: 'ls' });
    if (finished) return;
    if (answer.exitCode !== 0) { finish(1, answer.message); return; }
    const before = rows;
    rows = parsePaneRows(answer.message);
    lsAnswer = answer.message;
    // Clean-up policy: a pane that has exited is history. The one on screen stays until the selection leaves it (its last
    // screen is the point of looking); every other exited pane — left over from an earlier session — is closed.
    const leftovers = rows.filter((row) => row.state === 'exited' && row.pane !== selected);
    if (leftovers.length > 0) {
      for (const row of leftovers) await deps.request({ op: 'close', pane: row.pane });
      if (finished) return;
      const again = await deps.request({ op: 'ls' });
      if (again.exitCode === 0) { rows = parsePaneRows(again.message); lsAnswer = again.message; }
    }
    if (selected && !everyRow().some((row) => row.pane === selected)) {
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

  // ELS-ONE-SPACE: n/p and 1-9 move between the tabs of the selected space (herdr's tabs); w walks the same tabs further —
  // it wraps inside the space (never into the next one), and the wrap done, the next `w` steps to the next space.
  // 대표 11-18 test 원문: 두 번째 w는 «wraps inside w1, never into w2», 세 번째 w가 p3(w2)에, 1탭 스페이스는 w 한 번에 다음 스페이스로.
  const nextTab = (): void => {
    const tabs = spaceTabs();
    if (tabs.length === 0) return;
    if (wrapped || tabs.length === 1) { wrapped = false; nextWorkspace(); return; }   // one tab: nothing to walk — step at once
    const at = Math.max(0, tabs.findIndex((row) => row.pane === selected));
    if (at < tabs.length - 1) select(tabs[at + 1]!.pane);
    else { select(tabs[0]!.pane); wrapped = true; }                                    // wrap to the first tab of this space
  };
  const spaceTabs = (): PaneRow[] => {
    const all = everyRow();
    const ws = current()?.wsId ?? all[0]?.wsId;
    return all.filter((row) => row.wsId === ws);
  };
  const move = (step: number): void => {
    const tabs = spaceTabs();
    if (tabs.length === 0) return;
    const at = Math.max(0, tabs.findIndex((row) => row.pane === selected));
    select(tabs[(at + step + tabs.length) % tabs.length]!.pane);
  };
  const nextWorkspace = (): void => {
    const row = current();
    const all = everyRow();
    if (!row || all.length === 0) return;
    const order = [...new Set(all.map((entry) => entry.wsId))];
    const next = order[(order.indexOf(row.wsId) + 1) % order.length];
    select(all.find((entry) => entry.wsId === next)?.pane);
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
      case 'next-workspace': nextTab(); return;
      case 'goto': { const tabs = spaceTabs(); if (n !== undefined && tabs[n - 1]) select(tabs[n - 1]!.pane); return; }
      case 'toggle-sidebar': sidebarOpen = !sidebarOpen; remember(); attached?.resize(paneSize().cols, paneSize().rows); render(); return;
      case 'new-chat': void create(row && !row.remote ? row.workspace : undefined, { command: deps.chatCommand, title: 'elanous' }); return;
      case 'new': void create(row && !row.remote ? row.workspace : undefined); return;
      case 'new-workspace': void create(freshWorkspaceName()); return;
      case 'close': if (row?.remote) { note = `⇄${row.remote} pane 은 여기서 닫을 수 없음 (그 호스트에서)`; render(); return; } if (row) { confirm = { what: 'close', target: row.pane, prompt: `pane «${row.title}» 닫기?` }; render(); } return;
      case 'close-workspace': if (row?.remote) { note = `⇄${row.remote} 작업공간은 여기서 닫을 수 없음 (그 호스트에서)`; render(); return; } if (row) { confirm = { what: 'close-workspace', target: row.wsId, prompt: `작업공간 «${row.workspace}» 와 그 안의 pane 모두 닫기?` }; render(); } return;
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
        timer = deps.setInterval(() => { void refreshRemote(); refresh().catch((error: unknown) => finish(1, `els: ${error instanceof Error ? error.message : String(error)}`)); }, deps.pollMs);
        await refresh();
        void refreshRemote();                                      // the other hosts join the list when they answer
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
        if (event.kind === 'input') {
          if (current()?.remote) { note = `⇄${current()!.remote} pane 은 읽기 전용 — 입력은 els do ${current()!.pane} <글>`; render(); } else attached?.input(event.bytes);
        }
        else if (event.kind === 'action') act(event.action, event.n);
        else { note = `ctrl+b ${event.key} 는 아직 없음`; render(); }
      }
    },
    resized() { const size = paneSize(); attached?.resize(size.cols, size.rows); render(); },
  };
}
