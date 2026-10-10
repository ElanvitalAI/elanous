/**
 * 독립 OpenAI 호환 릴레이 리스너 (대표 2026-08-23).
 *
 * ⛔ 왜 «독립»인가 — nexus 데몬(31415)에는 `/v1/` 라우트가 167개 있다. 릴레이 하나를 테일넷에
 *    열자고 그 167개를 같이 여는 것은 노출이 과하다. 이 프로세스는 ***릴레이 경로만*** 서빙한다.
 *
 * ⛔ TLS 를 안 쓴다 — 테일넷 트래픽은 WireGuard 가 이미 암호화한다(대표 지적). 평문 HTTP 로
 *    테일스케일 IP 에 바인딩하며, 그 IP 는 테일넷 밖에서 라우팅되지 않는다.
 *
 * 환경변수
 *   ELANOUS_OPENAI_RELAY_SHARED_SECRET  (필수) — 없으면 핸들러가 503 을 낸다
 *   ELANOUS_OPENAI_RELAY_HOST           바인딩 주소. 기본 127.0.0.1
 *   ELANOUS_OPENAI_RELAY_PORT           바인딩 포트. 기본 31420
 */
import { OPENAI_RELAY_PATH, tryHandleOpenAiRelay } from '../src/nexus/api/openai-relay.js';
import { resolveGrokCredential } from '../src/grok/credential.js';
import { debug } from '../src/debug/log.js';
import { getOpenAiRelaySharedSecret, hydrateEnvFromKeyCache } from '../src/config.js';
import { registerLogStoreSink } from '../src/mss/logging/log-store.js';
import { getUserConfig } from '../src/user-config.js';

// ⛔ 독립 프로세스라 데몬의 부팅 배선을 안 탄다 — 스토어 싱크를 «직접» 단다.
//    이걸 안 달면 debug.log 가 화면에만 남고 `elanous logs` 조회에 «영영 안 닿는다»
//    (2026-08-23 실측: nexus.openai-relay 는 닿았고 이 프로세스 자기 로그는 0건이었다).
// 🩸 10-09 22:2x: 보존 설정 없이 등록하면 기본 상한 500MB 로 시작 보존이 돈다 — 운영 config 는 4000MB 인데
//    레일 설치마다 재기동되는 이 프로세스가 1.1GB logs.db 의 행을 최대 50% 지웠다(«지운 주체가 안 보이는» 소실).
//    다른 독립 스크립트처럼 config 의 보존 값을 넘긴다.
registerLogStoreSink(debug.registerSink.bind(debug), 'openai-relay', getUserConfig().logs.retention);

const MODELS_PATH = '/v1/models';
const HEALTH_PATH = '/healthz';

// 설치본 전환 RFC 0b — 공유 비밀·xAI 키는 plist 가 아니라 키 캐시(~/.cache/<소문자 env 이름>)에서.
const hydratedKeys = hydrateEnvFromKeyCache(['ELANOUS_OPENAI_RELAY_SHARED_SECRET', 'XAI_API_KEY']);
const host = process.env.ELANOUS_OPENAI_RELAY_HOST?.trim() || '127.0.0.1';
const port = Number.parseInt(process.env.ELANOUS_OPENAI_RELAY_PORT?.trim() || '31420', 10);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 공유 비밀 검사는 릴레이 핸들러가 canonical — 목록 경로만 여기서 같은 관문을 다시 친다. */
function secretMatches(req: Request): boolean {
  const expected = getOpenAiRelaySharedSecret();
  if (!expected) return false;
  const auth = req.headers.get('authorization');
  const received = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  // 길이가 다르면 비교 자체가 성립하지 않는다 — 상수시간 비교는 핸들러 쪽 계약을 따른다.
  return received.length === expected.length && received === expected;
}

