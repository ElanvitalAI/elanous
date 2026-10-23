// TUI-LOOP-COMMAND — /loop 칸 문면의 판정선 시험.
//   idle 발사 1 · busy 미룸 · stop 0 (src/dashboard/loop-scheduler.ts)
import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ptyAvailable, startPty, unregisterPty } from '../pty-shell/registry.js';
import { createLoopScheduler } from './loop-scheduler.js';

test('idle 발사 1 — 쉬고 있는 틱마다 프롬프트를 정확히 한 번 발사한다', () => {
  let idle = true;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 1_000,
    isIdle: () => idle,
    fire: () => { fired += 1; },
  });
  scheduler.start();
  scheduler.tick();
  expect(fired).toBe(1);
  expect(scheduler.pendingFireCount()).toBe(0);
  scheduler.tick();
  expect(fired).toBe(2);
  expect(scheduler.pendingFireCount()).toBe(0);
  scheduler.stop();
});

test('idle 발사 1 — 바쁜 틱 사이로 돌아온 쉼 틱에서도 틱당 발사는 한 번이다', () => {
  let idle = true;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 1_000,
    isIdle: () => idle,
    fire: () => { fired += 1; },
  });
  scheduler.start();
  idle = false;
  scheduler.tick();
  expect(fired).toBe(0);
  expect(scheduler.pendingFireCount()).toBe(1);
  idle = true;
  scheduler.tick();
  expect(fired).toBe(1);
  scheduler.tick();
  expect(fired).toBe(2);
  scheduler.stop();
});

test('busy 미룸 — 바쁜 틱은 발사를 버리지 않고 «한 개»로 미룬다(적체 없음)', () => {
  let idle = false;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 1_000,
    isIdle: () => idle,
    fire: () => { fired += 1; },
  });
  scheduler.start();
  scheduler.tick();
  expect(fired).toBe(0);
  expect(scheduler.pendingFireCount()).toBe(1);
  scheduler.tick();
  expect(fired).toBe(0);
  expect(scheduler.pendingFireCount()).toBe(1);
  idle = true;
  scheduler.tick();
  expect(fired).toBe(1);
  expect(scheduler.pendingFireCount()).toBe(0);
  scheduler.stop();
});

test('stop 0 — stop 이후에는 어떤 틱도 발사하지 않는다', () => {
  let idle = true;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 1_000,
    isIdle: () => idle,
    fire: () => { fired += 1; },
  });
  scheduler.start();
  scheduler.tick();
  expect(fired).toBe(1);
  scheduler.stop();
  expect(scheduler.isRunning()).toBe(false);
  scheduler.tick();
  scheduler.tick();
  expect(fired).toBe(1);
  expect(scheduler.pendingFireCount()).toBe(0);
});

test('start 은 타이머를 스케줄하고 stop 은 그 타이머를 푼다 — 늦게 도착한 틱도 발사하지 않는다', () => {
  const scheduled: Array<{ callback: () => void; unsubscribe: () => void }> = [];
  let idle = true;
  let fired = 0;
  const scheduler = createLoopScheduler({
    intervalMs: 50,
    isIdle: () => idle,
    fire: () => { fired += 1; },
    schedule: (callback) => {
      const entry: { callback: () => void; unsubscribe: () => void } = {
        callback,
        unsubscribe: () => {
          const index = scheduled.indexOf(entry);
          if (index >= 0) scheduled.splice(index, 1);
        },
      };
      scheduled.push(entry);
      return entry;
    },
  });
  scheduler.start();
  expect(scheduled).toHaveLength(1);
  scheduled[0]!.callback();
  expect(fired).toBe(1);
  scheduler.stop();
  expect(scheduled).toHaveLength(0);
  scheduler.tick();
  expect(fired).toBe(1);
});

