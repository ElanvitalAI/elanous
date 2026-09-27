import { describe, expect, test } from 'bun:test';
import { runScenarios, summarize, type PageDriver } from './runner.js';
import { formatCell, main } from '../../pwa-scenarios.js';
import { createScenarios, type Scenario } from './scenarios.js';

const scenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  id: 'T1', surface: 'terminal', path: '/app/term/', title: 'probe',
  steps: [{ kind: 'goto' }], expect: [{ js: 'ready', expected: 'ready', timeoutMs: 0 }], ...overrides,
});

function fake(evaluate: (expression: string) => unknown | Promise<unknown>): PageDriver & { visits: string[] } {
  const visits: string[] = [];
  return {
    visits, goto: async (url) => { visits.push(url); }, evaluate: async (js) => evaluate(js),
    insertText: async () => {}, press: async () => {}, click: async () => {}, screenshot: async () => Buffer.from('png'),
    llmCallCursor: async () => 0,
  };
}

describe('PWA scenario runner (no browser or daemon)', () => {
  test('CLI rejects operational daemon port before starting a browser', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (message) => { errors.push(String(message)); };
    try {
      expect(await main(['--base-url', 'http://127.0.0.1:31415'])).toBe(2);
      expect(errors).toEqual([expect.stringContaining('port 31415 refused')]);
    } finally { console.error = original; }
  });

  test('CLI accepts explicit HTTP default port under --allow-port before browser launch', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (message) => { errors.push(String(message)); };
    try {
      expect(await main(['--base-url', 'http://127.0.0.1:80', '--allow-port', '--only', 'missing'])).toBe(2);
      expect(errors).toEqual(['unknown scenario ID: missing']);
    } finally { console.error = original; }
  });

  test('condition true immediately passes and records URL and check evidence', async () => {
    const driver = fake(() => true);
    const [result] = await runScenarios(driver, [scenario()], 'http://127.0.0.1:31455');
    expect(driver.visits).toEqual(['http://127.0.0.1:31455/app/term/']);
    expect(result?.pass).toBe(true);
    expect(result?.title).toBe('probe');
    expect(formatCell(result!)).toContain('T1 probe pass');
    expect(result?.ms).toBeGreaterThanOrEqual(0);
    expect(result?.evidence).toEqual(expect.arrayContaining(['Check 1 (ready): last=true']));
  });

  test('every scenario title reaches the per-cell results and CLI lines', async () => {
    const cases = createScenarios().map((item) => ({ ...item, steps: [], expect: [], hostCheck: [] }));
    const results = await runScenarios(fake(() => true), cases, 'http://127.0.0.1:31455');
    expect(results).toHaveLength(cases.length);
    expect(results.map((result) => result.title)).toEqual(cases.map((item) => item.title));
    for (const [index, result] of results.entries()) {
      expect(formatCell(result)).toContain(`${cases[index]!.id} ${cases[index]!.title} pass`);
    }
  });

  test('hostCheck evaluates page identity and polls its Node predicate, recording failures', async () => {
    let calls = 0;
    const identities: unknown[] = [];
    const probe = scenario({ steps: [], expect: [], hostCheck: [{
      js: 'identity', expected: 'matching session and terminal', timeoutMs: 50, intervalMs: 1,
      predicate: async (value, baseUrl) => {
        identities.push({ value, baseUrl });
        return (value as { terminalId?: string })?.terminalId === 'term-a';
      },
    }] });
    const [passed] = await runScenarios(fake(() => ({ sessionId: 'session-a', terminalId: ++calls >= 2 ? 'term-a' : '' })), [probe], 'http://127.0.0.1:31455');
    expect(passed?.pass).toBe(true);
    expect(identities).toHaveLength(2);
    expect(identities[1]).toEqual({ value: { sessionId: 'session-a', terminalId: 'term-a' }, baseUrl: 'http://127.0.0.1:31455' });
    const [failed] = await runScenarios(fake(() => ({ sessionId: 'session-a', terminalId: 'wrong' })), [
      scenario({ ...probe, hostCheck: [{ ...probe.hostCheck![0]!, timeoutMs: 0 }] }),
    ], 'http://127.0.0.1:31455');
    expect(failed?.failure).toContain('Host check 1 (matching session and terminal)');
    expect(failed?.evidence).toContain('Host check 1 (matching session and terminal): last={"sessionId":"session-a","terminalId":"wrong"}; pass=false');
  });

  test('N5a chipMs measures from insertion to chip and reaches CLI and JSON result', async () => {
    const n5a = scenario({ id: 'N5a', surface: 'intake', steps: [
      { kind: 'type', text: 'https://example.com' },
      { kind: 'waitFor', jsPredicate: 'chip', timeoutMs: 5_000, intervalMs: 1, measureChip: true },
    ], expect: [] });
    const [result] = await runScenarios(fake(() => true), [n5a], 'http://127.0.0.1:31455');
    expect(result?.pass).toBe(true);
    expect(result?.chipMs).toBeGreaterThanOrEqual(0);
    expect(result?.evidence).toContain(`chipMs: ${result!.chipMs}`);
    expect(formatCell(result!)).toContain(`chipMs=${result!.chipMs}ms`);
    expect(JSON.parse(JSON.stringify(result)).chipMs).toBe(result!.chipMs);
    const [slow] = await runScenarios(fake(() => false), [{ ...n5a, steps: [
      { kind: 'type', text: 'https://example.com' }, { kind: 'waitFor', jsPredicate: 'chip', timeoutMs: 0, measureChip: true },
    ] }], 'http://127.0.0.1:31455');
    expect(slow?.pass).toBe(false);
    expect(slow?.chipMs).toBeUndefined();
    expect(slow?.evidence.some((line) => line.includes('chipMs: unavailable'))).toBe(true);
  });

  test('chipMs records chip arrival before the absorb label and 5s rule still checks the label', async () => {
    const n5a = createScenarios().find((item) => item.id === 'N5a')!;
    let labelReads = 0;
    const driver = fake((js) => {
      if (js.includes('data-auto-submit')) return ++labelReads >= 2;
      return true;
    });
    const [result] = await runScenarios(driver, [{ ...n5a, steps: n5a.steps.slice(3), expect: [] }], 'http://127.0.0.1:31455');
    expect(result?.pass).toBe(true);
    expect(labelReads).toBe(2);
    expect(result?.chipMs).toBeLessThan(100);
    expect(result?.ms).toBeGreaterThanOrEqual(result!.chipMs!);
    const [late] = await runScenarios(fake((js) => !js.includes('data-auto-submit')), [{ ...n5a,
      steps: [{ kind: 'type', text: 'https://example.com' }, { kind: 'waitFor', jsPredicate: 'visible-chip', timeoutMs: 5_000, measureChip: true },
        { kind: 'waitFor', jsPredicate: 'data-auto-submit', timeoutMs: 0, withinChipMs: true }], expect: [],
    }], 'http://127.0.0.1:31455');
    expect(late?.pass).toBe(false);
    expect(late?.chipMs).toBeGreaterThanOrEqual(0);
    expect(late?.failure).toContain('Step 3 (waitFor): timed out');
    const [overBudget] = await runScenarios(fake(async (js) => {
      if (js === 'data-auto-submit') await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    }), [{ ...n5a, steps: [
      { kind: 'type', text: 'https://example.com' }, { kind: 'waitFor', jsPredicate: 'visible-chip', timeoutMs: 5_000, measureChip: true },
      { kind: 'waitFor', jsPredicate: 'data-auto-submit', timeoutMs: 1, withinChipMs: true },
    ], expect: [] }], 'http://127.0.0.1:31455');
    expect(overBudget?.chipMs).toBeGreaterThanOrEqual(0);
    expect(overBudget?.pass).toBe(false);
    expect(overBudget?.failure).toContain('absorb chip conditions exceeded 1ms from insertion');
  });

  test('condition remains false: fails at Check and retains last value', async () => {
    const [result] = await runScenarios(fake(() => false), [scenario()], 'http://127.0.0.1:31455');
    expect(result?.pass).toBe(false);
    expect(result?.failure).toBe('Check 1 (ready): last=false');
    expect(result?.evidence).toContain('Check 1 (ready): last=false');
  });

  test('waitFor polls until true instead of assuming readiness on navigation', async () => {
    let calls = 0;
    const [result] = await runScenarios(fake(() => ++calls >= 2), [scenario({ steps: [{ kind: 'waitFor', jsPredicate: 'ready', timeoutMs: 200, intervalMs: 1 }] })], 'http://127.0.0.1:31455');
    expect(result?.pass).toBe(true);
    expect(calls).toBe(3);
  });

  test('driver error fails at the exact Step with its reason', async () => {
    const driver = fake(() => true);
    driver.press = async () => { throw new Error('CDP disconnected'); };
    const [result] = await runScenarios(driver, [scenario({ steps: [{ kind: 'press', key: 'Enter' }] })], 'http://127.0.0.1:31455');
    expect(result?.failure).toContain('Step 1 (press): CDP disconnected');
    expect(result?.pass).toBe(false);
  });

  test('missing selector blocks one cell and continues to the next', async () => {
    const driver = fake(() => false);
    const results = await runScenarios(driver, [scenario({ steps: [{ kind: 'click' }], expect: [] }), scenario({ id: 'N1', steps: [], expect: [] })], 'http://127.0.0.1:31455');
    expect(results[0]?.blocked).toBe('no-selector');
    expect(results[0]?.failure).toBe('Step 1 (click): no-selector');
    expect(results[1]?.pass).toBe(true);
  });

  test('a selector present in component source but absent in the page fails at Step with last value', async () => {
    const [result] = await runScenarios(fake(() => false), [scenario({
      steps: [{ kind: 'waitFor', selector: '.xterm', timeoutMs: 0 }], expect: [],
    })], 'http://127.0.0.1:31455');
    expect(result?.blocked).toBeUndefined();
    expect(result?.pass).toBe(false);
    expect(result?.failure).toBe('Step 1 (waitFor): timed out (.xterm); last=false');
  });

  test('an existing selector missing at click time is a Step failure, not blocked', async () => {
    const [result] = await runScenarios(fake(() => false), [scenario({ steps: [{ kind: 'click', selector: '.xterm' }], expect: [] })], 'http://127.0.0.1:31455');
    expect(result?.blocked).toBeUndefined();
    expect(result?.failure).toBe('Step 1 (click): selector not rendered (.xterm); last=false');
  });

  test('N6a compares isolated daemon LLM cursor before and after; any call fails', async () => {
    const driver = fake(() => true);
    let calls = 0;
    driver.llmCallCursor = async () => ++calls;
    const n6a = scenario({ id: 'N6a', surface: 'intake', steps: [{ kind: 'goto' }, { kind: 'type', text: '안녕' }] });
    const [result] = await runScenarios(driver, [n6a], 'http://127.0.0.1:31455');
    expect(result?.pass).toBe(false);
    expect(result?.failure).toBe('Check 2 (LLM calls remain zero): last=1→2');
    expect(result?.evidence).toContain('LLM cursor after: 2; changed=true');
    driver.llmCallCursor = async () => 2;
    const [clean] = await runScenarios(driver, [n6a], 'http://127.0.0.1:31455');
    expect(clean?.pass).toBe(true);
    expect(clean?.evidence).toContain('Check 2 (LLM calls remain zero): last=0');
    driver.llmCallCursor = async () => { throw new Error('log store unavailable'); };
    const [unmeasured] = await runScenarios(driver, [n6a], 'http://127.0.0.1:31455');
    expect(unmeasured?.pass).toBe(false);
    expect(unmeasured?.failure).toContain('Check 2 (LLM calls remain zero, baseline): Error: log store unavailable; last=unavailable');
  });

  test('failure screenshot is recorded and summary separates pass, fail and blocked', async () => {
    const results = await runScenarios(fake(() => false), [scenario(), scenario({ id: 'N1', steps: [], expect: [] }), scenario({ id: 'N5a', steps: [{ kind: 'click' }], expect: [] })], 'http://127.0.0.1:31455', async () => '/shots/T1.png');
    expect(results[0]?.evidence).toContain('screenshot: /shots/T1.png');
    expect(summarize(results, 'http://127.0.0.1:31455')).toBe('pwa-scenarios: pass 1 · fail 1 · blocked 1 · base http://127.0.0.1:31455');
  });
});
