import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDecision, reduceDecisions, EMPTY_DECISIONS } from '../../apps/pwa/src/components/inside/pty-decisions.js';
import { runAgentMission, claudeBackend, codexBackend, createMissionControlBrain } from './driver.js';
import { emitPtyDecision, PTY_DECISION_TEXT_MAX } from './pty-decision.js';
import type { PtyHandle } from '../pty-shell/registry.js';
import { runPtyControlLoop, type PtyControlDeps, type RunSupervisor } from '../autopilot/pty-control-loop.js';
import { decideInterventionStep } from '../self-implement/intervention-step.js';

test('repeated choice prompts emit recover decisions in action order', async () => {
  const rows: unknown[] = [];
  const actions: string[] = [];
  const ident = { missionId: 'choice-recover-test', sessionId: 'session', terminalId: 'terminal', agent: 'codex' };
  const brain = createMissionControlBrain({ mission: 'Build', evidenceReady: () => false, search: () => {},
    stream: async () => '{"action":"wait"}', initialCommand: 'Build',
    onRecover: (blocked, action) => {
      actions.push(action);
      emitPtyDecision({ ...ident, step: 'recover', text: action, detail: { blocked, action } }, (_category, _event, row) => { rows.push(row); });
    },
  });
  for (let step = 0; step < 7; step++) {
    const decision = await brain.decide({ screen: 'Proceed? [y/N]', state: 'blocked', step,
      changed: false, sameScreenMs: 0, intervention: {} as Parameters<typeof brain.decide>[0]['intervention'] });
    if (decision.action === 'input') brain.onInputResult(decision.text, true);
  }
  expect(actions).toEqual(['Enter', 'Esc', 'Ctrl-C and replay previous command', 'Human needed']);
  const decisions = rows.map(parseDecision);
  expect(decisions.map((row) => row?.step)).toEqual(['recover', 'recover', 'recover', 'recover']);
  expect(decisions.map((row) => row?.seq)).toEqual([0, 1, 2, 3]);
});

