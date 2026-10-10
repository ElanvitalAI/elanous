// POST write/execute routes bearer gate — wiring, not handler unit.
//
// The four mutation POSTs used to reach handlers before auth (400 invalid-json
// or an unconditional discovery run). The gate lives in http-server.ts, same
// one-liner as mint-token / SESSION_TURN_CONTROL_PATH / publish/markdown.

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { startNexusHttpServer } from '../src/nexus/api/http-server.js';
import { NexusEventBus } from '../src/nexus/api/event-bus.js';
import { createNexusState } from '../src/nexus/state/state.js';
import { TabRegistry } from '../src/nexus/state/tab-registry.js';
import * as templates from '../src/nexus/api/templates.js';
import * as config from '../src/nexus/api/config.js';
import * as discovery from '../src/nexus/api/registry-discovery.js';
import * as autopilot from '../src/nexus/api/autopilot-handler.js';
import * as channelBot from '../src/nexus/api/setup-channel-bot.js';
import * as podCredential from '../src/nexus/api/pod-credential-api.js';

const WRITE_PATHS = [
  '/v1/autopilot/run',
  '/v1/nexus/templates',
  '/v1/config/secrets',
  '/v1/registry/discovery',
  '/v1/pod/credential/grok',
  '/v1/pod/credential/github',
] as const;

const CONNECT_INFO_PATH = '/v1/nexus/connect-info';
const APP_PATH = '/app/';
const BEARER = 'write-gate-test-token';
const STUB_BODY = { gated: true };

