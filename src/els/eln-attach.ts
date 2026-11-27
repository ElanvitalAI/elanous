// ELS-ATTACH (대표 11-26 «eln 에 첨부» · API fixed in the coordinator's API-eln-attach.md) — hand a file to an open agent
// pane as an attachment: its path goes into the agent's INPUT LINE through the pane's runtime adapter (eln · Claude Code ·
// codex: «@<abs path>», quoted when it has spaces or Korean; grok: the quoted path) — never Enter, never a turn.
// Path-based only (대표 simplification): no text is inlined. A remote file («host:/abs/path») is first cached under the els
// state folder (size-capped) and the local copy's path is inserted.
//
// Target: the explicit pane → the focused pane (journal lastFocus) when it is an attach-capable agent → the last-used
// attach-capable agent pane in the workspace → none («No open eln» toast, reason 'no-eln').
// Server op: { op: 'eln-attach', path, source, ws?, pane? } — insertion goes through the server's machine-input path
// (the owner control door's paste: bracketed paste, refused on an approval panel) with the usual auth (door action 'input').

import { mkdirSync, realpathSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { adapterFor, shellQuote, type InputOp } from './runtime-adapters/index.js';

/** Kept for the fixed API: text is never inlined any more (대표 simplification — attach is path-based), so the cap is 0. */
export const ELN_ATTACH_INLINE_MAX_BYTES = 0;
// 출처: 대표 11-26 attach spec «SSH/remote files → cached first to a local temp path (size cap)» — 50 MiB, an attachment not a dataset.
export const ELN_ATTACH_REMOTE_MAX_BYTES = 52_428_800;

export type AttachRuntime = 'eln' | 'codex' | 'claude' | 'grok' | 'unknown';
export interface ElnPaneInfo {
  readonly pane: string;
  readonly ws: string;
  /** Kept for the fixed API: true when the pane's runtime can take an attachment (any attach-capable agent, not only eln). */
  readonly isEln: boolean;
  readonly lastInputAt?: number;
  readonly runtime?: AttachRuntime;
}

export type ElnAttachFailure = 'no-eln' | 'not-found' | 'too-large' | 'outside' | 'denied' | 'deliver-failed';
export type ElnAttachResult =
  | { readonly ok: true; readonly pane: string; readonly title: string; readonly mode: 'inline' | 'path'; readonly bytes: number; readonly runtime?: AttachRuntime; readonly inserted?: string }
  | { readonly ok: false; readonly reason: ElnAttachFailure; readonly message: string };

/** explicit (when attach-capable) → focused (when attach-capable) → the last-used attach-capable pane in `ws` → undefined. */
export function pickAttachTarget(panes: readonly ElnPaneInfo[], opts: { readonly ws?: string; readonly focused?: string; readonly explicit?: string }): string | undefined {
  const able = panes.filter((one) => one.isEln);
  if (opts.explicit) return able.some((one) => one.pane === opts.explicit) ? opts.explicit : undefined;
  if (opts.focused && able.some((one) => one.pane === opts.focused)) return opts.focused;
  const inWs = opts.ws ? able.filter((one) => one.ws === opts.ws) : able;
  return [...inWs].sort((a, b) => (b.lastInputAt ?? 0) - (a.lastInputAt ?? 0))[0]?.pane;
}
/** The fixed API's name for pickAttachTarget. */
export const pickElnPane = pickAttachTarget;

/** Path-based payload (fixed API shape): mode is always 'path'; `text` = the path as it would be inserted. */
export function elnAttachPayload(file: { readonly path: string; readonly bytes: number; readonly isText: boolean; readonly text?: string }): { readonly mode: 'inline' | 'path'; readonly text: string } {
  return { mode: 'path', text: file.path };
}

/** The input ops for this runtime (no Enter in any of them — asserted by the caller too). */
export function attachOps(runtime: string | undefined, pane: string, files: readonly string[]): InputOp[] {
  return adapterFor(runtime).insertAttachment({ pane, ...(runtime ? { kind: runtime } : {}) }, files);
}

/** Client helper: the server op. A broken answer is a clean failure, never a throw. */
export async function requestElnAttach(request: (r: unknown) => Promise<{ exitCode: number; message: string }>, args: { readonly path: string; readonly source: string; readonly ws?: string; readonly pane?: string }): Promise<ElnAttachResult> {
  try {
    const answer = await request({ op: 'eln-attach', path: args.path, source: args.source, ...(args.ws ? { ws: args.ws } : {}), ...(args.pane ? { pane: args.pane } : {}) });
    try { return JSON.parse(answer.message) as ElnAttachResult; }
    catch { return { ok: false, reason: answer.exitCode === 0 ? 'deliver-failed' : 'denied', message: answer.message.replace(/[\u0000-\u001f]/g, ' ').slice(0, 160) || 'no answer' }; }
  } catch (error) { return { ok: false, reason: 'deliver-failed', message: error instanceof Error ? error.message.slice(0, 160) : 'els unreachable' }; }
}

/** The toast line for a result (English UI; «No open eln» for no target). */
export function attachToast(result: ElnAttachResult): { readonly text: string; readonly level: 'success' | 'error' | 'warning' } {
  if (result.ok) return { text: `Attached to ${result.title}`.slice(0, 120), level: 'success' };
  if (result.reason === 'no-eln') return { text: 'No open eln', level: 'warning' };
  return { text: `Not attached: ${result.message}`.slice(0, 120), level: 'error' };
}

// ── server side ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AttachListingRow { readonly pane: string; readonly workspace: string; readonly title?: string; readonly kind?: string; readonly state?: string; readonly ptyId?: string; readonly lastEventAtMs?: number }
export interface ElnAttachDeps {
  /** `els ls` JSON (core.list()). */
  readonly listing: () => { readonly panes: readonly AttachListingRow[]; readonly workspaces?: ReadonlyArray<{ id: string; name: string }>; readonly lastFocus?: { readonly workspaceId?: string; readonly paneId?: string } };
  /** Type text into the pane's input line through the machine-input path (bracketed paste). */
  readonly insert: (pane: string, text: string) => Promise<{ exitCode: number; message: string }>;
  /** The Obsidian vault root (config obsidian.vault) for source 'obsidian'. */
  readonly vault?: () => string | undefined;
  /** The els state folder (the remote cache lives under it). */
  readonly stateDir: string;
  /** Read a remote file, at most `max` + 1 bytes (production: ssh … head -c). */
  readonly fetchRemote?: (host: string, path: string, max: number) => Promise<Buffer>;
}

const REMOTE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,62}):(\/[^\u0000\n\r]+)$/;
const fail = (reason: ElnAttachFailure, message: string): ElnAttachResult => ({ ok: false, reason, message });
const runtimeOf = (kind: string | undefined): AttachRuntime => kind === 'eln' || kind === 'codex' || kind === 'claude' || kind === 'grok' ? kind : 'unknown';
const inside = (root: string, real: string): boolean => { const rel = relative(root, real); return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep)); };

