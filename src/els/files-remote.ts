// ELS-FILES-SSH (대표 11-26 «파일 브라우저에 SSH — 같은 요소로 원격 호스트 파일 보기») — the server side of remote browsing.
// The file browser element's hydrate is synchronous (the overlay registry calls it on every act), so remote reads live here:
// a small cache keyed by host+folder (and host+file for previews), filled by ONE ssh call per miss, run in the background;
// when a read lands the hub calls `onReady` and the server re-hydrates the open files layer (event-driven, never a poll).
//
// The ssh call is the person's own ssh (their keys, agent, known_hosts, ~/.ssh/config aliases) in BatchMode — no password or
// passphrase prompt can ever appear inside the TUI: a host that needs interactive auth answers «needs login» and is skipped.
// ConnectTimeout bounds a dead host; a stopped cloud VM is simply «unreachable» (nothing here starts, wakes or pays for a VM).
// A ControlMaster socket under the els state dir makes every call after the first ride one connection. The script goes in
// on stdin to `sh -s` (the remote login shell only ever sees «sh -s»), the path inside it single-quoted for POSIX sh; the
// remote side runs only ls / head / wc / pwd / cd / test. Nothing is written remotely; no credential is read, printed or stored.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MAX_FILE_ENTRIES, MAX_PREVIEW_BYTES, previewOfBytes, type FileEntry, type FilePreview } from './elements/files-view.js';

export interface RemoteRun { readonly code: number | null; readonly stdout: Buffer; readonly stderr: string; readonly timedOut: boolean }
/** Run `script` on `host` (stdin to `sh -s`). Injectable: tests and the sim use a fake host. */
export type RemoteRunner = (host: string, script: string, timeoutMs: number) => Promise<RemoteRun>;

export type RemoteListing =
  | { readonly state: 'ok'; readonly dir: string; readonly entries: readonly FileEntry[]; readonly total: number }
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly text: string; readonly dir?: string };

export interface RemoteFiles {
  /** Host names for the switcher (els hosts.json ⊕ ~/.ssh/config aliases, no wildcards), re-read at most every 30 s. */
  readonly hosts: () => readonly string[];
  /** A folder listing ('' = the remote home): cached, or 'loading' while one ssh call fetches it. */
  readonly listing: (host: string, dir: string, hidden: boolean) => RemoteListing;
  /** A preview of one entry: cached, or undefined while it is being fetched. */
  readonly preview: (host: string, dir: string, entry: FileEntry) => FilePreview | undefined;
  /** Forget a host's cached reads (the `R` refresh key). */
  readonly refresh: (host: string) => void;
  readonly dispose: () => void;
}

// 출처: ELS-FILES-SSH — a reachable host answers in well under a second; 5 s connect is the «unreachable» line.
export const CONNECT_TIMEOUT_S = 5;
// 출처: ELS-FILES-SSH — a call that has not finished after 12 s is reported as slow and abandoned (its process is killed).
export const CALL_TIMEOUT_MS = 12_000;
// 출처: ELS-FILES-SSH — the remote side lists at most this many names (the element shows the first MAX_FILE_ENTRIES).
const REMOTE_LIST_CAP = 5_000;
// 출처: #40244 ELS-ELN-LAYERS §2-4 flat memory — a few dozen folders and previews are plenty for a browsing session.
const CACHE_MAX = 64;
const HOSTS_TTL_MS = 30_000;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_HOSTS = 32;

/** POSIX single-quoting: the one safe way to put an arbitrary path in a `sh` script. */
export const shQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** The list script: `P <pwd>` (or `E <reason>`), then one name per line (`/` suffix = folder, symlinks followed), then
 *  `#TOTAL <n>`. Portable (macOS BSD and GNU): ls -1ApL, awk, pwd. */
export function listScript(dir: string): string {
  return [
    `d=${shQuote(dir)}`,
    'if [ -z "$d" ]; then cd || { echo "E cannot open home"; exit 0; }',
    'elif [ ! -e "$d" ]; then echo "E not found"; exit 0',
    'elif [ ! -d "$d" ]; then echo "E not a folder"; exit 0',
    'elif ! cd -- "$d" 2>/dev/null; then echo "E permission denied"; exit 0; fi',
    'echo "P $(pwd)"',
    `ls -1ApL 2>/dev/null | awk 'NR<=${REMOTE_LIST_CAP}{print} END{print "#TOTAL " NR}'`,
    '',
  ].join('\n');
}

