import { createServer, type Server } from 'node:http';
import {
  CODEX_DEVICE_TOKEN_URL,
  CODEX_DEVICE_USERCODE_URL,
  CODEX_OAUTH_TOKEN_URL,
} from '../oauth/codex.js';

export type FakeOpenAiApiMode = 'ok' | 'unauthorized' | 'rate-limited' | 'disconnect' | 'slow';

export type FakeCodexDeviceOAuthMode = 'complete' | 'denied' | 'expired-code' | 'pending' | 'poll-in-flight' | 'exchange-in-flight';

export interface FakeCodexDeviceOAuth {
  /** Route only the production loginWithCodex fetch seam; unknown URLs fail closed. */
  fetchImpl: typeof fetch;
  /** Safe request facts only. Codes, verifiers and tokens are never retained. */
  requests: () => Array<{ endpoint: 'device-code' | 'device-poll' | 'token'; grantType?: string }>;
  /** Delayed fake token exchange for cancellation race tests; it carries no live credentials. */
  exchangeStarted: Promise<void>;
  releaseExchange(): void;
  /** Delayed fake device approval for cancellation race tests. */
  pollStarted: Promise<void>;
  releasePoll(): void;
}

/** Fake OpenAI device-code endpoints for the real loginWithCodex production path. */
export function createFakeCodexDeviceOAuth(mode: FakeCodexDeviceOAuthMode = 'complete'): FakeCodexDeviceOAuth {
  let polls = 0;
  let signalPollStarted!: () => void;
  let releasePollResponse!: (response: Response) => void;
  let signalExchangeStarted!: () => void;
  let releaseExchangeResponse!: (response: Response) => void;
  const pollStarted = new Promise<void>(resolve => { signalPollStarted = resolve; });
  const pollResponse = new Promise<Response>(resolve => { releasePollResponse = resolve; });
  const exchangeStarted = new Promise<void>(resolve => { signalExchangeStarted = resolve; });
  const exchangeResponse = new Promise<Response>(resolve => { releaseExchangeResponse = resolve; });
  const calls: Array<{ endpoint: 'device-code' | 'device-poll' | 'token'; grantType?: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === CODEX_DEVICE_USERCODE_URL) {
      calls.push({ endpoint: 'device-code' });
      return new Response(JSON.stringify({
        device_auth_id: 'fake-device-auth-id', user_code: 'FAKE-USER-CODE', interval: 0,
        verification_uri: 'https://auth.openai.com/codex/device',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url === CODEX_DEVICE_TOKEN_URL) {
      calls.push({ endpoint: 'device-poll' });
      polls++;
      if (mode === 'denied') {
        return new Response(JSON.stringify({ error: 'access_denied' }), { status: 400 });
      }
      if (mode === 'expired-code') {
        return new Response(JSON.stringify({ error: 'expired_token' }), { status: 400 });
      }
      if (mode === 'pending') return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 403 });
      if (mode === 'poll-in-flight') {
        signalPollStarted();
        // Deliberately ignore AbortSignal so the production post-poll abort check is exercised.
        return pollResponse;
      }
      if (mode === 'exchange-in-flight') return new Response(JSON.stringify({ authorization_code: 'fake-authorization-code', code_verifier: 'fake-code-verifier' }), { status: 200 });
      if (polls === 1) return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 403 });
      return new Response(JSON.stringify({ authorization_code: 'fake-authorization-code', code_verifier: 'fake-code-verifier' }), { status: 200 });
    }
    if (url === CODEX_OAUTH_TOKEN_URL) {
      const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      const grantType = body.get('grant_type') ?? undefined;
      calls.push({ endpoint: 'token', ...(grantType ? { grantType } : {}) });
      if (grantType === 'authorization_code') {
        if (mode === 'exchange-in-flight') {
          signalExchangeStarted();
          // Deliberately ignore AbortSignal so the production post-response abort check is exercised.
          return exchangeResponse;
        }
        if (body.get('code') !== 'fake-authorization-code' || body.get('code_verifier') !== 'fake-code-verifier') {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        }
        return new Response(JSON.stringify({
          access_token: 'fake-initial-access-token', refresh_token: 'fake-initial-refresh-token', expires_in: 0,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (grantType === 'refresh_token' && body.get('refresh_token') === 'fake-initial-refresh-token') {
        return new Response(JSON.stringify({
          access_token: 'fake-refreshed-access-token', refresh_token: 'fake-rotated-refresh-token', expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'unsupported_grant_type' }), { status: 400 });
    }
    throw new Error('fake Codex OAuth blocked an unexpected endpoint');
  }) as typeof fetch;
  return {
    fetchImpl,
    requests: () => calls.map(call => ({ ...call })),
    exchangeStarted,
    pollStarted,
    releasePoll: () => releasePollResponse(new Response(JSON.stringify({ authorization_code: 'late-fake-authorization-code', code_verifier: 'late-fake-code-verifier' }), { status: 200, headers: { 'content-type': 'application/json' } })),
    releaseExchange: () => releaseExchangeResponse(new Response(JSON.stringify({
      access_token: 'fake-delayed-access-token', refresh_token: 'fake-delayed-refresh-token', expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } })),
  };
}

/** Local OpenAI-compatible /v1/models endpoint for testing the production key verifier. */
export async function startFakeOpenAiCompatibleApi(mode: FakeOpenAiApiMode, delayMs = 350): Promise<{
  baseUrl: string;
  requests: () => number;
  close: () => Promise<void>;
}> {
  let requestCount = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server: Server = createServer((request, response) => {
    requestCount++;
    if (request.url !== '/v1/models') {
      response.writeHead(404).end();
      return;
    }
    if (mode === 'disconnect') {
      request.socket.destroy();
      return;
    }
    if (mode === 'slow') {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      }, delayMs);
      timers.add(timer);
      return;
    }
    const status = mode === 'ok' ? 200 : mode === 'unauthorized' ? 401 : 429;
    response.writeHead(status, { 'content-type': 'application/json' }).end(mode === 'ok' ? '{"data":[]}' : '{}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake OpenAI API did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requestCount,
    close: () => new Promise<void>((resolve, reject) => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