test('a fake mission emits read, judge, input, answer and done without changing decisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-decision-'));
  const rows: unknown[] = [];
  const writes: string[] = [];
  let retryEvidence = true;
  let enterWritten!: () => void;
  const enter = new Promise<void>((resolve) => { enterWritten = resolve; });
  const collect = (category: string, event: string, data?: unknown) => {
    expect(category).toBe('pty.decision');
    expect(event).toBe((data as { step: string }).step);
    rows.push(data);
  };
  try {
    const result = await runAgentMission({ mission: 'Inspect result', repo: dir, branch: 'fixture', agent: claudeBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /output/ }, memory: false, resources: 'off', commit: false, screensDir: join(dir, 'screens'),
    }, {
      emitPtyDecision: (input) => emitPtyDecision(input, collect),
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
      startPty: ((opts) => ({ id: opts.id!, kind: 'claude', nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready to proceed',
        renderScreenPng: async () => null, write: (text: string) => { writes.push(text); if (text === '\r' && writes.includes('continue')) enterWritten(); }, kill: () => {},
      } as unknown as PtyHandle)),
      controlStream: async () => '{"action":"send","text":"continue"}',
      runControlLoop: (async (brain: RunSupervisor, control: PtyControlDeps) => {
        const obs = { screen: 'ready to proceed', state: 'idle' as const, step: 0, changed: false,
          intervention: decideInterventionStep({ screen: 'ready to proceed', previous: null, stopAfterSameScreens: 2,
            descriptor: { level: 'L3', controlStance: 'owned', draft: 'continue' } }),
        };
        const decision = await brain.decide(obs);
        expect(decision).toEqual({ action: 'input', text: 'continue\r' });
        expect(control.inject('continue\r')).toBe(true);
        await enter;
        const retry = await control.verifyDone?.(obs);
        expect(retry?.ok).toBe(false);
        await control.onStep?.(obs, decision);
        expect(control.injectKey?.('Down', 2)).toBe(true);
        const trust = await brain.decide({ ...obs, step: 1, screen: 'Accessing workspace:\nQuick safety check: Is this a project you trust?\n❯ Yes, I trust this folder\n  No, exit' });
        expect(trust).toEqual({ action: 'input', text: '\r' });
        expect(control.inject('\r')).toBe(true);
        retryEvidence = false;
        return { termination: { kind: 'success' }, steps: 2 } as never;
      }) as never,
      checkEvidence: () => retryEvidence ? { ok: false, path: null, retry: 'Output missing' } : { ok: true, path: join(dir, 'docs', 'output.md') },
    });
    expect(result.ok).toBe(true);
    expect(writes.slice(0, 2)).toEqual(['Inspect result', '\r']);
    expect(writes).toContain('continue');
    expect(writes).toContain('\x1b[B\x1b[B');
    const parsed = rows.map((row) => parseDecision(row));
    expect(parsed.every(Boolean)).toBe(true);
    const events = parsed.filter((row): row is NonNullable<typeof row> => row !== null);
    expect(events.map(({ step }) => step)).toContain('answer');
    expect(events.find((row) => row.step === 'recover')?.detail).toMatchObject({ blocked: expect.stringContaining('Output missing'), action: 'Retry after fixing evidence' });
    const read = events.findIndex((row) => row.step === 'read');
    const judge = events.findIndex((row, i) => i > read && row.step === 'judge');
    const input = events.findIndex((row, i) => i > judge && row.step === 'input');
    const key = events.findIndex((row, i) => i > input && row.step === 'input' && row.detail?.keys === 'Down');
    const answer = events.findIndex((row, i) => i > key && row.step === 'answer');
    const done = events.findIndex((row, i) => i > answer && row.step === 'done');
    expect([read, judge, input, key, answer, done].every((n) => n >= 0)).toBe(true);
    expect(events.filter((row) => row.step === 'read')).toHaveLength(2);
    expect(events[read]?.text).toBe('step 0 (idle): ready to proceed');
    expect(events[key]?.text).toBe('Pressed Down ×2');
    // seq is per mission id (the process run id), so another mission in the same process may have advanced it — require no gaps.
    expect(events.map(({ seq }) => seq)).toEqual(events.map((_, i) => events[0]!.seq + i));
    expect(events.every((row) => row.missionId === events[0]?.missionId && row.terminalId === events[0]?.terminalId && row.sessionId === events[0]?.sessionId)).toBe(true);
    expect(events.reduce(reduceDecisions, EMPTY_DECISIONS).missions[events[0]!.missionId]).toHaveLength(events.length);
    expect(events.at(-1)?.detail).toMatchObject({ result: { kind: 'file', ref: join(dir, 'docs', 'output.md') } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('observation failure cannot change handoff and launch behavior', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-handoff-'));
  const events: string[] = [];
  let readCalls = 0;
  let brainCalls = 0;
  let judgeFailures = 0;
  try {
    const result = await runAgentMission({ mission: 'Build feature', repo: dir, branch: 'fixture', agent: codexBackend,
      chain: ['codex', 'claude', 'elanous'], evidence: { kind: 'doc', dirRel: 'docs', glob: /output/ },
      memory: false, resources: 'off', commit: true, screensDir: join(dir, 'screens'),
    }, {
      emitPtyDecision: (input) => { if (input.step === 'judge') judgeFailures++; throw new Error('log store unavailable'); },
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
      startPty: ((opts) => {
        events.push(`pty:${opts.kind}`);
        return { id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'Review finding: missing test',
          renderScreenPng: async () => null, write: () => {}, kill: () => {},
        } as unknown as PtyHandle;
      }),
      handoffOperations: { diff: () => 'diff --git a/file b/file\n+new', gateAndPr: async () => { events.push('gate/PR'); } },
      controlStream: async () => { brainCalls++; return brainCalls === 1
        ? '{"action":"handoff","to":"claude","mission":"Review changes","carry":"diff","reason":"Review"}'
        : '{"action":"handoff","to":"elanous","mission":"Gate changes","reason":"Review complete"}'; },
      runControlLoop: (brain, control, options) => runPtyControlLoop(brain, {
        ...control,
        settle: async () => {},
        observe: async () => { readCalls++; return 'Review finding: missing test'; },
        onStep: async (obs, decision) => { await control.onStep?.(obs, decision); },
      }, options),
    });
    expect(result.ok).toBe(true);
    expect(events).toEqual(['pty:codex', 'pty:claude', 'gate/PR']);
    expect(readCalls).toBe(2);
    expect(brainCalls).toBe(2);
    expect(judgeFailures).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

test('an agent question answered by the brain carries its actual question and reply', async () => {
  const rows: unknown[] = [];
  const collect = (category: string, _event: string, data?: unknown) => { if (category === 'pty.decision') rows.push(data); };
  const dir = mkdtempSync(join(tmpdir(), 'pty-question-'));
  try {
    await runAgentMission({ mission: 'Answer', repo: dir, branch: 'fixture', agent: claudeBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /output/ }, memory: false, resources: 'off', commit: false, screensDir: join(dir, 'screens'),
    }, {
      emitPtyDecision: (input) => emitPtyDecision(input, collect),
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
      startPty: ((opts) => ({ id: opts.id!, kind: 'claude', nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
        renderScreenPng: async () => null, write: () => {}, kill: () => {},
      } as unknown as PtyHandle)),
      controlStream: async () => '{"action":"send","text":"yes","reason":"Answering question: Use the existing file?"}',
      runControlLoop: (async (brain: RunSupervisor, control: PtyControlDeps) => {
        const screen = 'Use the existing file?';
        const decision = await brain.decide({ screen, state: 'blocked', step: 0, changed: false,
          intervention: decideInterventionStep({ screen, previous: null, stopAfterSameScreens: 2,
            descriptor: { level: 'L3', controlStance: 'owned', draft: 'continue' } }),
        });
        expect(decision).toEqual({ action: 'input', text: 'yes\r' });
        if (decision.action !== 'input') throw new Error('expected answer input');
        expect(control.inject(decision.text)).toBe(true);
        return { termination: { kind: 'success' }, steps: 1 } as never;
      }) as never,
      checkEvidence: () => ({ ok: true, path: join(dir, 'docs', 'output.md') }),
    });
    const answers = rows.map((row) => parseDecision(row)).filter((row) => row?.step === 'answer');
    expect(answers).toContainEqual(expect.objectContaining({ step: 'answer', detail: { question: 'Use the existing file?', answer: 'yes' } }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a refused input in the real control loop never claims the question was answered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-refused-answer-'));
  const rows: unknown[] = [];
  let writable = true;
  let probesAfterRefusal = 0;
  const writesAfterRefusal: string[] = [];
  try {
    const refused = runAgentMission({ mission: 'Answer', repo: dir, branch: 'fixture', agent: claudeBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /output/ }, memory: false, resources: 'off', commit: false, screensDir: join(dir, 'screens'),
    }, {
      emitPtyDecision: (input) => emitPtyDecision(input, (_category, _event, row) => { rows.push(row); }),
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
      startPty: ((opts) => ({ id: opts.id!, kind: 'claude', nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => { if (!writable) probesAfterRefusal++; return writable; }, drainDelta: () => '', renderScreen: async () => 'Use the existing file?',
        renderScreenPng: async () => null, write: (text: string) => { if (!writable) writesAfterRefusal.push(text); }, kill: () => {},
      } as unknown as PtyHandle)),
      // The PTY stops accepting agent writes right after the brain decides, so the driver's own inject wrapper
      // reaches the real handle-level inject and gets false back (no test override of control.inject).
      controlStream: async () => { writable = false; return '{"action":"send","text":"yes","reason":"Answering question: Use the existing file?"}'; },
      runControlLoop: (brain, control, options) => runPtyControlLoop(brain, {
        ...control, settle: async () => {}, sleep: async () => {}, controlStance: () => 'owned' as const,
      }, options),
      checkEvidence: () => ({ ok: false, path: null, retry: 'Not written' }),
    });
    await expect(refused).rejects.toThrow('AGENT_YIELDED');
    expect(probesAfterRefusal).toBeGreaterThan(0);
    expect(writesAfterRefusal).toEqual([]);
    const events = rows.map((row) => parseDecision(row));
    expect(events.map((event) => event?.step)).toContain('judge');
    expect(events.map((event) => event?.step)).not.toContain('answer');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 20_000);

test('unrelated screen question does not turn a send into an answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-unrelated-'));
  const rows: unknown[] = [];
  try {
    await runAgentMission({ mission: 'Continue', repo: dir, branch: 'fixture', agent: claudeBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /output/ }, memory: false, resources: 'off', commit: false, screensDir: join(dir, 'screens'),
    }, {
      emitPtyDecision: (input) => emitPtyDecision(input, (_category, _event, row) => { rows.push(row); }),
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
      startPty: ((opts) => ({ id: opts.id!, kind: 'claude', nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'Old unrelated question?',
        renderScreenPng: async () => null, write: () => {}, kill: () => {},
      } as unknown as PtyHandle)),
      controlStream: async () => '{"action":"send","text":"continue","reason":"Proceed with the task"}',
      runControlLoop: (async (brain: RunSupervisor) => {
        const screen = 'Old unrelated question?';
        const decision = await brain.decide({ screen, state: 'idle', step: 0, changed: false,
          intervention: decideInterventionStep({ screen, previous: null, stopAfterSameScreens: 2,
            descriptor: { level: 'L3', controlStance: 'owned', draft: 'continue' } }),
        });
        expect(decision).toEqual({ action: 'input', text: 'continue\r' });
        return { termination: { kind: 'success' }, steps: 1 } as never;
      }) as never,
      checkEvidence: () => ({ ok: true, path: join(dir, 'docs', 'output.md') }),
    });
    expect(rows.map((row) => parseDecision(row)?.step)).not.toContain('answer');
    expect(rows.map((row) => parseDecision(row)?.step)).toContain('judge');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('per-mission sequence is independent and every free-text detail is masked before logging', () => {
  const events: unknown[] = [];
  const collect = (category: string, _event: string, data?: unknown) => { if (category === 'pty.decision') events.push(data); };
  const ident = { missionId: 'mask-mission', sessionId: 'session', terminalId: 'terminal', agent: 'claude' };
  const first = emitPtyDecision({ ...ident, step: 'answer', text: `Bearer abc123 ${'x'.repeat(500)}`, detail: {
      question: 'Email me at user@example.com; token=sk-secret', answer: 'api_key=abc123 ghp_hidden xoxb-secret',
  } }, collect);
  const second = emitPtyDecision({ ...ident, step: 'recover', text: 'Retry', detail: { blocked: 'Bearer forbidden', action: 'password=unsafe' } }, collect);
  const third = emitPtyDecision({ ...ident, step: 'done', text: 'Finished', detail: { result: { kind: 'text', ref: 'contact@example.com' } } }, collect);
  const other = emitPtyDecision({ ...ident, missionId: 'another-mission', step: 'read', text: 'screen' }, collect);
  emitPtyDecision({ ...ident, step: 'input', text: 'key=secret AWS_ACCESS_KEY_ID=AKIAEXAMPLE', detail: { keys: 'key=hidden' } }, collect);
  emitPtyDecision({ ...ident, step: 'read', text: 'AWS_ACCESS_KEY_ID: visible' }, collect);
  emitPtyDecision({ ...ident, step: 'answer', text: 'token="secret with spaces"', detail: {
    question: "api_key='question secret with spaces'", answer: 'Bearer "bearer secret with spaces"',
  } }, collect);
  expect([first.seq, second.seq, third.seq, other.seq]).toEqual([0, 1, 2, 0]);
  expect(events.every((e) => parseDecision(e) !== null)).toBe(true);
  const encoded = JSON.stringify(events);
  for (const secret of ['abc123', 'sk-secret', 'user@example.com', 'ghp_hidden', 'xoxb-secret', 'forbidden', 'unsafe', 'contact@example.com', 'key=secret', 'AKIAEXAMPLE', 'key=hidden', 'AWS_ACCESS_KEY_ID: visible', 'secret with spaces', 'question secret with spaces', 'bearer secret with spaces']) {
    expect(encoded).not.toContain(secret);
  }
  expect(first.text.length).toBeLessThanOrEqual(PTY_DECISION_TEXT_MAX);
});

test('distinct secret-bearing mission IDs retain unique opaque aliases and independent sequences', () => {
  const rows: unknown[] = [];
  const collect = (_category: string, _event: string, row?: unknown) => { rows.push(row); };
  const base = { sessionId: 'session', terminalId: 'terminal', agent: 'claude', step: 'read' as const, text: 'screen' };
  const first = emitPtyDecision({ ...base, missionId: 'mission-token=first-secret' }, collect);
  const other = emitPtyDecision({ ...base, missionId: 'mission-token=second-secret' }, collect);
  const next = emitPtyDecision({ ...base, missionId: 'mission-token=first-secret' }, collect);
  expect(first.missionId).not.toBe(other.missionId);
  expect(next.missionId).toBe(first.missionId);
  expect([first.seq, other.seq, next.seq]).toEqual([0, 0, 1]);
  expect(rows.every((row) => parseDecision(row) !== null)).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(/first-secret|second-secret/);
});

test('emission masks identifier secrets and caps every string to UTF-16 length without splitting a surrogate pair', () => {
  const rows: unknown[] = [];
  const input = {
    missionId: 'mission-token=private', sessionId: 'user@example.com', terminalId: 'Bearer terminal-secret',
    agent: 'agent api_key=hidden', step: 'answer' as const,
    text: `${'x'.repeat(PTY_DECISION_TEXT_MAX - 1)}😀`,
    detail: { question: `Bearer another-secret ${'x'.repeat(500)}`, answer: 'ops@example.com' },
  };
  const decision = emitPtyDecision(input, (category, event, row) => {
    expect(category).toBe('pty.decision');
    expect(event).toBe('answer');
    rows.push(row);
  });
  expect(rows).toEqual([decision]);
  expect(parseDecision(decision)).not.toBeNull();
  if (decision.step !== 'answer') throw new Error('expected answer');
  expect(decision.text).toBe('x'.repeat(PTY_DECISION_TEXT_MAX - 1));
  for (const value of [decision.missionId, decision.sessionId, decision.terminalId, decision.agent,
    decision.text, decision.detail.question, decision.detail.answer]) {
    expect(value.length).toBeLessThanOrEqual(PTY_DECISION_TEXT_MAX);
    expect(value).not.toMatch(/[\uD800-\uDBFF]$/);
  }
  for (const secret of ['private', 'user@example.com', 'terminal-secret', 'hidden', 'another-secret', 'ops@example.com']) {
    expect(JSON.stringify(rows)).not.toContain(secret);
  }
});

test('moving the trust selection is only input; the answer comes when the choice is confirmed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-trust-'));
  const rows: Array<{ step: string; detail?: { answer?: string } }> = [];
  const trustScreen = (selected: 'no' | 'yes') => `Accessing workspace:\nQuick safety check: Is this a project you trust?\n${selected === 'yes' ? '❯' : ' '} Yes, I trust this folder\n${selected === 'no' ? '❯' : ' '} No, exit`;
  try {
    await runAgentMission({ mission: 'Trust', repo: dir, branch: 'fixture', agent: claudeBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /output/ }, memory: false, resources: 'off', commit: false, screensDir: join(dir, 'screens'),
    }, {
      emitPtyDecision: (input) => emitPtyDecision(input, (_category, _event, row) => { rows.push(row as never); }),
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
      startPty: ((opts) => ({ id: opts.id!, kind: 'claude', nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready to proceed',
        renderScreenPng: async () => null, write: () => {}, kill: () => {},
      } as unknown as PtyHandle)),
      controlStream: async () => '{"action":"wait"}',
      runControlLoop: (async (brain: RunSupervisor, control: PtyControlDeps) => {
        const base = { state: 'idle' as const, changed: false,
          intervention: decideInterventionStep({ screen: 'x', previous: null, stopAfterSameScreens: 2, descriptor: { level: 'L3', controlStance: 'owned', draft: '' } }) };
        const move = await brain.decide({ ...base, step: 0, screen: trustScreen('no') });
        expect(move).toEqual({ action: 'input', text: '\x1b[B' });
        expect(control.inject('\x1b[B')).toBe(true);
        expect(rows.filter((row) => row.step === 'answer')).toHaveLength(0);
        const confirm = await brain.decide({ ...base, step: 1, screen: trustScreen('yes') });
        expect(confirm).toEqual({ action: 'input', text: '\r' });
        expect(control.inject('\r')).toBe(true);
        return { termination: { kind: 'success' }, steps: 2 } as never;
      }) as never,
      checkEvidence: () => ({ ok: true, path: join(dir, 'docs', 'output.md') }),
    });
    const answers = rows.filter((row) => row.step === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers[0]!.detail?.answer).toBe('Confirm selected choice');
    expect(rows.map((row) => parseDecision(row)).every(Boolean)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a rejected recovery input neither emits a recover decision nor advances the stage', async () => {
  const actions: string[] = [];
  const brain = createMissionControlBrain({ mission: 'Build', evidenceReady: () => false, search: () => {},
    stream: async () => '{"action":"wait"}', initialCommand: 'Build',
    onRecover: (_blocked, action) => { actions.push(action); },
  });
  const obs = (step: number) => ({ screen: 'Proceed? [y/N]', state: 'blocked' as const, step,
    changed: false, sameScreenMs: 0, intervention: {} as Parameters<typeof brain.decide>[0]['intervention'] });
  for (let step = 0; step < 2; step++) await brain.decide(obs(step));
  const first = await brain.decide(obs(2));
  expect(first).toEqual({ action: 'input', text: '\r' });
  brain.onInputResult('\r', false);
  expect(actions).toEqual([]);
  // The same stage is retried; once accepted it is recorded and the next stage is Esc.
  const retry = await brain.decide(obs(3));
  expect(retry).toEqual({ action: 'input', text: '\r' });
  brain.onInputResult('\r', true);
  expect(actions).toEqual(['Enter']);
  const next = await brain.decide(obs(4));
  expect(next).toEqual({ action: 'input', text: '\x1b' });
  // A rejected Ctrl-C does not schedule the command replay.
  brain.onInputResult('\x1b', true);
  const interrupt = await brain.decide(obs(5));
  expect(interrupt).toEqual({ action: 'input', text: '\x03' });
  brain.onInputResult('\x03', false);
  expect(await brain.decide(obs(6))).toEqual({ action: 'input', text: '\x03' });
});
