// CLI · <config-dir>/remotes.json bookmark store (Track 4.B · 2026-05-07)
//
// Paths follow `getElanousConfigDir()` (honors `--config-dir` / isolation).
// Default daily-driver root is still `~/.elanous`; tests and `--config-dir`
// must not leak into the operational store.
//
// `elanous nexus connect <host>` 가 처음 셋업 후 본 store 에 entry 추가:
//   - host (user-friendly key)
//   - acp_url / voice_url (T4.A connect-info 결과)
//   - token_file (<config-dir>/remotes/<name>.token · mode 0o600)
//   - addedAt timestamp · default flag
//
// 일상 사용 (`elanous` 무인자 · T4.C) 가 default bookmark resolve.
// 외울 명령 = `elanous` 1개 + 처음 1회 `elanous nexus connect <host>`.
//
// File mode 0o600 · backup-on-write (atomic · v1 schema lock).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { join as joinPath, dirname } from 'node:path';
import { getElanousConfigDir } from '../elanous-config-dir.js';
import { DEFAULT_NEXUS_HTTP_PORT } from '../nexus/default-port.js';

export const REMOTES_FILE_VERSION = 1;

export interface RemoteEntry {
  /** Host (user-friendly key — same as bookmark name unless overridden). */
  host: string;
  /** Resolved from connect-info endpoint. */
  acp_url: string;
  /** Voice ws URL · optional (older NEXUS may not expose). */
  voice_url?: string;
  /** Path to <config-dir>/remotes/<name>.token (0o600). */
  token_file: string;
  /** server_label from connect-info. */
  label?: string;
  /** ISO timestamp. */
  addedAt: string;
}

export interface RemotesFile {
  version: 1;
  /** Default bookmark name — used when `elanous` is run without args. */
  default?: string;
  remotes: Record<string, RemoteEntry>;
}

function defaultRemotesPath(): string {
  return joinPath(getElanousConfigDir(), 'remotes.json');
}

function defaultTokensDir(): string {
  return joinPath(getElanousConfigDir(), 'remotes');
}

export interface RemotesStoreOpts {
  /** Override the remotes.json path (tests). */
  remotesFilePath?: string;
  /** Override the tokens directory (tests). */
  tokensDir?: string;
}

export class RemotesStore {
  private readonly remotesFilePath: string;
  private readonly tokensDir: string;

  constructor(opts: RemotesStoreOpts = {}) {
    this.remotesFilePath = opts.remotesFilePath ?? defaultRemotesPath();
    this.tokensDir = opts.tokensDir ?? defaultTokensDir();
  }