function serverFixture() {
  const state = createNexusState({ nexusVersion: 'test', phase: 'test' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  return {
    state,
    eventBus,
    registry: new TabRegistry(state),
    metaApi: { bearerToken: BEARER, noAuth: false },
    connectInfo: {
      nexusVersion: 'test',
      acpTokenOverride: 'unused-acp-token',
    },
    startPort: 58000 + Math.floor(Math.random() * 1000),
  };
}

function stubHandlers() {
  const stub = () => Promise.resolve(Response.json(STUB_BODY, { status: 200 }));
  return {
    templates: spyOn(templates, 'handleTemplateSave').mockImplementation(stub),
    secrets: spyOn(config, 'handleSecretPost').mockImplementation(stub),
    discovery: spyOn(discovery, 'handleDiscoveryRun').mockImplementation(stub),
    autopilot: spyOn(autopilot, 'handleAutopilotRun').mockImplementation(stub),
  };
}

afterEach(() => {
  mock.restore();
});

describe('POST write routes — bearer gate', () => {
  test('GitHub credential route uses gh-credential scope, not the Nexus or Grok bearer', async () => {
    const gate = spyOn(podCredential, 'authenticatePodCredential').mockImplementation(async (_req, _deps, scope) => {
      if (scope !== 'gh-credential') return { ok: false, response: Response.json({ error: 'wrong_scope' }, { status: 403 }) };
      return { ok: true, runId: 'run', job: 'job', repository: 'owner/repo', exp: Date.now() + 60_000 };
    });
    const handler = spyOn(podCredential, 'handlePodGithubCredential').mockImplementation(async () => Response.json({ token: 'app', expires_at: '2030-01-01T00:00:00Z' }));
    const server = startNexusHttpServer(serverFixture());
    try {
      const response = await fetch(`${server.url}/v1/pod/credential/github`, { method: 'POST', headers: { authorization: 'Bearer run-token' } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ token: 'app', expires_at: '2030-01-01T00:00:00Z' });
      expect(gate).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally { server.stop(); handler.mockRestore(); gate.mockRestore(); }
  });

  test.each([...WRITE_PATHS])('Authorization header 없이 %s 를 POST 하면 401', async (path) => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally {
      server.stop();
    }
  });

  test('인증 실패 시 핸들러가 불리지 않는다', async () => {
    const spies = stubHandlers();
    const server = startNexusHttpServer(serverFixture());
    try {
      for (const path of WRITE_PATHS) {
        const res = await fetch(`${server.url}${path}`, {
          method: 'POST',
          headers: { 'sec-fetch-site': 'cross-site' },
        });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'unauthorized' });
      }
      expect(spies.templates).toHaveBeenCalledTimes(0);
      expect(spies.secrets).toHaveBeenCalledTimes(0);
      expect(spies.discovery).toHaveBeenCalledTimes(0);
      expect(spies.autopilot).toHaveBeenCalledTimes(0);
    } finally {
      server.stop();
    }
  });

  test('유효한 bearer 로 부르면 401 이 아니고 핸들러에 도달한다', async () => {
    const spies = stubHandlers();
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}/v1/nexus/templates`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${BEARER}`,
          'sec-fetch-site': 'cross-site',
        },
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(STUB_BODY);
      expect(spies.templates).toHaveBeenCalledTimes(1);
      expect(spies.secrets).toHaveBeenCalledTimes(0);
      expect(spies.discovery).toHaveBeenCalledTimes(0);
      expect(spies.autopilot).toHaveBeenCalledTimes(0);
    } finally {
      server.stop();
    }
  });

  // 🔐 2026-09-26: 교차 출처(아무 웹사이트)는 connect-info 에서 관리 토큰을 받지 못한다 — 연결 정보만.
  //   종전 이 시험은 «cross-site 에도 auto_token 이 실린다»를 보증했다(실측: Origin evil → 200 ⊕ ACAO * ⊕ 토큰 원문).
  test.each([
    ['다른 웹사이트', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, false],
    // 🔐 2026-09-26(🅣 전수): Origin 없음·루프백 출처도 원문을 못 받는다 — tailnet serve 가 localhost 로 프록시해 가를 수 없다.
    ['Origin 없음(로컬 프로세스·CLI · tailnet 기기·Pod 와 구별 불가)', {}, false],
    ['루프백 출처(PWA 개발 서버)', { origin: 'http://localhost:3210' }, false],
  ] as const)('GET /v1/nexus/connect-info — %s → 토큰 %s', async (_label, headers, expectToken) => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}${CONNECT_INFO_PATH}`, { headers: headers as Record<string, string> });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { auto_token?: unknown; acp_url?: unknown };
      expect(typeof body.acp_url).toBe('string');   // 연결 정보는 누구에게나
      expect(typeof body.auto_token === 'string' && (body.auto_token as string).length > 0).toBe(expectToken);
    } finally {
      server.stop();
    }
  });
  test('GET /v1/nexus/connect-info — 이 데몬이 서빙한 페이지(Origin 호스트 == Host)도 원문을 받지 않는다(PWA 는 mint-token 을 쓴다)', async () => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const host = new URL(server.url).host;
      const res = await fetch(`${server.url}${CONNECT_INFO_PATH}`, { headers: { origin: `http://${host}` } });
      const body = (await res.json()) as { auto_token?: unknown };
      expect(body.auto_token).toBeNull();
    } finally {
      server.stop();
    }
  });

  test('GET /app/ 는 새 관문으로 차단되지 않는다', async () => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}${APP_PATH}`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'static-not-wired' });
    } finally {
      server.stop();
    }
  });
});

// 2026-09-26 — 설정·제어 쓰기 여섯이 인증 없이 핸들러에 닿던 자리(🅢 비파괴 탐침). OPTIONS 사전 요청은 그대로 둔다.
const CONFIG_WRITES: ReadonlyArray<readonly [string, string]> = [
  ['PUT', '/v1/config/switches/__gate_probe__'],
  ['PUT', '/v1/config/model-tier'],
  ['POST', '/v1/setup/llm-provider'],
  ['POST', '/v1/setup/obsidian'],
  ['POST', '/v1/setup/skills'],
  ['POST', '/v1/setup/child-llm'],
  ['POST', '/v1/setup/channel-bot'],
  ['PUT', '/v1/vault/file'],
  ['POST', '/v1/intake-ledger/items'],
  ['PUT', '/v1/llm/hosts'],
  ['DELETE', '/v1/llm/hosts'],
  ['POST', '/v1/llm/rotation/next'],
  ['POST', '/v1/autopilot/mission-action'],
  ['POST', '/v1/autopilot/triage-preview'], // TRIAGE-COMMIT-AUTH(10-09) — commit:true 가 미션을 쓴다
  ['POST', '/v1/intake/route'],
];
describe('config/control write routes — bearer gate', () => {
  test('OPTIONS /v1/vault/file is available for cross-origin PUT preflight', async () => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}/v1/vault/file`, {
        method: 'OPTIONS', headers: { origin: 'https://example.invalid', 'access-control-request-method': 'PUT' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    } finally { server.stop(); }
  });
  test.each(CONFIG_WRITES.map(([m, p]) => [m, p]))('인증 없이 %s %s → 401 (교차 출처)', async (method, path) => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}${path}`, { method, headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body: '{}' });
      expect(res.status).toBe(401);
    } finally { server.stop(); }
  });
  // TRIAGE-COMMIT-AUTH(10-09): 라우트 줄엔 checkAuth 가 없지만 위 default-deny(isPublicRoute 밖 /v1/*)가 막는다 — 그 계약을 못 박는다.
  test('TRIAGE-COMMIT-AUTH: 출처 머리 없는 직접 호출(데몬 포트)도 commit:true 미션 쓰기 전에 401', async () => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}/v1/autopilot/triage-preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'probe', commit: true }),
      });
      expect(res.status).toBe(401);
    } finally { server.stop(); }
  });
  test('인증 없이 GET /v1/intake-ledger/items/:id → 401 (원장 추적도 막는다 · PWA 칸은 user-private)', async () => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}/v1/intake-ledger/items/0123456789abcdef`, { headers: { 'sec-fetch-site': 'cross-site' } });
      expect(res.status).toBe(401);
    } finally { server.stop(); }
  });
  test('channel-bot POST is gated before its handler, and a bearer reaches that handler', async () => {
    const handler = spyOn(channelBot, 'handleChannelBotSet').mockImplementation(async () => Response.json(STUB_BODY));
    const server = startNexusHttpServer(serverFixture());
    try {
      const url = `${server.url}/v1/setup/channel-bot`;
      const denied = await fetch(url, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' });
      expect(denied.status).toBe(401);
      expect(handler).toHaveBeenCalledTimes(0);
      const allowed = await fetch(url, { method: 'POST', headers: {
        authorization: `Bearer ${BEARER}`, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json',
      }, body: '{}' });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual(STUB_BODY);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally { server.stop(); handler.mockRestore(); }
  });
  test('올바른 bearer 는 게이트를 지나 핸들러에 닿는다(대조군 — 401 이 아니다)', async () => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}/v1/config/switches/__gate_probe__`, { method: 'PUT', headers: { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' }, body: '{"value":true}' });
      expect(res.status).not.toBe(401);
    } finally { server.stop(); }
  });
});

// 2026-09-27 — /v1/vault/* 읽기·template-expand 가 인증 없이 노트 원문·전문검색을 돌려주던 자리.
// 게이트는 startNexusHttpServer 의 parseVaultPath → handleVaultGet / template-expand 호출 직전(기존 checkAuth).
const VAULT_READS: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/v1/vault/info'],
  ['GET', '/v1/vault/read?path=note.md'],
  ['GET', '/v1/vault/search?q=a'],
  ['POST', '/v1/vault/template-expand'],
];
describe('vault read routes — bearer gate', () => {
  test.each(VAULT_READS.map(([m, p]) => [m, p]))('인증 없이 %s %s → 401 (교차 출처)', async (method, path) => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}${path}`, {
        method,
        headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    } finally { server.stop(); }
  });
  test.each(VAULT_READS.map(([m, p]) => [m, p]))('올바른 bearer 로 %s %s → 401 이 아니다', async (method, path) => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${BEARER}`, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.status).not.toBe(401);
    } finally { server.stop(); }
  });
  test('OPTIONS /v1/vault/list 는 사전 요청이라 204', async () => {
    const server = startNexusHttpServer(serverFixture());
    try {
      const res = await fetch(`${server.url}/v1/vault/list`, {
        method: 'OPTIONS',
        headers: { 'sec-fetch-site': 'cross-site', origin: 'https://example.invalid', 'access-control-request-method': 'GET' },
      });
      expect(res.status).toBe(204);
    } finally { server.stop(); }
  });
});