test.skipIf(!ptyAvailable())('real /loop ticks use H2, preserve typed input, reject busy ticks and retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-loop-h2-'));
  const state = join(root, 'state');
  mkdirSync(state);
  const requests: unknown[] = [];
  let releaseFirst: (() => void) | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'test-model' }] });
      if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 });
      requests.push(await request.json());
      if (requests.length === 1) await new Promise<void>(resolve => { releaseFirst = resolve; });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true }, debug: { renderLogs: true }, llm: { provider: 'local', model: 'test-model', baseUrl: `http://127.0.0.1:${server.port}/v1` },
    skillRouter: { llmFallback: false }, mcp: { enabled: false },
  }));
  // 격리 무대: HOME·state 를 뿌리 안으로, 로그인 셸 env 수입 끔, 공급자 자격 모양 env 는 지운다
  // (가짜 로컬 서버 밖의 실 공급자가 불릴 길을 닫는다).
  const env: Record<string, string> = { ...process.env as Record<string, string>, NODE_ENV: 'development',
    HOME: root, ELANOUS_STATE_DIR: state, ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_SKIP_LOGIN_ENV: '1', TERM: 'xterm-256color' };
  for (const key of ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR']) delete env[key];
  const credentialEnv = /(_API_KEY|_TOKEN|_AUTH|_SECRET)$|^(ANTHROPIC|OPENAI|OPENROUTER|XAI|GROK|GEMINI|GOOGLE|CODEX|CLAUDE|AWS|BEDROCK|ELANOUS_CODEX)/i;
  for (const key of Object.keys(env)) if (credentialEnv.test(key)) delete env[key];
  const handle = startPty({ cmd: 'bun', args: ['bin/elanous.mjs', `--test=${root}`, '--chat-only'],
    workdir: resolve(import.meta.dir, '../..'), cols: 120, rows: 30, env,
    unsetEnv: ['ELANOUS_TEST_FAKE_LLM', 'XDG_CONFIG_HOME', 'ELANOUS_CONFIG_DIR'] });
  try {
    const deadline = Date.now() + 60_000;
    const wait = async (predicate: () => Promise<boolean> | boolean) => {
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await Bun.sleep(100);
      }
      throw new Error(`loop H2 timeout: requests=${requests.length}; events=${JSON.stringify(events())}; screen=${(await handle.renderScreen()).slice(-1000)}`);
    };
    const events = (category = 'dashboard.loop') => {
      const db = new Database(join(root, 'logs', 'logs.db'), { readonly: true });
      try {
        return db.query('select event, data from logs where category = ? order by id')
          .all(category) as Array<{ event: string; data: string }>;
      } finally { db.close(); }
    };
    await wait(async () => (await handle.renderScreen()).split('\n').some(line => line.trim() === '❯'));
    handle.write('/loop 1s loop-h2-probe\r');
    await wait(() => requests.length === 1 && !!releaseFirst);
    expect(JSON.stringify(requests[0])).toContain('loop-h2-probe');
    await wait(() => events().some(row => row.event === 'rejected' && JSON.parse(row.data).reason === 'NotIdle'));
    expect(events().filter(row => row.event === 'fired')).toHaveLength(1);
    expect(requests).toHaveLength(1);
    releaseFirst?.();
    await wait(async () => (await handle.renderScreen()).split('\n').some(line => line.trim() === '❯'));
    handle.write('typed-buffer-probe');
    await wait(async () => (await handle.renderScreen()).includes('typed-buffer-probe'));
    await wait(() => events('tui.autoturn').some(row => row.event === 'rejected'
      && JSON.parse(row.data).reason === 'HumanTyping' && JSON.parse(row.data).detail === 'buffer'));
    expect(events().some(row => row.event === 'rejected' && JSON.parse(row.data).reason === 'HumanTyping')).toBe(true);
    expect((await handle.renderScreen())).toContain('typed-buffer-probe');
    const before = requests.length;
    await Bun.sleep(1_100);
    expect(requests).toHaveLength(before);
    handle.write('\x7f'.repeat('typed-buffer-probe'.length));
    await wait(async () => !(await handle.renderScreen()).includes('typed-buffer-probe'));
    await wait(() => events().filter(row => row.event === 'fired').length >= 2);
    await wait(() => requests.length > before);
    expect(JSON.stringify(requests.at(-1))).toContain('loop-h2-probe');
    expect(events().filter(row => row.event === 'fired')).toHaveLength(2);
    const reasons = events().filter(row => row.event === 'rejected').map(row => JSON.parse(row.data).reason as string);
    expect(reasons).toContain('NotIdle');
    expect(reasons).toContain('HumanTyping');
    console.log(`LOOP-H2 live: fired=2 rejected=NotIdle,HumanTyping buffer-preserved=true retry=true`);
  } finally {
    releaseFirst?.();
    handle.kill();
    unregisterPty(handle.id);
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('start 을 두 번 불러도 타이머는 하나다', () => {
  const scheduled: Array<{ callback: () => void; unsubscribe: () => void }> = [];
  const scheduler = createLoopScheduler({
    intervalMs: 50,
    isIdle: () => true,
    fire: () => {},
    schedule: (callback) => {
      const entry: { callback: () => void; unsubscribe: () => void } = {
        callback,
        unsubscribe: () => {
          const index = scheduled.indexOf(entry);
          if (index >= 0) scheduled.splice(index, 1);
        },
      };
      scheduled.push(entry);
      return entry;
    },
  });
  scheduler.start();
  scheduler.start();
  expect(scheduled).toHaveLength(1);
  scheduler.stop();
  expect(scheduled).toHaveLength(0);
});
