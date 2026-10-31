import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');

interface RecordedBody { authorization: string; body: Record<string, unknown> }

function startMockLineServer(missionId: string, attemptId: string) {
  const accepted: RecordedBody[] = [];
  const rejected: RecordedBody[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!/^\/v1\/missions\/([^/]+)\/line$/.test(url.pathname) || req.method !== 'POST') return new Response('not found', { status: 404 });
      const body = JSON.parse(await req.text() as string) as Record<string, unknown>;
      const record = { authorization: req.headers.get('authorization') ?? '', body };
      const ok = record.authorization === 'Bearer tok-hand' && body.missionId === missionId && body.attemptId === attemptId;
      (ok ? accepted : rejected).push(record);
      return new Response(JSON.stringify({ sequence: 1, createdAt: new Date().toISOString(), done: false, ...body }), {
        status: ok ? 202 : 401, headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { server, accepted, rejected, url: `http://127.0.0.1:${server.port}` };
}

test('HAND-HOOKS-NEXUS-STATUS: Codex notify 훅은 progress 만 보낸다 — 계약 POST /v1/missions/{id}/line', async () => {
  const missionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const mock = startMockLineServer(missionId, attemptId);
  const temp = mkdtempSync(join(tmpdir(), 'codex-notify-hook-'));
  const env = {
    ...process.env,
    ELANOUS_STATE_DIR: temp,
    ELANOUS_NEXUS_URL: mock.url,
    ELANOUS_HAND_TOKEN: 'tok-hand',
    ELANOUS_MISSION_ID: missionId,
    ELANOUS_ATTEMPT_ID: attemptId,
  };
  try {
    const hook = Bun.spawnSync(['bash', join(import.meta.dir, 'codex-notify.sh')], {
      cwd: root, env, stdin: new TextEncoder().encode(JSON.stringify({ tool_name: 'shell', cwd: root })),
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(hook.exitCode, new TextDecoder().decode(hook.stderr)).toBe(0);
    const deadline = Date.now() + 15_000;
    while (mock.accepted.length === 0 && Date.now() < deadline) await Bun.sleep(50);
    expect(mock.accepted).toHaveLength(1);
    const body = mock.accepted[0]!.body;
    expect(body.type).toBe('progress');
    expect(body.agent).toBe('codex');
    expect(body.missionId).toBe(missionId);
    expect(body.attemptId).toBe(attemptId);
    expect(String(body.source)).toBe('codex-notify:shell');
  } finally {
    mock.server.stop(true);
    rmSync(temp, { recursive: true, force: true });
  }
}, 20_000);

test('HAND-HOOKS-NEXUS-STATUS: 잘못된 token은 거부되고 훅은 fail-soft(exit 0)다', async () => {
  const missionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const mock = startMockLineServer(missionId, attemptId);
  const temp = mkdtempSync(join(tmpdir(), 'codex-notify-hook-'));
  const env = {
    ...process.env,
    ELANOUS_STATE_DIR: temp,
    ELANOUS_NEXUS_URL: mock.url,
    ELANOUS_HAND_TOKEN: 'tok-wrong',
    ELANOUS_MISSION_ID: missionId,
    ELANOUS_ATTEMPT_ID: attemptId,
  };
  try {
    const hook = Bun.spawnSync(['bash', join(import.meta.dir, 'codex-notify.sh')], {
      cwd: root, env, stdin: new TextEncoder().encode(JSON.stringify({ tool_name: 'shell' })),
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(hook.exitCode).toBe(0);
    const deadline = Date.now() + 15_000;
    while (mock.rejected.length === 0 && Date.now() < deadline) await Bun.sleep(50);
    expect(mock.accepted).toHaveLength(0);
    expect(mock.rejected.length).toBeGreaterThanOrEqual(1);
  } finally {
    mock.server.stop(true);
    rmSync(temp, { recursive: true, force: true });
  }
}, 20_000);

test('HAND-HOOKS-NEXUS-STATUS: child env 자격이 없으면 아무 전송도 하지 않는다', async () => {
  const missionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const mock = startMockLineServer(missionId, attemptId);
  const temp = mkdtempSync(join(tmpdir(), 'codex-notify-hook-'));
  const env = { ...process.env, ELANOUS_STATE_DIR: temp, ELANOUS_NEXUS_URL: mock.url };
  delete (env as Record<string, string | undefined>).ELANOUS_HAND_TOKEN;
  delete (env as Record<string, string | undefined>).ELANOUS_MISSION_ID;
  try {
    const hook = Bun.spawnSync(['bash', join(import.meta.dir, 'codex-notify.sh')], {
      cwd: root, env, stdin: new TextEncoder().encode(JSON.stringify({ tool_name: 'shell' })),
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(hook.exitCode).toBe(0);
    await Bun.sleep(300);
    expect(mock.accepted).toHaveLength(0);
    expect(mock.rejected).toHaveLength(0);
  } finally {
    mock.server.stop(true);
    rmSync(temp, { recursive: true, force: true });
  }
}, 20_000);

test('HAND-HOOKS-NEXUS-STATUS: Codex notify JSON 인자(argv[1])로도 progress 한 건을 보낸다', async () => {
  const missionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const mock = startMockLineServer(missionId, attemptId);
  const temp = mkdtempSync(join(tmpdir(), 'codex-notify-hook-'));
  const env = {
    ...process.env,
    ELANOUS_STATE_DIR: temp,
    ELANOUS_NEXUS_URL: mock.url,
    ELANOUS_HAND_TOKEN: 'tok-hand',
    ELANOUS_MISSION_ID: missionId,
    ELANOUS_ATTEMPT_ID: attemptId,
  };
  try {
    // Codex notify 프로그램 규약: notify JSON 을 인자 하나로 넘긴다(stdin 은 폴백).
    const payload = JSON.stringify({ type: 'agent-turn-complete', 'last-assistant-message': 'hand progress 인자 전달' });
    const hook = Bun.spawnSync(['bash', join(import.meta.dir, 'codex-notify.sh'), payload], {
      cwd: root, env, stdin: new TextEncoder().encode(''),
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(hook.exitCode, new TextDecoder().decode(hook.stderr)).toBe(0);
    const deadline = Date.now() + 15_000;
    while (mock.accepted.length === 0 && Date.now() < deadline) await Bun.sleep(50);
    expect(mock.accepted).toHaveLength(1);
    const body = mock.accepted[0]!.body;
    expect(body.type).toBe('progress');
    expect(body.agent).toBe('codex');
    expect(body.missionId).toBe(missionId);
    expect(body.attemptId).toBe(attemptId);
    expect(String(body.source)).toBe('codex-notify:notify');
    expect(String(body.text)).toContain('agent-turn-complete');
  } finally {
    mock.server.stop(true);
    rmSync(temp, { recursive: true, force: true });
  }
}, 20_000);