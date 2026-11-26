// ELS-FANOUT-GATHER — two thin primitives on top of the els owner: `els fanout` opens one tab per item (through the
// same authorized `new` request `els new` / ElsControl use — the server door judges it, nothing is bypassed) and
// `els gather` folds those tabs back into one JSON answer. Run records live in <state>/els/fanout/<runId>.json so a
// later gather (another shell, after a reattach or a server restart) finds them. Exits are observed from the pushed
// `subscribe` listing (pane state + exit code the owner already keeps) — no DB, no polling loop on the hot path.
// Remote host workspaces are a follow-up (FU): this runs on the local owner only.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const FANOUT_DEFAULT_PREFIX = 'FAN';

export type FanoutLaunchState = 'queued' | 'launched' | 'launch-failed';

export interface FanoutItem {
  readonly i: number;
  readonly item: string;
  readonly command: string;
  readonly title: string;
  state: FanoutLaunchState;
  pane?: string;
  address?: string;
  startedAt?: number;
  error?: string;
  /** Filled the first time an observer sees the tab exited — survives the owner forgetting the exited pane. */
  done?: { code: number | null; endedAt: number; tail: string[] };
}

export interface FanoutRecord {
  readonly runId: string;
  readonly ws: string;
  readonly prefix: string;
  readonly template: string;
  readonly cwd: string;
  readonly max: number;
  readonly createdAt: number;
  items: FanoutItem[];
}

/** POSIX single-quote: every byte (CJK included) is literal inside '…'; a ' becomes '\''. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** {item} → the quoted item, {i} → the 1-based index. Nothing else in the template is touched. */
export function substitute(template: string, item: string, i: number): string {
  return template.replace(/\{item\}|\{i\}/g, (token) => (token === '{i}' ? String(i) : shellQuote(item)));
}

/** `--over`: an existing file → its non-empty lines; otherwise a whole number N → "1".."N". */
export function parseOver(over: string, read: (path: string) => string | undefined): { ok: true; items: string[] } | { ok: false; message: string } {
  const text = read(over);
  if (text !== undefined) {
    const items = text.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
    return items.length ? { ok: true, items } : { ok: false, message: `els fanout: ${over} has no items` };
  }
  if (/^[1-9]\d{0,3}$/.test(over)) return { ok: true, items: Array.from({ length: Number(over) }, (_, k) => String(k + 1)) };
  return { ok: false, message: `els fanout: --over ${over} is neither a readable file nor a count (1..9999)` };
}

export function newRunId(now: number = Date.now()): string {
  return `fan-${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

export function planFanout(input: { runId: string; ws: string; prefix?: string; template: string; cwd: string; max?: number; items: string[]; now: number }): FanoutRecord {
  const prefix = input.prefix?.trim() || FANOUT_DEFAULT_PREFIX;
  const max = input.max && input.max > 0 ? Math.floor(input.max) : input.items.length;
  return {
    runId: input.runId, ws: input.ws, prefix, template: input.template, cwd: input.cwd, max, createdAt: input.now,
    items: input.items.map((item, k) => ({ i: k + 1, item, command: substitute(input.template, item, k + 1), title: `${prefix}·${k + 1}`, state: 'queued' as const })),
  };
}

// ── run record store ────────────────────────────────────────────────────────────────────────────────────────────────

export function fanoutDir(stateRoot: string): string { return join(stateRoot, 'els', 'fanout'); }

export function saveRecord(stateRoot: string, record: FanoutRecord): void {
  const dir = fanoutDir(stateRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${record.runId}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadRecord(stateRoot: string, runId: string): FanoutRecord | undefined {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) return undefined;
  const path = join(fanoutDir(stateRoot), `${runId}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as FanoutRecord;
}

// ── launch + K-limit queue ──────────────────────────────────────────────────────────────────────────────────────────

export interface ListedPane { readonly pane: string; readonly state?: string; readonly exit?: { code: number | null; tail?: string[] } }
export type LaunchFn = (item: FanoutItem, record: FanoutRecord) => Promise<{ exitCode: number; message: string }>;

/** Launch one queued item; the server's answer decides (a door refusal is kept verbatim). */
export async function launchItem(record: FanoutRecord, item: FanoutItem, launch: LaunchFn, now: () => number): Promise<boolean> {
  const answer = await launch(item, record);
  if (answer.exitCode !== 0) { item.state = 'launch-failed'; item.error = answer.message; return false; }
  try {
    const created = JSON.parse(answer.message) as { pane?: string; address?: string };
    item.state = 'launched'; item.startedAt = now();
    if (created.pane) item.pane = created.pane;
    if (created.address) item.address = created.address;
    return true;
  } catch { item.state = 'launch-failed'; item.error = `unreadable answer: ${answer.message}`; return false; }
}

/** Fold a listing into the record: tabs seen exited get their `done` stamp. Returns the number still running. */
export function observe(record: FanoutRecord, panes: readonly ListedPane[], now: number): number {
  const byId = new Map(panes.map((p) => [p.pane, p]));
  let running = 0;
  for (const item of record.items) {
    if (item.state !== 'launched' || item.done) continue;
    const row = item.pane ? byId.get(item.pane) : undefined;
    if (row && row.state !== 'exited') { running += 1; continue; }
    // An exited row whose exit code has not been recorded yet is stamped on the next push (the slot is free already).
    if (row && !row.exit) continue;
    item.done = { code: row?.exit?.code ?? null, endedAt: now, tail: row?.exit?.tail ?? [] };
  }
  return running;
}