  load(): RemotesFile {
    if (!existsSync(this.remotesFilePath)) {
      return { version: 1, remotes: {} };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.remotesFilePath, 'utf-8')) as Partial<RemotesFile>;
      if (parsed.version !== REMOTES_FILE_VERSION) {
        // Forwards-compat — refuse rather than silently lose data.
        throw new Error(
          `remotes.json version ${parsed.version} unsupported (expected ${REMOTES_FILE_VERSION})`,
        );
      }
      return {
        version: 1,
        ...(parsed.default !== undefined ? { default: parsed.default } : {}),
        remotes: parsed.remotes ?? {},
      };
    } catch (err) {
      throw new Error(
        `failed to read ${this.remotesFilePath}: ${(err as Error).message}`,
      );
    }
  }

  save(file: RemotesFile): void {
    mkdirSync(dirname(this.remotesFilePath), { recursive: true });
    const tmp = `${this.remotesFilePath}.tmp`;
    const body = JSON.stringify(file, null, 2);
    writeFileSync(tmp, body, { mode: 0o600 });
    // Backup existing file (if any) before atomic rename.
    if (existsSync(this.remotesFilePath)) {
      try {
        renameSync(this.remotesFilePath, `${this.remotesFilePath}.bak`);
      } catch {
        /* best-effort */
      }
    }
    renameSync(tmp, this.remotesFilePath);
    try {
      chmodSync(this.remotesFilePath, 0o600);
    } catch {
      /* best-effort — some filesystems reject chmod */
    }
  }

  addRemote(name: string, entry: RemoteEntry, opts: { setDefault?: boolean } = {}): void {
    if (!isValidName(name)) {
      throw new Error(`invalid remote name: ${name} (alphanumeric / _ / - · max 64 chars)`);
    }
    const file = this.load();
    file.remotes[name] = entry;
    if (opts.setDefault || file.default === undefined) {
      file.default = name;
    }
    this.save(file);
  }

  removeRemote(name: string): boolean {
    const file = this.load();
    if (!file.remotes[name]) return false;
    const tokenPath = file.remotes[name]?.token_file;
    delete file.remotes[name];
    if (file.default === name) {
      // Pick first remaining as default · undefined when none left.
      const next = Object.keys(file.remotes)[0];
      if (next) file.default = next;
      else delete file.default;
    }
    this.save(file);
    if (tokenPath && existsSync(tokenPath)) {
      try { unlinkSync(tokenPath); } catch { /* best-effort */ }
    }
    return true;
  }

  setDefaultRemote(name: string): boolean {
    const file = this.load();
    if (!file.remotes[name]) return false;
    file.default = name;
    this.save(file);
    return true;
  }

  getDefaultRemote(): RemoteEntry | undefined {
    const file = this.load();
    if (!file.default) return undefined;
    return file.remotes[file.default];
  }

  getRemote(name: string): RemoteEntry | undefined {
    return this.load().remotes[name];
  }

  listRemotes(): { name: string; entry: RemoteEntry; isDefault: boolean }[] {
    const file = this.load();
    return Object.entries(file.remotes).map(([name, entry]) => ({
      name,
      entry,
      isDefault: name === file.default,
    }));
  }

  /** Persist a token to <config-dir>/remotes/<name>.token (mode 0o600).
   *  Returns the absolute path. */
  saveToken(name: string, token: string): string {
    if (!isValidName(name)) {
      throw new Error(`invalid remote name: ${name}`);
    }
    mkdirSync(this.tokensDir, { recursive: true });
    const path = joinPath(this.tokensDir, `${name}.token`);
    writeFileSync(path, token, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    return path;
  }

  readToken(entry: RemoteEntry): string | undefined {
    if (!existsSync(entry.token_file)) return undefined;
    try {
      return readFileSync(entry.token_file, 'utf-8').trim();
    } catch {
      return undefined;
    }
  }
}

const NAME_RX = /^[A-Za-z0-9_-]{1,64}$/;
export function isValidName(name: string): boolean {
  return NAME_RX.test(name);
}

/** Slugify a hostname into a bookmark name (lowercase, replace dots/colons). */
export function deriveNameFromHost(host: string): string {
  // strip protocol/scheme · trim trailing slash
  let h = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  // strip port suffix
  h = h.replace(/:\d+$/, '');
  // sanitize
  h = h.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (h.length === 0) return 'remote';
  if (h.length > 64) h = h.slice(0, 64);
  return h;
}

/** Parse a host/URL spec the user passed: `mbp.tailnet`, `mbp.tailnet:31415`,
 *  or `http://mbp.tailnet:31415`. Returns base URL (no trailing slash). */
export function normalizeHost(spec: string, defaultPort = DEFAULT_NEXUS_HTTP_PORT): { url: string; host: string; port: number } {
  let raw = spec.trim();
  if (raw.length === 0) throw new Error('host required');
  if (!/^https?:\/\//.test(raw)) raw = `http://${raw}`;
  const u = new URL(raw);
  const host = u.hostname;
  const port = u.port ? Number.parseInt(u.port, 10) : defaultPort;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${u.port}`);
  }
  return {
    url: `${u.protocol}//${host}:${port}`,
    host,
    port,
  };
}
