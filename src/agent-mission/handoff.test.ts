import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoffMission, loginCard, missionDiff, waitForHumanLogin, type HandoffOperations } from './handoff.js';
import { runPtyControlLoop } from '../autopilot/pty-control-loop.js';
import { runAgentMission, codexBackend, createMissionControlBrain } from './driver.js';
import type { PtyHandle } from '../pty-shell/registry.js';

function fakeOps(events: string[], worktree: string): HandoffOperations {
  return {
    start: async (to, mission, cwd) => {
      expect(cwd).toBe(worktree);
      events.push(`start:${to}:${mission}`);
    },
    gateAndPr: async (cwd) => { expect(cwd).toBe(worktree); events.push('gate/PR'); },
    claudeLoggedIn: () => true,
    notify: (card) => { events.push(`card:${JSON.stringify(card)}`); },
    screen: async () => 'ready',
    alive: () => true,
    sleep: async () => {},
    diff: () => 'diff --git a/a b/a\n+new',
  };
}

test('mission brain leaves repeated-question recovery after a different screen appears', async () => {
  const actions: string[] = [];
  const brain = createMissionControlBrain({
    mission: 'Build', evidenceReady: () => false, search: () => {},
    stream: async () => '{"action":"wait"}', onRecover: (_blocked, action) => { actions.push(action); },
  });
  const makeObs = (screen: string, step: number) => ({ screen, step, state: 'blocked' as const,
    changed: step > 0, sameScreenMs: 0,
    intervention: {} as Parameters<typeof brain.decide>[0]['intervention'] });
  // The control loop reports each input back; a recovery step commits only when it was accepted.
  const decideAccepted = async (obs: ReturnType<typeof makeObs>) => {
    const decision = await brain.decide(obs);
    if (decision.action === 'input') brain.onInputResult(decision.text, true);
    return decision;
  };
  for (let step = 0; step < 3; step++) await decideAccepted(makeObs('Proceed? [y/N]', step));
  expect(actions).toEqual(['Enter']);
  expect(await brain.decide(makeObs('Proceed? [y/N]\ncompiling 1/3', 3))).toEqual({ action: 'wait' });
  expect(await brain.decide(makeObs('Proceed? [y/N]\ncompiling 2/3', 4))).toEqual({ action: 'wait' });
  expect(actions).toEqual(['Enter']);
});

test('fake PTYs: codex → claude(diff file) → codex(review findings) → elanous(gate/PR), same worktree', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-handoff-'));
  try {
    const events: string[] = [];
    const ops = fakeOps(events, wt);
    await ops.start('codex', 'Build the patch', wt);
    await handoffMission({ action: 'handoff', to: 'claude', mission: 'Review the patch', carry: 'diff' }, wt, ops);
    expect(readFileSync(join(wt, '.mission-handoff.diff'), 'utf8')).toContain('+new');
    await handoffMission({ action: 'handoff', to: 'codex', mission: 'Fix findings', carry: 'summary' }, wt, ops, 'Missing assertion in test');
    expect(() => readFileSync(join(wt, '.mission-handoff.diff'))).toThrow();
    await handoffMission({ action: 'handoff', to: 'elanous', mission: 'Gate and open PR' }, wt, ops);
    expect(() => readFileSync(join(wt, '.mission-handoff.diff'))).toThrow();
    expect(events).toEqual([
      'start:codex:Build the patch',
      'start:claude:Review the patch\nRead .mission-handoff.diff and review the changes before responding.',
      'start:codex:Fix findings\nPrevious controller summary: Missing assertion in test',
      'gate/PR',
    ]);
  } finally { rmSync(wt, { recursive: true, force: true }); }
});

