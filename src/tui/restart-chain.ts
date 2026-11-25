// TUI-RESTART-NESTED-CHAIN — nested restart chains of the TUI: detect, collapse, reap.
//
// Situation: until this fix every TUI self-restart (installed-moved · seat migrate) spawned the new TUI as a CHILD with
// stdio inherited and the old TUI stayed alive waiting for it (`defaultTuiSelfRestartSpawn` · src/index.ts). Each rail
// added one more waiting `bun …/bin/elanous.mjs --resume <id>` to the pane: one session on mshq carried 38 of them.
//
// Signal propagation (why the reaper does NOT simply terminate the ancestors):
//   · every waiting wrapper exits as soon as its child exits (`exit(childExitCode)`), so killing ANY wrapper cascades
//     up to the chain root;
//   · the chain root is the pane's session leader (its parent is the els holder / pty owner). When a session leader
//     exits, the kernel sends SIGHUP to the foreground group and revokes the tty — the leaf TUI loses its terminal.
//   · SIGTERM is not safe either: the TUI's SIGTERM handler (src/tui.ts) restores the terminal on the shared pty.
// So: SIGSTOP the root first (it can no longer react to its child's exit), then SIGKILL the intermediates top-down
// (each killed wrapper's parent is already stopped or dead, so no wrapper runs its exit path). The leaf is reparented to
// launchd/init, keeps its session, process group and controlling tty. Orphaned-group SIGHUP is not triggered: the
// group's orphan count only moves on members whose parent is in a different group of the same session (none here).
// When the leaf later exits for good it sends SIGCONT to the frozen root (`thawFrozenRestartRoot`), the root sees its
// child gone and exits the way it always did (pane closes). A frozen root whose leaf is gone is thawed by the reaper.
//
// 세 얼굴: 관측 = `tui.restart nested-chain {depth}` · `self reap-chains --dry-run` 표 / 판단 근거 = ps 표의 ppid 사슬 ⊕
// 같은 세션·같은 tty / 수복과 인계 = 리프 기동 시 자기 사슬 접기 ⊕ `self reap-chains --yes`(정확 PID 만 · pkill 없음).
import { spawnSync } from 'node:child_process';

export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly stat: string;
  readonly tty: string;
  readonly rssKb: number;
  readonly command: string;
}

/** `ps -axo pid=,ppid=,pgid=,stat=,tty=,rss=,command=` — the one process table every judgement here reads. */
export const PS_TABLE_ARGS: readonly string[] = ['-axww', '-o', 'pid=,ppid=,pgid=,stat=,tty=,rss=,command='];

export function parsePsTable(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), stat: match[4]!, tty: match[5]!,
      rssKb: Number(match[6]), command: match[7]!.trim(),
    });
  }
  return rows;
}

export function readProcessTable(): ProcRow[] {
  const run = spawnSync('ps', [...PS_TABLE_ARGS], { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 ? parsePsTable(run.stdout ?? '') : [];
}

/** Flags of the root TUI command line that take a value (the value is not a subcommand). */
const VALUE_FLAGS = new Set(['--resume', '-r', '--provider', '--model', '--config-dir', '--name', '--tui', '--profile']);

export interface TuiCommand { readonly sessionId: string | null }

/**
 * The command line of an interactive elanous TUI (`bun …/bin/elanous.mjs [root flags] [--resume <id>]`), or null for
 * anything else (subcommands such as `elanous logs`, helpers such as fast-repl-child, other programs).
 */
export function parseTuiCommand(command: string): TuiCommand | null {
  const tokens = command.split(/\s+/).filter(Boolean);
  const entry = tokens.findIndex((token) => token.endsWith('/bin/elanous.mjs'));
  // The entry is the program (`elanous.mjs …` via shebang) or its interpreter's first argument (`bun elanous.mjs …`);
  // a wrapper such as `script -q /dev/null bun …/elanous.mjs` is not the TUI.
  if (entry < 0 || entry > 1) return null;
  let sessionId: string | null = null;
  for (let i = entry + 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith('--resume=')) { sessionId = token.slice('--resume='.length) || null; continue; }
    if (!token.startsWith('-')) return null;
    if (VALUE_FLAGS.has(token)) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        if (token === '--resume' || token === '-r') sessionId = next;
        i += 1;
      }
    }
  }
  return { sessionId };
}