/** The preview script: `S <size>` then the first bytes (head -c), or `E <reason>`. */
export function previewScript(path: string): string {
  return [
    `p=${shQuote(path)}`,
    'if [ ! -e "$p" ]; then echo "E not found"; exit 0; fi',
    'if [ ! -f "$p" ]; then echo "E not a regular file"; exit 0; fi',
    'if [ ! -r "$p" ]; then echo "E permission denied"; exit 0; fi',
    `s=$(wc -c < "$p" | tr -d ' '); echo "S $s"; head -c ${MAX_PREVIEW_BYTES} -- "$p"`,
    '',
  ].join('\n');
}

/** What a failed ssh call means, in words for the person (never the raw stderr — it may echo config details). */
export function classifyFailure(run: RemoteRun): string {
  if (run.timedOut) return 'slow or unreachable (no answer in 12 s)';
  const err = run.stderr;
  if (/permission denied \(|host key verification failed|no more authentication methods|passphrase|password|keyboard-interactive|too many authentication/i.test(err)) return 'needs login — open a terminal and ssh once';
  if (/could not resolve|name or service not known|nodename nor servname/i.test(err)) return 'unknown host';
  if (/timed out|no route to host|connection refused|network is unreachable|host is down|connection closed|broken pipe|operation not permitted/i.test(err)) return 'unreachable';
  return `unreachable (ssh exit ${run.code ?? '?'})`;
}

/** Parse the list script's output. */
export function parseListing(stdout: string, hidden: boolean): RemoteListing {
  const lines = stdout.replace(/\r/g, '').split('\n');
  const head = lines.shift() ?? '';
  if (head.startsWith('E ')) return { state: 'error', text: head.slice(2).trim() || 'cannot read' };
  if (!head.startsWith('P /')) return { state: 'error', text: 'unexpected answer from the host' };
  const dir = head.slice(2).trim();
  let total = 0;
  const entries: FileEntry[] = [];
  for (const line of lines) {
    if (line.startsWith('#TOTAL ')) { total = Number(line.slice(7)) || 0; continue; }
    if (!line || line === './' || line === '../') continue;
    const isDir = line.endsWith('/');
    const name = isDir ? line.slice(0, -1) : line;
    if (!name || name.includes('/') || (!hidden && name.startsWith('.'))) continue;
    entries.push({ name, dir: isDir });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { state: 'ok', dir, entries: entries.slice(0, MAX_FILE_ENTRIES), total: hidden ? Math.max(total, entries.length) : entries.length };
}

/** Parse the preview script's output (stdout as bytes: the head may be binary). */
export function parsePreview(name: string, path: string, stdout: Buffer): FilePreview {
  const nl = stdout.indexOf(0x0a);
  const head = stdout.subarray(0, nl < 0 ? stdout.length : nl).toString('utf8');
  if (head.startsWith('E ')) return { name, kind: 'error', text: head.slice(2).trim() };
  if (!head.startsWith('S ')) return { name, kind: 'error', text: 'unexpected answer from the host' };
  const size = Number(head.slice(2)) || 0;
  return previewOfBytes(name, path, new Uint8Array(stdout.subarray(nl + 1, nl + 1 + MAX_PREVIEW_BYTES)), size);
}

/** Host aliases from an ssh config text: every name on `Host` lines without wildcards or negation. */
export function sshConfigHosts(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*Host\s+(.+)$/i.exec(line);
    if (!match) continue;
    for (const name of match[1]!.trim().split(/\s+/)) if (HOST.test(name) && !/[*?!]/.test(name)) out.push(name);
  }
  return out;
}

/** The person's ssh in BatchMode with a ControlMaster under `controlDir` — never a prompt, bounded by timeouts. */
export function sshRunner(controlDir: string): RemoteRunner {
  return (host, script, timeoutMs) => new Promise((resolve) => {
    try { mkdirSync(controlDir, { recursive: true, mode: 0o700 }); } catch { /* ssh reports the missing control dir */ }
    const child = spawn('ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${CONNECT_TIMEOUT_S}`, '-o', 'LogLevel=ERROR',
      '-o', 'ControlMaster=auto', '-o', `ControlPath=${join(controlDir, 'cm-%C')}`, '-o', 'ControlPersist=120',
      '--', host, 'sh -s',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never' } });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let timedOut = false;
    let done = false;
    // 출처: the preview cap plus a header line — anything more is the remote misbehaving; stop reading.
    const maxOut = MAX_PREVIEW_BYTES + 1_048_576;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const finish = (code: number | null): void => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: err.slice(0, 4_096), timedOut }); };
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= maxOut) out.push(chunk); else child.kill('SIGKILL'); });
    child.stderr.on('data', (chunk: Buffer) => { if (err.length < 4_096) err += chunk.toString('utf8'); });
    child.on('error', () => { err += 'ssh not available'; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* the host closed early; close follows */ });
    child.stdin.end(script);
  });
}

