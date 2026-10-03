import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dashboard = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8');


describe('dashboard real user echo wiring', () => {
  // macOS: the TUI does not render inside `bun test` here (empty screen · same as the Linux-pod PTY tests from 10-02).
  // The same Q2 → Q3 order is checked on a real PTY on mac by `bun scripts/tui-regress.ts` (R7).
  test.skipIf(process.platform === 'darwin')('PTY screen preserves submitted Q2 → answer Q2 → submitted Q3 → answer Q3', async () => {
    const { startPty, unregisterPty } = await import('../src/pty-shell/registry.js');
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const dir = await mkdtemp(join(tmpdir(), 'elanous-echo-'));
    let handle: ReturnType<typeof startPty> | undefined;
    const logDir = join(process.cwd(), 'log');
    const debugFiles = async () => {
      const names = await readdir(logDir).catch(() => [] as string[]);
      return names.filter(name => /^debug-\d+\.log$/.test(name)).map(name => join(logDir, name));
    };
    const before = new Map(await Promise.all((await debugFiles()).map(async path => [path, (await stat(path)).size] as const)));
    const observed = async (offsets = before) => {
      const chunks = await Promise.all((await debugFiles()).map(async path => {
        const bytes = await readFile(path);
        return bytes.subarray(offsets.get(path) ?? 0).toString('utf8');
      }));
      return chunks.join('\n').split('\n').flatMap(line => {
        try { return [JSON.parse(line) as { category?: string; event?: string; data?: { path?: string; length?: number; disposition?: string } }]; }
        catch { return []; }
      }).filter(event => event.category === 'dashboard.turn-typeahead');
    };
    try {
      await writeFile(join(dir, 'config.json'), JSON.stringify({ llm: { provider: 'openai-codex' } }));
      handle = startPty({
        cmd: 'bun', args: ['bin/elanous.mjs', '--config-dir', dir, '--test-state-dir', dir],
        workdir: process.cwd(),
        env: { ELANOUS_DRIVE_TUI: '1', ELANOUS_STATE_DIR: dir, NODE_ENV: 'test' },
        cols: 160, rows: 50, kind: 'shell', detach: false,
      });
      await sleep(9000);
      expect(await handle.renderScreen()).toContain('말 한 줄로 시작');
      handle.write('1부터 30까지 천천히 한 줄에 하나씩 써 줘. 도구는 쓰지 마.\r');
      // A FIFO classification exists only while the first turn owns the keyboard.
      // Do not accept a normal submission after the first turn has ended.
      for (let i = 0; i < 20; i++) {
        if ((await handle.renderScreen()).includes('❯ 1부터 30까지')) break;
        await sleep(250);
      }
      handle.write('Q2MARK 라고만 답해\r');
      let events = await observed();
      for (let i = 0; i < 40 && !events.some(e => e.event === 'submission-classified' && e.data?.disposition === 'fifo' && e.data.length === 'Q2MARK 라고만 답해'.length); i++) {
        await sleep(250);
        events = await observed();
      }
      expect(events.some(e => e.event === 'submission-classified' && e.data?.disposition === 'fifo' && e.data.length === 'Q2MARK 라고만 답해'.length)).toBe(true);
      handle.write('Q3MARK 라고만 답해\r');
      let screen = '';
      let fifoInputReady = false;
      for (let i = 0; i < 45; i++) {
        await sleep(1000);
        screen = await handle.renderScreen();
        events = await observed();
        const q3Echo = screen.indexOf('❯ Q3MARK 라고만 답해');
        const q3Answer = screen.indexOf('Q3MARK\n', q3Echo + '❯ Q3MARK 라고만 답해'.length);
        fifoInputReady = q3Echo >= 0 && q3Answer > q3Echo
          && screen.indexOf('✔ 완료', q3Answer) > q3Answer
          && screen.includes('❯ 말 한 줄로 시작');
        if (fifoInputReady) break;
      }
      expect(fifoInputReady).toBe(true);
      expect(events.some(e => e.event === 'submission-classified' && e.data?.disposition === 'fifo' && e.data.length === 'Q3MARK 라고만 답해'.length)).toBe(true);
      expect(events.filter(e => e.event === 'echoed' && e.data?.path === 'turn-end' && e.data.length === 'Q2MARK 라고만 답해'.length)).toHaveLength(2);
      console.log('PTY_ECHO_OBSERVED:', JSON.stringify(events.filter(e => e.event === 'echoed').map(e => e.data)));
      const q2 = screen.indexOf('❯ Q2MARK 라고만 답해');
      const a2 = screen.indexOf('Q2MARK\n', q2 + '❯ Q2MARK 라고만 답해'.length);
      const q3 = screen.indexOf('❯ Q3MARK 라고만 답해');
      const a3 = screen.indexOf('Q3MARK\n', q3 + '❯ Q3MARK 라고만 답해'.length);
      console.log('PTY_ECHO_SCREEN:', screen.slice(Math.max(0, q2 - 15), a3 + 8).replace(/\n/g, ' | '));
      expect(q2).toBeGreaterThanOrEqual(0);
      expect(a2).toBeGreaterThan(q2);
      expect(q3).toBeGreaterThan(a2);
      expect(a3).toBeGreaterThan(q3);
      expect(screen.split('❯ Q2MARK 라고만 답해').length - 1).toBe(1);
      expect(screen.split('❯ Q3MARK 라고만 답해').length - 1).toBe(1);

      // Restart the PTY so pending items from the plain-text turn cannot be
      // mistaken for items drained in the tool-boundary turn.
      handle.kill();
      for (let i = 0; i < 30 && handle.isAlive(); i++) await sleep(100);
      unregisterPty(handle.id);
      handle = startPty({
        cmd: 'bun', args: ['bin/elanous.mjs', '--config-dir', dir, '--test-state-dir', dir],
        workdir: process.cwd(),
        env: { ELANOUS_DRIVE_TUI: '1', ELANOUS_STATE_DIR: dir, NODE_ENV: 'test' },
        cols: 160, rows: 50, kind: 'shell', detach: false,
      });
      await sleep(9000);
      expect(await handle.renderScreen()).toContain('말 한 줄로 시작');
      const beforeLive = new Map(await Promise.all((await debugFiles()).map(async path => [path, (await stat(path)).size] as const)));
      handle.write('Bash 도구를 사용해서 현재 디렉터리의 파일 이름을 확인하고 설명해 줘.\r');
      await sleep(800);
      handle.write('LIVEQMARK 라고만 답해\r');
      for (let i = 0; i < 55; i++) {
        await sleep(1000);
        events = await observed(beforeLive);
        screen = await handle.renderScreen();
        if (events.some(e => e.event === 'echoed' && e.data?.path === 'live') && screen.includes('❯ LIVEQMARK 라고만 답해')) break;
      }
      console.log('PTY_LIVE_OBSERVED:', JSON.stringify(events.filter(e => e.event === 'echoed').map(e => e.data)));
      console.log('PTY_LIVE_SCREEN:', screen.slice(-1600).replace(/\n/g, ' | '));
      expect(events.filter(e => e.event === 'submission-classified' && e.data?.disposition === 'fifo' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toHaveLength(1);
      expect(events.filter(e => e.event === 'echoed' && e.data?.path === 'live' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toHaveLength(1);
      expect(events.some(e => e.event === 'echoed' && e.data?.path === 'turn-end' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toBe(false);
      expect(screen.split('❯ LIVEQMARK 라고만 답해').length - 1).toBe(1);
      expect(screen).toContain('↳ 이어서');
      expect(screen.indexOf('↳ 이어서')).toBeLessThan(screen.indexOf('❯ LIVEQMARK 라고만 답해'));
      // An answer token alone does not prove the turn-end FIFO handoff has run.
      // The empty composer placeholder returns only after the completed turn
      // has re-entered the input loop and is waiting for the next submission.
      let nextInputReady = false;
      for (let i = 0; i < 55; i++) {
        await sleep(1000);
        screen = await handle.renderScreen();
        events = await observed(beforeLive);
        nextInputReady = screen.includes('LIVEQMARK\n')
          && screen.includes('✔ 완료')
          && screen.includes('말 한 줄로 시작')
          && !screen.includes('⏳ 대기');
        if (nextInputReady) break;
      }
      expect(nextInputReady).toBe(true);
      console.log('PTY_LIVE_FINAL_SCREEN:', screen.slice(-2400).replace(/\n/g, ' | '));
      console.log('PTY_LIVE_FINAL_OBSERVED:', JSON.stringify(events.filter(e => e.event === 'echoed').map(e => e.data)));
      expect(screen.indexOf('LIVEQMARK\n', screen.indexOf('❯ LIVEQMARK 라고만 답해'))).toBeGreaterThan(screen.indexOf('❯ LIVEQMARK 라고만 답해'));
      expect(screen.split('❯ LIVEQMARK 라고만 답해').length - 1).toBe(1);
      expect(events.filter(e => e.event === 'submission-classified' && e.data?.disposition === 'fifo' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toHaveLength(1);
      expect(events.filter(e => e.event === 'echoed' && e.data?.path === 'live' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toHaveLength(1);
      expect(events.filter(e => e.event === 'echoed' && e.data?.path === 'turn-end' && e.data.length === 'LIVEQMARK 라고만 답해'.length)).toHaveLength(0);
      console.log('PTY_LIVE_VERDICT: next-input-ready=1 live=1 turn-end=0 echo-on-screen=1 answer-on-screen=1');
    } finally {
      if (handle) {
        handle.kill();
        for (let i = 0; i < 30 && handle.isAlive(); i++) await sleep(100);
        if (handle.isAlive()) handle.kill('SIGKILL');
        unregisterPty(handle.id);
      }
      await rm(dir, { recursive: true, force: true });
    }
  }, 110_000);

  test('normal submission and each delivered live item share the same chat-log renderer', () => {
    expect(dashboard).toContain('echoSubmittedUserText(tok.text);');
    const callback = dashboard.slice(dashboard.indexOf('enqueuePendingUserInput(sid, queuedText, (drained) => {'));
    const body = callback.slice(0, callback.indexOf("debug.log('dashboard.turn-typeahead', 'drained-into-live-turn'"));
    expect(body).toContain('turnTypeaheadRef.state.queuedSubmissions.slice(drained.length)');
    expect(body).toContain('for (const text of drained) {\n                      echoSubmittedUserText(text, { live: true });');
    expect(dashboard).toContain('turnStreamRuntime.onText(chunk, accumulated);\n                  restoreLiveTypeaheadEchoes();');
    expect(dashboard).toContain("if (opts?.live) chatLines.push(C.muted('  ↳ 이어서'));");
    expect(dashboard).toContain('wrapAnsiByWidth(`❯ ${text}`, echoWrapCols)');
  });

  test('turn-end injected Enter reaches the regular echo without an extra pre-echo', () => {
    expect(dashboard).toContain("const queuedTurnEndText = drained.injectEnter ? drained.nextInitial : undefined;");
    expect(dashboard).toContain("if (drained.injectEnter) injectKey({ name: 'enter', ctrl: false, shift: false });");
    expect(dashboard).toContain('initialText: nextInitial,');
    expect(dashboard).toContain('echoSubmittedUserText(tok.text);');
    expect(dashboard).not.toContain('wireDashboardTurnTypeaheadEcho(drained)');
  });

  test('only lengths and paths are emitted by the echoed observation', () => {
    expect(dashboard).toContain("debug.log('dashboard.turn-typeahead', 'echoed', { path: 'live', length: text.length });");
    expect(dashboard).toContain("debug.log('dashboard.turn-typeahead', 'echoed', { path: 'turn-end', length: queuedTurnEndText.length });");
    const echoedCalls = [...dashboard.matchAll(/debug\.log\('dashboard\.turn-typeahead', 'echoed', \{([^}]+)\}\)/g)];
    expect(echoedCalls).toHaveLength(2);
    for (const [, payload] of echoedCalls) {
      expect(payload).not.toMatch(/\btext\s*:/);
      expect(payload).toMatch(/\bpath\s*:/);
      expect(payload).toMatch(/\blength\s*:/);
    }
    expect(dashboard).toContain("debug.log('dashboard.turn-typeahead', 'submission-classified', {");
    expect(dashboard).toContain('length: (r.immediateSubmission ?? turnTypeaheadRef.state.queuedSubmissions.at(-1))?.length ?? 0');
  });
});
