import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { getUserConfig, reloadUserConfig, saveUserConfig, type McpServerSpec } from '../user-config.js';
import {
  discoverMcpOAuth,
  exchangeAuthorizationCode,
  loadStoredRegistration,
  loopbackRedirectPort,
  prepareMcpOAuthAuthorization,
  type McpOAuthFetch,
} from '../mcp/mcp-oauth.js';
import { parseWwwAuthenticate } from '../mcp/client.js';
import { debug } from '../debug/log.js';
import { browserUnavailableReason } from '../oauth/browser-availability.js';

const CALLBACK_PATH = '/oauth/callback';
const DEFAULT_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);

type Output = { log: (line: string) => void; error: (line: string) => void };
type Callback = { code: string; state: string };

export interface McpLoginResult {
  exitCode: number;
}

export interface McpLoginOpts {
  serverId: string;
  timeoutMs?: number;
  out?: Output;
  readConfigFn?: () => { mcp?: { servers: McpServerSpec[] } };
  fetch?: McpOAuthFetch;
  openBrowser?: (url: string) => Promise<void>;
  browserEnv?: NodeJS.ProcessEnv;
  browserPlatform?: NodeJS.Platform;
  createListener?: (handler: (req: IncomingMessage, res: ServerResponse) => void) => Server;
  /** 발견한 issuer/tokenEndpoint 를 config 에 되쓰는 자리. 테스트 심. */
  persistDiscoveryFn?: (input: PersistDiscoveryInput) => PersistDiscoveryResult;
}

export interface PersistDiscoveryInput {
  serverId: string;
  issuer: string;
  tokenEndpoint?: string;
  /** config.json 경로. 기본은 운영 경로 — 테스트 심. */
  configPath?: string;
}

export interface PersistDiscoveryResult {
  /** config 에 실제로 «쓴» 값이 있나. 이미 같은 값이면 false. */
  written: boolean;
  /** 못 썼으면 이유 — 화면에 경고로 낸다. */
  error?: string;
}

