import { expect, test, spyOn, beforeAll, afterAll } from 'bun:test';
import { debug } from '../debug/log.js';
import { buildDevCliSpec, setLaunchGrokQuotaReaderForTesting, type DevCliExecutor } from './dev-cli.js';

// 실시간 `elanous usage`(grok 잔량)를 부르지 않는다 — 이 파일은 effort 관측만 잰다.
beforeAll(() => setLaunchGrokQuotaReaderForTesting(() => 'unknown'));
afterAll(() => setLaunchGrokQuotaReaderForTesting(undefined));

const SELF: DevCliExecutor = { kind: 'self' };

function observeChildLlm(run: () => void): {
  stderr: string;
  logs: Array<{ category: string; event: string; data: Record<string, unknown> }>;
} {
  const chunks: string[] = [];
  const logs: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const write = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  const originalLog = debug.log;
  (debug as { log: typeof debug.log }).log = ((category, event, data) => {
    logs.push({ category: String(category), event: String(event), data: data as Record<string, unknown> });
  }) as typeof debug.log;
  try {
    run();
    return { stderr: chunks.join(''), logs };
  } finally {
    write.mockRestore();
    (debug as { log: typeof debug.log }).log = originalLog;
  }
}

test('flagged child effort shares one resolved value across stderr and structured observation', () => {
  const observed = observeChildLlm(() => {
    buildDevCliSpec({ text: 'implement' }, SELF, {
      childLlmProvider: 'grok', childLlmModel: 'grok-4.6', childLlmEffort: 'high',
    });
  });

  expect(observed.stderr).toContain('effort=high(ceiling=high · source=flag)');
  expect(observed.logs.filter((log) => log.category === 'self-dev.child-llm')).toEqual([{
    category: 'self-dev.child-llm',
    event: 'effort-resolved',
    data: {
      provider: 'grok', model: 'grok-4.6', resolvedId: 'grok-4.6', tier: 'flagship',
      effort: 'high', ceiling: 'high', source: 'flag', selectionSource: 'flag',
    },
  }]);
});

test('unset child effort stays unspecified without inferring a provider default', () => {
  const observed = observeChildLlm(() => {
    buildDevCliSpec({ text: 'implement' }, SELF, {
      childLlmProvider: 'grok', childLlmModel: 'grok-4.6',
    });
  });

  expect(observed.stderr).toContain('effort=미지정(ceiling=high · source=unset)');
  expect(observed.stderr).not.toMatch(/effort=(minimal|low|medium|high|xhigh|max)\b/);
  expect(observed.logs.filter((log) => log.category === 'self-dev.child-llm')).toEqual([{
    category: 'self-dev.child-llm',
    event: 'effort-resolved',
    data: {
      provider: 'grok', model: 'grok-4.6', resolvedId: 'grok-4.6', tier: 'flagship',
      effort: '미지정', ceiling: 'high', source: 'unset', selectionSource: 'flag',
    },
  }]);
});