/** Start queued items while fewer than `max` are running. Returns true when nothing is left queued. */
export async function fillSlots(record: FanoutRecord, running: number, launch: LaunchFn, now: () => number): Promise<boolean> {
  let active = running;
  for (const item of record.items) {
    if (active >= record.max) break;
    if (item.state !== 'queued') continue;
    if (await launchItem(record, item, launch, now)) active += 1;
  }
  return !record.items.some((item) => item.state === 'queued');
}

/** The queue driver: on each pushed listing, observe exits and start the next items. Resolves when the queue is empty. */
export function driveQueue(record: FanoutRecord, deps: {
  launch: LaunchFn;
  subscribe: (onList: (panes: ListedPane[]) => void, onEnd: (reason: string) => void) => { close: () => void };
  save: (record: FanoutRecord) => void;
  now: () => number;
}): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let busy = false; let pending: ListedPane[] | undefined; let finished = false;
    const finish = (result: { ok: boolean; reason?: string }): void => { if (finished) return; finished = true; sub.close(); resolve(result); };
    const step = async (panes: ListedPane[]): Promise<void> => {
      if (busy) { pending = panes; return; }
      busy = true;
      try {
        const empty = await fillSlots(record, observe(record, panes, deps.now()), deps.launch, deps.now);
        deps.save(record);
        if (empty) { finish({ ok: true }); return; }
      } finally { busy = false; }
      if (pending) { const next = pending; pending = undefined; await step(next); }
    };
    const sub = deps.subscribe((panes) => { void step(panes); }, (reason) => finish({ ok: false, reason }));
  });
}

// ── gather ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type GatherStatus = 'queued' | 'running' | 'exited' | 'failed';

export interface GatherRow {
  readonly i: number; readonly item: string; readonly title: string; readonly pane: string | null;
  readonly status: GatherStatus; readonly exitCode: number | null; readonly durationMs: number | null;
  readonly output: string[]; readonly outputSource: 'screen' | 'file' | 'none'; readonly error?: string;
}

export function lastLines(text: string, n: number): string[] {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  return n > 0 ? lines.slice(-n) : [];
}

export function statusOf(item: FanoutItem): GatherStatus {
  if (item.state === 'queued') return 'queued';
  if (item.state === 'launch-failed') return 'failed';
  if (!item.done) return 'running';
  return item.done.code === 0 ? 'exited' : 'failed';
}

export function isTerminal(item: FanoutItem): boolean {
  return item.state === 'launch-failed' || !!item.done;
}

export async function gatherRows(record: FanoutRecord, deps: {
  tail: number; now: number; file?: string;
  readScreen: (pane: string) => Promise<string | undefined>;
  readFile: (path: string) => string | undefined;
}): Promise<GatherRow[]> {
  const rows: GatherRow[] = [];
  for (const item of record.items) {
    const status = statusOf(item);
    let output: string[] = []; let outputSource: GatherRow['outputSource'] = 'none';
    if (deps.file) {
      const text = deps.readFile(deps.file.replace(/\{i\}/g, String(item.i)));
      if (text !== undefined) { output = lastLines(text, Number.MAX_SAFE_INTEGER); outputSource = 'file'; }
    } else if (item.pane && item.state === 'launched') {
      const screen = await deps.readScreen(item.pane);
      if (screen !== undefined) { output = lastLines(screen, deps.tail); outputSource = 'screen'; }
      else if (item.done?.tail.length) { output = item.done.tail.slice(-deps.tail); outputSource = 'screen'; }
    }
    const durationMs = item.startedAt === undefined ? null : (item.done?.endedAt ?? deps.now) - item.startedAt;
    rows.push({ i: item.i, item: item.item, title: item.title, pane: item.pane ?? null, status, exitCode: item.done?.code ?? null,
      durationMs, output, outputSource, ...(item.error ? { error: item.error } : {}) });
  }
  return rows;
}

/** `els read` starts with a «[screen CxR cursor=…]» line — not output. */
export function stripScreenHeader(text: string): string {
  return text.replace(/^\[screen \d+x\d+ cursor=[^\]]*\]\n?/, '');
}

/** Parse "10m" / "90s" / "1500ms" / "2h" / bare seconds. */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  return Math.round(n * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000));
}

/** Wait (event-driven) until every item is terminal or the timeout hits. */
export function waitAll(record: FanoutRecord, deps: {
  subscribe: (onList: (panes: ListedPane[]) => void, onEnd: (reason: string) => void) => { close: () => void };
  save: (record: FanoutRecord) => void; now: () => number; timeoutMs: number;
}): Promise<{ complete: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result: { complete: boolean; reason?: string }): void => { if (finished) return; finished = true; clearTimeout(timer); sub.close(); deps.save(record); resolve(result); };
    const timer = setTimeout(() => finish({ complete: false, reason: 'timeout' }), deps.timeoutMs);
    const sub = deps.subscribe((panes) => {
      observe(record, panes, deps.now());
      if (record.items.every(isTerminal)) finish({ complete: true });
    }, (reason) => finish({ complete: record.items.every(isTerminal), reason }));
  });
}
