// CLI · `elanous nexus connect|list|switch|remove` action handlers (T4.B)
//
// Subcommand action functions are split out from src/index.ts so the
// commander wiring stays declarative + the action logic can be unit-
// tested without re-running the CLI via Bun.spawn.

import { existsSync, readFileSync } from 'node:fs';
import { defaultAcpTokenPath } from '../nexus/api/connect-info.js';
import { DEFAULT_NEXUS_HTTP_PORT } from '../nexus/default-port.js';
import {
  RemotesStore,
  deriveNameFromHost,
  normalizeHost,
  type RemoteEntry,
} from './remotes.js';

/** 이 기계를 가리키는 주소 — 토큰 파일을 직접 읽어도 되는 경우(같은 uid). */
const LOOPBACK_BOOTSTRAP_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface ConnectRemoteOpts {
  host: string;
  name?: string;
  port?: number;
  token?: string;
  tokenFile?: string;
  /** Boolean from --default / --no-default (commander). */
  setDefault?: boolean;
  /** False = skip /v1/health probe. */
  ping?: boolean;
  /** Test seam — fetch override. */
  fetchImpl?: typeof fetch;
  /** Test seam — same-host token file (default `~/.elanous/acp-token`). */
  localTokenPath?: string;
  /** Test seam — store override (alternate paths). */
  store?: RemotesStore;
  /** Stdout sink (test). */
  stdout?: { log: (s: string) => void; error: (s: string) => void };
}

interface ConnectInfoResponse {
  acp_url: string;
  voice_url: string | null;
  token_required: boolean;
  token_hint?: string;
  server_label: string;
  auto_token: string | null;
}

export async function connectRemote(opts: ConnectRemoteOpts): Promise<number> {
  const out = opts.stdout ?? console;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const store = opts.store ?? new RemotesStore();
  let parsed: ReturnType<typeof normalizeHost>;
  try {
    parsed = normalizeHost(opts.host, opts.port ?? DEFAULT_NEXUS_HTTP_PORT);
  } catch (err) {
    out.error(`elanous nexus connect: ${(err as Error).message}`);
    return 1;
  }
  const name = opts.name ?? deriveNameFromHost(parsed.host);
  if (opts.ping !== false) {
    try {
      const health = await fetchImpl(`${parsed.url}/v1/health`);
      if (!health.ok) {
        out.error(`/v1/health returned ${health.status} — pass --no-ping to bookmark anyway.`);
        return 1;
      }
    } catch (err) {
      out.error(
        `/v1/health unreachable: ${(err as Error).message} — pass --no-ping to bookmark anyway.`,
      );
      return 1;
    }
  }

  let metadata: ConnectInfoResponse | null = null;
  let acpUrl = `ws://${parsed.host}:${parsed.port}/v1/acp`;
  let voiceUrl: string | undefined;
  let serverLabel: string | undefined;
  let autoToken: string | null = null;
  try {
    const res = await fetchImpl(`${parsed.url}/v1/nexus/connect-info`);
    if (res.ok) {
      metadata = (await res.json()) as ConnectInfoResponse;
      acpUrl = metadata.acp_url;
      if (metadata.voice_url) voiceUrl = metadata.voice_url;
      serverLabel = metadata.server_label;
      autoToken = metadata.auto_token;
    } else if (res.status !== 404) {
      out.error(`/v1/nexus/connect-info returned ${res.status} — falling back to defaults.`);
    }
  } catch (err) {
    out.error(`connect-info fetch failed: ${(err as Error).message} — using default URL.`);
  }

  let token = opts.token ?? null;
  if (!token && opts.tokenFile) {
    if (!existsSync(opts.tokenFile)) {
      out.error(`token-file not found: ${opts.tokenFile}`);
      return 1;
    }
    token = readFileSync(opts.tokenFile, 'utf-8').trim();
  }
  if (!token && autoToken) {
    // 옛 서버(원문을 싣던 판)와의 호환 — 새 서버는 늘 null 이다.
    token = autoToken;
    out.log(`auto_token loaded from ${parsed.host} (loopback bootstrap).`);
  }
  if (!token && LOOPBACK_BOOTSTRAP_HOSTS.has(parsed.host)) {
    // 🔐 같은 기계 · 같은 uid — 서버에게 원문을 받지 않고 토큰 파일을 직접 읽는다.
    const localTokenPath = opts.localTokenPath ?? defaultAcpTokenPath();
    if (existsSync(localTokenPath)) {
      const local = readFileSync(localTokenPath, 'utf-8').trim();
      if (local) {
        token = local;
        out.log(`token loaded from ${localTokenPath} (same-host bootstrap).`);
      }
    }
  }
  if (!token) {
    out.error(
      'token required. Pass --token <value> or --token-file <path>. ' +
        'Or run from the host machine to use loopback auto_token.',
    );
    return 1;
  }
  const tokenPath = store.saveToken(name, token);

  const entry: RemoteEntry = {
    host: parsed.host,
    acp_url: acpUrl,
    ...(voiceUrl ? { voice_url: voiceUrl } : {}),
    token_file: tokenPath,
    ...(serverLabel ? { label: serverLabel } : {}),
    addedAt: new Date().toISOString(),
  };
  const setDefault = opts.setDefault === true;
  store.addRemote(name, entry, { setDefault });
  out.log(`bookmark ${name} → ${parsed.url}`);
  out.log(`  acp_url    ${entry.acp_url}`);
  if (entry.voice_url) out.log(`  voice_url  ${entry.voice_url}`);
  out.log(`  token      ${tokenPath} (mode 0o600)`);
  if (setDefault) out.log(`  default    ${name} (use \`elanous\` no-arg)`);
  return 0;
}

