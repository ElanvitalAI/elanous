import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import * as linearSecretary from '../intake-plane/linear-secretary-runtime.js';
import { registerAllDefaultToolRuntimes } from './index.js';
import { _resetToolRuntimeRegistryForTest, dispatchToolByName, listToolRuntimes } from './registry.js';
import {
  elanousLinearSecretaryRuntime,
  setElanousLinearSecretaryRunnerForTest,
} from './elanous-linear-secretary-runtime.js';

let restore: (() => void) | undefined;
let logSpy: ReturnType<typeof spyOn> | undefined;
let productionCall: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  restore?.(); restore = undefined;
  logSpy?.mockRestore(); logSpy = undefined;
  productionCall?.mockRestore(); productionCall = undefined;
  _resetToolRuntimeRegistryForTest();
});

describe('Linear secretary runtime', () => {
  test('registers on TUI and MCP surfaces', () => {
    registerAllDefaultToolRuntimes();
    expect(listToolRuntimes('tui').map(runtime => runtime.id)).toContain('elanous_linear_secretary');
    expect(listToolRuntimes('mcp').map(runtime => runtime.id)).toContain('elanous_linear_secretary');
  });

  test('validates request and routes successful calls through the existing secretary flow', async () => {
    const received: string[] = [];
    productionCall = spyOn(linearSecretary, 'runLinearSecretaryRequest').mockImplementation(async request => {
      received.push(request);
      return { replyCard: '등록: 부모 1개 · 하위 3개', parentIssueId: 'parent-1', childIssueIds: ['child-1', 'child-2', 'child-3'] };
    });
    registerAllDefaultToolRuntimes();
    expect(await dispatchToolByName('elanous_linear_secretary', { request: '   ' }, { surface: 'tui' })).toMatchObject({ ok: false });
    const result = await dispatchToolByName('elanous_linear_secretary', { request: 'HBM 전망 2026-11-04' }, { surface: 'tui' });
    expect(received).toEqual(['HBM 전망 2026-11-04']);
    expect(result).toMatchObject({ ok: true, output: '등록: 부모 1개 · 하위 3개', parentIssueId: 'parent-1', childIssueIds: ['child-1', 'child-2', 'child-3'] });
  });

  test('does not return or log unexpected connector errors that may contain secrets', async () => {
    const secret = 'linear-private-token-123';
    const error = new Error('connector failed');
    error.name = secret;
    restore = setElanousLinearSecretaryRunnerForTest(async () => { throw error; });
    const logs: unknown[] = [];
    logSpy = spyOn(debug, 'log').mockImplementation((...args: unknown[]) => { logs.push(args); });
    const result = await elanousLinearSecretaryRuntime.run({ request: 'HBM 전망 2026-11-04' }, { surface: 'tui' });
    expect(result).toEqual({ ok: false, output: 'Linear 비서 작업을 진행하지 못했습니다. 키·프로젝트·요청 내용을 확인해 주세요.' });
    expect(JSON.stringify({ result, logs })).not.toContain(secret);
    expect(logs).toEqual([['tool.linear-secretary', 'failed', { errorType: 'Error' }]]);
  });

  test('returns the safe explanation when a projectless request omits its team key', async () => {
    restore = setElanousLinearSecretaryRunnerForTest(async () => { throw new Error('projectless=true requires an explicit teamKey=<KEY>'); });
    const result = await elanousLinearSecretaryRuntime.run({ request: 'projectless=true create issues' }, { surface: 'tui' });
    expect(result).toEqual({ ok: false, output: 'projectless=true requires an explicit teamKey=<KEY>' });
  });
});