export interface RestartChain {
  /** root → … → leaf, all on the same tty; the root is the pane-attached TUI started first. */
  readonly members: readonly ProcRow[];
  readonly sessionId: string;
  readonly root: ProcRow;
  readonly leaf: ProcRow;
  /** Wrappers between root and leaf — each only waits for its child. */
  readonly intermediates: readonly ProcRow[];
}

export type ChainAction =
  /** Root + leaf only: nothing to reclaim but the root itself, which must stay (pane session leader). */
  | { readonly kind: 'none'; readonly reason: string }
  /** SIGSTOP root, then SIGKILL intermediates top-down; leaf untouched. */
  | { readonly kind: 'collapse'; readonly stop: number; readonly kill: readonly number[]; readonly keep: number; readonly reclaimKb: number }
  /** The chain has no terminal any more (pane gone): SIGKILL every member top-down. */
  | { readonly kind: 'kill-orphan'; readonly kill: readonly number[]; readonly reclaimKb: number }
  /** A root this reaper froze earlier whose leaf has exited: SIGCONT so it exits the normal way. */
  | { readonly kind: 'thaw'; readonly cont: number };

export interface ChainPlan {
  readonly sessionId: string | null;
  readonly depth: number;
  readonly tty: string;
  readonly pids: readonly number[];
  readonly action: ChainAction;
}

const isStopped = (row: ProcRow): boolean => row.stat.startsWith('T');

/** Every restart chain in the table: a TUI whose parent is not a TUI, followed down through same-session TUI children. */
export function findRestartChains(rows: readonly ProcRow[]): RestartChain[] {
  const tui = new Map<number, { row: ProcRow; cmd: TuiCommand }>();
  for (const row of rows) {
    const cmd = parseTuiCommand(row.command);
    if (cmd) tui.set(row.pid, { row, cmd });
  }
  const children = new Map<number, Array<{ row: ProcRow; cmd: TuiCommand }>>();
  for (const entry of tui.values()) {
    if (!tui.has(entry.row.ppid)) continue;
    const list = children.get(entry.row.ppid) ?? [];
    list.push(entry);
    children.set(entry.row.ppid, list);
  }
  const chains: RestartChain[] = [];
  for (const start of tui.values()) {
    if (tui.has(start.row.ppid)) continue;
    const members = [start];
    let cursor = start;
    let ok = true;
    for (;;) {
      const next = (children.get(cursor.row.pid) ?? []).filter((child) => child.cmd.sessionId !== null);
      if (next.length === 0) break;
      if (next.length > 1) { ok = false; break; }
      cursor = next[0]!;
      members.push(cursor);
    }
    if (!ok || members.length < 2) continue;
    const leaf = members.at(-1)!;
    const sessionId = leaf.cmd.sessionId!;
    // A restart child resumes the same session as its parent; the root may have started without --resume.
    const sameSession = members.slice(1).every((member) => member.cmd.sessionId === sessionId)
      && (start.cmd.sessionId === null || start.cmd.sessionId === sessionId);
    const sameTty = members.every((member) => member.row.tty === start.row.tty);
    if (!sameSession || !sameTty) continue;
    chains.push({
      members: members.map((member) => member.row), sessionId, root: start.row, leaf: leaf.row,
      intermediates: members.slice(1, -1).map((member) => member.row),
    });
  }
  return chains;
}

/** Frozen roots left behind: a stopped TUI with no TUI descendant and no other TUI in its process group. */
export function findLeaflessFrozenRoots(rows: readonly ProcRow[]): ProcRow[] {
  const tuiRows = rows.filter((row) => parseTuiCommand(row.command) !== null);
  return tuiRows.filter((row) => isStopped(row)
    && row.pgid === row.pid
    && !tuiRows.some((other) => other.pid !== row.pid && (other.ppid === row.pid || other.pgid === row.pid)));
}