test('diff carry includes tracked edits and untracked source files from the actual worktree', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-real-diff-'));
  try {
    execFileSync('git', ['init', '-q', wt]);
    writeFileSync(join(wt, 'tracked.ts'), 'before\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-qm', 'base'], { cwd: wt });
    writeFileSync(join(wt, 'tracked.ts'), 'after\n');
    writeFileSync(join(wt, 'new.ts'), 'export const newFeature = true;\n');
    const events: string[] = [];
    const { diff: _diff, ...ops } = fakeOps(events, wt);
    await handoffMission({ action: 'handoff', to: 'claude', mission: 'Review', carry: 'diff' }, wt, ops);
    const patch = readFileSync(join(wt, '.mission-handoff.diff'), 'utf8');
    expect(patch).toContain('+after');
    expect(patch).toContain('+export const newFeature = true;');
    expect(missionDiff(wt)).not.toContain('.mission-handoff.diff');
  } finally { rmSync(wt, { recursive: true, force: true }); }
});

test('diff carry restores a new empty file and a new binary file', () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-patch-'));
  const target = mkdtempSync(join(tmpdir(), 'mission-patch-apply-'));
  try {
    execFileSync('git', ['init', '-q', wt]);
    writeFileSync(join(wt, 'base.ts'), 'base\n');
    execFileSync('git', ['add', 'base.ts'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-qm', 'base'], { cwd: wt });
    writeFileSync(join(wt, 'empty.ts'), '');
    writeFileSync(join(wt, 'empty spaced.ts'), '');
    writeFileSync(join(wt, 'image.bin'), Buffer.from([0, 1, 2, 255, 0]));
    const patch = missionDiff(wt);
    expect(patch).toContain('GIT binary patch');
    writeFileSync(join(target, 'patch.diff'), patch);
    execFileSync('git', ['apply', '--binary', 'patch.diff'], { cwd: target });
    expect(existsSync(join(target, 'empty.ts'))).toBe(true);
    expect(existsSync(join(target, 'empty spaced.ts'))).toBe(true);
    expect(readFileSync(join(target, 'image.bin'))).toEqual(Buffer.from([0, 1, 2, 255, 0]));
  } finally { rmSync(wt, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test('unauthenticated Claude escalates URL-only card, keeps PTY alive, resumes on screen change', async () => {
  const events: string[] = [];
  let screen = 'Sign in: https://claude.ai/login';
  let loggedIn = false;
  const ops = { ...fakeOps(events, '/wt'), claudeLoggedIn: () => loggedIn,
    screen: async () => 'Codex completed without login URL',
    login: async () => ({ screen: async () => screen, alive: () => true, close: () => { events.push('login:closed'); } }),
    sleep: async () => { screen = 'ready'; loggedIn = true; },
  };
  expect(await handoffMission({ action: 'handoff', to: 'claude', mission: 'Review' }, '/wt', ops)).toBe('started');
  expect(events[0]).toBe('card:{"text":"로그인해 주세요","url":"https://claude.ai/login"}');
  expect(events.slice(1)).toEqual(['login:closed', 'start:claude:Review']);
  expect(events.join('\n')).not.toContain('token');
});

test('Claude subscription stays unavailable: escalation does not launch another PTY', async () => {
  const events: string[] = [];
  const ops = { ...fakeOps(events, '/wt'), claudeLoggedIn: () => false,
    login: async () => ({ screen: async () => 'Sign in at https://claude.ai/login', alive: () => events.length === 0, close: () => {} }),
  };
  await expect(handoffMission({ action: 'handoff', to: 'claude', mission: 'Review' }, '/wt', ops)).rejects.toThrow('still unavailable');
  expect(events).toEqual(['card:{"text":"로그인해 주세요","url":"https://claude.ai/login"}']);
});

test('real control loop routes handoff and resumes login without killing the PTY', async () => {
  const events: string[] = [];
  let screen = 'Sign in: https://claude.ai/login';
  let turns = 0;
  const ops = { ...fakeOps(events, '/wt'), screen: async () => screen, sleep: async () => { screen = 'ready'; } };
  const result = await runPtyControlLoop({ decide: () => ++turns === 1
    ? { action: 'ask-human', reason: 'login' }
    : { action: 'handoff', to: 'elanous', mission: 'Gate' },
  }, { observe: () => screen, inject: () => true, isAlive: () => true,
    sleep: async () => {}, handoff: async (decision, obs) => { await handoffMission(decision, '/wt', ops, obs.screen); },
    askHuman: async (decision) => { await waitForHumanLogin(decision, ops); },
  }, { maxSteps: 3 });
  expect(result.handoff?.to).toBe('elanous');
  expect(turns).toBe(2);
  expect(events).toEqual(['card:{"text":"로그인해 주세요","url":"https://claude.ai/login"}', 'gate/PR']);
});

test('runAgentMission uses real control loops across three fake PTYs and gates actual worktree changes', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-integrated-'));
  try {
    execFileSync('git', ['init', '-q', wt]);
    writeFileSync(join(wt, 'existing.ts'), 'old\n');
    execFileSync('git', ['add', 'existing.ts'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-qm', 'base'], { cwd: wt });
    const events: string[] = [];
    const responses: Record<string, string> = {
      codex: JSON.stringify({ action: 'handoff', to: 'claude', mission: 'Review', carry: 'diff', reason: 'Review changes' }),
      claude: JSON.stringify({ action: 'handoff', to: 'codex', mission: 'Fix', carry: 'summary', reason: 'Missing assertion' }),
      repair: JSON.stringify({ action: 'handoff', to: 'elanous', mission: 'Gate', reason: 'Fix verified' }),
    };
    let stage = 'codex';
    let creations = 0;
    const result = await runAgentMission({ mission: 'Build', repo: wt, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /x/ }, memory: false, enhance: false, commit: true,
      screensDir: join(wt, 'screens'),
    }, {
      createWorktree: (() => { creations++; return { path: wt, branch: 'fixture', base: 'HEAD' }; }) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
      startPty: ((opts) => {
        expect(opts.workdir).toBe(wt);
        stage = opts.kind === 'codex' && events.includes('pty:claude') ? 'repair' : opts.kind!;
        events.push(`pty:${stage}`);
        if (stage === 'codex') {
          writeFileSync(join(wt, 'existing.ts'), 'updated\n');
          writeFileSync(join(wt, 'new.ts'), 'export const feature = true;\n');
        }
        if (stage === 'claude') {
          const patch = readFileSync(join(wt, '.mission-handoff.diff'), 'utf8');
          expect(patch).toContain('+updated');
          expect(patch).toContain('+export const feature = true;');
        }
        return { id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '',
          renderScreen: async () => stage === 'claude' ? 'Review finding: Missing assertion' : 'MISSION-COMPLETE',
          renderScreenPng: async () => null, write: (text: string) => { events.push(`input:${stage}:${text}`); },
          kill: () => { events.push(`kill:${stage}`); },
        } as unknown as PtyHandle;
      }),
      controlStream: async () => responses[stage]!,
      handoffOperations: {
        gateAndPr: async (cwd) => {
          expect(cwd).toBe(wt);
          expect(readFileSync(join(wt, 'new.ts'), 'utf8')).toContain('feature');
          events.push('gate/PR');
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(creations).toBe(1);
    expect(events.filter((event) => event.startsWith('pty:') || event === 'gate/PR')).toEqual(['pty:codex', 'pty:claude', 'pty:repair', 'gate/PR']);
    expect(events.some((event) => event.includes('Previous controller summary: Missing assertion'))).toBe(true);
  } finally { rmSync(wt, { recursive: true, force: true }); }
}, 30000);

test('explicit four-stage chain delivers Claude screen review findings after a generic completion reason', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-four-stage-'));
  try {
    execFileSync('git', ['init', '-q', wt]);
    writeFileSync(join(wt, 'existing.ts'), 'old\n');
    execFileSync('git', ['add', 'existing.ts'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-qm', 'base'], { cwd: wt });
    const events: string[] = [];
    let stage = 'codex';
    const result = await runAgentMission({ mission: 'Build', repo: wt, branch: 'fixture', agent: codexBackend,
      chain: ['codex', 'claude', 'codex', 'elanous'], evidence: { kind: 'doc', dirRel: 'docs', glob: /x/ },
      memory: false, enhance: false, commit: true, screensDir: join(wt, 'screens'),
    }, {
      createWorktree: (() => ({ path: wt, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
      startPty: ((opts) => {
        expect(opts.workdir).toBe(wt);
        stage = opts.kind === 'codex' && events.includes('pty:claude') ? 'repair' : opts.kind!;
        events.push(`pty:${stage}`);
        if (stage === 'codex') writeFileSync(join(wt, 'existing.ts'), 'updated\n');
        return { id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '',
          renderScreen: async () => stage === 'claude' ? 'Review finding: Missing assertion in feature test' : 'MISSION-COMPLETE',
          renderScreenPng: async () => null, write: (text: string) => { events.push(`input:${stage}:${text}`); }, kill: () => {},
        } as unknown as PtyHandle;
      }),
      controlStream: async () => '{"action":"done","reason":"Completed"}',
      handoffOperations: { gateAndPr: async () => { events.push('gate/PR'); } },
    });
    expect(result.ok).toBe(true);
    expect(events.filter((event) => event.startsWith('pty:') || event === 'gate/PR')).toEqual(['pty:codex', 'pty:claude', 'pty:repair', 'gate/PR']);
    expect(events.some((event) => event.includes('Previous controller summary: Missing assertion in feature test'))).toBe(true);
    // The repair stage must carry the original mission text, not only «finish the original mission».
    expect(events.some((event) => event.startsWith('input:repair:') && event.includes('Original mission:') && event.includes('Build'))).toBe(true);
  } finally { rmSync(wt, { recursive: true, force: true }); }
}, 30000);

test('explicit chain rejects a brain handoff that skips Claude review', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-skip-review-'));
  try {
    await expect(runAgentMission({ mission: 'Build', repo: wt, branch: 'fixture', agent: codexBackend,
      chain: ['codex', 'claude', 'elanous'], evidence: { kind: 'doc', dirRel: 'docs', glob: /x/ },
      memory: false, enhance: false, commit: true, screensDir: join(wt, 'screens'),
    }, {
      createWorktree: (() => ({ path: wt, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      startPty: ((opts) => ({ id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'MISSION-COMPLETE',
        renderScreenPng: async () => null, write: () => {}, kill: () => {},
      } as unknown as PtyHandle)),
      controlStream: async () => '{"action":"handoff","to":"elanous","mission":"Gate"}',
      handoffOperations: { gateAndPr: async () => { throw new Error('must not gate'); } },
    })).rejects.toThrow('chain order violation: expected claude, got elanous');
  } finally { rmSync(wt, { recursive: true, force: true }); }
}, 30000);

test('runtime handoff launches Claude login PTY, sends its URL instead of Codex screen, then resumes review', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-login-runtime-'));
  const events: string[] = [];
  let loggedIn = false;
  let loginScreen = 'Sign in at https://claude.ai/device';
  try {
    const result = await runAgentMission({ mission: 'Build', repo: wt, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /x/ }, memory: false, enhance: false, commit: true,
      screensDir: join(wt, 'screens'),
    }, {
      createWorktree: (() => ({ path: wt, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: loggedIn, authMethod: loggedIn ? 'claude.ai' : null, apiProvider: loggedIn ? 'firstParty' : null, reason: loggedIn ? 'subscription' : 'logged-out' }),
      startPty: ((opts) => {
        const login = opts.args?.includes('login') ?? false;
        events.push(login ? 'pty:claude-login' : `pty:${opts.kind}`);
        expect(opts.workdir).toBe(wt);
        return { id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '',
          renderScreen: async () => login ? loginScreen : 'MISSION-COMPLETE without login URL',
          renderScreenPng: async () => null, write: () => {}, kill: () => { events.push(login ? 'kill:login' : `kill:${opts.kind}`); },
        } as unknown as PtyHandle;
      }),
      controlStream: async (messages) => messages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('claude(외부'))
        ? '{"action":"handoff","to":"elanous","mission":"Gate","reason":"Review complete"}'
        : '{"action":"handoff","to":"claude","mission":"Review","reason":"Other eyes"}',
      handoffOperations: {
        notify: (card) => { events.push(`card:${JSON.stringify(card)}`); },
        sleep: async () => { expect(events).toContain('pty:claude-login'); loginScreen = 'ready'; loggedIn = true; },
        gateAndPr: async () => { events.push('gate/PR'); },
      },
    });
    expect(result.ok).toBe(true);
    expect(events.filter((e) => e.startsWith('pty:') || e.startsWith('card:') || e === 'gate/PR')).toEqual([
      'pty:codex', 'pty:claude-login', 'card:{"text":"로그인해 주세요","url":"https://claude.ai/device"}', 'pty:claude', 'gate/PR',
    ]);
    expect(events.indexOf('kill:login')).toBeGreaterThan(events.indexOf('card:{"text":"로그인해 주세요","url":"https://claude.ai/device"}'));
  } finally { rmSync(wt, { recursive: true, force: true }); }
}, 30000);

test('login card accepts only URL and device code from the visible screen, never a claimed credential', async () => {
  const events: string[] = [];
  let screen = 'Sign in at https://example.org/device\nDevice code: ABCD-1234';
  const ops = { ...fakeOps(events, '/wt'), screen: async () => screen, sleep: async () => { screen = 'ready'; } };
  await waitForHumanLogin({ action: 'ask-human', reason: 'secret=NOT-FOR-CARD', url: 'https://example.org/device', code: 'ABCD-1234' }, ops);
  expect(events).toEqual(['card:{"text":"로그인해 주세요","url":"https://example.org/device","code":"ABCD-1234"}']);
});

test('screen callback credentials are not forwarded in a login card', () => {
  expect(loginCard({ action: 'ask-human', reason: 'login' },
    'Sign in at https://example.org/callback?access_token=SECRET&code=SECRET\ncode: ABCD-SECRET')).toEqual({ text: '로그인해 주세요' });
  expect(loginCard({ action: 'ask-human', reason: 'login' },
    'Sign in at https://example.org/login?ticket=SENSITIVE')).toEqual({ text: '로그인해 주세요' });
});

test('a login request with no visible login screen fails rather than silently resuming', async () => {
  const events: string[] = [];
  const ops = { ...fakeOps(events, '/wt'), screen: async () => 'Build finished. See https://example.org/logs' };
  await expect(waitForHumanLogin({ action: 'ask-human', reason: 'login' }, ops)).rejects.toThrow('without a visible login screen');
  expect(events).toEqual([]);
});

test('login URL with safe authorization request parameters and fragment survives; credential parameters do not', () => {
  const url = 'https://claude.ai/oauth/authorize?client_id=public&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcallback&state=nonce#login';
  expect(loginCard({ action: 'ask-human', reason: 'login', url }, `Sign in: ${url}`)).toEqual({ text: '로그인해 주세요', url });
  expect(loginCard({ action: 'ask-human', reason: 'login' }, 'Sign in: https://claude.ai/callback?code=SECRET')).toEqual({ text: '로그인해 주세요' });
  expect(loginCard({ action: 'ask-human', reason: 'login' }, 'Sign in: https://claude.ai/login?continue=%2Fdevice&flow=1')).toEqual({ text: '로그인해 주세요', url: 'https://claude.ai/login?continue=%2Fdevice&flow=1' });
});

test('unverified URL or code from the brain is rejected without notifying a human', async () => {
  const events: string[] = [];
  const ops = { ...fakeOps(events, '/wt'), screen: async () => 'Sign in: https://claude.ai/login' };
  await expect(waitForHumanLogin({ action: 'ask-human', reason: 'login', url: 'https://injected.invalid' }, ops)).rejects.toThrow('not verified');
  expect(events).toEqual([]);
});

test('login PTY exits before screen change: no backend launch', async () => {
  const events: string[] = [];
  const ops = { ...fakeOps(events, '/wt'), screen: async () => 'Sign in: https://example.org/login', alive: () => false };
  await expect(waitForHumanLogin({ action: 'ask-human', reason: 'login required' }, ops)).rejects.toThrow('exited');
  expect(events).toEqual(['card:{"text":"로그인해 주세요","url":"https://example.org/login"}']);
});

test('diff carry never writes through a symlink planted at the carry path', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-carry-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'mission-carry-outside-'));
  try {
    const target = join(outside, 'victim.txt');
    writeFileSync(target, 'untouched\n');
    symlinkSync(target, join(wt, '.mission-handoff.diff'));
    const events: string[] = [];
    await handoffMission({ action: 'handoff', to: 'claude', mission: 'Review', carry: 'diff' }, wt, fakeOps(events, wt));
    expect(readFileSync(target, 'utf8')).toBe('untouched\n');
    expect(lstatSync(join(wt, '.mission-handoff.diff')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(wt, '.mission-handoff.diff'), 'utf8')).toContain('+new');
  } finally { rmSync(wt, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('diff carry handles a tracked change larger than the default 1 MiB exec buffer', () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-big-diff-'));
  try {
    execFileSync('git', ['init', '-q', wt]);
    writeFileSync(join(wt, 'big.txt'), 'seed\n');
    execFileSync('git', ['add', 'big.txt'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-qm', 'base'], { cwd: wt });
    writeFileSync(join(wt, 'big.txt'), Array.from({ length: 60_000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n'));
    const patch = missionDiff(wt);
    expect(patch.length).toBeGreaterThan(1024 * 1024);
    expect(patch).toContain('+line 59999');
  } finally { rmSync(wt, { recursive: true, force: true }); }
});

test('a gate/PR handoff does not turn a control loop that ended in error into success', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-gated-error-'));
  try {
    execFileSync('git', ['init', '-q', wt]);
    writeFileSync(join(wt, 'existing.ts'), 'old\n');
    execFileSync('git', ['add', 'existing.ts'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-qm', 'base'], { cwd: wt });
    const events: string[] = [];
    const run = runAgentMission({ mission: 'Build', repo: wt, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /x/ }, memory: false, enhance: false, commit: true, screensDir: join(wt, 'screens'),
    }, {
      createWorktree: (() => ({ path: wt, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      startPty: ((opts) => ({ id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
        renderScreenPng: async () => null, write: () => {}, kill: () => {} } as unknown as PtyHandle)),
      handoffOperations: { gateAndPr: async () => { events.push('gate/PR'); } },
      runControlLoop: (async (_brain: unknown, deps: { handoff?: (d: unknown, o: unknown) => Promise<void> }) => {
        await deps.handoff?.({ action: 'handoff', to: 'elanous', mission: 'Gate and open PR' }, { screen: '' });
        return { steps: 2, termination: { kind: 'error', message: 'controller crashed after gate' } };
      }) as never,
    }).then((r) => r, (e: unknown) => ({ ok: false, detail: String(e) }));
    const result = await run as { ok: boolean };
    expect(events).toContain('gate/PR');
    expect(result.ok).toBe(false);
  } finally { rmSync(wt, { recursive: true, force: true }); }
}, 30000);

test('a codex «Trust this folder?» prompt that appears after launch is answered in the loop, not typed over', async () => {
  const wt = mkdtempSync(join(tmpdir(), 'mission-late-trust-'));
  try {
    execFileSync('git', ['init', '-q', wt]);
    writeFileSync(join(wt, 'existing.ts'), 'old\n');
    execFileSync('git', ['add', 'existing.ts'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', 'commit', '-qm', 'base'], { cwd: wt });
    const writes: string[] = [];
    const decisions: unknown[] = [];
    const trustScreen = 'Folder access\nTrust this folder? Codex can read, edit, and run files here.\n› 1. Trust and continue\n2. Quit\nenter continue · esc quit';
    await runAgentMission({ mission: 'Build', repo: wt, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /x/ }, memory: false, enhance: false, commit: false, screensDir: join(wt, 'screens'),
    }, {
      createWorktree: (() => ({ path: wt, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      startPty: ((opts) => ({ id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
        renderScreenPng: async () => null, write: (text: string) => { writes.push(text); }, kill: () => {} } as unknown as PtyHandle)),
      controlStream: async () => '{"action":"wait","reason":"llm fallback"}',
      runControlLoop: (async (brain: { decide: (o: unknown) => Promise<unknown> | unknown }) => {
        decisions.push(await brain.decide({ step: 1, screen: trustScreen }));
        return { steps: 1, termination: { kind: 'stuck', message: 'fixture' } };
      }) as never,
    }).catch(() => undefined);
    expect(decisions[0]).toEqual({ action: 'input', text: '1\r' });
  } finally { rmSync(wt, { recursive: true, force: true }); }
}, 30000);
