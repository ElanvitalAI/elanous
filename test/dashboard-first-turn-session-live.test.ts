import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ptyAvailable, startPty } from '../src/pty-shell/registry.js';

test.skipIf(!ptyAvailable())('isolated real TUI first turn attributes input.submit and core.turn to one session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'elanous-first-turn-'));
  const state = join(root, 'state');
  const xdg = join(root, 'xdg');
  mkdirSync(state);
  mkdirSync(xdg);
  const llm = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: () => new Response([
      'data: {"choices":[{"delta":{"content":"안녕!"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } }),
  });
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    onboarding: { completed: true },
    llm: { provider: 'local', model: 'stub-model', baseUrl: `http://127.0.0.1:${llm.port}/v1` },
  }));
  const repo = resolve(import.meta.dir, '..');
  const handle = startPty({
    cmd: 'bun',
    args: ['bin/elanous.mjs', `--test=${root}`, '--chat-only'],
    workdir: repo,
    cols: 100,
    rows: 30,
    env: { ...process.env, NODE_ENV: 'development', XDG_STATE_HOME: xdg, ELANOUS_STATE_DIR: state, TERM: 'xterm-256color' },
  });
  try {
    const deadline = Date.now() + 60_000;
    while (!(await handle.renderScreen()).includes('Type a message to begin') && Date.now() < deadline) await Bun.sleep(100);
    expect(await handle.renderScreen()).toContain('Type a message to begin');
    handle.write('안녕\r');

    const dbPath = join(root, 'logs', 'logs.db');
    let ids: { category: string; event: string; session_id: string | null }[] = [];
    while (Date.now() < deadline) {
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
          ids = db.query("select category,event,session_id from logs where category in ('input.submit','core.turn') order by id").all() as typeof ids;
        } finally { db.close(); }
      }
      if (ids.filter((row) => row.category === 'input.submit').length >= 3
        && ids.filter((row) => row.category === 'core.turn').length >= 2) break;
      await Bun.sleep(100);
    }
    const submits = ids.filter((row) => row.category === 'input.submit');
    const turns = ids.filter((row) => row.category === 'core.turn');
    expect(submits.map((row) => row.event)).toEqual(['create', 'execute.begin', 'execute.ok']);
    expect(turns.map((row) => row.event)).toEqual(['callbacks-wired', 'dispatch-summary']);
    const sessionId = submits[0]?.session_id;
    expect(sessionId).toMatch(/^elanous-session-/);
    if (typeof sessionId !== 'string') throw new Error(`first turn session id missing: ${String(sessionId)}`);
    expect([...submits, ...turns].every((row) => row.session_id === sessionId)).toBe(true);

    // SESSION-RESUME-ISOLATED 판정선: 첫 턴 완료 뒤 격리 state 에 그 ACP 세션이 등록되고 active 로 지정된다.
    const sessionFile = join(state, 'sessions', `${sessionId}.jsonl`);
    let registered = false;
    while (Date.now() < deadline && !registered) {
      if (existsSync(sessionFile)) registered = true;
      else await Bun.sleep(100);
    }
    expect(registered).toBe(true);
    const activePath = join(state, 'elanous', 'active');
    let activeId: string | undefined;
    while (Date.now() < deadline && activeId === undefined) {
      if (existsSync(activePath)) activeId = readFileSync(activePath, 'utf8').trim();
      else await Bun.sleep(100);
    }
    expect(activeId).toBe(sessionId);
    const sessionDir = join(state, 'sessions');
    let listed: string[] = [];
    while (Date.now() < deadline && listed.length === 0) {
      listed = readdirSync(sessionDir).filter((name) => name.endsWith('.jsonl'));
      if (listed.length === 0) await Bun.sleep(100);
    }
    expect(listed).toEqual([`${sessionId}.jsonl`]);
    const sessionList = Bun.spawnSync({
      cmd: ['bun', 'bin/elanous.mjs', `--test=${root}`, 'session', 'list', '--json'],
      cwd: repo,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        XDG_STATE_HOME: xdg,
        ELANOUS_STATE_DIR: state,
        ELANOUS_SUPPRESS_XDG_WARNING: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(sessionList.exitCode).toBe(0);
    const sessions = JSON.parse(Buffer.from(sessionList.stdout).toString('utf8')) as Array<{ id: string }>;
    expect(sessions.map((session) => session.id)).toEqual([sessionId]);

    // /quit 경고 0: 첫 턴 뒤 종료 안내에 그 세션 id 가 실린다(«세션 id 를 기록하지 못했습니다» 없음).
    handle.write('/quit\r');
    let exitOutput = '';
    while (Date.now() < deadline && !exitOutput.includes('[session]')) {
      exitOutput = handle.snapshot();
      if (!exitOutput.includes('[session]')) await Bun.sleep(100);
    }
    expect(exitOutput).not.toContain('기록하지 못했');
    expect(exitOutput).toContain(sessionId);
  } finally {
    handle.kill();
    llm.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 75_000);