export function planChain(chain: RestartChain): ChainPlan {
  const base = { sessionId: chain.sessionId, depth: chain.members.length - 1, tty: chain.root.tty, pids: chain.members.map((row) => row.pid) };
  if (chain.root.tty === '??' || chain.root.tty === '?') {
    const kill = chain.members.map((row) => row.pid);
    return { ...base, action: { kind: 'kill-orphan', kill, reclaimKb: chain.members.reduce((sum, row) => sum + row.rssKb, 0) } };
  }
  if (chain.intermediates.length === 0) return { ...base, action: { kind: 'none', reason: 'root-and-leaf-only' } };
  return {
    ...base,
    action: {
      kind: 'collapse', stop: chain.root.pid, kill: chain.intermediates.map((row) => row.pid), keep: chain.leaf.pid,
      reclaimKb: chain.intermediates.reduce((sum, row) => sum + row.rssKb, 0),
    },
  };
}

export function planReap(rows: readonly ProcRow[]): ChainPlan[] {
  const plans = findRestartChains(rows).map(planChain);
  for (const root of findLeaflessFrozenRoots(rows)) {
    plans.push({ sessionId: parseTuiCommand(root.command)?.sessionId ?? null, depth: 0, tty: root.tty, pids: [root.pid], action: { kind: 'thaw', cont: root.pid } });
  }
  return plans;
}

export interface SignalPort {
  readonly table: () => readonly ProcRow[];
  readonly kill: (pid: number, signal: 'SIGSTOP' | 'SIGKILL' | 'SIGCONT') => void;
  readonly sleep: (ms: number) => Promise<void>;
}

