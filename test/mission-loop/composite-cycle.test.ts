import { setDefaultTimeout, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCompositeCycle } from '../../src/mission-loop/composite-cycle.js';
import { debug } from '../../src/debug/log.js';
import { createHarnessGoal, main, MissionRequestJudgeError, runMissionRequestJudge } from '../../scripts/mission-request-judge.js';
import type { CapabilityProvider } from '../../src/mission-capabilities/registry.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const id = 'req:v1:0123456789abcdef';
function root(): string { const value = mkdtempSync(join(tmpdir(), 'composite-cycle-')); roots.push(value); mkdirSync(join(value, 'docs/mission-requests'), { recursive: true }); return value; }
function request(at: string, requires = 'alpha.beta', requestId = id): void { writeFileSync(join(at, 'docs/mission-requests/request.md'), `---\nid: ${requestId}\nintent: "Test"\nschedule: "0 * * * *"\nrequires: [${requires}]\n---\n`); }
function canonicalRequestId(): string { return `req:v1:${createHash('sha256').update('test|0 * * * *|alpha.beta').digest('hex').slice(0, 16)}`; }
function judge(status: 'blueprint-candidate' | 'missing-blueprint' = 'blueprint-candidate') { return (authorityRoot: string) => ({ authorityRoot, requestCatalog: join(authorityRoot, 'docs/mission-requests'), catalogStatus: 'present' as const, requestsScanned: 1, invalidCount: 0, judgments: [status === 'blueprint-candidate' ? { file: 'request.md', status, capabilityCount: 1, blueprintPath: 'candidate.ts' } : { file: 'request.md', status, capabilityCount: 1 }] }); }
function provider(result: Awaited<ReturnType<CapabilityProvider['probe']>>): CapabilityProvider { return { id: 'alpha.beta', async probe() { return result; } }; }
function writeCapability(at: string, capability = 'alpha.beta'): void { const [directory, ...rest] = capability.split('.'); const path = join(at, 'src/mission-capabilities', directory!, `${rest.join('.')}.ts`); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'export {};\n'); }
function codeTreeCapabilityPath(capability: string): string { const [directory, ...rest] = capability.split('.'); return join(fileURLToPath(new URL('../../src/mission-capabilities/', import.meta.url)), directory!, `${rest.join('.')}.ts`); }

