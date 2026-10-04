import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentMission, type AgentMissionDeps } from './driver.js';
import type { PtyHandle } from '../pty-shell/registry.js';
import { runAgentMissionDuo } from './duo.js';
import { emitPtyDecision, type DecisionInput, type PtyDecision } from './pty-decision.js';
import type { AgentMissionResult, AgentMissionSpec } from './driver.js';

const success = (spec: AgentMissionSpec): AgentMissionResult => ({
  ok: true, worktree: `/worktrees/${spec.branch}`, branch: spec.branch!, rounds: 2,
  evidencePath: `/worktrees/${spec.branch}/proof`, evidenceSatisfied: true, committed: true,
  usedOmniCrawl: false, ptyId: `pty-${spec.agent!.name}`, driveVerdict: 'success', detail: '완료(증거 충족)',
});

const opts = { left: 'codex', right: 'claude', branch: 'demo', evidence: 'doc' };
const resolveBackend = (name?: string) => ({ name: name as 'codex' | 'claude', cmd: 'fake', args: [] });

test('duo runs the same verbatim mission concurrently, with two terminal streams under one duo alias and two summary lines', async () => {
  const specs: AgentMissionSpec[] = [];
  const events: PtyDecision[] = [];
  const aliases: string[] = [];
  const log = (_category: string, _event: string, data: Record<string, unknown>) => { aliases.push(String(data.missionId)); };
  const waiting: Array<() => void> = [];
  const pending = runAgentMissionDuo(['Original\nmission'], opts, {
    id: () => 'parallel', resolveBackend,
    runMission: async (spec) => {
      specs.push(spec);
      const terminalId = `pty-${spec.agent!.name}`;
      const identity = { missionId: spec.decisionMissionId!, sessionId: terminalId, terminalId, agent: spec.agent!.name };
      events.push(emitPtyDecision({ ...identity, step: 'read', text: 'ready' }, log));
      await new Promise<void>((resolve) => waiting.push(resolve));
      events.push(emitPtyDecision({ ...identity, step: 'judge', text: 'verify' }, log));
      events.push(emitPtyDecision({ ...identity, step: 'done', text: 'evidence', detail: { result: { kind: 'file', ref: 'proof' } } }, log));
      return success(spec);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(specs).toHaveLength(2);
  expect(specs.map((s) => s.mission)).toEqual(['Original\nmission', 'Original\nmission']);
  expect(specs.map((s) => s.branch)).toEqual(['demo-codex', 'demo-claude']);
  expect(specs.map((s) => s.agent?.name)).toEqual(['codex', 'claude']);
  expect(specs.map((s) => s.decisionMissionId)).toEqual(['duo-parallel', 'duo-parallel']);
  waiting[1]!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  waiting[0]!();
  const result = await pending;
  expect(result.missionId).toBe('duo-parallel');
  expect(result.exitCode).toBe(0);
  expect(result.lines).toHaveLength(2);
  expect(result.lines[1]).toContain('먼저 · 증거 충족');
  expect(result.lines[0]).toContain('나중 · 증거 충족');
  expect(result.lines.every((line) => line.includes('DRIVE-OK success'))).toBe(true);
  expect(new Set(events.map((event) => event.missionId)).size).toBe(1);
  expect(events[0]!.missionId).toMatch(/^duo-/);
  expect(new Set(aliases).size).toBe(1);
  expect(aliases[0]).toMatch(/^duo-/);
  expect(new Set(events.map((event) => event.terminalId))).toEqual(new Set(['pty-codex', 'pty-claude']));
  for (const terminalId of ['pty-codex', 'pty-claude']) {
    expect(events.filter((event) => event.terminalId === terminalId).map((event) => event.step)).toEqual(['read', 'judge', 'done']);
  }
});

test('a failed left backend does not prevent the right backend from reaching done', async () => {
  const steps: string[] = [];
  const result = await runAgentMissionDuo(['unaltered'], opts, {
    id: () => 'failure', resolveBackend,
    runMission: async (spec) => {
      const identity = { missionId: spec.decisionMissionId!, sessionId: spec.branch!, terminalId: `pty-${spec.agent!.name}`, agent: spec.agent!.name };
      steps.push(emitPtyDecision({ ...identity, step: 'read', text: 'started' }, () => {}).step + ':' + identity.terminalId);
      if (spec.agent!.name === 'codex') throw new Error('backend failed');
      steps.push(emitPtyDecision({ ...identity, step: 'done', text: 'finished', detail: { result: { kind: 'file', ref: 'proof' } } }, () => {}).step + ':' + identity.terminalId);
      return success(spec);
    },
  });
  expect(steps).toEqual(['read:pty-codex', 'read:pty-claude', 'done:pty-claude']);
  expect(result.lines).toHaveLength(2);
  expect(result.lines[0]).toContain('증거 미측정 · DRIVE-OK 미측정 · 실패 (backend failed)');
  expect(result.lines[1]).toContain('완료');
  expect(result.exitCode).toBe(2);
});

test('evidence success without a path is reported independently of the final mission verdict', async () => {
  const result = await runAgentMissionDuo(['same'], opts, {
    resolveBackend,
    runMission: async (spec) => ({ ...success(spec), evidencePath: null }),
  });
  expect(result.lines).toHaveLength(2);
  for (const line of result.lines) {
    expect(line).toContain('증거 충족');
    expect(line).not.toContain('증거 미충족');
    expect(line).toContain('DRIVE-OK success');
  }
});

test('evidence success is reported even when DRIVE-OK rejects the mission', async () => {
  const result = await runAgentMissionDuo(['same'], opts, {
    resolveBackend,
    runMission: async (spec) => ({
      ...success(spec), ok: false, evidencePath: null, driveVerdict: 'done-but-failed',
      detail: '미완(DRIVE-OK: failed screen)',
    }),
  });
  expect(result.exitCode).toBe(2);
  for (const line of result.lines) {
    expect(line).toContain('증거 충족');
    expect(line).toContain('DRIVE-OK done-but-failed');
    expect(line).toContain('실패');
  }
});

test('duo drives both fake PTYs through the real mission driver and emits distinct terminal decisions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'duo-pty-'));
  const decisions: PtyDecision[] = [];
  const seenBranches: string[] = [];
  try {
    const runMission = (spec: AgentMissionSpec): Promise<AgentMissionResult> => {
      const worktree = join(root, spec.branch!);
      mkdirSync(join(worktree, 'docs'), { recursive: true });
      seenBranches.push(spec.branch!);
      const backend = spec.agent!.name;
      const deps: AgentMissionDeps = {
        createWorktree: (() => ({ path: worktree, branch: spec.branch, base: 'HEAD' })) as never,
        recordWorktreeProvenance: (() => {}) as never,
        checkClaudeSubscription: (() => ({ ok: true })) as never,
        controlStream: (async () => '{"action":"verify","reason":"evidence ready"}') as never,
        commitWorktree: (() => ({ ok: true, out: '' })) as never,
        resolvePtyWebAddress: (() => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' })) as never,
        emitPtyDecision: ((input: DecisionInput) => { decisions.push(emitPtyDecision(input, () => {})); }) as never,
        startPty: (ptyOpts) => ({
          id: ptyOpts.id, kind: backend, nickname: backend, accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '',
          renderScreen: async () => backend === 'codex' ? 'error: build failed' : 'MISSION-COMPLETE', renderScreenPng: async () => null,
          write: () => {}, kill: () => {},
        }) as unknown as PtyHandle,
        runControlLoop: async (brain) => {
          await brain.decide({ screen: 'MISSION-COMPLETE', step: 1, state: 'idle' } as never);
          if (backend === 'claude') writeFileSync(join(worktree, 'docs', 'proof.md'), 'proof');
          return { termination: { kind: 'success', reason: 'verified' }, steps: 1 };
        },
        checkEvidence: (() => ({ ok: true, path: backend === 'claude' ? join(worktree, 'docs', 'proof.md') : null })) as never,
      };
      return runAgentMission({ ...spec, repo: root, screensDir: join(root, `screens-${backend}`) }, deps);
    };
    const result = await runAgentMissionDuo(['same'], { ...opts, commit: false }, {
      resolveBackend, runMission, id: () => 'integration',
    });
    expect(seenBranches).toEqual(['demo-codex', 'demo-claude']);
    expect(result.sides[0]!.result).toMatchObject({ ok: false, evidenceSatisfied: true, evidencePath: null, driveVerdict: 'done-but-failed' });
    expect(result.sides[1]!.result).toMatchObject({ ok: true, evidenceSatisfied: true, evidencePath: join(root, 'demo-claude', 'docs', 'proof.md') });
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toContain('증거 충족 · DRIVE-OK done-but-failed · 실패');
    expect(result.lines[1]).toContain('DRIVE-OK success');
    expect(result.exitCode).toBe(2);
    expect(new Set(decisions.map((decision) => decision.missionId)).size).toBe(1);
    expect(new Set(decisions.map((decision) => decision.terminalId)).size).toBe(2);
    for (const terminalId of new Set(decisions.map((decision) => decision.terminalId))) {
      const stream = decisions.filter((decision) => decision.terminalId === terminalId).map((decision) => decision.step);
      expect(stream).toContain('read');
      expect(stream.indexOf('judge')).toBeGreaterThan(stream.indexOf('read'));
      expect(stream.indexOf('done')).toBeGreaterThan(stream.indexOf('judge'));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('duo rejects duplicate backends and missing evidence before starting either mission', async () => {
  let calls = 0;
  const deps = { resolveBackend, runMission: async (spec: AgentMissionSpec) => { calls++; return success(spec); } };
  await expect(runAgentMissionDuo(['ask'], { ...opts, right: 'codex' }, deps)).rejects.toThrow('서로 다른');
  await expect(runAgentMissionDuo(['ask'], { ...opts, evidence: 'test' }, deps)).rejects.toThrow('--test-path');
  expect(calls).toBe(0);
});

test('doc evidence defaults to plan markdown files, not arbitrary extensions', async () => {
  const evidence: AgentMissionSpec['evidence'][] = [];
  await runAgentMissionDuo(['ask'], { ...opts }, {
    resolveBackend,
    runMission: async (spec) => { evidence.push(spec.evidence); return success(spec); },
  });
  expect(evidence).toHaveLength(2);
  for (const mode of evidence) {
    if (mode?.kind !== 'doc') throw new Error('doc evidence expected');
    expect(mode.glob.test('PLAN-example.md')).toBe(true);
    expect(mode.glob.test('PLAN-exampleXmd')).toBe(false);
  }
});