/**
 * 상류 응답을 OpenAI 클라이언트가 받아들이는 모양으로 «최소한만» 맞춘다.
 *
 * ⛔ 순수 패스스루를 깨는 결정이라 근거를 남긴다(2026-08-23 · n8n 이 "unexpected response" 로 거절):
 *   ① 응답 `model` 이 요청과 «다르다» — 요청 `grok-4.6` → 상류 `grok-4.6-build`.
 *      스펙 위반은 아니나(「쓰인 모델」) 다수 클라이언트가 요청값과 같기를 기대한다.
 *   ② `/v1/models` 에 OpenAI 필수 칸 `created` 가 «없다».
 * ⛔ 정보는 «안 버린다» — 상류 값은 `upstream_model` 로 남기고 비표준 칸도 그대로 둔다.
 */
const OPENAI_COMPAT_EPOCH_SECONDS = 1_700_000_000;

function alignModelEcho(payload: unknown, requestedModel: string | undefined): unknown {
  if (!requestedModel || typeof payload !== 'object' || payload === null) return payload;
  const body = payload as Record<string, unknown>;
  const upstream = body['model'];
  if (typeof upstream !== 'string' || upstream === requestedModel) return payload;
  return { ...body, model: requestedModel, upstream_model: upstream };
}

/** `/v1/models` — 상류가 대부분 OpenAI 모양을 준다. 빠진 필수 칸만 채운다. */
async function handleModels(req: Request): Promise<Response> {
  if (!secretMatches(req)) return json({ error: 'invalid-authentication' }, 401);
  const credential = resolveGrokCredential();
  if (!credential || credential.kind !== 'subscription') {
    return json({ error: 'subscription-credential-required' }, 503);
  }
  const headers = new Headers(credential.headers);
  headers.set('authorization', `Bearer ${credential.token}`);
  headers.set('accept', 'application/json');
  let upstream: Response;
  try {
    upstream = await fetch(`${credential.baseUrl}/models`, { headers });
  } catch {
    return json({ error: 'upstream-request-failed' }, 502);
  }
  if (!upstream.ok) return upstream;
  let body: { object?: unknown; data?: unknown };
  try {
    body = await upstream.json() as typeof body;
  } catch {
    return json({ error: 'upstream-response-unparsable' }, 502);
  }
  const data = Array.isArray(body.data) ? body.data : [];
  const patched = data.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const model = entry as Record<string, unknown>;
    return typeof model['created'] === 'number'
      ? model
      : { ...model, created: OPENAI_COMPAT_EPOCH_SECONDS };
  });
  return json({ ...body, object: body.object ?? 'list', data: patched }, 200);
}

/** 비스트리밍 응답만 `model` 을 되돌린다 — 스트리밍은 SSE 프레이밍을 깨지 않게 그대로 흘린다. */
async function relayWithModelEcho(req: Request, url: URL): Promise<Response | undefined> {
  let requestedModel: string | undefined;
  let streaming = false;
  try {
    const parsed = await req.clone().json() as { model?: unknown; stream?: unknown };
    if (typeof parsed.model === 'string') requestedModel = parsed.model;
    streaming = parsed.stream === true;
  } catch { /* 본문을 못 읽으면 그대로 흘린다 — 판정은 상류가 한다. */ }

  const relayed = await tryHandleOpenAiRelay(req, url);
  if (!relayed || streaming || !relayed.ok || !requestedModel) return relayed;
  const contentType = relayed.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return relayed;
  try {
    const payload = await relayed.json();
    return json(alignModelEcho(payload, requestedModel), relayed.status);
  } catch {
    return relayed;
  }
}

const server = Bun.serve({
  hostname: host,
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === HEALTH_PATH) return json({ ok: true, path: OPENAI_RELAY_PATH }, 200);
    if (url.pathname === MODELS_PATH && req.method === 'GET') return handleModels(req);
    const relayed = await relayWithModelEcho(req, url);
    if (relayed) return relayed;
    return json({ error: 'not-found' }, 404);
  },
});

debug.log('openai-relay.server', 'listening', { host, port, envKeysFromCache: hydratedKeys });
console.log(`[openai-relay] listening http://${server.hostname}:${server.port}${OPENAI_RELAY_PATH}`);
