import { describe, expect, test } from 'bun:test';
import { MissionLineHttpError } from './mission-line.js';
import { postHandProgress, renderClaudeHandSource, renderCodexHandSource } from './hand-hooks.js';

const missionId = crypto.randomUUID();
const attemptId = crypto.randomUUID();

interface RecordedRequest { method: string; path: string; authorization: string; body: Record<string, unknown> }

/** Mock mission-line ingress — OP #54582 승인 · TC #54571 계약. TC 서버 미착지: 계약만 흉내낸다. */
function startMockLineServer() {
  const accepted: RecordedRequest[] = [];
  const rejected: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const match = /^\/v1\/missions\/([^/]+)\/line$/.exec(url.pathname);
      const authorization = req.headers.get('authorization') ?? '';
      if (!match || req.method !== 'POST') {
        rejected.push({ method: req.method, path: url.pathname, authorization, body: {} });
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }
      const body = JSON.parse(await req.text() as string) as Record<string, unknown>;
      const record = { method: req.method, path: url.pathname, authorization, body };
      const tokenOk = authorization === 'Bearer tok-hand';
      const attemptOk = body.attemptId === attemptId;
      const missionOk = body.missionId === missionId && decodeURIComponent(match[1]!) === missionId;
      if (!tokenOk || !attemptOk || !missionOk) {
        rejected.push(record);
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      accepted.push(record);
      return new Response(JSON.stringify({ sequence: 1, createdAt: new Date().toISOString(), done: false, ...body }), {
        status: 202, headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { server, accepted, rejected, url: `http://127.0.0.1:${server.port}` };
}

describe('HAND-HOOKS-NEXUS-STATUS: TC 소유 수신기/서버/별도 endpoint는 구현하지 않는다 — 이 불변 경계', () => {
  test('손(hook)은 기존 POST /v1/missions/{missionId}/line 계약만 지나간다 — 별도 endpoint 없음', async () => {
    const mock = startMockLineServer();
    try {
      await postHandProgress(
        { missionId, attemptId, agent: 'claude', source: renderClaudeHandSource('Stop'), text: 'stop됨' },
        { env: { ELANOUS_HAND_TOKEN: 'tok-hand', ELANOUS_NEXUS_URL: mock.url } },
      );
      expect(mock.accepted).toHaveLength(1);
      expect(mock.accepted[0]!.method).toBe('POST');
      expect(mock.accepted[0]!.path).toBe(`/v1/missions/${missionId}/line`);
      // hand-hooks 모듈은 수신기·서버·별도 endpoint를 내놓지 않는다 — client 전송 함수와 source 렌더러만.
      const mod = await import('./hand-hooks.js');
      expect(Object.keys(mod).sort()).toEqual(['CLAUDE_CODE_PROGRESS_EVENTS', 'postHandProgress', 'renderClaudeHandSource', 'renderCodexHandSource'].sort());
    } finally { mock.server.stop(true); }
  });

  test('postMissionLineEvent({missionId,agent,type:progress,source,text,state?,attemptId}) 계약 시그니처 그대로', async () => {
    const mock = startMockLineServer();
    try {
      const event = await postHandProgress(
        { missionId, attemptId, agent: 'codex', source: renderCodexHandSource('shell'), text: 'notify 본문', state: 'running' },
        { env: { ELANOUS_HAND_TOKEN: 'tok-hand', ELANOUS_NEXUS_URL: mock.url } },
      );
      expect(mock.accepted).toHaveLength(1);
      const body = mock.accepted[0]!.body;
      expect(body.missionId).toBe(missionId);
      expect(body.attemptId).toBe(attemptId);
      expect(body.agent).toBe('codex');
      expect(body.type).toBe('progress');
      expect(body.source).toBe('codex-notify:shell');
      expect(body.text).toBe('notify 본문');
      expect(body.state).toBe('running');
      expect(String(body.lineId)).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
      expect(event.type).toBe('progress');
      expect(event.sequence).toBe(1);
    } finally { mock.server.stop(true); }
  });

  test('token은 child env(ELANOUS_HAND_TOKEN)에만 둔다 — Bearer 헤더로만 전달', async () => {
    const mock = startMockLineServer();
    try {
      await postHandProgress(
        { missionId, attemptId, agent: 'claude', source: renderClaudeHandSource('PreToolUse'), text: 'x' },
        { env: { ELANOUS_HAND_TOKEN: 'tok-hand', ELANOUS_NEXUS_URL: mock.url } },
      );
      expect(mock.accepted[0]!.authorization).toBe('Bearer tok-hand');
      expect(Object.keys(mock.accepted[0]!.body)).not.toContain('token');
    } finally { mock.server.stop(true); }
  });

  test('동일 mission/current attempt 연결은 수용한다', async () => {
    const mock = startMockLineServer();
    try {
      const first = await postHandProgress(
        { missionId, attemptId, agent: 'claude', source: renderClaudeHandSource('SessionStart'), text: '시작' },
        { env: { ELANOUS_HAND_TOKEN: 'tok-hand', ELANOUS_NEXUS_URL: mock.url } },
      );
      const second = await postHandProgress(
        { missionId, attemptId, agent: 'claude', source: renderClaudeHandSource('UserPromptSubmit'), text: '두번째' },
        { env: { ELANOUS_HAND_TOKEN: 'tok-hand', ELANOUS_NEXUS_URL: mock.url } },
      );
      expect([first.type, second.type]).toEqual(['progress', 'progress']);
      expect(mock.accepted).toHaveLength(2);
      expect(mock.rejected).toHaveLength(0);
    } finally { mock.server.stop(true); }
  });

  test('잘못된 token은 거부한다(MissionLineHttpError 401)', async () => {
    const mock = startMockLineServer();
    try {
      await expect(postHandProgress(
        { missionId, attemptId, agent: 'claude', source: renderClaudeHandSource('Stop'), text: '거부' },
        { env: { ELANOUS_HAND_TOKEN: 'tok-wrong', ELANOUS_NEXUS_URL: mock.url } },
      )).rejects.toBeInstanceOf(MissionLineHttpError);
      expect(mock.accepted).toHaveLength(0);
      expect(mock.rejected).toHaveLength(1);
    } finally { mock.server.stop(true); }
  });

  test('stale attemptId는 거부한다', async () => {
    const mock = startMockLineServer();
    try {
      await expect(postHandProgress(
        { missionId, attemptId: crypto.randomUUID(), agent: 'codex', source: renderCodexHandSource('notify'), text: '옛 시도' },
        { env: { ELANOUS_HAND_TOKEN: 'tok-hand', ELANOUS_NEXUS_URL: mock.url } },
      )).rejects.toBeInstanceOf(MissionLineHttpError);
      expect(mock.accepted).toHaveLength(0);
      expect(mock.rejected).toHaveLength(1);
    } finally { mock.server.stop(true); }
  });

  test('child env에 token이 없으면 전송하지 않는다(자격 없음 = fail-soft)', async () => {
    const mock = startMockLineServer();
    try {
      await expect(postHandProgress(
        { missionId, attemptId, agent: 'claude', source: renderClaudeHandSource('Stop'), text: '토큰 없음' },
        { env: { ELANOUS_NEXUS_URL: mock.url } },
      )).rejects.toThrow('credentials');
      expect(mock.accepted).toHaveLength(0);
      expect(mock.rejected).toHaveLength(0);
    } finally { mock.server.stop(true); }
  });
});