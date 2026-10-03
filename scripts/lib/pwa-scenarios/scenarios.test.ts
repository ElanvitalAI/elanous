import { readFileSync } from 'node:fs';
import { describe, expect, test, spyOn } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { createScenarios, createScenariosWithReplay, selectScenarios, validateBaseUrl } from './scenarios.js';
import { runScenarios, type PageDriver } from './runner.js';

const ids = ['T1', 'T1b', 'T4a', 'T5', 'T5b', 'C1', 'C2a', 'C2b', 'N1', 'N5a', 'N6a'];

describe('PWA scenario data and port isolation', () => {
  test('C1 is costly, runs only when named, and its question never contains the expected answer', () => {
    const all = createScenarios();
    expect(all.filter((s) => s.costly).map((s) => s.id)).toEqual(['C1']);
    expect(selectScenarios(all).selected.map((s) => s.id)).not.toContain('C1');
    expect(selectScenarios(all, ['C1']).selected.map((s) => s.id)).toEqual(['C1']);
    expect(selectScenarios(all, ['nope']).unknown).toEqual(['nope']);
    const c1 = all.find((s) => s.id === 'C1')!;
    const question = c1.steps.find((s) => s.kind === 'type');
    const answer = /includes\("(\d+)"\)/.exec(c1.expect[0]!.js)?.[1];
    expect(answer).toBeDefined();
    expect(question && 'text' in question ? question.text : '').not.toContain(answer!);
  });

  test('unique IDs and all regression scenarios use /app/ paths', () => {
    const scenarios = createScenarios();
    expect(scenarios.map((s) => s.id)).toEqual(ids);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
    expect(scenarios.every((s) => s.path.startsWith('/app/'))).toBe(true);
  });

  test('T4a marker is fresh, 20s check requires two occurrences; N5a is bounded at 5s; N6a never clicks classifier', () => {
    const first = createScenarios();
    const second = createScenarios();
    const byId = (id: string) => first.find((s) => s.id === id)!;
    expect(byId('T4a').steps.find((s) => s.kind === 'type')).not.toEqual(second.find((s) => s.id === 'T4a')?.steps.find((s) => s.kind === 'type'));
    expect(byId('T4a').hostCheck?.[0]?.timeoutMs).toBe(20_000);
    expect(byId('T4a').expect).toEqual([]);
    expect(byId('N5a').steps.find((s) => s.kind === 'waitFor' && s.measureChip)).toMatchObject({ jsPredicate: expect.stringContaining('chip.getClientRects().length'), timeoutMs: 5_000 });
    expect(byId('N5a').steps.find((s) => s.kind === 'waitFor' && typeof s.jsPredicate === 'string' && s.jsPredicate.includes('data-auto-submit'))).toMatchObject({ timeoutMs: 5_000, withinChipMs: true });
    expect(byId('N5a').expect[0]?.js).toContain('data-auto-submit');
    expect(byId('N6a').steps.some((s) => s.kind === 'click' && s.selector?.includes('classify'))).toBe(false);
    expect(byId('C2a').steps[1]).toEqual({ kind: 'waitFor', selector: 'textarea[placeholder^="message"], textarea[placeholder^="메시지"]', timeoutMs: 20_000 });
    // The live ChatInput placeholder must match the selector (10-01 #22558 changed the copy and the release PWA node failed C1·C2a·C2b).
    const chatInputSource = readFileSync(new URL('../../../apps/pwa/src/components/chat/ChatInput.tsx', import.meta.url), 'utf8');
    const placeholder = /placeholder="([^"]+)"/.exec(chatInputSource)?.[1] ?? '';
    expect(['message', '메시지'].some((prefix) => placeholder.startsWith(prefix))).toBe(true);
  });

  test('T4a reads replay twice, fails a single marker, and rejects spawned shells', async () => {
    const calls: unknown[] = [];
    let snapshot = '';
    const scenarios = createScenariosWithReplay(async (options) => { calls.push(options); return snapshot; });
    const t4a = scenarios.find((item) => item.id === 'T4a')!;
    const marker = (t4a.steps.find((step) => step.kind === 'type') as { text: string }).text.slice('echo '.length);
    const check = t4a.hostCheck![0]!;
    const ids = { sessionId: 'session-a', terminalId: 'term-a' };
    snapshot = marker;
    expect(await check.predicate(ids, 'http://127.0.0.1:31455', {})).toBe(false);
    snapshot = `${marker} ${marker}`;
    expect(await check.predicate(ids, 'http://127.0.0.1:31455', {})).toBe(true);
    expect(calls).toEqual([expect.objectContaining({ baseUrl: 'http://127.0.0.1:31455', ...ids }), expect.objectContaining({ ...ids, timeoutMs: 2_000 })]);
    const spawned = createScenariosWithReplay(async () => { throw new Error('terminal replay not attached: spawned'); }).find((item) => item.id === 'T4a')!;
    await expect(spawned.hostCheck![0]!.predicate(ids, 'http://127.0.0.1:31455', {})).rejects.toThrow('not attached');
    const timedOut = createScenariosWithReplay(async () => { throw new Error('terminal replay timed out after 2000ms'); }).find((item) => item.id === 'T4a')!;
    const [failure] = await runScenarios({
      goto: async () => {}, click: async () => {}, insertText: async () => {}, press: async () => {},
      evaluate: async () => ids, screenshot: async () => Buffer.from('png'), llmCallCursor: async () => 0,
    }, [{ ...timedOut, steps: [] }], 'http://127.0.0.1:31455');
    expect(failure?.failure).toContain('terminal replay timed out after 2000ms');
    expect(failure?.evidence.some((line) => line.includes('terminal replay timed out'))).toBe(true);
    const socketError = createScenariosWithReplay(async () => { throw new Error('terminal replay WebSocket error'); }).find((item) => item.id === 'T4a')!;
    const [disconnected] = await runScenarios({
      goto: async () => {}, click: async () => {}, insertText: async () => {}, press: async () => {},
      evaluate: async () => ids, screenshot: async () => Buffer.from('png'), llmCallCursor: async () => 0,
    }, [{ ...socketError, steps: [] }], 'http://127.0.0.1:31455');
    expect(disconnected?.failure).toContain('terminal replay WebSocket error');
  });

  test('new cells check negative text, three opens with one web row, and /help', () => {
    const scenarios = createScenarios();
    const cell = (id: string) => scenarios.find((item) => item.id === id)!;
    expect(cell('T1b').hostCheck?.[0]?.expected).toContain('terminal replay');
    expect(cell('T1b').hostCheck?.[0]?.js).toContain('이 행에서는 알 수 없음');
    expect(cell('T1b').steps).toContainEqual({ kind: 'press', key: 'Enter' });
    expect(cell('T5').steps.filter((step) => step.kind === 'goto')).toHaveLength(3);
    expect(cell('T5').steps.filter((step) => step.kind === 'capture')).toHaveLength(3);
    expect(cell('T5').hostCheck?.[0]?.js).toContain('elanous.daemon.sessionId');
    expect(cell('C2b').steps).toContainEqual({ kind: 'type', text: '/help' });
    expect(cell('C2b').expect[0]?.js).toContain('Meta commands');
  });

  test('T4a runner polls actual replay via hostCheck until echo is visible twice', async () => {
    let reads = 0;
    let marker = '';
    const scenarios = createScenariosWithReplay(async () => (++reads === 1 ? marker : `${marker} ${marker}`));
    const t4a = scenarios.find((item) => item.id === 'T4a')!;
    marker = (t4a.steps.find((step) => step.kind === 'type') as { text: string }).text.slice(5);
    const driver: PageDriver = {
      goto: async () => {}, click: async () => {}, insertText: async () => {}, press: async () => {},
      evaluate: async () => ({ sessionId: 'session-a', terminalId: 'term-a' }), screenshot: async () => Buffer.from('png'),
      llmCallCursor: async () => 0,
    };
    const [result] = await runScenarios(driver, [{ ...t4a, steps: [], hostCheck: [{ ...t4a.hostCheck![0]!, intervalMs: 1 }] }], 'http://127.0.0.1:31455');
    expect(result?.pass).toBe(true);
    expect(reads).toBe(2);
    expect(result?.evidence.some((line) => line.includes('Host check 1 (replay contains'))).toBe(true);
  });

  test('T1b waits for its own echo before ruling out late forbidden text in replay and tab', async () => {
    let snapshot = '';
    const t1b = createScenariosWithReplay(async () => snapshot).find((item) => item.id === 'T1b')!;
    const marker = (t1b.steps.find((step) => step.kind === 'type') as { text: string }).text.slice(5);
    const check = t1b.hostCheck![0]!;
    const ids = { sessionId: 'session-a', terminalId: 'term-a' };
    const value = { ...ids, tabsClean: true, paneClean: true };
    expect(await check.predicate(value, 'http://127.0.0.1:31455', {})).toBe(false);
    snapshot = `${marker} ${marker} 관계를 알 수 없어 배치하지 않았습니다`;
    expect(await check.predicate(value, 'http://127.0.0.1:31455', {})).toBe(false);
    snapshot = `${marker} ${marker}`;
    expect(await check.predicate({ ...value, tabsClean: false }, 'http://127.0.0.1:31455', {})).toBe(false);
    expect(await check.predicate({ ...value, paneClean: false }, 'http://127.0.0.1:31455', {})).toBe(false);
    expect(await check.predicate(value, 'http://127.0.0.1:31455', {})).toBe(true);
    const driver: PageDriver = {
      goto: async () => {}, click: async () => {}, insertText: async () => {}, press: async () => {},
      evaluate: async (js) => js.includes('every(node => !node.textContent')
        ? runInNewContext(js, { localStorage: { getItem: () => ids.sessionId }, document: {
          querySelectorAll: (selector: string) => selector.startsWith('button')
            ? [{ title: '지금 보는 터미널', getAttribute: () => `switch to ${ids.terminalId}`, textContent: '이 행에서는 알 수 없음' }] : [],
        } }) : ids,
      screenshot: async () => Buffer.from('png'), llmCallCursor: async () => 0,
    };
    const [rejected] = await runScenarios(driver, [{ ...t1b, steps: [], hostCheck: [{ ...check, timeoutMs: 0 }] }], 'http://127.0.0.1:31455');
    expect(rejected?.pass).toBe(false);
    expect(rejected?.failure).toContain('no unknown relationship message in terminal replay, pane or tab');
    driver.evaluate = async (js) => js.includes('every(node => !node.textContent')
      ? runInNewContext(js, { localStorage: { getItem: () => ids.sessionId }, document: {
        querySelectorAll: (selector: string) => selector.startsWith('button')
          ? [{ title: '지금 보는 터미널', getAttribute: () => `switch to ${ids.terminalId}`, textContent: 'normal tab' }] : [],
      } }) : ids;
    const [accepted] = await runScenarios(driver, [{ ...t1b, steps: [] }], 'http://127.0.0.1:31455');
    expect(accepted?.pass).toBe(true);
    driver.evaluate = async (js) => js.includes('every(node => !node.textContent')
      ? runInNewContext(js, { localStorage: { getItem: () => ids.sessionId }, document: {
        querySelectorAll: (selector: string) => selector.startsWith('button')
          ? [{ title: '지금 보는 터미널', getAttribute: () => `switch to ${ids.terminalId}`, textContent: 'normal tab' }]
          : [{ textContent: '관계를 알 수 없어 배치하지 않았습니다' }],
      } }) : ids;
    const [paneRejected] = await runScenarios(driver, [{ ...t1b, steps: [], hostCheck: [{ ...check, timeoutMs: 0 }] }], 'http://127.0.0.1:31455');
    expect(paneRejected?.pass).toBe(false);
  });

  test('T5b checks the xterm buffer on open and reload, then requires fresh live output', async () => {
    const t5b = createScenarios().find((item) => item.id === 'T5b')!;
    const markers = t5b.steps.filter((step) => step.kind === 'type').map((step) => step.text.slice(5));
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatch(/^ELANOUS_T5B_[0-9a-f]{16}$/);
    expect(markers[1]).not.toBe(markers[0]);
    expect(t5b.steps.filter((step) => step.kind === 'goto')).toHaveLength(2);
    expect(t5b.steps.filter((step) => step.kind === 'press')).toEqual([{ kind: 'press', key: 'Enter' }, { kind: 'press', key: 'Enter' }]);
    const lines = Array.from({ length: 50 }, () => '');
    let opens = 0;
    let viewportY = 0;
    let mode: 'visible' | 'blank' | 'scrollback' | 'no-fresh' = 'visible';
    const driver: PageDriver = {
      goto: async () => { opens += 1; viewportY = mode === 'scrollback' && opens === 2 ? 20 : 0; }, click: async () => {},
      insertText: async (text) => {
        if (mode === 'blank' || (mode === 'no-fresh' && opens === 2)) return;
        lines[opens === 1 ? 0 : viewportY + 1] = text;
      },
      press: async () => {},
      evaluate: async (js) => js.includes('__reactFiber') ? true : runInNewContext(js, { document: {
        querySelector: (css: string) => css === '[data-xterm-host]' ? {
          getClientRects: () => [1],
          __elanousTerm: { rows: 3, buffer: { active: {
            viewportY, length: lines.length,
            getLine: (row: number) => ({ translateToString: () => lines[row] ?? '' }),
          } } },
        } : (css === '.xterm' ? {} : null),
        querySelectorAll: () => [{ textContent: 'ACP: 연결됨' }],
      } }),
      screenshot: async () => Buffer.from('png'), llmCallCursor: async () => 0,
    };
    const steps = t5b.steps.map((step) => step.kind === 'waitFor' && step.jsPredicate?.includes('__elanousTerm')
      ? { ...step, timeoutMs: 0 } : step);
    const [visible] = await runScenarios(driver, [{ ...t5b, steps }], 'http://127.0.0.1:31455');
    expect(visible?.failure).toBeUndefined();
    expect(visible?.pass).toBe(true);
    mode = 'blank'; opens = 0; lines[0] = '';
    const [blank] = await runScenarios(driver, [{ ...t5b, steps }], 'http://127.0.0.1:31455');
    expect(blank?.failure).toContain('Step 7 (waitFor): timed out');
    mode = 'scrollback'; opens = 0; lines[0] = '';
    const [scrollbackOnly] = await runScenarios(driver, [{ ...t5b, steps }], 'http://127.0.0.1:31455');
    expect(scrollbackOnly?.failure).toContain('Step 10 (waitFor): timed out');
    expect(scrollbackOnly?.evidence.at(-1)).toContain('last=false');
    mode = 'no-fresh'; opens = 0; lines[0] = ''; lines[1] = '';
    const [noFreshOutput] = await runScenarios(driver, [{ ...t5b, steps }], 'http://127.0.0.1:31455');
    expect(noFreshOutput?.failure).toContain('Step 14 (waitFor): timed out');
  }, 20_000);

  test('T5 counts only matching web-registration rows and rejects duplicate shells', async () => {
    const t5 = createScenarios().find((item) => item.id === 'T5')!;
    const check = t5.hostCheck![0]!;
    const ids = { sessionId: 'session-a', terminalId: 'term-a' };
    const captured = { first: ids, second: ids, third: ids };
    const requested: string[] = [];
    let rows = [{ id: 'term-a', producer: 'process' }, { id: 'term-a', producer: 'web-registration' }];
    const fetchFake = Object.assign(async (request: URL | RequestInfo) => {
      requested.push(String(request));
      return Response.json({ terminals: rows });
    }, { preconnect: () => {} });
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchFake);
    try {
      expect(await check.predicate(ids, 'http://127.0.0.1:31455', captured)).toBe(true);
      expect(await check.predicate(ids, 'http://127.0.0.1:31455', { ...captured, second: { ...ids, terminalId: 'term-b' } })).toBe(false);
      rows = [...rows, { id: 'term-a', producer: 'web-registration' }];
      expect(await check.predicate(ids, 'http://127.0.0.1:31455', captured)).toBe(false);
      expect(requested).toEqual(['http://127.0.0.1:31455/v1/terminals', 'http://127.0.0.1:31455/v1/terminals']);
    } finally { fetchSpy.mockRestore(); }
  });

  test('T5 fails when reloads change the active tab ID despite one row for the final ID', async () => {
    const t5 = createScenarios().find((item) => item.id === 'T5')!;
    let opens = 0;
    const driver: PageDriver = {
      goto: async () => { opens += 1; }, click: async () => {}, insertText: async () => {}, press: async () => {},
      evaluate: async (js) => js.includes('localStorage.getItem')
        ? { sessionId: 'session-a', terminalId: `term-${opens}` } : true,
      screenshot: async () => Buffer.from('png'), llmCallCursor: async () => 0,
    };
    const fetchFake = Object.assign(async () => Response.json({ terminals: [
      { id: 'term-3', producer: 'web-registration' },
    ] }), { preconnect: () => {} });
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fetchFake);
    try {
      const [result] = await runScenarios(driver, [{ ...t5, hostCheck: [{ ...t5.hostCheck![0]!, timeoutMs: 0 }] }], 'http://127.0.0.1:31455');
      expect(opens).toBe(3);
      expect(result?.pass).toBe(false);
      expect(result?.failure).toContain('same tab ID on three opens');
      expect(result?.evidence.filter((line) => line.includes('(capture)'))).toHaveLength(3);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  test('operational port 31415 refused, lease port 31455 allowed, explicit --allow-port overrides', () => {
    expect(() => validateBaseUrl('http://127.0.0.1:31415')).toThrow('port 31415 refused');
    expect(validateBaseUrl('http://127.0.0.1:31455')).toBe('http://127.0.0.1:31455');
    expect(validateBaseUrl('http://127.0.0.1:31415', true)).toBe('http://127.0.0.1:31415');
    expect(() => validateBaseUrl('http://127.0.0.1:80')).toThrow('port 80 refused');
    expect(validateBaseUrl('http://127.0.0.1:80', true)).toBe('http://127.0.0.1:80');
    for (const port of [31420, 31421, 31449, 31500]) {
      expect(() => validateBaseUrl(`http://127.0.0.1:${port}`)).toThrow();
    }
    expect(() => validateBaseUrl('http://localhost:31455')).toThrow();
    expect(() => validateBaseUrl('http://127.0.0.1:31455/app/term/')).toThrow();
  });
});