export async function runMcpLogin(opts: McpLoginOpts): Promise<McpLoginResult> {
  const out = opts.out ?? { log: (line) => process.stdout.write(`${line}\n`), error: (line) => process.stderr.write(`${line}\n`) };
  const config = (opts.readConfigFn ?? getUserConfig)();
  const spec = config.mcp?.servers?.find((server) => server.id === opts.serverId);
  if (!spec) {
    out.error(`✗ server id '${opts.serverId}' not found in user-config mcp.servers[]`);
    return { exitCode: 1 };
  }
  if (spec.transport !== 'http') {
    out.error(`✗ server '${opts.serverId}' uses ${spec.transport} transport; mcp login requires an HTTP server`);
    return { exitCode: 1 };
  }

  let server: Server | undefined;
  try {
    const early = await listenForCallback(opts.createListener, 0);
    server = early.server;
    const challenge = await requestChallenge(spec.url, opts.fetch);
    if (!challenge.resourceMetadata) {
      out.error(`✗ server '${opts.serverId}' did not provide a 401 Bearer resource_metadata challenge`);
      return { exitCode: 1 };
    }
    const opened = await openLoginListener({
      early,
      serverId: opts.serverId,
      resourceMetadataUrl: challenge.resourceMetadata,
      ...(challenge.scope ? { scope: challenge.scope } : {}),
      resourceUrl: spec.url,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.createListener ? { createListener: opts.createListener } : {}),
    });
    const listener = opened.listener;
    server = listener.server;
    const authorization = opened.authorization;
    const callbackPromise = listener.wait(authorization.request.state, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // Browser launch can synchronously trigger the loopback callback; mark its
    // rejection handled before awaiting the launch so OAuth errors stay in this flow.
    void callbackPromise.catch(() => undefined);
    out.log(`Open this URL to authorize '${opts.serverId}':`);
    out.log(authorization.request.url);
    const why = browserUnavailableReason(opts.browserEnv ?? process.env, opts.browserPlatform ?? process.platform);
    if (why) {
      out.log(why);
      debug.log('browser.open', 'skipped', { reason: why.includes('ssh') ? 'ssh' : 'no-display' });
    } else {
      try {
        await (opts.openBrowser ?? openDefaultBrowser)(authorization.request.url);
      } catch {
        out.error('Could not open the default browser; open the URL above manually.');
      }
    }
    const callback = await callbackPromise;
    await exchangeAuthorizationCode(authorization.metadata, authorization.request, callback, {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    out.log(`✓ credentials saved for '${opts.serverId}' (${authorization.metadata.issuer})`);
    // ⭐⭐ 🔴 여기가 이 파일의 «가장 중요한» 여덟 줄이다 (대표 2026-09-10).
    //
    //   초판은 issuer 를 «화면에 찍고 끝»이었다. 그런데 자격증명 저장소는
    //   issuer 를 «키»로 쓰고(`getValidAccessToken(issuer, …)`), 데몬은 그
    //   issuer 를 오직 config 의 `mcp.servers[].oauthIssuer` 에서만 얻는다
    //   (`register-mcp-clients.ts` 는 spec 에 «있을 때만» 넘기고,
    //    `McpClient.oauthAccessToken()` 은 `if (!this.oauthIssuer) return null`).
    //
    //   ⇒ 그래서 `mcp login` 이 «성공하고 ✓ 를 찍어도» 사람이 config 를 손으로
    //      고치지 않으면 그 토큰은 영영 안 쓰인다. 2026-09-10 에 krea 를 붙이며
    //      실제로 그 두 줄을 손으로 박았다. 「로그인했는데 도구가 0개」의 원인이다.
    const persist = (opts.persistDiscoveryFn ?? persistDiscoveredIssuer)({
      serverId: opts.serverId,
      issuer: authorization.metadata.issuer,
      ...(authorization.metadata.tokenEndpoint ? { tokenEndpoint: authorization.metadata.tokenEndpoint } : {}),
    });
    if (persist.error) {
      // ⛔ 자격증명은 «이미 저장됐다» — 되쓰기 실패로 로그인 자체를 실패로 접으면
      //    사람이 같은 브라우저 왕복을 또 한다. 경고로 내고 손 처방을 같이 준다.
      out.error(`⚠ config 에 oauthIssuer 를 못 적었습니다: ${persist.error}`);
      out.error(`  손으로: mcp.servers[] 의 '${opts.serverId}' 칸에 "oauthIssuer": "${authorization.metadata.issuer}" 를 더하세요.`);
    } else if (persist.written) {
      out.log(`✓ config 갱신 — '${opts.serverId}'.oauthIssuer = ${authorization.metadata.issuer}`);
    }
    out.log(`  도는 데몬에 반영하려면: elanous mcp reload`);
    return { exitCode: 0 };
  } catch (error) {
    const stage = loginFailureStage(error);
    debug.log('mcp.login', 'failed', {
      serverId: opts.serverId,
      stage,
      reason: error instanceof Error ? error.message : String(error),
    });
    out.error(`✗ MCP login failed: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 1 };
  } finally {
    if (server) await closeServer(server);
  }
}

async function requestChallenge(url: string, fetchFn?: McpOAuthFetch): Promise<{ resourceMetadata?: string; scope?: string }> {
  const response = await (fetchFn ?? ((target, init) => fetch(target, init)))(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'elanous', version: '1' } } }),
  });
  if (response.status !== 401) throw new Error(`initial MCP request returned HTTP ${response.status}; expected 401 authorization challenge`);
  return parseWwwAuthenticate(response.headers.get('www-authenticate') ?? '');
}

function loginFailureStage(error: unknown): 'authorization' | 'token' | 'login' {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'token' || code === 'refresh' || code === 'state-mismatch') return 'token';
  if (code === 'registration' || code === 'discovery' || code === 'identity-mismatch' || code === 's256-unsupported') {
    return 'authorization';
  }
  return 'login';
}

async function openLoginListener(opts: {
  serverId: string;
  resourceMetadataUrl: string;
  scope?: string;
  resourceUrl: string;
  fetch?: McpOAuthFetch;
  createListener?: McpLoginOpts['createListener'];
  early: Awaited<ReturnType<typeof listenForCallback>>;
}): Promise<{ listener: Awaited<ReturnType<typeof listenForCallback>>; authorization: Awaited<ReturnType<typeof prepareMcpOAuthAuthorization>> }> {
  const prior = await priorRegistration(opts);
  const preferred = loopbackRedirectPort(prior?.redirectUri);
  if (preferred === null && (prior === null || prior.redirectUri)) {
    const listener = opts.early;
    debug.log('mcp.login', 'callback-port', { serverId: opts.serverId, source: 'fresh' });
    const authorization = await prepareMcpOAuthAuthorization({
      resourceMetadataUrl: opts.resourceMetadataUrl,
      scope: opts.scope,
      redirectUri: listener.redirectUri,
      resourceUrl: opts.resourceUrl,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    return { listener, authorization };
  }
  await closeServer(opts.early.server);
  if (preferred !== null) {
    try {
      const listener = await listenForCallback(opts.createListener, preferred);
      debug.log('mcp.login', 'callback-port', { serverId: opts.serverId, source: 'registered' });
      const authorization = await prepareMcpOAuthAuthorization({
        resourceMetadataUrl: opts.resourceMetadataUrl,
        scope: opts.scope,
        redirectUri: listener.redirectUri,
        resourceUrl: opts.resourceUrl,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      return { listener, authorization };
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
  }
  const listener = await listenForCallback(opts.createListener, 0);
  debug.log('mcp.login', 'callback-port', {
    serverId: opts.serverId,
    source: 'reregistered',
    reason: preferred === null ? 'missing-redirect-uri' : 'port-in-use',
  });
  const authorization = await prepareMcpOAuthAuthorization({
    resourceMetadataUrl: opts.resourceMetadataUrl,
    scope: opts.scope,
    redirectUri: listener.redirectUri,
    resourceUrl: opts.resourceUrl,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    forceReregister: true,
  });
  return { listener, authorization };
}

async function priorRegistration(opts: {
  resourceMetadataUrl: string;
  resourceUrl: string;
  fetch?: McpOAuthFetch;
}): Promise<ReturnType<typeof loadStoredRegistration>> {
  try {
    const discovered = await discoverMcpOAuth(opts.resourceMetadataUrl, {
      resourceUrl: opts.resourceUrl,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    return loadStoredRegistration(discovered.metadata.issuer);
  } catch {
    return null;
  }
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 'EADDRINUSE');
}

async function listenForCallback(
  createListener: McpLoginOpts['createListener'],
  port: number,
): Promise<{
  server: Server;
  redirectUri: string;
  wait: (expectedState: string, timeoutMs: number) => Promise<Callback>;
}> {
  let completed = false;
  let callbackResult: Callback | Error | undefined;
  let settle: ((value: Callback) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  let clearWaitTimer: (() => void) | undefined;
  // ⛔⭐⭐ 기대 state 는 «인가 요청을 조립한 뒤»에야 정해진다 — 그런데 문은 그보다
  //    «먼저» 열려야 되돌려받을 주소를 알 수 있다. 그래서 이 값은 `wait()` 가 채운다.
  //    ⇒ 그 사이에 콜백이 «먼저» 도착할 수 있으므로 원본을 담아 두고 `wait()` 에서 대조한다.
  //    ⛔ 담아 두지 않으면 그 요청은 «유실»되고 사람은 타임아웃만 본다.
  let expectedState: string | undefined;
  let pendingRaw: { code: string; state: string } | undefined;
  const settleCallback = (result: Callback | Error): void => {
    callbackResult = result;
    clearWaitTimer?.();
    if (result instanceof Error) reject?.(result);
    else settle?.(result);
  };
  /** 기대 state 를 아는 시점에서만 부른다. */
  const matchState = (raw: { code: string; state: string }): Callback | Error =>
    raw.state === expectedState
      ? { code: raw.code, state: raw.state }
      : new Error('authorization callback state does not match the authorization request');
  const server = (createListener ?? createServer)((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== CALLBACK_PATH || completed) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      completed = true;
      const error = new Error(`authorization callback returned ${oauthError}${url.searchParams.get('error_description') ? `: ${url.searchParams.get('error_description')}` : ''}`);
      res.writeHead(400); res.end('Login failed; return to the terminal.');
      settleCallback(error);
      return;
    }
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? '';
    if (!code || !state) {
      completed = true;
      const error = new Error('authorization callback is missing code or state');
      res.writeHead(400); res.end('Login failed; return to the terminal.');
      settleCallback(error);
      return;
    }
    completed = true;
    if (expectedState === undefined) {
      // ⛔ 아직 대조할 값이 없다 — «성공했다»고 말하지 않는다.
      pendingRaw = { code, state };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Received. Return to the terminal.');
      return;
    }
    const result = matchState({ code, state });
    if (result instanceof Error) {
      res.writeHead(400); res.end('Login failed; return to the terminal.');
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Login complete. You may return to the terminal.');
    }
    settleCallback(result);
  });
  await new Promise<void>((resolve, rejectListen) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback listener did not provide a TCP port');
  return {
    server,
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    wait: (state, timeoutMs) => new Promise<Callback>((resolve, rejectWait) => {
      // ⭐ 대조 값이 «여기서» 정해진다. 그 전에 도착한 콜백은 아래에서 처리한다.
      expectedState = state;
      if (callbackResult instanceof Error) {
        rejectWait(callbackResult);
        return;
      }
      if (callbackResult) {
        resolve(callbackResult);
        return;
      }
      if (pendingRaw) {
        // 문이 열린 뒤 · 기대값이 정해지기 «전»에 온 콜백 — 지금 대조한다.
        const raw = pendingRaw;
        pendingRaw = undefined;
        const result = matchState(raw);
        callbackResult = result;
        if (result instanceof Error) rejectWait(result);
        else resolve(result);
        return;
      }
      settle = resolve;
      reject = rejectWait;
      const timer = setTimeout(() => rejectWait(new Error(`authorization callback timed out after ${timeoutMs}ms`)), timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      // ⛔ 성공·실패 어느 쪽으로 끝나든 타이머를 «반드시» 거둔다.
      clearWaitTimer = () => clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
    }),
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function openDefaultBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  await execFileAsync(command, args);
}


/** 발견한 issuer/tokenEndpoint 를 user-config 의 그 서버 칸에 되쓴다.
 *
 *  ⛔ `mcp` 섹션은 typed 파서를 통과하지만 `saveUserConfig` 의 `rawRest` 에서
 *     «지워지지 않는다» — 즉 raw 로 라운드트립한다. 그래서 되쓰기는 `cfg.raw.mcp`
 *     쪽에 해야 저장에서 살아남는다(typed `cfg.mcp` 만 고치면 조용히 버려진다). */
export function persistDiscoveredIssuer(input: PersistDiscoveryInput): PersistDiscoveryResult {
  try {
    // 되쓰기 직전에 «다시» 읽는다 — 로그인은 브라우저 왕복이라 몇 십 초가 걸리고,
    // 그 사이 사람이 config 를 고쳤을 수 있다. 캐시를 쓰면 그 편집을 지운다.
    const cfg = input.configPath ? reloadUserConfig(input.configPath) : reloadUserConfig();
    const raw = (cfg.raw ?? {}) as Record<string, unknown>;
    const mcpRaw = raw.mcp as { servers?: unknown } | undefined;
    const servers = Array.isArray(mcpRaw?.servers) ? (mcpRaw.servers as Record<string, unknown>[]) : undefined;
    if (!servers) return { written: false, error: 'config 에 mcp.servers[] 가 없습니다' };
    const row = servers.find((server) => server?.id === input.serverId);
    if (!row) return { written: false, error: `config 의 mcp.servers[] 에 '${input.serverId}' 가 없습니다` };
    const sameIssuer = row.oauthIssuer === input.issuer;
    const sameEndpoint = input.tokenEndpoint === undefined || row.oauthTokenEndpoint === input.tokenEndpoint;
    if (sameIssuer && sameEndpoint) return { written: false };
    row.oauthIssuer = input.issuer;
    if (input.tokenEndpoint !== undefined) row.oauthTokenEndpoint = input.tokenEndpoint;
    if (input.configPath) saveUserConfig(cfg, input.configPath);
    else saveUserConfig(cfg);
    return { written: true };
  } catch (err: unknown) {
    return { written: false, error: err instanceof Error ? err.message : String(err) };
  }
}