export const realSignalPort: SignalPort = {
  table: readProcessTable,
  kill: (pid, signal) => { process.kill(pid, signal); },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ApplyResult { readonly ok: boolean; readonly detail: string; readonly killed: readonly number[] }

/** Apply one plan with exact pids only. Each pid is re-read (same ppid · same command) right before it is signalled. */
export async function applyChainPlan(plan: ChainPlan, original: readonly ProcRow[], port: SignalPort = realSignalPort): Promise<ApplyResult> {
  const byPid = new Map(original.map((row) => [row.pid, row]));
  const unchangedIn = (table: readonly ProcRow[], pid: number): boolean => {
    const before = byPid.get(pid);
    const now = table.find((row) => row.pid === pid);
    return Boolean(before && now && now.ppid === before.ppid && now.command === before.command);
  };
  const unchanged = (pid: number): boolean => unchangedIn(port.table(), pid);
  const action = plan.action;
  if (action.kind === 'none') return { ok: true, detail: action.reason, killed: [] };
  if (action.kind === 'thaw') {
    if (!unchanged(action.cont)) return { ok: false, detail: `pid ${action.cont} changed`, killed: [] };
    port.kill(action.cont, 'SIGCONT');
    return { ok: true, detail: `thawed ${action.cont}`, killed: [] };
  }
  if (action.kind === 'kill-orphan') {
    const fresh = port.table();
    const killed: number[] = [];
    for (const pid of action.kill) {
      if (!unchangedIn(fresh, pid)) continue;
      port.kill(pid, 'SIGKILL');
      killed.push(pid);
    }
    return { ok: true, detail: `killed ${killed.length} orphan members`, killed };
  }
  const before = port.table();
  if (!unchangedIn(before, action.stop) || !unchangedIn(before, action.keep)) return { ok: false, detail: 'root or leaf changed — skipped', killed: [] };
  port.kill(action.stop, 'SIGSTOP');
  let stopped = false;
  for (let i = 0; i < 20 && !stopped; i += 1) {
    const root = port.table().find((row) => row.pid === action.stop);
    stopped = Boolean(root && isStopped(root));
    if (!stopped) await port.sleep(100);
  }
  if (!stopped) {
    port.kill(action.stop, 'SIGCONT');
    return { ok: false, detail: `root ${action.stop} did not stop — nothing killed`, killed: [] };
  }
  // Top-down: each wrapper's parent is already stopped (root) or dead, so no wrapper reaches its exit path.
  const fresh = port.table();
  const killed: number[] = [];
  for (const pid of action.kill) {
    if (!unchangedIn(fresh, pid)) continue;
    port.kill(pid, 'SIGKILL');
    killed.push(pid);
  }
  await port.sleep(300);
  const leafAlive = port.table().some((row) => row.pid === action.keep);
  return { ok: leafAlive, detail: leafAlive ? `leaf ${action.keep} alive · root ${action.stop} frozen` : `leaf ${action.keep} gone`, killed };
}

export function formatReapPlans(plans: readonly ChainPlan[]): string {
  if (plans.length === 0) return 'reap-chains: no nested TUI restart chains.';
  const lines = plans.map((plan) => {
    const a = plan.action;
    const what = a.kind === 'collapse'
      ? `collapse: SIGSTOP root ${a.stop} · SIGKILL ${a.kill.length} wrappers (${Math.round(a.reclaimKb / 1024)} MB) · keep leaf ${a.keep}`
      : a.kind === 'kill-orphan' ? `kill-orphan: SIGKILL ${a.kill.join(' ')} (${Math.round(a.reclaimKb / 1024)} MB · no terminal)`
        : a.kind === 'thaw' ? `thaw: SIGCONT frozen root ${a.cont} (its leaf has exited)`
          : `none: ${a.reason}`;
    return `${plan.sessionId ?? '-'}  tty=${plan.tty}  depth=${plan.depth}  ${what}`;
  });
  const wrappers = plans.reduce((sum, plan) => sum + (plan.action.kind === 'collapse' ? plan.action.kill.length : plan.action.kind === 'kill-orphan' ? plan.action.kill.length : 0), 0);
  const kb = plans.reduce((sum, plan) => sum + (plan.action.kind === 'collapse' || plan.action.kind === 'kill-orphan' ? plan.action.reclaimKb : 0), 0);
  return [...lines, `total: ${plans.length} chains · ${wrappers} processes to end · ~${Math.round(kb / 1024)} MB`].join('\n');
}

/**
 * Start guard (leaf side): if this TUI is the leaf of a nested chain, log `tui.restart nested-chain {depth}` and collapse
 * it (freeze the root, end the waiting wrappers). Never throws; never touches a chain this process is not the leaf of.
 */
export async function collapseOwnRestartChain(input: {
  readonly pid?: number;
  readonly port?: SignalPort;
  readonly log: (event: string, data: Record<string, unknown>) => void;
}): Promise<ChainPlan | null> {
  try {
    const port = input.port ?? realSignalPort;
    const pid = input.pid ?? process.pid;
    const rows = port.table();
    const chain = findRestartChains(rows).find((candidate) => candidate.leaf.pid === pid);
    if (!chain) return null;
    const plan = planChain(chain);
    input.log('nested-chain', { depth: plan.depth, sessionId: plan.sessionId, pids: plan.pids, action: plan.action.kind });
    if (plan.action.kind !== 'collapse') return plan;
    const result = await applyChainPlan(plan, rows, port);
    input.log('nested-chain-collapsed', { depth: plan.depth, ok: result.ok, detail: result.detail, killed: result.killed });
    return plan;
  } catch (error) {
    input.log('nested-chain-error', { error: String(error).slice(0, 200) });
    return null;
  }
}

/** Leaf exit: SIGCONT the root this chain froze, so the pane closes the way it did before the collapse. */
export function thawFrozenRestartRoot(port: SignalPort = realSignalPort, pid: number = process.pid): number | null {
  try {
    const rows = port.table();
    const self = rows.find((row) => row.pid === pid);
    if (!self || self.pgid === pid) return null;
    const root = rows.find((row) => row.pid === self.pgid);
    if (!root || !isStopped(root) || parseTuiCommand(root.command) === null) return null;
    port.kill(root.pid, 'SIGCONT');
    return root.pid;
  } catch {
    return null;
  }
}
