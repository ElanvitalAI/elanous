import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { GraphRunState } from './runner.js';

export interface GraphNotificationEvent {
  id: string;
  graphId: string;
  runId: string;
  nodeId: string;
  kind: 'approval' | 'node';
  visit: number;
  message: string;
  status?: 'ok' | 'fail';
}

export interface GraphNotifyOptions {
  root?: string;
  graphsDir?: string;
  dryRun?: boolean;
  send?: (message: string, event: GraphNotificationEvent) => Promise<void> | void;
}

type NotificationSetting = boolean | string | { on?: string | string[]; enabled?: boolean };
type NodeDeclaration = { node_id?: string; notify?: NotificationSetting };

function filesUnder(dir: string, extension: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => entry.isDirectory()
    ? filesUnder(join(dir, entry.name), extension)
    : entry.isFile() && entry.name.endsWith(extension) ? [join(dir, entry.name)] : []).sort();
}

function declarations(graphsDir: string): Map<string, Map<string, NodeDeclaration>> {
  const graphs = new Map<string, Map<string, NodeDeclaration>>();
  for (const file of [...filesUnder(graphsDir, '.yaml'), ...filesUnder(graphsDir, '.yml')].sort()) {
    const doc: unknown = parseYaml(readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
    const graph = doc as { graph_id?: unknown; nodes?: unknown };
    if (typeof graph.graph_id !== 'string' || !Array.isArray(graph.nodes)) continue;
    const nodes = new Map<string, NodeDeclaration>();
    for (const raw of graph.nodes) {
      if (raw && typeof raw === 'object' && typeof (raw as NodeDeclaration).node_id === 'string') {
        const node = raw as NodeDeclaration;
        nodes.set(node.node_id!, node);
      }
    }
    graphs.set(graph.graph_id, nodes);
  }
  return graphs;
}

function wantsNotification(setting: NotificationSetting | undefined, kind: 'approval' | 'node', status?: 'ok' | 'fail'): boolean {
  // Approval gates notify by default; ordinary nodes are opt-in.
  if (setting === undefined) return kind === 'approval';
  if (typeof setting === 'boolean') return setting;
  if (typeof setting === 'object' && setting !== null) {
    if (setting.enabled === false) return false;
    if (setting.on === undefined) return setting.enabled === true || kind === 'approval';
    return (Array.isArray(setting.on) ? setting.on : [setting.on]).some((value) => matches(value, kind, status));
  }
  return matches(setting, kind, status);
}

function matches(value: string, kind: 'approval' | 'node', status?: 'ok' | 'fail'): boolean {
  return value === 'always' || value === 'all' || value === (kind === 'approval' ? 'approval' : 'node') ||
    (kind === 'node' && (value === status || value === (status === 'ok' ? 'success' : 'failure')));
}

export function formatApprovalMessage(event: Pick<GraphNotificationEvent, 'graphId' | 'runId' | 'nodeId' | 'message'>): string {
  return `Graph ${event.graphId} / run ${event.runId} — approval required at ${event.nodeId}\n${event.message}\nApprove: elanous graph approve ${event.graphId} ${event.runId}\nReject: elanous graph approve ${event.graphId} ${event.runId} --reject`;
}

/** Observe persisted runs only. Notification progress lives exclusively in the JSONL ledger. */
export function collectGraphEvents(options: Pick<GraphNotifyOptions, 'root' | 'graphsDir'> = {}): GraphNotificationEvent[] {
  const root = options.root ?? effectiveInstanceRoot();
  const graphsDir = options.graphsDir ?? join(process.cwd(), 'graphs');
  const graphs = declarations(graphsDir);
  const events: GraphNotificationEvent[] = [];
  const runRoot = join(root, 'graph-runs');
  let graphDirectories;
  try { graphDirectories = readdirSync(runRoot, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  for (const directory of graphDirectories) {
    if (!directory.isDirectory()) continue;
    const graphId = directory.name;
    const nodes = graphs.get(graphId);
    if (!nodes) continue;
    const runDir = join(runRoot, graphId);
    for (const entry of readdirSync(runDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.decision.json')) continue;
      const file = join(runDir, entry.name);
      const state = JSON.parse(readFileSync(file, 'utf8')) as GraphRunState;
      if (state.graphId !== graphId || file !== join(runRoot, graphId, `${state.runId}.json`)) throw new Error(`run identity mismatch: ${file}`);
      if (!Array.isArray(state.nodes) || !Array.isArray(state.path) || state.dryRun) continue;
      const visits = new Map<string, number>();
      for (const record of state.nodes) {
        const visit = (visits.get(record.nodeId) ?? 0) + 1;
        visits.set(record.nodeId, visit);
        const status = record.ok ? 'ok' : 'fail';
        if (!nodes.has(record.nodeId) || !wantsNotification(nodes.get(record.nodeId)?.notify, 'node', status)) continue;
        events.push({ id: JSON.stringify([state.graphId, state.runId, 'node', record.nodeId, visit]),
          graphId: state.graphId, runId: state.runId, kind: 'node', nodeId: record.nodeId, visit, status,
          message: `Graph ${state.graphId} / run ${state.runId} — ${record.nodeId} #${visit}: ${status}` });
      }
      const decisionPath = `${file}.${state.path.length}.decision.json`;
      let claimed = false;
      try { readFileSync(decisionPath, 'utf8'); claimed = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (state.status === 'awaiting-approval' && state.pending && !state.pending.decision && !claimed && nodes.has(state.pending.nodeId) &&
          wantsNotification(nodes.get(state.pending.nodeId)?.notify, 'approval')) {
        const pending = state.pending;
        const visit = state.path.filter((nodeId) => nodeId === pending.nodeId).length;
        const event = { id: JSON.stringify([state.graphId, state.runId, 'approval', pending.nodeId, visit]),
          graphId: state.graphId, runId: state.runId, kind: 'approval' as const, nodeId: pending.nodeId, visit, message: pending.message };
        events.push({ ...event, message: formatApprovalMessage(event) });
      }
    }
  }
  return events;
}

// Keep the lock inode permanently: unlinking it permits a second flock on a new inode.
// flock is released by the kernel on process exit, including an unclean exit.
// ⛔ Loaded lazily: this module is imported by every CLI start (index → graph-cli), and a top-level
//    dlopen of glibc/libSystem throws on Windows and musl — that would take the whole CLI down.
const LOCK_EX_NB = 2 | 4;
const LOCK_UN = 8;
type FlockFn = (fd: number, operation: number) => number;
let flockFn: FlockFn | null | undefined;
let flockLoading: Promise<FlockFn | null> | undefined;
/** Test seam: `null` forces the exclusive-file path, `undefined` restores detection. */
export function setGraphNotifyFlockForTest(fn: FlockFn | null | undefined): void {
  flockFn = fn;
  flockLoading = undefined;
}
async function loadFlock(): Promise<FlockFn | null> {
  if (flockFn !== undefined) return flockFn;
  flockLoading ??= (async () => {
    const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : process.platform === 'linux' ? 'libc.so.6' : null;
    if (library) {
      try {
        const { dlopen, FFIType } = await import('bun:ffi');
        const lib = dlopen(library, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
        return (fd: number, operation: number) => lib.symbols.flock(fd, operation) as number;
      } catch { /* fall back to the exclusive owner file */ }
    }
    return null;
  })();
  const loaded = await flockLoading;
  flockFn = loaded;
  return loaded;
}

export async function notifyGraphEvents(options: GraphNotifyOptions = {}): Promise<GraphNotificationEvent[]> {
  const root = options.root ?? effectiveInstanceRoot();
  const ledgerPath = join(root, 'graph-runs', 'notifications.jsonl');
  const collectFresh = (): GraphNotificationEvent[] => {
    let ledger = '';
    try { ledger = readFileSync(ledgerPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const sent = new Set<string>();
    for (const line of ledger.split('\n').filter(Boolean)) {
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string') throw new Error(`invalid graph notification ledger: ${ledgerPath}`);
      sent.add((entry as { id: string }).id);
    }
    return collectGraphEvents({ root, graphsDir: options.graphsDir }).filter((event) => !sent.has(event.id));
  };
  if (options.dryRun) return collectFresh();
  // The former .lock path was a directory; use a separate, stable inode instead of trying to reclaim it.
  const lock = `${ledgerPath}.flock`;
  mkdirSync(join(root, 'graph-runs'), { recursive: true });
  const flock = await loadFlock();
  if (!flock) return notifyWithExclusiveFile(`${ledgerPath}.owner`, collectFresh, options.send, ledgerPath);
  const fd = openSync(lock, 'a');
  let acquired = false;
  try {
    if (flock(fd, LOCK_EX_NB) !== 0) throw new Error('graph notification is already running');
    acquired = true;
    return await sendFresh(collectFresh(), options.send, ledgerPath);
  } finally {
    try {
      if (acquired && flock(fd, LOCK_UN) !== 0) throw new Error('graph notification lock release failed');
    } finally { closeSync(fd); }
  }
}

async function sendFresh(fresh: GraphNotificationEvent[], sendOption: GraphNotifyOptions['send'], ledgerPath: string): Promise<GraphNotificationEvent[]> {
  const send = sendOption ?? (async (message: string) => {
    const { deliver } = await import('../domains/outbound-alert.js');
    if (!deliver(message, 'graph')) throw new Error('graph notification delivery failed');
  });
  for (const event of fresh) {
    await send(event.message, event);
    appendFileSync(ledgerPath, JSON.stringify({ id: event.id, graphId: event.graphId, runId: event.runId, nodeId: event.nodeId,
      kind: event.kind, visit: event.visit, sentAt: new Date().toISOString() }) + '\n');
  }
  return fresh;
}

/** Platforms without flock (Windows, musl): an exclusive owner file. A crash leaves it behind, and the next run names it instead of double-sending. */
async function notifyWithExclusiveFile(ownerPath: string, collectFresh: () => GraphNotificationEvent[], send: GraphNotifyOptions['send'], ledgerPath: string): Promise<GraphNotificationEvent[]> {
  try { writeFileSync(ownerPath, String(process.pid), { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`graph notification is already running (or a crashed run left ${ownerPath} — remove it if no notifier is running)`);
    throw error;
  }
  try { return await sendFresh(collectFresh(), send, ledgerPath); }
  finally { rmSync(ownerPath, { force: true }); }
}