/** The attach-capable panes of a listing (live, not exited, adapter says attach). */
export function attachPanes(rows: readonly AttachListingRow[]): ElnPaneInfo[] {
  return rows.flatMap((row) => {
    const able = adapterFor(row.kind).capabilities.attach && row.state !== 'exited' && !!row.ptyId;
    return able ? [{ pane: row.pane, ws: row.workspace, isEln: true, runtime: runtimeOf(row.kind), ...(row.lastEventAtMs ? { lastInputAt: row.lastEventAtMs } : {}) }] : [];
  });
}

/** Resolve the request's file to a local absolute path (vault-clamped for source 'obsidian'; remote → cached copy). */
async function localFile(deps: ElnAttachDeps, path: string, source: string): Promise<{ readonly path: string; readonly bytes: number } | ElnAttachResult> {
  const remote = REMOTE.exec(path);
  if (remote) {
    if (!deps.fetchRemote) return fail('denied', 'remote files are not available here');
    let data: Buffer;
    try { data = await deps.fetchRemote(remote[1]!, remote[2]!, ELN_ATTACH_REMOTE_MAX_BYTES); }
    catch (error) { return fail('not-found', `cannot read ${remote[1]}:${basename(remote[2]!)} (${error instanceof Error ? error.message.slice(0, 80) : 'error'})`); }
    if (data.length > ELN_ATTACH_REMOTE_MAX_BYTES) return fail('too-large', `${basename(remote[2]!)} is larger than 50 MiB`);
    const dir = join(deps.stateDir, 'attach-cache', remote[1]!);
    const local = join(dir, `${Date.now().toString(36)}-${basename(remote[2]!)}`);
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(`${local}.tmp`, data, { mode: 0o600 }); renameSync(`${local}.tmp`, local); }
    catch { return fail('deliver-failed', 'cannot write the local copy'); }
    return { path: local, bytes: data.length };
  }
  let abs = path;
  if (source === 'obsidian' && !isAbsolute(path)) {
    const vault = deps.vault?.()?.trim();
    if (!vault) return fail('not-found', 'Obsidian vault not set');
    let root: string;
    try { root = realpathSync(vault); } catch { return fail('not-found', 'Obsidian vault not found'); }
    if (path.split('/').some((part) => part === '..')) return fail('outside', 'path outside the vault');
    abs = join(root, path);
    try { if (!inside(root, realpathSync(abs))) return fail('outside', 'path outside the vault'); } catch { return fail('not-found', `${basename(path)} not found`); }
  }
  if (!isAbsolute(abs)) return fail('not-found', 'the path must be absolute');
  try {
    const st = statSync(abs);
    if (!st.isFile()) return fail('not-found', `${basename(abs)} is not a file`);
    return { path: abs, bytes: st.size };
  } catch { return fail('not-found', `${basename(abs)} not found`); }
}