export interface ListRemotesOpts {
  ping?: boolean;
  json?: boolean;
  fetchImpl?: typeof fetch;
  store?: RemotesStore;
  stdout?: { log: (s: string) => void; error: (s: string) => void };
}

export async function listRemotesCmd(opts: ListRemotesOpts): Promise<number> {
  const out = opts.stdout ?? console;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const store = opts.store ?? new RemotesStore();
  const entries = store.listRemotes();
  if (opts.json) {
    out.log(JSON.stringify(entries, null, 2));
    return 0;
  }
  if (entries.length === 0) {
    out.log('(no remotes bookmarked) — `elanous nexus connect <host>` to add.');
    return 0;
  }
  for (const { name, entry, isDefault } of entries) {
    const marker = isDefault ? '*' : ' ';
    let status = '';
    if (opts.ping !== false) {
      const url = entry.acp_url
        .replace(/^ws:\/\//, 'http://')
        .replace(/^wss:\/\//, 'https://')
        .replace(/\/v1\/acp$/, '/v1/health');
      try {
        const res = await fetchImpl(url);
        status = res.ok ? '· ok' : `· http ${res.status}`;
      } catch {
        status = '· unreachable';
      }
    }
    out.log(
      `${marker} ${name.padEnd(16)}  ${entry.label ?? entry.host}  ${status}`,
    );
    out.log(
      `    acp_url=${entry.acp_url} · added=${entry.addedAt}`,
    );
  }
  return 0;
}

export interface SwitchRemoteOpts {
  name: string;
  store?: RemotesStore;
  stdout?: { log: (s: string) => void; error: (s: string) => void };
}

export async function switchRemote(opts: SwitchRemoteOpts): Promise<number> {
  const out = opts.stdout ?? console;
  const store = opts.store ?? new RemotesStore();
  const ok = store.setDefaultRemote(opts.name);
  if (!ok) {
    out.error(`unknown remote: ${opts.name} — run \`elanous nexus list\` to see bookmarks.`);
    return 1;
  }
  out.log(`default remote → ${opts.name}`);
  return 0;
}

export interface RemoveRemoteOpts {
  name: string;
  store?: RemotesStore;
  stdout?: { log: (s: string) => void; error: (s: string) => void };
}

export async function removeRemoteCmd(opts: RemoveRemoteOpts): Promise<number> {
  const out = opts.stdout ?? console;
  const store = opts.store ?? new RemotesStore();
  const ok = store.removeRemote(opts.name);
  if (!ok) {
    out.error(`unknown remote: ${opts.name}`);
    return 1;
  }
  out.log(`removed bookmark: ${opts.name}`);
  return 0;
}