export interface RemoteFilesOptions {
  readonly run: RemoteRunner;
  /** A read landed (or failed): re-hydrate the open files layer. */
  readonly onReady: () => void;
  /** Host names from els hosts.json (registered hosts), listed first. */
  readonly registered?: () => readonly string[];
  /** The ssh config text (default ~/.ssh/config). */
  readonly sshConfig?: () => string;
  readonly now?: () => number;
}

export function createRemoteFiles(options: RemoteFilesOptions): RemoteFiles {
  const now = options.now ?? Date.now;
  const lists = new Map<string, RemoteListing>();
  const previews = new Map<string, FilePreview>();
  const flight = new Set<string>();
  let hostCache: { at: number; hosts: readonly string[] } | undefined;
  let disposed = false;
  const remember = <V>(map: Map<string, V>, key: string, value: V): void => {
    map.delete(key); map.set(key, value);
    while (map.size > CACHE_MAX) map.delete(map.keys().next().value!);
  };
  const hosts = (): readonly string[] => {
    if (hostCache && now() - hostCache.at < HOSTS_TTL_MS) return hostCache.hosts;
    let config = '';
    try { config = options.sshConfig ? options.sshConfig() : readFileSync(join(homedir(), '.ssh', 'config'), 'utf8'); } catch { /* no ssh config */ }
    let registered: readonly string[] = [];
    try { registered = options.registered?.() ?? []; } catch { /* no registry */ }
    const list = [...new Set([...registered.filter((name) => HOST.test(name)), ...sshConfigHosts(config)])].slice(0, MAX_HOSTS);
    hostCache = { at: now(), hosts: list };
    return list;
  };
  const known = (host: string): boolean => HOST.test(host) && hosts().includes(host);
  const fetch = (key: string, host: string, script: string, land: (run: RemoteRun) => void): void => {
    if (flight.has(key) || disposed) return;
    flight.add(key);
    void options.run(host, script, CALL_TIMEOUT_MS).then(land, () => land({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false })).finally(() => {
      flight.delete(key);
      if (!disposed) { try { options.onReady(); } catch { /* the layer may be gone */ } }
    });
  };
  return {
    hosts,
    listing(host, dir, hidden) {
      if (!known(host)) return { state: 'error', text: `unknown host ${host}` };
      const key = `${host}\0${dir}\0${hidden ? 1 : 0}`;
      const hit = lists.get(key);
      if (hit) return hit;
      fetch(key, host, listScript(dir), (run) => {
        const value: RemoteListing = run.code === 0 && !run.timedOut ? parseListing(run.stdout.toString('utf8'), hidden) : { state: 'error', text: `${host}: ${classifyFailure(run)}` };
        remember(lists, key, value);
      });
      return { state: 'loading' };
    },
    preview(host, dir, entry) {
      if (!known(host)) return { name: entry.name, kind: 'error', text: `unknown host ${host}` };
      const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
      if (entry.dir) {
        const inner = this.listing(host, path, false);
        if (inner.state === 'loading') return undefined;
        if (inner.state === 'error') return { name: entry.name, kind: 'error', text: inner.text };
        return { name: entry.name, kind: 'dir', text: inner.entries.slice(0, 200).map((one) => `${one.dir ? '▸ ' : '  '}${one.name}${one.dir ? '/' : ''}`).join('\n') + (inner.total > 200 ? `\n… ${inner.total - 200} more` : '') };
      }
      const key = `${host}\0${path}`;
      const hit = previews.get(key);
      if (hit) return hit;
      // A credential-looking name is never fetched (previewOfBytes would hide it anyway — this keeps the bytes off the wire).
      const hidden = previewOfBytes(entry.name, path, new Uint8Array(0), 1);
      if (hidden.kind === 'secret' || hidden.kind === 'image') return { name: entry.name, kind: hidden.kind };
      fetch(key, host, previewScript(path), (run) => {
        remember(previews, key, run.code === 0 && !run.timedOut ? parsePreview(entry.name, path, run.stdout) : { name: entry.name, kind: 'error', text: `${host}: ${classifyFailure(run)}` });
      });
      return undefined;
    },
    refresh(host) {
      for (const key of [...lists.keys()]) if (key.startsWith(`${host}\0`)) lists.delete(key);
      for (const key of [...previews.keys()]) if (key.startsWith(`${host}\0`)) previews.delete(key);
    },
    dispose() { disposed = true; lists.clear(); previews.clear(); },
  };
}
