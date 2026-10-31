import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');

test('HAND-HOOKS-NEXUS-STATUS: SessionStart·UserPromptSubmit·Stop·StopFailure·PreToolUse 훅은 progress 만 보낸다', async () => {
  const missionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const accepted: Array<{ authorization: string; body: Record<string, unknown> }> = [];
  const rejected: Array<{ authorization: string; body: Record<string, unknown> }> = [];
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
  const nexusUrl = `http://127.0.0.1:${server.port}`;
  const temp = mkdtempSync(join(tmpdir(), 'claude-hand-hook-'));
  const baseEnv = {
    ...process.env,
    ELANOUS_STATE_DIR: temp,
    ELANOUS_BIN: join(root, 'bin/elanous.mjs'),
    ELANOUS_NEXUS_URL: nexusUrl,
    ELANOUS_HAND_TOKEN: 'tok-hand',
    ELANOUS_MISSION_ID: missionId,
    ELANOUS_ATTEMPT_ID: attemptId,
  };
  try {
    // 실제 Claude Code 훅 본문: prompt 는 UserPromptSubmit 에만 있다 — 나머지 넷은 prompt 없이도 progress 를 보내야 한다.
    const payloads: Record<string, Record<string, unknown>> = {
      SessionStart: { session_id: 'hook-test', cwd: root, hook_event_name: 'SessionStart', source: 'startup' },
      UserPromptSubmit: { prompt: `hand-UserPromptSubmit`, session_id: 'hook-test', cwd: root, hook_event_name: 'UserPromptSubmit' },
      Stop: { session_id: 'hook-test', cwd: root, hook_event_name: 'Stop', stop_hook_active: false },
      StopFailure: { session_id: 'hook-test', cwd: root, hook_event_name: 'StopFailure' },
      PreToolUse: { session_id: 'hook-test', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash' },
    };
    for (const eventName of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'PreToolUse']) {
      const hook = Bun.spawnSync(['bash', join(import.meta.dir, 'claude-code-utterance.sh')], {
        cwd: root, env: baseEnv,
        stdin: new TextEncoder().encode(JSON.stringify(payloads[eventName]!)),
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(hook.exitCode, new TextDecoder().decode(hook.stderr)).toBe(0);
    }
    const deadline = Date.now() + 15_000;
    while (accepted.length < 5 && Date.now() < deadline) await Bun.sleep(50);
    expect(accepted).toHaveLength(5);
    expect(rejected).toHaveLength(0);
    const bodies = accepted.map(record => record.body);
    for (const body of bodies) {
      expect(body.type).toBe('progress');
      expect(body.agent).toBe('claude');
      expect(body.missionId).toBe(missionId);
      expect(body.attemptId).toBe(attemptId);
    }
    expect(bodies.map(body => body.source)).toEqual([
      'claude-code:SessionStart', 'claude-code:UserPromptSubmit', 'claude-code:Stop', 'claude-code:StopFailure', 'claude-code:PreToolUse',
    ]);
    expect(accepted[0]!.authorization).toBe('Bearer tok-hand');
  } finally {
    server.stop(true);
    rmSync(temp, { recursive: true, force: true });
  }
}, 30_000);

test('HAND-HOOKS-NEXUS-STATUS: 예약 이벤트(ask/answer/correct·final)와 잘못된 token은 전송되지 않는다', async () => {
  const missionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const accepted: Array<Record<string, unknown>> = [];
  const rejected: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!/^\/v1\/missions\/([^/]+)\/line$/.test(url.pathname) || req.method !== 'POST') return new Response('not found', { status: 404 });
      const body = JSON.parse(await req.text() as string) as Record<string, unknown>;
      ((req.headers.get('authorization') ?? '') === 'Bearer tok-hand' ? accepted : rejected).push(body);
      return new Response(JSON.stringify({ sequence: 1, createdAt: new Date().toISOString(), done: false, ...body }), { status: 202 });
    },
  });
  const temp = mkdtempSync(join(tmpdir(), 'claude-hand-hook-'));
  try {
    // ① 잘못된 token: 훅은 fail-soft(exit 0), 수용 기록 없음.
    const wrong = Bun.spawnSync(['bash', join(import.meta.dir, 'claude-code-utterance.sh')], {
      cwd: root,
      env: {
        ...process.env, ELANOUS_STATE_DIR: temp, ELANOUS_BIN: join(root, 'bin/elanous.mjs'),
        ELANOUS_NEXUS_URL: `http://127.0.0.1:${server.port}`, ELANOUS_HAND_TOKEN: 'tok-wrong',
        ELANOUS_MISSION_ID: missionId, ELANOUS_ATTEMPT_ID: attemptId,
      },
      stdin: new TextEncoder().encode(JSON.stringify({ prompt: 'wrong-token', cwd: root, hook_event_name: 'Stop' })),
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(wrong.exitCode).toBe(0);
    // ② 예약 밖 이벤트(hook_event_name 없음)는 progress 조차 보내지 않는다.
    const noEvent = Bun.spawnSync(['bash', join(import.meta.dir, 'claude-code-utterance.sh')], {
      cwd: root,
      env: {
        ...process.env, ELANOUS_STATE_DIR: temp, ELANOUS_BIN: join(root, 'bin/elanous.mjs'),
        ELANOUS_NEXUS_URL: `http://127.0.0.1:${server.port}`, ELANOUS_HAND_TOKEN: 'tok-hand',
        ELANOUS_MISSION_ID: missionId, ELANOUS_ATTEMPT_ID: attemptId,
      },
      stdin: new TextEncoder().encode(JSON.stringify({ prompt: 'no-event' })),
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(noEvent.exitCode).toBe(0);
    const rejectedDeadline = Date.now() + 15_000;
    while (rejected.length === 0 && Date.now() < rejectedDeadline) await Bun.sleep(50);
    expect(accepted).toHaveLength(0);
    // 거부 기록은 잘못된 token progress 1건뿐 — 예약 이벤트(ask/answer/correct·final)는 전혀 만들지 않는다.
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    for (const body of rejected) expect(body.type).toBe('progress');
  } finally {
    server.stop(true);
    rmSync(temp, { recursive: true, force: true });
  }
}, 20_000);

test('HAND-HOOKS-NEXUS-STATUS: TC 소유 수신기/서버/별도 endpoint는 구현하지 않는다 — 이 불변 경계', async () => {
  const missionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const requests: Array<{ method: string; path: string; authorization: string; body: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const onLine = /^\/v1\/missions\/([^/]+)\/line$/.test(url.pathname);
      const body = onLine ? JSON.parse(await req.text() as string) as Record<string, unknown> : {};
      requests.push({ method: req.method, path: url.pathname, authorization: req.headers.get('authorization') ?? '', body });
      return new Response(JSON.stringify({ sequence: 1, createdAt: new Date().toISOString(), done: false, ...body }), {
        status: onLine ? 202 : 404, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const temp = mkdtempSync(join(tmpdir(), 'claude-hand-hook-'));
  const env = {
    ...process.env,
    ELANOUS_STATE_DIR: temp,
    ELANOUS_BIN: join(root, 'bin/elanous.mjs'),
    ELANOUS_NEXUS_URL: `http://127.0.0.1:${server.port}`,
    ELANOUS_HAND_TOKEN: 'tok-hand',
    ELANOUS_MISSION_ID: missionId,
    ELANOUS_ATTEMPT_ID: attemptId,
  };
  // ① 수신기·서버·별도 endpoint·화면 scraping 부재 — 손(hook)은 기존 계약 호출만 싣는다.
  const claudeHook = readFileSync(join(import.meta.dir, 'claude-code-utterance.sh'), 'utf8');
  const codexHook = readFileSync(join(import.meta.dir, 'codex-notify.sh'), 'utf8');
  const handCli = readFileSync(join(root, 'src/agent-mission/hand-hooks.ts'), 'utf8');
  for (const source of [claudeHook, codexHook, handCli]) {
    expect(source).not.toContain('Bun.serve');
    expect(source).not.toContain('nc -l');
    expect(source).not.toContain('socat');
    expect(source).not.toContain('capture-pane');
    expect(source).not.toContain('screencapture');
    expect(source).not.toContain('/dev/vcs');
  }
  // 기존 계약 생산 호출 배선: hand CLI 는 postMissionLineEvent 를 지나가고, 두 훅 스크립트가 hand CLI 를 부른다.
  expect(handCli).toContain('postMissionLineEvent(');
  expect(claudeHook).toContain('hand-hooks.ts');
  expect(codexHook).toContain('hand-hooks.ts');
  try {
    // ② prompt 없는 SessionStart 본문(실 Claude Code 훅 페이로드)도 기존 endpoint 로 정확히 한 건의 progress 만
    //    보낸다 — 별도 endpoint 부재·Pod concurrency=1(재시도 없는 단일 전송)을 함께 관측한다.
    const hook = Bun.spawnSync(['bash', join(import.meta.dir, 'claude-code-utterance.sh')], {
      cwd: root, env,
      stdin: new TextEncoder().encode(JSON.stringify({ session_id: 'hook-test', cwd: root, hook_event_name: 'SessionStart', source: 'startup' })),
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(hook.exitCode, new TextDecoder().decode(hook.stderr)).toBe(0);
    const deadline = Date.now() + 15_000;
    while (requests.length < 1 && Date.now() < deadline) await Bun.sleep(50);
    await Bun.sleep(300);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.path).toBe(`/v1/missions/${missionId}/line`);
    expect(requests[0]!.authorization).toBe('Bearer tok-hand');
    expect(requests[0]!.body.type).toBe('progress');
    expect(requests[0]!.body.agent).toBe('claude');
  } finally {
    server.stop(true);
    rmSync(temp, { recursive: true, force: true });
  }
}, 30_000);

test('UserPromptSubmit reaches the human Claude Code utterance query', async () => {
  const root = join(import.meta.dir, '../..');
  const temp = mkdtempSync(join(tmpdir(), 'claude-utterance-hook-'));
  const prompt = `hook-human-${crypto.randomUUID()}`;
  const from = new Date(Date.now() - 60_000).toISOString();
  const env = { ...process.env, ELANOUS_BIN: join(root, 'bin/elanous.mjs'), ELANOUS_STATE_DIR: temp };
  try {
    const hook = Bun.spawnSync(['bash', join(import.meta.dir, 'claude-code-utterance.sh')], {
      cwd: root, env, stdin: new TextEncoder().encode(JSON.stringify({ prompt, session_id: 'hook-test', cwd: root })),
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(hook.exitCode).toBe(0);
    const dbPath = join(temp, 'surface_events.db');
    let recorded = false;
    const deadline = Date.now() + 10_000;
    while (!recorded && Date.now() < deadline) {
      if (existsSync(dbPath)) {
        try {
          const db = new Database(dbPath, { readonly: true });
          try { recorded = Boolean(db.query('SELECT id FROM events WHERE text = ?').get(prompt)); }
          finally { db.close(); }
        } catch (error) {
          if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
        }
      }
      if (!recorded) await Bun.sleep(50);
    }
    expect(recorded).toBe(true);
    const to = new Date(Date.now() + 60_000).toISOString();
    const read = Bun.spawnSync(['bun', 'bin/elanous.mjs', '--test', 'self', 'utterances', '--from', from, '--to', to, '--origin', 'human',
      '--surface', 'ext:claude-code', '--json'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    expect(read.exitCode, new TextDecoder().decode(read.stdout) + new TextDecoder().decode(read.stderr)).toBe(0);
    const utterances = JSON.parse(new TextDecoder().decode(read.stdout)).utterances as Array<{ text: string; origin: string }>;
    expect(utterances.filter(row => row.text === prompt).map(row => [row.text, row.origin])).toEqual([[prompt, 'human']]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 20_000);
