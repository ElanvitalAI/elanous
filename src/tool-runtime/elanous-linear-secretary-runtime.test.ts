import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';
import { updateLinearSecretaryProgress } from '../intake-plane/linear-wish.js';
import * as linearSecretary from '../intake-plane/linear-secretary-runtime.js';
import { registerAllDefaultToolRuntimes } from './index.js';
import { _resetToolRuntimeRegistryForTest, dispatchToolByName, listToolRuntimes } from './registry.js';
import {
  createElanousLinearSecretaryRuntime,
  elanousLinearSecretaryRuntime,
  setElanousLinearSecretaryRunnerForTest,
} from './elanous-linear-secretary-runtime.js';

let restore: (() => void) | undefined;
let logSpy: ReturnType<typeof spyOn> | undefined;
let productionCall: ReturnType<typeof spyOn> | undefined;
const tempDirs: string[] = [];
const schemaRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON schema object');
  return value as Record<string, unknown>;
};
const schemaEnum = (value: unknown): readonly unknown[] => {
  const row = schemaRecord(value);
  if (!Array.isArray(row.enum)) throw new Error('expected a JSON schema enum');
  return row.enum;
};
afterEach(() => {
  restore?.(); restore = undefined;
  logSpy?.mockRestore(); logSpy = undefined;
  productionCall?.mockRestore(); productionCall = undefined;
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
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
    expect(await dispatchToolByName('elanous_linear_secretary', { action: 'create', request: '   ' }, { surface: 'tui' })).toMatchObject({ ok: false });
    const result = await dispatchToolByName('elanous_linear_secretary', { action: 'create', request: 'HBM 전망 2026-11-04' }, { surface: 'tui' });
    expect(received).toEqual(['projectless=true teamKey=DEMO HBM 전망 2026-11-04']);
    expect(result).toMatchObject({ ok: true, output: '등록: 부모 1개 · 하위 3개', parentIssueId: 'parent-1', childIssueIds: ['child-1', 'child-2', 'child-3'], teamKey: 'DEMO' });
  });

  test('publishes the staged DEMO-only secretary contract', () => {
    const spec = elanousLinearSecretaryRuntime.spec;
    const parameters = schemaRecord(spec.parameters);
    const properties = schemaRecord(parameters.properties);
    const captureArtifact = schemaRecord(properties.captureArtifact);
    const captureProperties = schemaRecord(captureArtifact.properties);
    expect(schemaEnum(properties.action)).toEqual(['create', 'progress', 'approval']);
    expect(schemaEnum(properties.teamKey)).toEqual(['DEMO']);
    expect(schemaEnum(captureProperties.externalShare)).toEqual([true]);
    expect(schemaEnum(captureProperties.sensitivity)).toEqual(['public']);
    expect(parameters.additionalProperties).toBe(false);
  });

  test('rejects a non-DEMO destination before the create runner can write', async () => {
    const received: string[] = [];
    restore = setElanousLinearSecretaryRunnerForTest(async request => {
      received.push(request);
      return { replyCard: 'unexpected', parentIssueId: 'parent-1', childIssueIds: [] };
    });
    const result = await elanousLinearSecretaryRuntime.run({ action: 'create', request: 'projectless=true teamKey=ELA secret 2026-11-04' }, { surface: 'tui' });
    expect(result).toEqual({ ok: false, output: 'DEMO 팀만 지원합니다.' });
    expect(received).toEqual([]);
    const contradictory = await elanousLinearSecretaryRuntime.run({ action: 'create', request: 'teamKey=DEMO projectless=false agenda 2026-11-04' }, { surface: 'tui' });
    expect(contradictory).toEqual({ ok: false, output: 'DEMO 팀만 지원합니다.' });
    expect(received).toEqual([]);
  });

  test('forces explicit DEMO teamKey requests through projectless routing', async () => {
    const received: string[] = [];
    restore = setElanousLinearSecretaryRunnerForTest(async request => {
      received.push(request);
      return { replyCard: 'created', parentIssueId: 'parent-1', childIssueIds: [] };
    });
    const result = await elanousLinearSecretaryRuntime.run({ action: 'create', request: 'teamKey=DEMO agenda 2026-11-04' }, { surface: 'tui' });
    expect(result.ok).toBe(true);
    expect(received).toEqual(['projectless=true teamKey=DEMO agenda 2026-11-04']);
    const mixedCase = await elanousLinearSecretaryRuntime.run({ action: 'create', request: 'TEAMkey=demo PROJECTLESS=TRUE agenda 2026-11-04' }, { surface: 'tui' });
    expect(mixedCase.ok).toBe(true);
    expect(received.at(-1)).toBe('teamKey=DEMO projectless=true agenda 2026-11-04');
  });

  test('runs the progress runtime against the verified DEMO child manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'linear-secretary-intake-'));
    tempDirs.push(root);
    const intakeSources: string[] = [];
    const queries: string[] = [];
    const comments: string[] = [];
    let parentDescription = [
      '<!-- elanous-linear-secretary-checklist:start -->', '- [ ] 자료 흡수', '- [ ] 브라우저 증거', '- [ ] 검토 완료',
      '<!-- elanous-linear-secretary-checklist:end -->',
    ].join('\n');
    let childState = 'started';
    const childDescription = [
      'task details', '<!-- elanous-linear-secretary-manifest:start -->',
      JSON.stringify({ parentIssueId: 'parent-1', tasks: [{ issueId: 'child-1', title: '자료 흡수' }] }),
      '<!-- elanous-linear-secretary-manifest:end -->',
    ].join('\n');
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables?: { id?: string; input?: { description?: string } } };
      queries.push(body.query.match(/(?:query|mutation)\s+\w+/)?.[0] ?? 'unparsed');
      const id = body.variables?.id ?? '';
      if (body.query.includes('SecretaryDemoParent')) return Response.json({ data: { issue: { id: 'parent-1', team: { key: 'DEMO' } } } });
      if (body.query.includes('LinearMissionIssueIdentity')) return Response.json({ data: { issue: { id: 'child-1', team: { key: 'DEMO' }, parent: { id: 'parent-1' } } } });
      if (body.query.includes('LinearIssueDescription($id')) return Response.json({ data: { issue: { description: id === 'parent-1' ? parentDescription : childDescription } } });
      if (body.query.includes('LinearIssueStatus')) return Response.json({ data: { issue: { state: { type: childState } } } });
      if (body.query.includes('DecisionIssueStates')) return Response.json({ data: { issue: { team: { states: { nodes: [{ id: 'done', type: 'completed' }] } } } } });
      if (body.query.includes('DecisionIssueClose')) { childState = 'completed'; return Response.json({ data: { issueUpdate: { success: true } } }); }
      if (body.query.includes('DecisionComment')) { comments.push(id); return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-1' } } } }); }
      if (body.query.includes('LinearIssueDescriptionUpdate')) { parentDescription = String(body.variables?.input?.description ?? ''); return Response.json({ data: { issueUpdate: { success: true } } }); }
      throw new Error(`unexpected fake Linear query: ${body.query}`);
    }) as typeof fetch;
    const runtime = createElanousLinearSecretaryRuntime({
      getApiKey: async () => 'fake-key',
      fetch: fakeFetch,
      intake: { root: () => root, now: () => '2026-10-31T00:00:00.000Z',
        ingest: (_root, source, raws) => { intakeSources.push(source); return { shaped: raws.length, added: raws.length, merged: 0, seen: 0, skipped: 0, badLines: 0 }; } },
    });
    const result = await runtime.run({ action: 'progress', teamKey: 'DEMO', parentIssueId: 'parent-1', taskIssueId: 'child-1',
      state: 'completed', summary: '흡수 자료 검토 완료', absorbText: '원자료 URL https://example.test/brief' }, { surface: 'tui' });
    expect(result).toMatchObject({ ok: true, taskIssueId: 'child-1', state: 'completed' });
    const evidenceRefs: unknown[] = Array.isArray(result.evidenceRefs) ? result.evidenceRefs : [];
    expect(evidenceRefs).toHaveLength(1);
    expect(String(evidenceRefs[0])).toMatch(/^elanous:intake:/);
    expect(intakeSources).toEqual(['memo']);
    expect(queries).toContain('query SecretaryDemoParent');
    expect(queries).toContain('query LinearMissionIssueIdentity');
    expect(queries).toContain('mutation DecisionIssueClose');
    expect(queries).toContain('mutation LinearIssueDescriptionUpdate');
    expect(childState).toBe('completed');
    expect(comments).toHaveLength(1);
    expect(parentDescription).toContain('- [x] 자료 흡수');
  });

  test('forwards the approved browser artifact and workaround through the tool contract', async () => {
    const forwarded: Parameters<typeof updateLinearSecretaryProgress>[0][] = [];
    const captureArtifact = { path: '/tmp/demo-capture.png', mimeType: 'image/png', runId: 'run-demo', linearIssueId: 'parent-1',
      externalShare: true, sensitivity: 'public', createdAt: Date.parse('2026-10-31T00:00:00.000Z') };
    const runtime = createElanousLinearSecretaryRuntime({ getApiKey: async () => 'fake-key', verifyParent: async () => {},
      readChildManifest: async () => ({ parentIssueId: 'parent-1', tasks: [{ issueId: 'child-1', title: '브라우저 확인' }] }),
      updateProgress: async input => { forwarded.push(input); } });
    const result = await runtime.run({ action: 'progress', teamKey: 'DEMO', parentIssueId: 'parent-1', taskIssueId: 'child-1',
      state: 'completed', summary: '증거 연결', workaround: '해결 경로 기록', captureArtifact }, { surface: 'tui' });
    expect(result).toMatchObject({ ok: true, taskIssueId: 'child-1' });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ captureArtifact, workaround: '해결 경로 기록', parentIssueId: 'parent-1', taskIssueId: 'child-1' });
    const unapproved = await runtime.run({ action: 'progress', teamKey: 'DEMO', parentIssueId: 'parent-1', taskIssueId: 'child-1',
      state: 'completed', summary: '미승인 캡처 거부', captureArtifact: { ...captureArtifact, externalShare: false } }, { surface: 'tui' });
    expect(unapproved).toMatchObject({ ok: false, output: 'Linear 캡처는 현재 DEMO 부모에 대해 명시 승인된 공개 브라우저 증거여야 합니다.' });
    expect(forwarded).toHaveLength(1);
  });

  test('creates a local open approval and does not claim to reopen an already decided card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'linear-secretary-ledger-'));
    tempDirs.push(root);
    const ledger = new DecisionLedger({ stateDir: root, postDecisionNotice: () => 0,
      resolveVersion: () => ({ released: '0.2.43', dev: '0.2.44-dev.0', codename: null }) });
    const runtime = createElanousLinearSecretaryRuntime({ getApiKey: async () => 'fake-key',
      verifyParent: async () => {}, ledger: () => ledger });
    const args = { action: 'approval' as const, teamKey: 'DEMO' as const, parentIssueId: 'parent-1', title: '데모 승인', context: 'DEMO 자료 검토 완료' };
    const opened = await runtime.run(args, { surface: 'tui' });
    expect(opened).toMatchObject({ ok: true, status: 'open' });
    const decisionId = String(opened.decisionId);
    expect(ledger.show(decisionId).status).toBe('open');
    ledger.decide(decisionId, 'b', { kind: 'human' });
    const existing = await runtime.run(args, { surface: 'tui' });
    expect(existing).toMatchObject({ ok: true, status: 'decided' });
    expect(existing.output).toContain('새 카드는 열지 않았습니다');
    expect(ledger.list({ status: 'all' })).toHaveLength(1);
  });

  test('does not return or log unexpected connector errors that may contain secrets', async () => {
    const secret = 'linear-private-token-123';
    const error = new Error('connector failed');
    error.name = secret;
    restore = setElanousLinearSecretaryRunnerForTest(async () => { throw error; });
    const logs: unknown[] = [];
    logSpy = spyOn(debug, 'log').mockImplementation((...args: unknown[]) => { logs.push(args); });
    const result = await elanousLinearSecretaryRuntime.run({ action: 'create', request: 'HBM 전망 2026-11-04' }, { surface: 'tui' });
    expect(result).toEqual({ ok: false, output: 'Linear 비서 작업을 진행하지 못했습니다. 팀 키·이슈 ID·근거·권한을 확인해 주세요.' });
    expect(JSON.stringify({ result, logs })).not.toContain(secret);
    expect(logs).toEqual([['tool.linear-secretary', 'failed', { action: 'create', errorType: 'Error' }]]);
  });

  test('returns the safe explanation when a projectless request omits its team key', async () => {
    restore = setElanousLinearSecretaryRunnerForTest(async () => { throw new Error('projectless=true requires an explicit teamKey=<KEY>'); });
    const result = await elanousLinearSecretaryRuntime.run({ action: 'create', request: 'projectless=true create issues' }, { surface: 'tui' });
    expect(result).toEqual({ ok: false, output: 'DEMO 팀만 지원합니다.' });
  });
});