describe('runCompositeCycle', () => {
  test('keeps all-inside probe reason verbatim and repairHint paths for one harness goal', async () => {
    const authorityRoot = root(); request(authorityRoot); const goals: unknown[] = [];
    const result = await runCompositeCycle(authorityRoot, { judge: judge(), catalog: [provider({ ok: false, reason: 'SOURCE_REASON', repairHint: { paths: ['repair/a.ts'], what: 'fix' } })], createHarnessGoal: goal => { goals.push(goal); } });
    expect(result.actions).toEqual([{ requestId: id, action: 'goal-created', goal: { requestId: id, paths: ['repair/a.ts'], situation: 'SOURCE_REASON', ask: expect.any(String) } }]);
    expect(goals).toHaveLength(1);
  });

  test('changes repair target when repairHint paths change', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const result = await runCompositeCycle(authorityRoot, { judge: judge(), catalog: [provider({ ok: false, reason: 'bad', repairHint: { paths: ['other/fix.ts'], what: 'fix' } })], createHarnessGoal: () => {} });
    expect(result.actions[0]).toMatchObject({ action: 'goal-created', goal: { paths: ['other/fix.ts'] } });
  });

  test('escalates an existing capability external-state failure with repairHint.what verbatim and structural observation', async () => {
    const authorityRoot = root(); request(authorityRoot); writeCapability(authorityRoot);
    const events: unknown[][] = []; const log = spyOn(debug, 'log').mockImplementation((...args) => { events.push(args); });
    const repair = 'Run scripts/collect-market-daily.sh exactly as written.';
    try {
      const result = await runCompositeCycle(authorityRoot, { judge: judge(), catalog: [provider({ ok: false, reason: 'arbitrary stale wording', repairHint: { paths: ['scripts/collect-market-daily.sh'], what: repair } })], createHarnessGoal: () => { throw new Error('must not create'); } });
      expect(result.actions).toEqual([{ requestId: id, action: 'escalated', reason: repair }]);
      expect(events).toContainEqual(['mission-loop.composite', 'probe-failure-classified', { requestId: id, capabilityId: 'alpha.beta', branch: 'external-state', capabilityFileExists: true }]);
    } finally { log.mockRestore(); }
  });

  test('escalates all repository-outside repair paths without creating a goal and records their branch and reason', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const outsidePaths = [join(tmpdir(), 'outside-repair-a.ts'), join(tmpdir(), 'outside-repair-b.ts')];
    const events: unknown[][] = []; const log = spyOn(debug, 'log').mockImplementation((...args) => { events.push(args); });
    try {
      const result = await runCompositeCycle(authorityRoot, {
        judge: judge(),
        catalog: [provider({ ok: false, reason: 'OUTSIDE_REASON', repairHint: { paths: outsidePaths, what: 'fix' } })],
        createHarnessGoal: () => { throw new Error('must not create'); },
      });
      expect(result.actions).toEqual([{ requestId: id, action: 'escalated', reason: expect.stringContaining('OUTSIDE_REASON') }]);
      const action = result.actions[0];
      if (action?.action !== 'escalated') throw new Error('expected repository-outside escalation');
      expect(action.reason).toContain(outsidePaths[0]!);
      expect(action.reason).toContain(outsidePaths[1]!);
      expect(events).toContainEqual(['mission-loop.composite', 'probe-failure-classified', { requestId: id, capabilityId: 'alpha.beta', branch: 'repository-outside', capabilityFileExists: false }]);
    } finally { log.mockRestore(); }
  });

  test('creates a goal for mixed repository-inside and repository-outside repair paths without selecting repository-outside', async () => {
    const authorityRoot = root(); request(authorityRoot); const goals: unknown[] = [];
    const outsidePath = join(tmpdir(), 'mixed-outside-repair.ts');
    const events: unknown[][] = []; const log = spyOn(debug, 'log').mockImplementation((...args) => { events.push(args); });
    try {
      const result = await runCompositeCycle(authorityRoot, {
        judge: judge(),
        catalog: [provider({ ok: false, reason: 'MIXED_REASON', repairHint: { paths: ['repair/inside.ts', outsidePath], what: 'fix' } })],
        createHarnessGoal: goal => { goals.push(goal); },
      });
      expect(result.actions).toEqual([{ requestId: id, action: 'goal-created', goal: { requestId: id, paths: ['repair/inside.ts'], situation: expect.stringContaining(outsidePath), ask: expect.any(String) } }]);
      expect(goals).toHaveLength(1);
      expect(events).toContainEqual(['mission-loop.composite', 'probe-failure-classified', { requestId: id, capabilityId: 'alpha.beta', branch: 'missing-capability', capabilityFileExists: false }]);
      expect(events).not.toContainEqual(['mission-loop.composite', 'probe-failure-classified', { requestId: id, capabilityId: 'alpha.beta', branch: 'repository-outside', capabilityFileExists: false }]);
    } finally { log.mockRestore(); }
  });

  test('records cycle boundaries and safe goal decision details without the ask body', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await runCompositeCycle(authorityRoot, {
        judge: judge(),
        catalog: [provider({ ok: false, reason: 'SOURCE_REASON', repairHint: { paths: ['repair/a.ts'], what: 'fix' } })],
        createHarnessGoal: () => {},
      });
      const events = log.mock.calls.filter(([category]) => category === 'mission-loop.composite');
      expect(events).toEqual([
        ['mission-loop.composite', 'cycle-started', { requestCount: 'unknown' }],
        ['mission-loop.composite', 'requests-judged', { requestCount: 1 }],
        ['mission-loop.composite', 'probe-failure-classified', { requestId: id, capabilityId: 'alpha.beta', branch: 'missing-capability', capabilityFileExists: false }],
        ['mission-loop.composite', 'request-decision', { requestId: id, action: 'goal-created', paths: ['repair/a.ts'] }],
        ['mission-loop.composite', 'cycle-completed', { goalCreatedCount: 1, escalatedCount: 0 }],
      ]);
      expect(JSON.stringify(events)).not.toContain('대상 경로:');
      expect(JSON.stringify(events)).not.toContain('SOURCE_REASON');
    } finally { log.mockRestore(); }
  });

  test('records escalation requestId and reason while debug failures leave goals and escalations intact', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const log = spyOn(debug, 'log').mockImplementation(() => { throw new Error('LOG_FAILED'); });
    try {
      const goalResult = await runCompositeCycle(authorityRoot, {
        judge: judge(),
        catalog: [provider({ ok: false, reason: 'goal reason', repairHint: { paths: ['repair/a.ts'], what: 'fix' } })],
        createHarnessGoal: () => {},
      });
      const escalationResult = await runCompositeCycle(authorityRoot, {
        judge: judge(),
        catalog: [provider({ ok: false, reason: 'escalation reason', repairHint: { paths: [join(mkdtempSync(join(tmpdir(), 'mission-outside-')), 'outside.ts')], what: 'fix' } })],
      });
      expect(goalResult.actions[0]).toMatchObject({ requestId: id, action: 'goal-created', goal: { paths: ['repair/a.ts'] } });
      expect(escalationResult.actions).toEqual([{ requestId: id, action: 'escalated', reason: expect.stringContaining('escalation reason') }]);
    } finally { log.mockRestore(); }

    const events: unknown[][] = [];
    const recordingLog = spyOn(debug, 'log').mockImplementation((...args) => { events.push(args); });
    try {
      await runCompositeCycle(authorityRoot, {
        judge: judge(),
        catalog: [provider({ ok: false, reason: 'escalation reason', repairHint: { paths: [join(mkdtempSync(join(tmpdir(), 'mission-outside-')), 'outside.ts')], what: 'fix' } })],
      });
      expect(events).toContainEqual(['mission-loop.composite', 'request-decision', { requestId: id, action: 'escalated', reason: expect.stringContaining('escalation reason') }]);
      expect(events).toContainEqual(['mission-loop.composite', 'escalated', { requestId: id, reason: expect.stringContaining('escalation reason') }]);
      expect(events).toContainEqual(['mission-loop.composite', 'cycle-completed', { goalCreatedCount: 0, escalatedCount: 1 }]);
    } finally { recordingLog.mockRestore(); }
  });

  test('uses a blueprint path only after probes succeed and it is missing', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const result = await runCompositeCycle(authorityRoot, { judge: judge('missing-blueprint'), catalog: [provider({ ok: true })], loadBlueprint: async () => ({ status: 'missing', path: 'src/mission-blueprints/missing.ts' }), createHarnessGoal: () => {} });
    expect(result.actions[0]).toMatchObject({ action: 'goal-created', goal: { paths: ['src/mission-blueprints/missing.ts'], situation: 'Mission blueprint is missing.' } });
  });

  test('preserves loader readiness failure reason and repairHint as a capability goal when its capability file is missing', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const result = await runCompositeCycle(authorityRoot, {
      judge: judge('missing-blueprint'),
      catalog: [provider({ ok: true })],
      loadBlueprint: async () => ({ status: 'unavailable', path: 'unused.ts', capabilityId: 'alpha.beta', reason: 'SOURCE_REASON', repairHint: { paths: ['repair/a.ts'], what: 'fix' } }),
      createHarnessGoal: () => {},
    });
    expect(result.actions).toEqual([{ requestId: id, action: 'goal-created', goal: { requestId: id, paths: ['repair/a.ts'], situation: 'SOURCE_REASON', ask: expect.any(String) } }]);
  });

  test('escalates loader-unavailable failures for an existing capability with exact repairHint.what and structural observation', async () => {
    const authorityRoot = root(); request(authorityRoot); writeCapability(authorityRoot);
    const events: unknown[][] = []; const log = spyOn(debug, 'log').mockImplementation((...args) => { events.push(args); });
    const repair = 'Run the loader recovery command verbatim.';
    try {
      const result = await runCompositeCycle(authorityRoot, {
        judge: judge('missing-blueprint'), catalog: [provider({ ok: true })],
        loadBlueprint: async () => ({ status: 'unavailable', path: 'unused.ts', capabilityId: 'alpha.beta', reason: 'different arbitrary wording', repairHint: { paths: ['scripts/recover.sh'], what: repair } }),
        createHarnessGoal: () => { throw new Error('must not create'); },
      });
      expect(result.actions).toEqual([{ requestId: id, action: 'escalated', reason: repair }]);
      expect(events).toContainEqual(['mission-loop.composite', 'probe-failure-classified', { requestId: id, capabilityId: 'alpha.beta', branch: 'external-state', capabilityFileExists: true }]);
    } finally { log.mockRestore(); }
  });

  test('executes a ready blueprint and returns its body and delivery metadata without delivery', async () => {
    const authorityRoot = root(); request(authorityRoot); let ran = 0;
    const deliveryRoot = root();
    const result = await runCompositeCycle(authorityRoot, { judge: judge(), catalog: [provider({ ok: true })], resolveDeliveryRoot: () => deliveryRoot, loadBlueprint: async () => ({ status: 'ready', path: 'x', blueprint: { id, requires: [{ id: 'alpha.beta' }], produces: { kind: 'report', deliver: ['telegram', 'pwa'] }, async run() { ran++; return { ok: true, body: 'BODY', measured: { count: 1 } }; } } }) });
    expect(ran).toBe(1); expect(result.actions).toEqual([{ requestId: id, action: 'executed', body: 'BODY', measured: { count: 1 }, deliver: ['telegram', 'pwa'], fileDelivery: { status: 'persisted', path: join(deliveryRoot, 'mission-delivery', 'req_v1_0123456789abcdef.md'), bytes: 4 } }]);
  });

  test('ends the cycle after the first created goal without processing later requests', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const second = 'req:v1:fedcba9876543210'; writeFileSync(join(authorityRoot, 'docs/mission-requests/second.md'), `---\nid: ${second}\nintent: "Two"\nschedule: "0 * * * *"\nrequires: [alpha.beta]\n---\n`);
    const base = judge()(authorityRoot); base.judgments.push({ file: 'second.md', status: 'blueprint-candidate', capabilityCount: 1, blueprintPath: 'two.ts' });
    let probes = 0;
    const result = await runCompositeCycle(authorityRoot, { judge: () => base, catalog: [{ id: 'alpha.beta', async probe() { probes++; return { ok: false, reason: 'bad', repairHint: { paths: ['fix.ts'], what: 'fix' } } as const; } }], createHarnessGoal: () => {} });
    expect(result.actions.map(action => action.action)).toEqual(['goal-created']);
    expect(probes).toBe(1);
  });

  test('propagates harness goal creation failures without recording a successful action', async () => {
    const authorityRoot = root(); request(authorityRoot);
    await expect(runCompositeCycle(authorityRoot, { judge: judge(), catalog: [provider({ ok: false, reason: 'bad', repairHint: { paths: ['fix.ts'], what: 'fix' } })], createHarnessGoal: () => { throw new Error('HARNESS_FAILED'); } })).rejects.toThrow('HARNESS_FAILED');
  });

  test('records cycle-started before a throwing judge without claiming zero requests, and completes once', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const timeline: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event) => { timeline.push(`log:${event}`); });
    try {
      await expect(runCompositeCycle(authorityRoot, { judge: () => { timeline.push('judge'); throw new Error('JUDGE_FAILED'); } })).rejects.toThrow('JUDGE_FAILED');
      expect(timeline).toEqual(['log:cycle-started', 'judge', 'log:cycle-completed']);
      const events = log.mock.calls.filter(([category]) => category === 'mission-loop.composite');
      expect(events).toContainEqual(['mission-loop.composite', 'cycle-started', { requestCount: 'unknown' }]);
      expect(events).not.toContainEqual(['mission-loop.composite', 'cycle-started', { requestCount: 0 }]);
      expect(events.filter(([, event]) => event === 'cycle-completed')).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  test.each([
    ['in-flight check', (authorityRoot: string) => ({ judge: judge(), isRequestInFlight: () => { throw new Error('IN_FLIGHT_FAILED'); } })],
    ['harness goal creator', (authorityRoot: string) => ({ judge: judge(), catalog: [provider({ ok: false, reason: 'bad', repairHint: { paths: ['fix.ts'], what: 'fix' } })], createHarnessGoal: () => { throw new Error('HARNESS_FAILED'); } })],
  ])('records each cycle boundary once and propagates a thrown %s dependency', async (_name, dependenciesFor) => {
    const authorityRoot = root(); request(authorityRoot);
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      await expect(runCompositeCycle(authorityRoot, dependenciesFor(authorityRoot))).rejects.toThrow(/FAILED/);
      const events = log.mock.calls.filter(([category]) => category === 'mission-loop.composite');
      expect(events.filter(([, event]) => event === 'cycle-started')).toHaveLength(1);
      expect(events.filter(([, event]) => event === 'cycle-completed')).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  test('suppresses an in-flight request', async () => {
    const authorityRoot = root(); request(authorityRoot); let probes = 0;
    const result = await runCompositeCycle(authorityRoot, { judge: judge(), catalog: [{ id: 'alpha.beta', async probe() { probes++; return { ok: true } as const; } }], isRequestInFlight: requestId => requestId === id });
    expect(result.actions).toEqual([{ requestId: id, action: 'in-flight' }]); expect(probes).toBe(0);
  });

  test('escalates a thrown probe without loading or executing a blueprint and records its structural branch', async () => {
    const authorityRoot = root(); request(authorityRoot); let loaded = 0;
    const events: unknown[][] = []; const log = spyOn(debug, 'log').mockImplementation((...args) => { events.push(args); });
    try {
      const result = await runCompositeCycle(authorityRoot, { judge: judge(), catalog: [{ id: 'alpha.beta', async probe() { throw new Error('PROBE_THROWN'); } }], loadBlueprint: async () => { loaded++; throw new Error('unreachable'); } });
      expect(result.actions).toEqual([{ requestId: id, action: 'escalated', reason: 'PROBE_THROWN' }]); expect(loaded).toBe(0);
      expect(events).toContainEqual(['mission-loop.composite', 'probe-failure-classified', { requestId: id, capabilityId: 'alpha.beta', branch: 'probe-error', capabilityFileExists: false }]);
    } finally { log.mockRestore(); }
  });

  test('the product --tick path calls its injected harness goal creator', async () => {
    const authorityRoot = root(); const requestId = canonicalRequestId(); request(authorityRoot, 'alpha.beta', requestId); const goals: unknown[] = [];
    const lines = await runMissionRequestJudge(['--root', authorityRoot, '--tick'], { createHarnessGoal: goal => { goals.push(goal); } });
    expect(goals).toEqual([{ requestId, paths: [codeTreeCapabilityPath('alpha.beta')], situation: `Capability provider unavailable: alpha.beta`, ask: expect.any(String) }]);
    expect(lines.at(-2)).toBe('🔁 복합 회차 1건');
    expect(lines.at(-1)).toContain('goal-created');
  });

  test('the product --tick path propagates a harness goal creator failure without success output', async () => {
    const authorityRoot = root(); request(authorityRoot, 'alpha.beta', canonicalRequestId());
    await expect(runMissionRequestJudge(['--root', authorityRoot, '--tick'], { createHarnessGoal: () => { throw new Error('CLI_HARNESS_FAILED'); } })).rejects.toThrow('CLI_HARNESS_FAILED');
  });

  // ⛔ 이 저장소의 저작기는 «형태»로 문다. 그래서 여기서 모양을 «추측»하지 않고 ***진짜 판정자 셋***에 건다.
  //   📏 계기(2026-08-31 실측): 옛 판의 ask 는 첫 줄이 `Situation:` 이라 대상 경로 파서가
  //     labelMissing:true · paths:[] 를 냈다 — ***루프가 쏘는 골이 경로를 통째로 잃었다.***
  //     그리고 불변식·판정 신호 표지가 아예 없어 `matched:false` 였다.
  describe('루프가 만든 ask 가 «자기 하니스의 판정자»에 문다', () => {
    async function askFor(kind: 'capability' | 'blueprint'): Promise<string> {
      const authorityRoot = root(); request(authorityRoot);
      const goals: any[] = [];
      await runCompositeCycle(authorityRoot, kind === 'capability'
        ? { judge: judge(), catalog: [provider({ ok: false, reason: 'SOURCE_REASON', repairHint: { paths: ['repair/a.ts'], what: 'REPAIR_WHAT' } })], createHarnessGoal: g => { goals.push(g); } }
        : { judge: judge('missing-blueprint'), catalog: [provider({ ok: true })], loadBlueprint: async () => ({ status: 'missing', path: 'src/mission-blueprints/missing.ts' }), createHarnessGoal: g => { goals.push(g); } });
      expect(goals).toHaveLength(1);
      return goals[0].ask as string;
    }

    test('대상 경로 파서가 그 경로를 «찾는다»', async () => {
      const { parseAskTargetPathHintsResult } = await import('../../src/self-dev/launch-preflight.js');
      for (const kind of ['capability', 'blueprint'] as const) {
        const parsed = parseAskTargetPathHintsResult(await askFor(kind));
        expect(parsed.labelMissing).toBe(false);
        expect(parsed.paths.length).toBeGreaterThan(0);
      }
    });

    test('불변식 판정자가 «문다»', async () => {
      const { inspectAskInvariantMarker } = await import('../../src/self-implement/goal-author.js');
      for (const kind of ['capability', 'blueprint'] as const) {
        const inspection = inspectAskInvariantMarker(await askFor(kind));
        expect(inspection.matched).toBe(true);
        expect(inspection.extracted).toBe(true);
      }
    });

    test('판정 신호 판정자가 «문다»', async () => {
      const { inspectAskDecisionSignalMarker } = await import('../../src/self-implement/goal-author.js');
      for (const kind of ['capability', 'blueprint'] as const) {
        const inspection = inspectAskDecisionSignalMarker(await askFor(kind));
        expect(inspection.matched).toBe(true);
        expect(inspection.extracted).toBe(true);
      }
    });

    test('probe 가 준 reason 과 고칠 곳이 ask 본문에 «그대로» 들어 있다', async () => {
      const ask = await askFor('capability');
      expect(ask).toContain('SOURCE_REASON');
      expect(ask).toContain('REPAIR_WHAT');
      expect(ask).toContain('요청 id: ');
    });
  });

  describe('제품 하니스 호출이 repository 밖 ask 파일을 받는다', () => {
    test('기본 명령은 bun elanous harness ask에 repository 밖 ask 파일을 위치 인자로 전달하고 지운다', () => {
      const previous = process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND;
      const askDirectory = join(tmpdir(), 'mission-request-default-argv');
      const askFile = join(askDirectory, 'ask.md');
      const calls: Array<{ command: string; args: readonly string[] }> = [];
      let written = '';
      const removed: string[] = [];
      delete process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND;
      try {
        createHarnessGoal({ requestId: id, paths: ['src/example.ts'], situation: 'bad', ask: '대상 경로: src/example.ts\n\n불변식: preserved\n\n판정 신호: 조건 = x; 관측 = y; 기대 = z' }, {
          mkdtempSync: prefix => { expect(prefix).toStartWith(join(tmpdir(), 'mission-request-ask-')); return askDirectory; },
          writeFileSync: (file, content) => { expect(file).toBe(askFile); written = content; },
          rmSync: path => { removed.push(path); },
          spawnSync: (command, args) => { calls.push({ command, args }); expect(written).toContain('대상 경로: src/example.ts'); return { status: 0, stderr: '' }; },
        });
        expect(calls).toHaveLength(1);
        const [{ command, args }] = calls;
        expect(command).toBe('bun');
        expect(args).toEqual([join(import.meta.dir, '../../bin/elanous.mjs'), 'harness', 'ask', askFile]);
        expect(args).not.toContain('--ask');
        expect(args).not.toContain('--test');
        expect(args).not.toContain('--implement');
        expect(askFile).not.toStartWith(import.meta.dir);
        expect(written).toContain('불변식: preserved');
        expect(written).toContain('판정 신호: 조건 = x; 관측 = y; 기대 = z');
        expect(removed).toEqual([askDirectory]);
      } finally {
        if (previous === undefined) delete process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND;
        else process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND = previous;
      }
    });

    test('ELANOUS_MISSION_REQUEST_HARNESS_COMMAND 접두 덮어쓰기도 harness ask 위치 인자와 ask 내용을 받고 발사 뒤 파일을 지운다', async () => {
      const authorityRoot = root(); const requestId = canonicalRequestId(); request(authorityRoot, 'alpha.beta', requestId);
      const recorder = join(authorityRoot, 'record-argv.mjs');
      const sink = join(authorityRoot, 'argv.txt');
      writeFileSync(recorder, `import { readFileSync, writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nconst ask = args.at(-1);\nwriteFileSync(${JSON.stringify(sink)}, JSON.stringify({ args, ask, content: readFileSync(ask, 'utf8') }));\n`);
      const previous = process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND;
      process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND = `bun ${recorder}`;
      try {
        const lines = await runMissionRequestJudge(['--root', authorityRoot, '--tick']);
        expect(lines.at(-1)).toContain('goal-created');
        const received = JSON.parse(readFileSync(sink, 'utf8')) as { args: string[]; ask: string; content: string };
        expect(received.args).toEqual([received.ask]);
        expect(received.args).not.toContain('--ask');
        expect(received.ask).not.toStartWith(authorityRoot);
        expect(received.content.split('\n')[0]).toContain('대상 경로:');
        expect(received.content).toContain('불변식:');
        expect(received.content).toContain('판정 신호: 조건 =');
        expect(received.content).toContain(requestId);
        expect(existsSync(received.ask)).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND;
        else process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND = previous;
      }
    });

    test('비영 하니스 실패도 전파하고 ask 파일을 지운다', async () => {
      const authorityRoot = root(); request(authorityRoot, 'alpha.beta', canonicalRequestId());
      const recorder = join(authorityRoot, 'fail-argv.mjs');
      const sink = join(authorityRoot, 'failed-ask.txt');
      writeFileSync(recorder, `import { writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nwriteFileSync(${JSON.stringify(sink)}, args.at(-1));\nprocess.exitCode = 23;\n`);
      const previous = process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND;
      process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND = `bun ${recorder}`;
      try {
        await expect(runMissionRequestJudge(['--root', authorityRoot, '--tick'])).rejects.toThrow('status 23');
        expect(existsSync(readFileSync(sink, 'utf8'))).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND;
        else process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND = previous;
      }
    });
  });

  test('요청 카탈로그가 없으면 «자리» 두 줄을 잃지 않고 실패한다', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mission-empty-'));
    try {
      // ⛔ 「없다」를 말하기 «전»에 「어디를 봤나」를 낸다 — RFC 가 그 두 줄을 필수로 못 박았다.
      const failure = await runMissionRequestJudge(['--root', empty]).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(MissionRequestJudgeError);
      const lines = (failure as InstanceType<typeof MissionRequestJudgeError>).lines;
      expect(lines[0]).toContain('📍 권위 트리:');
      expect(lines[1]).toContain('📍 요청 카탈로그:');
      expect(lines.at(-1)).toContain('디렉토리 부재');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('하니스 명령 설정이 «비어 있으면» 임시 디렉터리 없이 읽을 수 있는 오류를 낸다', () => {
    const previous = process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND;
    process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND = '   ';
    let directoriesCreated = 0;
    try {
      expect(() => createHarnessGoal({ requestId: id, paths: [], situation: 'bad', ask: 'ask' }, {
        mkdtempSync: () => { directoriesCreated++; return 'unreachable'; },
        writeFileSync: () => { throw new Error('unreachable'); },
        rmSync: () => { throw new Error('unreachable'); },
        spawnSync: () => ({ status: 0, stderr: '' }),
      })).toThrow('비어 있다');
      expect(directoriesCreated).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND;
      else process.env.ELANOUS_MISSION_REQUEST_HARNESS_COMMAND = previous;
    }
  });

  test('ask 파일 기록 실패도 생성한 임시 디렉터리를 지운다', () => {
    const askDirectory = join(tmpdir(), 'mission-request-write-failure');
    const removed: string[] = [];
    expect(() => createHarnessGoal({ requestId: id, paths: [], situation: 'bad', ask: 'ask' }, {
      mkdtempSync: () => askDirectory,
      writeFileSync: () => { throw new Error('WRITE_FAILED'); },
      rmSync: path => { removed.push(path); },
      spawnSync: () => { throw new Error('unreachable'); },
    })).toThrow('WRITE_FAILED');
    expect(removed).toEqual([askDirectory]);
  });

  // ⛔ 마커 파서가 문다고 「그 명령이 돈다」가 아니다(리뷰 3R must-fix: Goodhart).
  //   ⇒ 생성된 «관측» 명령을 그대로 뽑아 ***실제로 실행***하고 산출을 본다.
  describe('생성된 판정 신호의 «관측 명령»이 실제로 돈다', () => {
    test('미등록 능력의 생성 목표는 코드 트리 진단 경로를 가리킨다', async () => {
      const authorityRoot = root(); const requestId = canonicalRequestId(); request(authorityRoot, 'alpha.beta', requestId);
      const goals: any[] = [];
      await runMissionRequestJudge(['--root', authorityRoot, '--tick'], { createHarnessGoal: g => { goals.push(g); } });
      expect(goals).toHaveLength(1);
      const ask = goals[0].ask as string;

      expect(ask.split('\n')[0]).toBe(`대상 경로: ${codeTreeCapabilityPath('alpha.beta')}`);
      expect(ask).not.toContain(authorityRoot);
    });
  });

  test('CLI entry wires cron PATH and scheduler sink before judgment', async () => {
    const calls: string[] = [];
    await main(['--tick'], {
      ensureCronNodePath: () => { calls.push('path'); },
      registerStandaloneLogSink: async surface => { calls.push(`sink:${surface}`); return true; },
      runMissionRequestJudge: async argv => { calls.push(`judge:${argv.join(' ')}`); return ['JUDGED']; },
      log: line => { calls.push(`log:${line}`); },
    });
    expect(calls).toEqual(['path', 'sink:scheduler', 'judge:--tick', 'log:JUDGED']);
  });

  test('CLI sink failure is named and judgment continues', async () => {
    const calls: string[] = [];
    await main([], {
      ensureCronNodePath: () => { calls.push('path'); },
      registerStandaloneLogSink: async () => { throw new Error('SINK_UNAVAILABLE'); },
      runMissionRequestJudge: async () => { calls.push('judge'); return ['JUDGED']; },
      log: line => { calls.push(`log:${line}`); },
      error: line => { calls.push(`error:${line}`); },
    });
    expect(calls).toEqual([
      'path',
      'error:⚠️ registerStandaloneLogSink(scheduler) failed; continuing mission request judgment: SINK_UNAVAILABLE',
      'judge',
      'log:JUDGED',
    ]);
  });

  test('importing the judgment module has no standalone sink side effect', () => {
    const entry = join(import.meta.dir, '../../scripts/mission-request-judge.ts');
    const sink = join(import.meta.dir, '../../src/domains/standalone-log-sink.ts');
    const probe = `
      import { mock } from 'bun:test';
      let calls = 0;
      mock.module(${JSON.stringify(sink)}, () => ({
        registerStandaloneLogSink: async () => { calls++; return true; },
      }));
      await import(${JSON.stringify(entry)});
      console.log(JSON.stringify({ calls }));
    `;
    const run = spawnSync('bun', ['-e', probe], { cwd: join(import.meta.dir, '../..'), encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    expect(JSON.parse(run.stdout.trim())).toEqual({ calls: 0 });
  });

  test('CLI 계약: 카탈로그가 없으면 stdout 에 «자리» 두 줄을 내고 exit 1 이다', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mission-cli-'));
    try {
      const entry = join(import.meta.dir, '../../scripts/mission-request-judge.ts');
      const run = spawnSync('bun', [entry, '--root', empty], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      const out = run.stdout.split('\n');
      expect(out[0]).toContain('📍 권위 트리:');
      expect(out[1]).toContain('📍 요청 카탈로그:');
      expect(run.stderr).toContain('디렉토리 부재');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('escalates an all-outside probe failure with each named path and creates no goal', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const outside = join(mkdtempSync(join(tmpdir(), 'mission-outside-')), 'far.ts');
    const goals: unknown[] = [];
    const result = await runCompositeCycle(authorityRoot, {
      judge: judge(),
      catalog: [provider({ ok: false, reason: 'bad', repairHint: { paths: [outside], what: 'fix' } })],
      createHarnessGoal: goal => { goals.push(goal); },
    });
    expect(result.actions).toEqual([{ requestId: id, action: 'escalated', reason: expect.stringContaining(outside) }]);
    expect(goals).toEqual([]);
  });

  test('creates a mixed-path goal with only inside paths and records omitted outside paths', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const inside = join(authorityRoot, 'repair', 'inside.ts');
    const outside = join(mkdtempSync(join(tmpdir(), 'mission-outside-')), 'far.ts');
    const goals: any[] = [];
    const result = await runCompositeCycle(authorityRoot, {
      judge: judge(),
      catalog: [provider({ ok: false, reason: 'bad', repairHint: { paths: [inside, outside], what: 'fix' } })],
      createHarnessGoal: goal => { goals.push(goal); },
    });
    expect(result.actions[0]).toMatchObject({ action: 'goal-created', goal: { paths: [inside] } });
    expect(goals[0].situation).toContain(outside);
    expect(goals[0].ask).toContain(outside);
    expect(goals[0].paths).not.toContain(outside);
  });

  test('escalates a root traversal path rather than treating it as inside', async () => {
    const authorityRoot = root(); request(authorityRoot);
    const traversal = `${authorityRoot}/../escaped.ts`;
    const result = await runCompositeCycle(authorityRoot, {
      judge: judge(),
      catalog: [provider({ ok: false, reason: 'bad', repairHint: { paths: [traversal], what: 'fix' } })],
      createHarnessGoal: () => { throw new Error('must not create'); },
    });
    expect(result.actions).toEqual([{ requestId: id, action: 'escalated', reason: expect.stringContaining(traversal) }]);
  });
});