/** The server op: pick the target, resolve the file, insert the adapter's ops (never Enter). */
export async function serveElnAttach(deps: ElnAttachDeps, request: { readonly path?: unknown; readonly source?: unknown; readonly ws?: unknown; readonly pane?: unknown }): Promise<ElnAttachResult> {
  const path = typeof request.path === 'string' ? request.path : '';
  const source = typeof request.source === 'string' ? request.source : 'files';
  if (!path || path.length > 4096 || /[\u0000\n\r]/.test(path)) return fail('not-found', 'a file path is required');
  let listed: ReturnType<ElnAttachDeps['listing']>;
  try { listed = deps.listing(); } catch { return fail('deliver-failed', 'cannot list the panes'); }
  const focused = listed.lastFocus?.paneId;
  const focusWs = listed.workspaces?.find((one) => one.id === listed.lastFocus?.workspaceId)?.name;
  const ws = typeof request.ws === 'string' && request.ws ? (listed.workspaces?.find((one) => one.id === request.ws)?.name ?? request.ws) : focusWs;
  const explicit = typeof request.pane === 'string' && request.pane ? request.pane : undefined;
  const target = pickAttachTarget(attachPanes(listed.panes), { ...(ws ? { ws } : {}), ...(focused ? { focused } : {}), ...(explicit ? { explicit } : {}) });
  if (!target) return fail('no-eln', explicit ? `${explicit} is not an open agent pane (열린 eln 없음)` : 'No open eln (열린 eln 없음)');
  const file = await localFile(deps, path, source);
  if (!('path' in file)) return file;
  const row = listed.panes.find((one) => one.pane === target)!;
  const ops = attachOps(row.kind, target, [file.path]);
  let inserted = '';
  for (const op of ops) {
    const text = op.kind === 'paste' ? op.text : op.bytes;
    if (/[\r\n]/.test(text)) return fail('denied', 'refused: the insert would press Enter');
    const done = await deps.insert(target, text);
    if (done.exitCode !== 0) return fail('deliver-failed', done.message.replace(/^els input: /, '').slice(0, 140) || 'the pane refused the input');
    inserted += text;
  }
  return { ok: true, pane: target, title: row.title || target, mode: 'path', bytes: file.bytes, runtime: runtimeOf(row.kind), inserted };
}

/** Production remote read: `ssh <host> head -c <max+1> -- '<path>'` (argv, no local shell; the remote path is single-quoted). */
export async function sshFetch(host: string, path: string, max: number): Promise<Buffer> {
  const child = Bun.spawn(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, `head -c ${max + 1} -- ${shellQuote(path)}`], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [out, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
    if (code !== 0) throw new Error(`ssh exit ${code}`);
    return Buffer.from(out);
  } finally { clearTimeout(timer); }
}
