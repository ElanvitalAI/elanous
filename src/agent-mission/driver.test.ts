import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asideBackend, claudeTrustChoice, submitSeparately, geminiBackend, buildMissionWorktreeProvenance, buildScreenLogPayload, checkEvidence, claudeBackend, codexBackend, collectTscDiagnostics, createMissionControlBrain, createMissionSearch, createMissionVerifyDone, grokBackend, recordMissionWorktreeProvenance, runAgentMission, runTsc, SCREEN_LOG_TAIL_MAX_LINE_LENGTH, SCREEN_LOG_TAIL_MAX_LINES, type EvidenceMode } from './driver.js';
import { emitPtyEvent } from '../pty-shell/registry.js';
import type { PtyHandle } from '../pty-shell/registry.js';
import { createWorktree, gateWorktreeReuse } from '../git-fs/worktree.js';
import { recordHarnessWorktreeProvenance } from '../harness/harness-worktree-add.js';
import { debug } from '../debug/log.js';
import { classifierFrameLines } from '../capture/frame-state-detect.js';
import type { StreamLLMFn } from '../autopilot/llm-control-brain.js';
import type { LLMMessage } from '../llm.js';
import type { TypecheckError } from '../typecheck-ratchet.js';
import { decideInterventionStep } from '../self-implement/intervention-step.js';
import type { PtyControlDeps, RunSupervisor } from '../autopilot/pty-control-loop.js';
import type { AgentMissionSpec, AgentMissionDeps } from './driver.js';
import { planMissionResources, type ResourcePlan } from './resource-ladder.js';
import { listCoordEvents } from '../context-bus/coord-events.js';
import { openSurfaceEventsDb } from '../domains/surface-events.js';
import { generateIndexKeyPair, signIndex, type MarketplaceIndex } from '../market/signed-index.js';
import { OFFICIAL_INDEX_KEYS } from '../market/official-keys.js';

const observation = {
  screen: 'agent screen',
  state: 'idle' as const,
  step: 0,
  intervention: decideInterventionStep({
    screen: 'agent screen',
    previous: null,
    stopAfterSameScreens: 2,
    descriptor: { level: 'L3', controlStance: 'owned', draft: 'continue' },
  }),
  changed: false,
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} — ${result.stderr}`);
  return result.stdout.trim();
}

function scriptedStream(raw: string): StreamLLMFn {
  return async () => raw;
}

describe('pre-mission resource ladder on PTY dispatch', () => {
  const plan: ResourcePlan = {
    needs: ['basics', 'unavailable'], have: ['ready-tool'],
    plugin: { plugin: 'elanous-basics', marketplace: 'elanous', source: 'official-index' },
    backend: { name: 'claude', why: 'ready' },
    gaps: [{ need: 'unavailable', candidates: [] }], decisions: [],
  };
  const launch = async (over: Partial<AgentMissionSpec> = {}, extra: Partial<AgentMissionDeps> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-resources-'));
    const events: string[] = [];
    const writes: string[] = [];
    const calls: Array<{ mission: string; options: unknown }> = [];
    const installs: string[] = [];
    try {
      const result = await runAgentMission({ mission: 'List skills', repo: dir, branch: 'fixture', agent: codexBackend,
        evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture/ }, memory: false, enhance: false, commit: false,
        // The ladder runs only on an explicit `on` (what the CLI passes by default).
        screensDir: join(dir, 'screens'), resources: 'on', ...over,
      }, {
        createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
        recordWorktreeProvenance: () => {},
        startPty: ((opts) => ({ id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
          renderScreenPng: async () => null, write: (s: string) => { writes.push(s); events.push(`write:${s}`); }, kill: () => {},
        } as unknown as PtyHandle)),
        planMissionResources: async (mission, _deps, options) => { calls.push({ mission, options }); events.push('plan'); return plan; },
        installPlugin: async (request) => { installs.push(`${request.plugin}@${request.marketplace}`); events.push('install'); return { outcome: 'installed' }; },
        runControlLoop: async () => ({ termination: { kind: 'success' }, steps: 1 }) as never,
        checkEvidence: () => ({ ok: true, path: dir }),
        ...extra,
      });
      return { result, events, writes, calls, installs, prompt: existsSync(join(dir, '.mission-prompt.md')) ? readFileSync(join(dir, '.mission-prompt.md'), 'utf8') : null };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  test('codex PTY start and finish are in coord events without the mission prompt', async () => {
    const since = new Date().toISOString();
    const { result } = await launch({ mission: 'PRIVATE MISSION PROMPT', resources: 'off' });
    expect(result.ok).toBe(true);
    const db = openSurfaceEventsDb();
    try {
      const rows = listCoordEvents({ since, seat: 'codex-agent-mission' }, { db });
      expect(rows.map((row) => row.kind)).toEqual(['started', 'finished']);
      expect(JSON.stringify(rows)).not.toContain('PRIVATE MISSION PROMPT');
      expect(rows[0]?.refs.source).toStartWith('elanous://agent-mission/');
    } finally { db.close(); }
  });

  test('official suggestion installs before mission and appends only resource names; backend stays selected', async () => {
    const { result, events, calls, installs, prompt } = await launch({ backendExplicit: 'codex' });
    expect(result.detail).toBe('완료(증거)');
    expect(calls).toEqual([{ mission: 'List skills', options: { backend: 'codex', plugin: undefined, resources: 'on', deadlineMs: 20_000 } }]);
    expect(installs).toEqual(['elanous-basics@elanous']);
    expect(events.slice(0, 2)).toEqual(['plan', 'install']);
    expect(events[2]).toContain('.mission-prompt.md');
    expect(prompt).toContain('List skills\n\n설치된 elanous-basics');
    expect(prompt).toContain('[elanous 자원]\n보유: ready-tool\n설치: elanous-basics@elanous\n미충족: unavailable');
    expect(prompt).not.toContain('claude');
  });

  test('signed name mention reaches the driver installer before mission dispatch without an explicit plugin', async () => {
    const key = generateIndexKeyPair();
    const official: MarketplaceIndex = { name: 'elanous', interface: { displayName: 'Official' }, sequence: 1, plugins: [{
      name: 'elanous-basics', version: '1.0.0', description: 'basic skills', source: { source: 'url' },
      artifact: { sha256: '0'.repeat(64), bytes: 0, key: 'basics.tgz' },
      'ai.elanous': { capabilities: ['omni-crawl'], connectors: [], pricing: { model: 'free' } },
    }] };
    const bytes = Buffer.from(JSON.stringify(official));
    const keys = OFFICIAL_INDEX_KEYS as { keyId: string; publicKey: string }[];
    const observed: Array<{ step: string; data: Record<string, unknown> }> = [];
    const originalLog = debug.log;
    debug.log = ((category: string, step: string, data: Record<string, unknown>) => {
      if (category === 'agent-mission.resources') observed.push({ step, data });
    }) as typeof debug.log;
    keys.push({ keyId: key.keyId, publicKey: key.publicKey });
    try {
      const result = await launch({ mission: 'List the skills the elanous-basics plugin provides', backendExplicit: 'codex' }, {
        planMissionResources,
        resourceLadder: {
          readOfficialIndex: async () => ({ marketplaceBytes: bytes, signatureText: signIndex(bytes, key.privateKeyPem, key.keyId) }),
          inferNeeds: async () => '{"needs":["unlisted skill"]}',
          readers: { codex: () => [], claude: () => [], grok: () => [] },
          readInstalledPlugins: () => [], discover: async () => [], decide: () => {},
        },
      });
      expect(result.result.detail).toBe('완료(증거)');
      expect(result.calls).toEqual([]);
      expect(result.installs).toEqual(['elanous-basics@elanous']);
      expect(result.events[0]).toBe('install');
      expect(result.prompt).toContain('설치된 elanous-basics');
      expect(observed.some(event => event.step === 'official-index' && event.data.kind === 'ROUTE' && event.data.what === '공식 플러그인 선택')).toBe(true);
      expect(observed.some(event => event.step === 'planned' && event.data.suggestedPlugin === 'elanous-basics')).toBe(true);
      expect(observed.some(event => event.step === 'plan-failed')).toBe(false);
    } finally { keys.pop(); debug.log = originalLog; }
  });

  test('an unset resources mode (library callers) skips the ladder like off', async () => {
    const { calls } = await launch({ resources: undefined });
    expect(calls).toHaveLength(0);
  });

  test('resources off skips planning and leaves the typed mission unchanged', async () => {
    const { result, calls, installs, writes } = await launch({ resources: 'off' });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(installs).toHaveLength(0);
    expect(writes).toEqual(['List skills', '\r']);
  });

  test('explicit plugin wins over suggestion and retains the original installation behavior', async () => {
    const { calls, installs, prompt } = await launch({ plugin: { plugin: 'manual', marketplace: 'other' } });
    expect(calls[0]?.options).toEqual({ backend: undefined, plugin: 'manual@other', resources: 'on', deadlineMs: 20_000 });
    expect(installs).toEqual(['manual@other']);
    expect(prompt).toContain('설치: manual@other');
    expect(prompt).not.toContain('설치된 elanous-basics');
  });

  test('a never-settling ladder times out at 20 seconds and still sends the original mission', async () => {
    const original = debug.log;
    const logs: unknown[][] = [];
    debug.log = ((...args: unknown[]) => { logs.push(args); }) as typeof debug.log;
    try {
      const { result, writes } = await launch({}, { planMissionResources: async () => new Promise<ResourcePlan>(() => {}) });
      expect(result.ok).toBe(true);
      expect(writes).toEqual(['List skills', '\r']);
      expect(logs).toContainEqual(['agent-mission.resources', 'plan-failed', { reason: 'resource ladder timeout (20s)' }, { level: 'warn' }]);
    } finally { debug.log = original; }
  }, 30_000);

  test('suggested installer exception does not prevent mission dispatch', async () => {
    const original = debug.log;
    const logs: unknown[][] = [];
    debug.log = ((...args: unknown[]) => { logs.push(args); }) as typeof debug.log;
    try {
      const { result, prompt } = await launch({}, { installPlugin: async () => { throw new Error('network failed'); } });
      expect(result.ok).toBe(true);
      expect(prompt).toContain('설치: 없음');
      expect(logs).toContainEqual(['agent-mission.resources', 'install-failed', { plugin: 'elanous-basics', reason: 'installer-error' }, { level: 'warn' }]);
    } finally { debug.log = original; }
  });

  test('explicit plugin installation failure still blocks dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-explicit-plugin-'));
    const writes: string[] = [];
    let killed = false;
    try {
      const result = await runAgentMission({ mission: 'List skills', repo: dir, branch: 'fixture', agent: codexBackend,
        evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture/ }, memory: false, resources: 'off', commit: false,
        plugin: { plugin: 'manual', marketplace: 'other' }, screensDir: join(dir, 'screens'),
      }, {
        createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
        recordWorktreeProvenance: () => {},
        startPty: ((opts) => ({ id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
          renderScreenPng: async () => null, write: (s: string) => writes.push(s), kill: () => { killed = true; },
        } as unknown as PtyHandle)),
        installPlugin: async () => ({ outcome: 'escalate', reason: 'plugins-disabled' }),
      });
      expect(result).toMatchObject({ ok: false, detail: '플러그인 설치 ESCALATE (plugins-disabled) — 미션은 전송하지 않았다' });
      expect(writes).toEqual([]);
      expect(killed).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('resource names never carry secrets or terminal control bytes into the prompt', async () => {
    const { prompt } = await launch({}, { planMissionResources: async () => ({
      ...plan, have: ['token=sk-abcdef', 'ready\u001b[31m'], gaps: [{ need: 'password=very-secret', candidates: [] }, { need: 'https://example.invalid/key', candidates: [] }],
    }) });
    expect(prompt).not.toContain('sk-abcdef');
    expect(prompt).not.toContain('very-secret');
    expect(prompt).not.toContain('example.invalid');
    expect(prompt).not.toContain('\u001b');
  });

  test('ladder rejection warns then sends the original mission', async () => {
    const original = debug.log;
    const logs: unknown[][] = [];
    debug.log = ((...args: unknown[]) => { logs.push(args); }) as typeof debug.log;
    try {
      const { result, writes, installs } = await launch({}, { planMissionResources: async () => { throw new Error('offline'); } });
      expect(result.ok).toBe(true);
      expect(writes).toEqual(['List skills', '\r']);
      expect(installs).toHaveLength(0);
      expect(logs).toContainEqual(['agent-mission.resources', 'plan-failed', { reason: 'offline' }, { level: 'warn' }]);
    } finally { debug.log = original; }
  });

  test('failed suggested installation warns and sends the mission without claiming installation', async () => {
    const original = debug.log;
    const logs: unknown[][] = [];
    debug.log = ((...args: unknown[]) => { logs.push(args); }) as typeof debug.log;
    try {
      const { result, prompt } = await launch({}, { installPlugin: async () => ({ outcome: 'escalate', reason: 'plugins-disabled' }) });
      expect(result.ok).toBe(true);
      expect(prompt).toContain('설치: 없음');
      expect(prompt).not.toContain('설치된 elanous-basics');
      expect(logs).toContainEqual(['agent-mission.resources', 'install-failed', { plugin: 'elanous-basics', reason: 'plugins-disabled' }, { level: 'warn' }]);
    } finally { debug.log = original; }
  });

  test('only the official marketplace is eligible even if an injected plan claims official provenance', async () => {
    const { installs, prompt } = await launch({}, { planMissionResources: async () => ({ ...plan, plugin: { ...plan.plugin!, marketplace: 'other' } }) });
    expect(installs).toHaveLength(0);
    expect(prompt).toContain('설치: 없음');
  });

  test('unverified plugin suggestion is not installed', async () => {
    const { installs, prompt } = await launch({}, { planMissionResources: async () => ({ ...plan, plugin: { ...plan.plugin!, source: 'community' as 'official-index' } }) });
    expect(installs).toHaveLength(0);
    expect(prompt).toContain('설치: 없음');
  });
});

test('runAgentMission re-emits exactly once on its Codex child exit with the spawned CODEX_HOME and runId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-pty-usage-'));
  const home = join(dir, 'codex-home');
  mkdirSync(home);
  const oldHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const calls: Array<{ codexHome: string; runId: string; workdir: string; sinceMs?: number }> = [];
  try {
    let spawnedId = '';
    let spawnedRunId = '';
    const result = await runAgentMission({ mission: 'done', repo: dir, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture/ }, memory: false, resources: 'off', commit: false,
      screensDir: join(dir, 'screens'),
    }, {
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      startPty: ((opts) => {
        const id = opts.id!;
        spawnedId = id;
        spawnedRunId = opts.env?.ELANOUS_RUN_ID ?? '';
        expect(opts.env?.CODEX_HOME).toBe(home);
        return { id, kind: 'codex', nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
          renderScreenPng: async () => null, write: () => {}, kill: () => {},
        } as unknown as PtyHandle;
      }),
      runControlLoop: async () => {
        emitPtyEvent({ type: 'exit', id: 'unrelated-child', exitCode: 0 });
        expect(calls).toHaveLength(0);
        emitPtyEvent({ type: 'output', id: spawnedId, chunk: 'Session ID: 12345678-1234-1234-1234-123456789abc' });
        emitPtyEvent({ type: 'exit', id: spawnedId, exitCode: 0 });
        emitPtyEvent({ type: 'exit', id: spawnedId, exitCode: 0 });
        return { termination: { kind: 'success' }, steps: 1 } as never;
      },
      reemitPtyUsage: (opts) => { calls.push(opts); return 0; },
    });
    expect(result.ok).toBe(false);
    expect(spawnedRunId).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ codexHome: home, runId: spawnedRunId, workdir: dir, sessionId: '12345678-1234-1234-1234-123456789abc' });
    expect(typeof calls[0]?.sinceMs).toBe('number');
    emitPtyEvent({ type: 'exit', id: spawnedId, exitCode: 0 });
    expect(calls).toHaveLength(1);
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgentMission hands a brain-selected review to the existing launcher in the same worktree and routes the gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-driver-handoff-'));
  const events: string[] = [];
  let launches = 0;
  let created = 0;
  try {
    const result = await runAgentMission({ mission: 'Build feature', repo: dir, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture/ }, memory: false, resources: 'off', commit: false,
      screensDir: join(dir, 'screens'),
    }, {
      createWorktree: (() => { created++; return { path: dir, branch: 'fixture', base: 'HEAD' }; }) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
      startPty: ((opts) => {
        launches++;
        expect(opts.workdir).toBe(dir);
        events.push(`pty:${opts.kind}`);
        return { id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'Review finding: missing test',
          renderScreenPng: async () => null, write: () => {}, kill: () => {},
        } as unknown as PtyHandle;
      }),
      handoffOperations: {
        diff: () => 'diff --git a/file b/file\n+new',
        gateAndPr: async (worktree) => { expect(worktree).toBe(dir); events.push('gate/PR'); },
      },
      runControlLoop: (async (_brain: RunSupervisor, controlDeps: PtyControlDeps) => {
        if (launches === 1) {
          await controlDeps.handoff!({ action: 'handoff', to: 'claude', mission: 'Review', carry: 'diff' }, observation);
          return { termination: { kind: 'success' }, steps: 1, handoff: { action: 'handoff', to: 'claude', mission: 'Review', carry: 'diff' } } as never;
        }
        expect(readFileSync(join(dir, '.mission-handoff.diff'), 'utf8')).toContain('+new');
        await controlDeps.handoff!({ action: 'handoff', to: 'elanous', mission: 'Gate' }, observation);
        return { termination: { kind: 'success' }, steps: 1, handoff: { action: 'handoff', to: 'elanous', mission: 'Gate' } } as never;
      }) as never,
    });
    expect(result.ok).toBe(true);
    expect(created).toBe(1);
    expect(events).toEqual(['pty:codex', 'pty:claude', 'gate/PR']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe('agent-mission handoff commit and PR', () => {
  const run = async (origin: 'local' | 'github-pushurl-local' | 'github' | 'github-ssh' | 'github-scp', commit = true, prFails = false, stagePrompt = false) => {
    const root = mkdtempSync(join(tmpdir(), 'mission-pr-handoff-'));
    const repo = join(root, 'repo');
    const bare = join(root, 'origin.git');
    const events: string[] = [];
    const contextEvents: import('../context-bus/session-events.js').SessionEventInput[] = [];
    const logs: unknown[][] = [];
    const originalLog = debug.log;
    let prCalls = 0;
    debug.log = ((...args: unknown[]) => { logs.push(args); }) as typeof debug.log;
    try {
      git(root, 'init', '-q', '--bare', bare);
      git(root, 'init', '-q', '-b', 'main', repo);
      git(repo, 'config', 'user.email', 'mission@example.test');
      git(repo, 'config', 'user.name', 'Mission Test');
      writeFileSync(join(repo, 'seed.txt'), 'seed');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'seed');
      git(repo, 'checkout', '-qb', 'fixture');
      const originUrl = origin === 'local' ? bare : origin === 'github-ssh' ? 'ssh://git@github.com/x/y.git'
        : origin === 'github-scp' ? 'git@github.com:x/y.git' : 'https://github.com/x/y.git';
      git(repo, 'remote', 'add', 'origin', originUrl);
      if (origin === 'github-pushurl-local') {
        git(repo, 'config', 'remote.origin.pushurl', bare);
        expect(git(repo, 'remote', 'get-url', 'origin')).toBe('https://github.com/x/y.git');
        expect(git(repo, 'remote', 'get-url', '--push', 'origin')).toBe(bare);
      } else if (origin !== 'local') {
        // Preserve the GitHub destination URL; a local SSH transport stands in for the unreachable server.
        // The PR runner only succeeds once that endpoint has received the branch.
        const ssh = join(root, 'ssh-fixture.sh');
        writeFileSync(ssh, `#!/bin/sh\ncase "$*" in *github.com*x/y.git*) ;; *) exit 80 ;; esac\nexec git-receive-pack '${bare}'\n`);
        chmodSync(ssh, 0o755);
        git(repo, 'config', 'core.sshCommand', ssh);
        if (origin === 'github') git(repo, 'config', 'url.ssh://git@github.com/.insteadOf', 'https://github.com/');
        expect(git(repo, 'remote', 'get-url', '--push', 'origin')).toContain('github.com');
      }
      const result = runAgentMission({ mission: 'Build feature', repo, branch: 'fixture', agent: codexBackend,
        evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture/ }, memory: false, resources: 'on', commit,
        screensDir: join(repo, 'screens'),
      }, {
        createWorktree: (() => ({ path: repo, branch: 'fixture', base: 'main' })) as never,
        recordWorktreeProvenance: () => {},
        emitContextEvent: input => { contextEvents.push(input); },
        planMissionResources: async () => ({ needs: [], have: ['available'], backend: { name: 'codex', why: 'selected' }, gaps: [], decisions: [] } satisfies ResourcePlan),
        startPty: ((opts) => ({ id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'done',
          renderScreenPng: async () => null, write: () => {}, kill: () => {},
        } as unknown as PtyHandle)),
        checkEvidence: () => { events.push('evidence'); return { ok: true, path: repo }; },
        commitWorktree: (cwd, message) => {
          events.push('commit');
          expect(existsSync(join(cwd, '.mission-prompt.md'))).toBe(false);
          git(cwd, 'add', '-A');
          git(cwd, 'commit', '-qm', message);
          return { ok: true, out: 'committed' };
        },
        dispatchOpenPullRequest: () => {
          expect(git(bare, 'rev-parse', 'refs/heads/fixture')).toBe(git(repo, 'rev-parse', 'HEAD'));
          prCalls++;
          events.push('pr');
          if (prFails) throw new Error('PR runner failed');
          return { output: 'opened', url: 'https://github.com/x/y/pull/1', number: 1 };
        },
        runControlLoop: (async (_brain: RunSupervisor, controlDeps: PtyControlDeps) => {
          expect(readFileSync(join(repo, '.mission-prompt.md'), 'utf8')).toContain('Build feature');
          if (stagePrompt) git(repo, 'add', '--', '.mission-prompt.md');
          writeFileSync(join(repo, 'output.txt'), 'feature');
          try {
            await controlDeps.handoff!({ action: 'handoff', to: 'elanous', mission: 'Gate' }, observation);
          } catch (error) {
            return { termination: { kind: 'error', message: String(error) }, steps: 1 } as never;
          }
          return { termination: { kind: 'success' }, steps: 1 } as never;
        }) as never,
      });
      if (!commit || prFails) {
        await expect(result).rejects.toThrow(!commit ? 'requires commit authorization' : 'PR runner failed');
        expect(prCalls).toBe(prFails ? 1 : 0);
        if (prFails) {
          expect(git(bare, 'rev-parse', 'refs/heads/fixture')).toBe(git(repo, 'rev-parse', 'HEAD'));
          expect(events.indexOf('evidence')).toBeLessThan(events.indexOf('commit'));
          expect(events.indexOf('commit')).toBeLessThan(events.indexOf('pr'));
          expect(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('.mission-prompt.md');
        } else {
          expect(events).not.toContain('evidence');
        }
        return;
      }
      const settled = await result;
      expect(contextEvents.map(event => event.kind)).toEqual(['task-claimed', 'task-done']);
      expect(contextEvents[0]?.ref).toMatch(/^runId=run-/);
      expect(contextEvents[1]?.ref).toBe(origin === 'local' || origin === 'github-pushurl-local'
        ? contextEvents[0]?.ref : `${contextEvents[0]?.ref} PR=#1`);
      expect(settled.ok).toBe(true);
      expect(settled.committed).toBe(true);
      expect(git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('.mission-prompt.md');
      expect(git(bare, 'rev-parse', 'refs/heads/fixture')).toBe(git(repo, 'rev-parse', 'HEAD'));
      expect(events.indexOf('evidence')).toBeLessThan(events.indexOf('commit'));
      expect(events.indexOf('commit')).toBeLessThan(origin === 'local' || origin === 'github-pushurl-local' ? events.length : events.indexOf('pr'));
      expect(logs).toContainEqual(['agent-mission', 'handoff-prompt-file-removed', { existed: true }]);
      if (origin === 'local' || origin === 'github-pushurl-local') {
        expect(prCalls).toBe(0);
        expect(settled).toMatchObject({ pr: 'skipped', reason: 'origin-not-github' });
        expect(logs).toContainEqual(['agent-mission', 'handoff-pr-skipped', { reason: 'origin-not-github' }]);
      } else {
        expect(prCalls).toBe(1);
        expect(settled.pr).toBeUndefined();
      }
    } finally {
      debug.log = originalLog;
      rmSync(root, { recursive: true, force: true });
    }
  };

  test('local bare origin pushes a prompt-free commit and skips PR', async () => run('local'));
  test('GitHub fetch URL with local pushurl skips PR after pushing to the local bare origin', async () => run('github-pushurl-local'));
  test('GitHub HTTPS origin still calls the PR runner after its branch reaches the GitHub destination', async () => run('github'));
  test('GitHub SSH origin still calls the PR runner after its branch reaches the GitHub destination', async () => run('github-ssh'));
  test('GitHub scp-style origin still calls the PR runner after its branch reaches the GitHub destination', async () => run('github-scp'));
  test('staged internal prompt is removed from the handoff commit', async () => run('local', true, false, true));
  test('GitHub HTTPS PR failure remains a failure after push', async () => run('github', true, true));
  test('commit authorization is still required before handoff', async () => run('local', false));
});

test('Claude handoff login escalation failure cannot fall through to a successful single-backend result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-login-fail-'));
  let killed = false;
  try {
    await expect(runAgentMission({ mission: 'Build', repo: dir, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture/ }, memory: false, resources: 'off', commit: false,
      screensDir: join(dir, 'screens'),
    }, {
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      startPty: ((opts) => ({ id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => opts.args?.includes('login') ? 'Sign in at https://claude.ai/login' : 'Codex done',
        renderScreenPng: async () => null, write: () => {}, kill: () => { killed = true; },
      } as unknown as PtyHandle)),
      checkClaudeSubscription: () => ({ ok: false, authMethod: null, apiProvider: null, reason: 'logged-out' }),
      handoffOperations: { notify: () => { throw new Error('login card delivery failed'); } },
      runControlLoop: (async (_brain: RunSupervisor, controlDeps: PtyControlDeps) => {
        try {
          await controlDeps.handoff!({ action: 'handoff', to: 'claude', mission: 'Review' }, observation);
        } catch (error) {
          return { termination: { kind: 'error', message: String(error) }, steps: 1 } as never;
        }
        throw new Error('handoff must reject');
      }) as never,
    })).rejects.toThrow('login card delivery failed');
    expect(killed).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('brain gate failure is surfaced instead of falling through to a success result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-gate-fail-'));
  let killed = false;
  try {
    await expect(runAgentMission({ mission: 'Build', repo: dir, branch: 'fixture', agent: codexBackend,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture/ }, memory: false, resources: 'off', commit: true,
      screensDir: join(dir, 'screens'),
    }, {
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      startPty: ((opts) => ({ id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
        isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'done',
        renderScreenPng: async () => null, write: () => {}, kill: () => { killed = true; },
      } as unknown as PtyHandle)),
      handoffOperations: { gateAndPr: async () => { throw new Error('handoff evidence gate failed: missing test'); } },
      runControlLoop: (async (_brain: RunSupervisor, controlDeps: PtyControlDeps) => {
        try {
          await controlDeps.handoff!({ action: 'handoff', to: 'elanous', mission: 'Gate' }, observation);
        } catch (error) {
          return { termination: { kind: 'error', message: String(error) }, steps: 1 } as never;
        }
        throw new Error('gate must reject');
      }) as never,
    })).rejects.toThrow('handoff evidence gate failed: missing test');
    expect(killed).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit chain uses the same handoff coordinator and launch path: codex → claude → elanous', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mission-driver-chain-'));
  const events: string[] = [];
  let created = 0;
  try {
    const result = await runAgentMission({ mission: 'Build feature', repo: dir, branch: 'fixture', agent: codexBackend,
      chain: ['codex', 'claude', 'elanous'], evidence: { kind: 'doc', dirRel: 'docs', glob: /fixture/ },
      memory: false, resources: 'off', commit: true, screensDir: join(dir, 'screens'),
    }, {
      createWorktree: (() => { created++; return { path: dir, branch: 'fixture', base: 'HEAD' }; }) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
      startPty: ((opts) => {
        expect(opts.workdir).toBe(dir);
        events.push(`pty:${opts.kind}`);
        return { id: opts.id!, kind: opts.kind!, nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'Review finding: missing test',
          renderScreenPng: async () => null, write: () => {}, kill: () => {},
        } as unknown as PtyHandle;
      }),
      handoffOperations: {
        diff: () => 'diff --git a/file b/file\n+new',
        gateAndPr: async (worktree) => { expect(worktree).toBe(dir); events.push('gate/PR'); },
      },
      runControlLoop: (async (_brain: RunSupervisor, controlDeps: PtyControlDeps) => {
        if (events.at(-1) === 'pty:claude') {
          expect(readFileSync(join(dir, '.mission-handoff.diff'), 'utf8')).toContain('+new');
        }
        return { termination: { kind: 'success', reason: 'done' }, steps: 1 } as never;
      }) as never,
    });
    expect(result.ok).toBe(true);
    expect(created).toBe(1);
    expect(events).toEqual(['pty:codex', 'pty:claude', 'gate/PR']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe('agent-mission worktree provenance', () => {
  test('records literal agent owner and command in worktree scope, then opens the strict reuse gate', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'agent-mission-provenance-'));
    try {
      const repo = join(tmp, 'repo');
      const root = join(tmp, 'worktrees');
      git(tmp, 'init', '-q', '-b', 'main', repo);
      git(repo, 'config', 'user.email', 't@t.t');
      git(repo, 'config', 'user.name', 't');
      writeFileSync(join(repo, 'f.txt'), 'x');
      git(repo, 'add', '.');
      git(repo, 'commit', '-qm', 'init');
      const branch = 'agent/provenance-reuse';
      const created = createWorktree({ repoRoot: repo, worktreeRoot: root, branch, base: 'HEAD', skipRemoteBaseSync: true });
      const provenance = buildMissionWorktreeProvenance(branch, '2026-08-12T00:00:00.000Z');

      recordHarnessWorktreeProvenance(created.path, provenance);

      expect(git(created.path, 'config', '--worktree', '--get', 'elanous.harness.owner')).toBe('agent:agent/provenance-reuse');
      expect(git(created.path, 'config', '--worktree', '--get', 'elanous.harness.command')).toBe('elanous agent-mission');
      expect(git(created.path, 'config', '--worktree', '--get', 'elanous.harness.createdAt')).toBe('2026-08-12T00:00:00.000Z');
      expect(gateWorktreeReuse(created.path, true, {
        branch,
        commonGitDir: join(repo, git(repo, 'rev-parse', '--git-common-dir')),
      }).reuse).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('provenance recording failure is observed and rethrown instead of looking like unrecorded ownership', () => {
    const observed: unknown[][] = [];
    const original = debug.log;
    debug.log = ((...args: unknown[]) => observed.push(args)) as typeof debug.log;
    try {
      const provenance = buildMissionWorktreeProvenance('agent/failure', '2026-08-12T00:00:00.000Z');
      expect(() => recordMissionWorktreeProvenance('/wt', provenance, () => { throw new Error('write denied'); }))
        .toThrow('agent-mission worktree provenance failed — write denied');
      expect(observed).toContainEqual(['agent-mission', 'provenance-failed', {
        path: '/wt', owner: 'agent:agent/failure', command: 'elanous agent-mission', createdAt: '2026-08-12T00:00:00.000Z', reason: 'write denied',
      }, { level: 'warn' }]);
    } finally {
      debug.log = original;
    }
  });
});

describe('buildScreenLogPayload', () => {
  test('bottom line count is bounded at the classifier-compatible ten-line constant while retaining the final lines', () => {
    const screen = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join('\n');
    const payload = buildScreenLogPayload('capture', screen);

    expect(SCREEN_LOG_TAIL_MAX_LINES).toBe(10);
    expect(payload.tail).toEqual(Array.from({ length: 10 }, (_, index) => `line-${index + 3}`));
    expect(payload.tail).toHaveLength(10);
    expect(payload.tailTruncated).toBe(false);
  });

  test('uses the classifier-cleaned final non-empty lines despite blank and ANSI-only physical trailing lines', () => {
    const longLine = `long-${'x'.repeat(SCREEN_LOG_TAIL_MAX_LINE_LENGTH + 1)}`;
    const cleanLines = Array.from({ length: SCREEN_LOG_TAIL_MAX_LINES + 2 }, (_, index) => `line-${index + 1}`);
    const screen = [
      ...cleanLines,
      '\u001B[31mcolored-line\u001B[0m',
      '││',
      '   ',
      longLine,
      '\u001B[2K',
      '',
    ].join('\n');
    const expectedClassifierInput = classifierFrameLines(screen).slice(-SCREEN_LOG_TAIL_MAX_LINES);
    const payload = buildScreenLogPayload('capture', screen);

    expect(expectedClassifierInput).toHaveLength(SCREEN_LOG_TAIL_MAX_LINES);
    expect(payload.tail).toEqual(expectedClassifierInput.map((line) => [...line].slice(0, SCREEN_LOG_TAIL_MAX_LINE_LENGTH).join('')));
    expect(payload.tail).toHaveLength(SCREEN_LOG_TAIL_MAX_LINES);
    expect(payload.tail.every((line) => [...line].length <= SCREEN_LOG_TAIL_MAX_LINE_LENGTH)).toBe(true);
    expect(payload.tailTruncated).toBe(true);
  });

  test('long tail line is capped and records truncation separately', () => {
    const payload = buildScreenLogPayload('capture', 'x'.repeat(SCREEN_LOG_TAIL_MAX_LINE_LENGTH + 1));

    expect(payload.tail).toEqual(['x'.repeat(SCREEN_LOG_TAIL_MAX_LINE_LENGTH)]);
    expect(payload.tailTruncated).toBe(true);
  });

  test('short screen keeps existing label and chars values and is not marked truncated', () => {
    const screen = 'short\nscreen';
    const payload = buildScreenLogPayload('ready', screen);

    expect(payload).toEqual({ label: 'ready', chars: screen.length, tail: ['short', 'screen'], tailTruncated: false });
  });
});

describe('createMissionControlBrain', () => {
  test('does not carry a login decision reason into the next backend summary', async () => {
    const summaries: string[] = [];
    const brain = createMissionControlBrain({ mission: 'Review', evidenceReady: () => true, search: () => {},
      onSummary: (text) => { summaries.push(text); },
      stream: scriptedStream('{"action":"ask-human","reason":"code: SECRET-1234"}'),
    });
    expect(await brain.decide({ ...observation, screen: 'Sign in at https://example.org/device' })).toEqual({ action: 'ask-human', reason: 'code: SECRET-1234' });
    expect(summaries).toEqual([]);
  });

  test('forwards the preceding brain summary, not a screen transcript, to the next stage', async () => {
    const summaries: string[] = [];
    const brain = createMissionControlBrain({ mission: 'Review', evidenceReady: () => true, search: () => {},
      onSummary: (text) => { summaries.push(text); },
      stream: scriptedStream('{"action":"handoff","to":"codex","mission":"Fix review","carry":"summary","reason":"Missing assertion in test"}'),
    });
    expect(await brain.decide({ ...observation, screen: 'token=SCREEN_SECRET' })).toEqual({ action: 'handoff', to: 'codex', mission: 'Fix review', carry: 'summary' });
    expect(summaries).toEqual(['Missing assertion in test']);
  });

  test('wait/send/verify/done 5-action 판단을 canonical 3-action으로 매핑하고 carriage return을 붙인다', async () => {
    const make = (raw: string) => createMissionControlBrain({ mission: 'goal', evidenceReady: () => false, search: () => {}, stream: scriptedStream(raw) });
    expect(await make('{"action":"wait"}').decide(observation)).toEqual({ action: 'wait' });
    expect(await make('{"action":"send","text":"continue"}').decide(observation)).toEqual({ action: 'input', text: 'continue\r' });
    expect(await make('{"action":"verify","reason":"evidence"}').decide(observation)).toEqual({ action: 'done', reason: 'evidence' });
    expect(await make('{"action":"done","reason":"complete"}').decide(observation)).toEqual({ action: 'done', reason: 'complete' });
  });

  test.each([asideBackend, claudeBackend, codexBackend, grokBackend])('$name 백엔드 이름만 시스템 프롬프트와 화면 머리표에 사용한다', async (backend) => {
    let messages: LLMMessage[] = [];
    const brain = createMissionControlBrain({
      mission: 'goal', backend, evidenceReady: () => false, search: () => {},
      stream: async (captured) => {
        messages = captured;
        return '{"action":"wait"}';
      },
    });

    await brain.decide(observation);

    const system = messages.find((message) => message.role === 'system')!.content;
    const user = messages.find((message) => message.role === 'user')!.content;
    expect(system).toContain(backend.name);
    expect(user).toContain(`=== ${backend.name} 화면 ===`);
    for (const name of ['codex', 'claude', 'gemini', 'grok', 'aside']) {
      if (name !== backend.name) {
        expect(system).not.toContain(name);
        expect(user).not.toContain(name);
      }
    }
  });

  test('provision(P4) — 감독이 provision emit 시 provisioner 호출 후 결과 detail 을 input 으로 내부화', async () => {
    let got: { layer: string; spec: string } | null = null;
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async (req) => { got = { layer: req.layer, spec: req.spec }; return { ok: true, layer: req.layer, spec: req.spec, action: 'installed', detail: `설치완료 ${req.spec}` }; },
      stream: scriptedStream('{"action":"provision","spec":"lodash","layer":"pkg","reason":"module not found"}'),
    });
    expect(await brain.decide(observation)).toEqual({ action: 'input', text: '설치완료 lodash\r' });
    expect(got).not.toBeNull();
    expect(got!.layer).toBe('pkg');
    expect(got!.spec).toBe('lodash');
  });

  test('provision 미배선(provision dep 없음) = wait 폴백(무회귀)', async () => {
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      stream: scriptedStream('{"action":"provision","spec":"lodash","layer":"pkg"}'),
    });
    expect(await brain.decide(observation)).toEqual({ action: 'wait' });
  });

  test('provision 거부/실패 결과도 자식에 "계속 진행" input 으로 전달(denied detail)', async () => {
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async (req) => ({ ok: false, layer: req.layer, spec: req.spec, action: 'denied', detail: '설치 거부(정책). 다른 방법으로 진행하라.' }),
      stream: scriptedStream('{"action":"provision","spec":"postgres","layer":"app"}'),
    });
    expect(await brain.decide(observation)).toEqual({ action: 'input', text: '설치 거부(정책). 다른 방법으로 진행하라.\r' });
  });

  test('provision dedup — 같은 spec 반복 요청은 재설치 안 하고 "다른 방법으로" 지시(설치루프 차단)', async () => {
    let calls = 0;
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async (req) => { calls += 1; return { ok: true, layer: req.layer, spec: req.spec, action: 'installed', detail: `설치완료 ${req.spec}` }; },
      stream: scriptedStream('{"action":"provision","spec":"lodash","layer":"pkg"}'),
    });
    const first = await brain.decide(observation);
    expect(first).toEqual({ action: 'input', text: '설치완료 lodash\r' });
    const second = await brain.decide(observation); // 같은 spec 재요청
    expect(calls).toBe(1); // 성공 후엔 영구 차단 → provisioner 한 번만 호출
    expect(second.action).toBe('input'); // 무조건 input(wait 회귀 통과 방지)
    if (second.action === 'input') expect(second.text).toContain('이미 provision');
  });

  test('provision dedup — 실패는 제한적 재시도(최대 2회) 후 차단(일시 오류 재시도·지속실패 루프 차단)', async () => {
    let calls = 0;
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async (req) => { calls += 1; return { ok: false, layer: req.layer, spec: req.spec, action: 'error', detail: '설치 실패. 다른 방법으로.' }; },
      stream: scriptedStream('{"action":"provision","spec":"lodash","layer":"pkg"}'),
    });
    await brain.decide(observation); // 1회
    await brain.decide(observation); // 2회
    const third = await brain.decide(observation); // 3회째 = 차단
    expect(calls).toBe(2); // 실패는 2회까지만 실제 시도(일시 오류 재시도 허용)
    if (third.action === 'input') expect(third.text).toContain('이미 provision');
  });

  test('provision — 무효 layer 는 pkg 로 오분류 안 하고 정책에 raw 그대로 전달(우회 차단·must-fix)', async () => {
    let gotLayer = '';
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async (req) => { gotLayer = req.layer; return { ok: false, layer: req.layer, spec: req.spec, action: 'denied', detail: '거부' }; },
      stream: scriptedStream('{"action":"provision","spec":"x","layer":"garbage-xyz"}'),
    });
    await brain.decide(observation);
    expect(gotLayer).toBe('garbage-xyz'); // pkg 로 바뀌지 않음 → 정책이 defer(오분류-as-pkg 우회 없음)
  });

  test('provision 콜백 예외 → decide 밖 전파 안 하고 graceful input(미션 무중단)', async () => {
    const brain = createMissionControlBrain({
      mission: 'goal', evidenceReady: () => false, search: () => {},
      provision: async () => { throw new Error('provisioner boom'); },
      stream: scriptedStream('{"action":"provision","spec":"lodash","layer":"pkg"}'),
    });
    const d = await brain.decide(observation);
    expect(d.action).toBe('input');
    if (d.action === 'input') expect(d.text).toContain('설치 없이');
  });

  test('search는 omni 결과를 .mission-context.md에 기록한 뒤 context 후속 input으로 내부화한다', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'mission-search-'));
    try {
      const search = createMissionSearch({
        worktree,
        omniPath: '/fake/omni.ts',
        crawl: (query, path) => {
          expect(query).toBe('PTY contract');
          expect(path).toBe('/fake/omni.ts');
          return '## contract\ncanonical PTY reference';
        },
      });
      const brain = createMissionControlBrain({
        mission: 'goal', evidenceReady: () => false, search,
        stream: scriptedStream('{"action":"search","query":"PTY contract"}'),
      });
      expect(await brain.decide(observation)).toEqual({ action: 'input', text: '조사 결과를 .mission-context.md 에 저장했다. 읽고 계속 진행하라.\r' });
      expect(readFileSync(join(worktree, '.mission-context.md'), 'utf8')).toContain('canonical PTY reference');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });

  test('search — crawl이 throw해도 미션 무중단(graceful·실패 메시지를 context에 기록)', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'mission-search-fail-'));
    try {
      const search = createMissionSearch({
        worktree, omniPath: '/fake/omni.ts',
        crawl: () => { throw new Error('network down'); }, // omni-crawl(외부·네트워크) 실패 시뮬
      });
      const brain = createMissionControlBrain({
        mission: 'goal', evidenceReady: () => false, search,
        stream: scriptedStream('{"action":"search","query":"q"}'),
      });
      // decide 가 throw 하지 않고 정상 input 을 반환해야 미션이 안 죽는다(control loop error termination 회피).
      expect(await brain.decide(observation)).toEqual({ action: 'input', text: '조사 결과를 .mission-context.md 에 저장했다. 읽고 계속 진행하라.\r' });
      expect(readFileSync(join(worktree, '.mission-context.md'), 'utf8')).toContain('omni-crawl 실패: network down');
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});

describe('runTsc baseline comparison', () => {
  const baseline: TypecheckError[] = [{ file: 'scripts/existing.ts', line: 'scripts/existing.ts(1,1): error TS2304: Cannot find name \'Existing\'.' }];

  test('기준선에 이미 있던 오류만 존재하면 통과한다', () => {
    const result = runTsc('/worktree', baseline, () => ({ ran: true, diagnostics: [...baseline] }));
    expect(result).toMatchObject({ ok: true, baselineErrors: 1, newErrors: [] });
  });

  test('기준선 밖 새 오류만 실패 문구에 담는다', () => {
    const newDiagnostic: TypecheckError = { file: 'src/new.ts', line: 'src/new.ts(2,3): error TS2322: Type \'number\' is not assignable to type \'string\'.' };
    const result = runTsc('/worktree', baseline, () => ({ ran: true, diagnostics: [...baseline, newDiagnostic] }));
    expect(result.ok).toBe(false);
    expect(result.failure).toBe(newDiagnostic.line);
    expect(result.failure).not.toContain(baseline[0]!.line);
    expect(result).toMatchObject({ baselineErrors: 1, newErrors: [newDiagnostic.line] });
  });

  test('진단 없는 타입검사 실행 실패는 기준선 비교 전에 실패한다', () => {
    const result = runTsc('/worktree', baseline, () => ({ ran: false, diagnostics: [], failure: 'tsc 설정 오류' }));
    expect(result).toMatchObject({ ok: false, baselineErrors: 1, newErrors: [], failure: 'tsc 설정 오류' });
  });

  // 🩸 2026-09-23: 저장소 tsc 가 V8 기본 힙(≈4GB)을 넘는다(RSS 5.0GB) — 외부 에이전트 미션 게이트도 OOM 으로 막혔다.
  test('⛔ tsc 에 명시 힙을 싣는다', () => {
    const seen: { env?: NodeJS.ProcessEnv }[] = [];
    collectTscDiagnostics('/worktree', ((_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => { seen.push(o); return ''; }) as never);
    expect(seen[0]?.env?.NODE_OPTIONS ?? '').toContain('--max-old-space-size=');
  });

  test('TS5058처럼 파싱할 수 없는 정상 오류 종료는 collect 경로에서 fail-closed다', () => {
    const failure = Object.assign(new Error('tsconfig missing'), { status: 2, signal: null, stdout: '', stderr: 'error TS5058: The specified path does not exist.' });
    const collected = collectTscDiagnostics('/worktree', () => { throw failure; });
    expect(collected.ran).toBe(false);
    expect(collected.diagnostics).toEqual([]);
    expect(collected.failure).toContain('타입 검사 실행 실패');
    expect(collected.output).toBe('error TS5058: The specified path does not exist.');
  });
});

describe('test evidence tsc preservation', () => {
  const worktree = '/clean-worktree';
  const evidence: EvidenceMode = { kind: 'test', testPath: 'test/target.test.ts' };

  test('전체 타입검사 실패면 runTest를 호출하지 않고 기존 tsc 실패 문구를 보존한다', () => {
    let testsRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => ({ ran: true, diagnostics: [{ file: 'src/broken.ts', line: 'src/broken.ts(1,1): error TS2322: broken' }] }),
      runTest: () => { testsRun += 1; return { ok: true, out: '1 pass' }; },
      hasChanges: () => true,
      hasTsconfig: true,
    });
    expect(result).toEqual({ ok: false, path: null, retry: 'tsc 실패. 다음 에러를 고쳐라:\nsrc/broken.ts(1,1): error TS2322: broken' });
    expect(testsRun).toBe(0);
  });

  test('TS5058 수집 실패는 원시 출력으로 보고하고 runTest를 호출하지 않는다', () => {
    const failure = Object.assign(new Error('tsconfig missing'), { status: 2, signal: null, stdout: '', stderr: 'error TS5058: The specified path does not exist.' });
    const collected = collectTscDiagnostics(process.cwd(), () => { throw failure; });
    let testsRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => collected,
      runTest: () => { testsRun += 1; return { ok: true, out: '1 pass' }; },
      hasChanges: () => true,
      hasTsconfig: true,
    });
    expect(result).toEqual({ ok: false, path: null, retry: 'tsc 실패. 다음 에러를 고쳐라:\nerror TS5058: The specified path does not exist.' });
    expect(testsRun).toBe(0);
  });

  test('전체 타입검사 성공 뒤에만 runTest를 실행하고 기존 테스트 실패 문구를 보존한다', () => {
    let testsRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => ({ ran: true, diagnostics: [] }),
      runTest: () => { testsRun += 1; return { ok: false, out: '0 pass / 1 fail' }; },
      hasChanges: () => true,
      hasTsconfig: true,
    });
    expect(result).toEqual({ ok: false, path: null, retry: '테스트 실패/부재:\n0 pass / 1 fail' });
    expect(testsRun).toBe(1);
  });

  test('26개 이상 진단은 앞 25개만 싣는다(종전 parseTscErrors().slice(0,25) 계약 보존)', () => {
    const diagnostics: TypecheckError[] = Array.from({ length: 26 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: `src/f${i}.ts(1,1): error TS2322: msg${i}`,
    }));
    // 종전 문구 = parseTscErrors(out).slice(0,25).join('\n') || out.slice(-1500), 그 뒤 .slice(0,1500).
    const former = diagnostics.map((d) => d.line).slice(0, 25).join('\n').slice(0, 1500);
    let testsRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => ({ ran: true, diagnostics }),
      runTest: () => { testsRun += 1; return { ok: true, out: '1 pass' }; },
      hasChanges: () => true,
      hasTsconfig: true,
    });
    expect(result).toEqual({ ok: false, path: null, retry: `tsc 실패. 다음 에러를 고쳐라:\n${former}` });
    // 26번째 진단은 문구에 없어야 한다(25개 상한).
    expect((result.retry ?? '')).not.toContain('msg25');
    expect((result.retry ?? '')).toContain('msg24');
    expect(testsRun).toBe(0);
  });

  test('1500자 초과 비파싱 출력은 끝 1500자를 쓴다(종전 out.slice(-1500) 계약 보존·앞부분 아님)', () => {
    const head = 'HEAD_MARKER_';
    const tail = '_TAIL_MARKER';
    const filler = 'x'.repeat(2000);
    const rawOutput = `${head}${filler}${tail}`; // >1500자, 머리·꼬리 구별
    // 종전 문구 = ('' || out.slice(-1500)).slice(0,1500) = out.slice(-1500).
    const former = rawOutput.slice(-1500).slice(0, 1500);
    let testsRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => ({ ran: false, diagnostics: [], output: rawOutput, failure: 'tsc 실행 실패' }),
      runTest: () => { testsRun += 1; return { ok: true, out: '1 pass' }; },
      hasChanges: () => true,
      hasTsconfig: true,
    });
    expect(result).toEqual({ ok: false, path: null, retry: `tsc 실패. 다음 에러를 고쳐라:\n${former}` });
    // 끝부분(꼬리)은 실리고 머리는 잘려나가야 한다(앞 1500자를 쓰면 회귀).
    expect((result.retry ?? '')).toContain(tail);
    expect((result.retry ?? '')).not.toContain(head);
    expect(testsRun).toBe(0);
  });

  test('tsconfig 가 없는 저장소는 tsc 를 건너뛰고 시험으로 판정한다(09-29 S6: 시험 2/2 인데 tsc 도움말이 «실패»였다)', () => {
    let tscRun = 0;
    const result = checkEvidence(worktree, evidence, {
      executeTsc: () => { tscRun += 1; return { ran: false, diagnostics: [], output: 'Version 5.9 … tsc: The TypeScript Compiler', failure: 'exit 1' }; },
      runTest: () => ({ ok: true, out: '2 pass' }),
      hasChanges: () => true,
      hasTsconfig: false,
    });
    expect(result).toEqual({ ok: true, path: worktree });
    expect(tscRun).toBe(0);
  });
});

describe('createMissionVerifyDone', () => {
  const evidence: EvidenceMode = { kind: 'doc', dirRel: 'docs', glob: /PLAN/ };

  test('evidence 미달은 coverage를 실행하지 않고 canonical retry를 반환한다', async () => {
    let coverageCalls = 0;
    const verifyDone = createMissionVerifyDone({
      worktree: '/worktree', evidence, checklist: ['must-have'], coverageRetries: 2,
      checkEvidence: () => ({ ok: false, path: null, retry: '문서가 없다.' }),
      verifyCoverage: async () => { coverageCalls += 1; return { covered: [], missing: [], ratio: 1, method: 'test' }; },
    });
    await expect(verifyDone()).resolves.toEqual({ ok: false, retry: '문서가 없다.\n고친 뒤 MISSION-COMPLETE 라고 답하라.\r' });
    expect(coverageCalls).toBe(0);
  });

  test('coverage 미달은 retry budget 동안 되먹이고, 예산 소진 시 미달을 수락한다(visible omission·원본 시맨틱)', async () => {
    const missing = { covered: [], missing: ['must-have'], ratio: 0, method: 'test' };
    const verifyDone = createMissionVerifyDone({
      worktree: '/worktree', evidence, checklist: ['must-have'], coverageRetries: 1,
      checkEvidence: () => ({ ok: true, path: '/worktree/docs/PLAN.md' }),
      gatherArtifactText: () => 'artifact',
      verifyCoverage: async () => missing, // 계속 미달
    });
    const first = await verifyDone();
    const second = await verifyDone();
    // 1회 되먹임(남은 0) 후, 예산 소진 시 evidence 는 충족했으므로 수락한다(최종 ok 는 evidence gate 가 결정·
    // hard-fail 로 두면 control loop 이 budget 까지 헛돌며 자식을 계속 찌른다).
    expect(first).toMatchObject({ ok: false, retry: expect.stringContaining('남은 커버리지 재시도: 0') });
    expect(second).toEqual({ ok: true });
  });

  test('coverage 완전 충족이면 즉시 success(재시도 예산 무관)', async () => {
    const complete = { covered: ['must-have'], missing: [], ratio: 1, method: 'test' };
    const verifyDone = createMissionVerifyDone({
      worktree: '/worktree', evidence, checklist: ['must-have'], coverageRetries: 2,
      checkEvidence: () => ({ ok: true, path: '/worktree/docs/PLAN.md' }),
      gatherArtifactText: () => 'artifact',
      verifyCoverage: async () => complete,
    });
    expect(await verifyDone()).toEqual({ ok: true });
  });
});

describe('checkEvidence doc — only a document this mission wrote counts', () => {
  const mkRepo = () => {
    const d = mkdtempSync(join(tmpdir(), 'doc-evidence-'));
    execFileSync('git', ['init', '-q', d]);
    mkdirSync(join(d, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(d, 'docs', 'plans', 'PLAN-old-2026-01-01.md'), 'old\n');
    execFileSync('git', ['-C', d, 'add', '-A']);
    execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
    return d;
  };
  const ev = { kind: 'doc' as const, dirRel: 'docs/plans', glob: /^PLAN-.*\.md$/ };

  test('a matching document that was already committed does not pass round 0', () => {
    const d = mkRepo();
    try {
      const r = checkEvidence(d, ev);
      expect(r.ok).toBe(false);
      expect(r.retry).toContain('이번 미션이 쓴 것이 아니다');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a new document passes · an edited old one passes', () => {
    const d = mkRepo();
    try {
      writeFileSync(join(d, 'docs', 'plans', 'PLAN-new-2026-09-27.md'), 'new\n');
      expect(checkEvidence(d, ev)).toMatchObject({ ok: true, path: join(d, 'docs', 'plans', 'PLAN-new-2026-09-27.md') });
      rmSync(join(d, 'docs', 'plans', 'PLAN-new-2026-09-27.md'));
      writeFileSync(join(d, 'docs', 'plans', 'PLAN-old-2026-01-01.md'), 'old\nedited\n');
      expect(checkEvidence(d, ev)).toMatchObject({ ok: true, path: join(d, 'docs', 'plans', 'PLAN-old-2026-01-01.md') });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test('a document inside a wholly untracked directory passes (porcelain collapses it to the directory)', () => {
    const d = mkRepo();
    try {
      const e2 = { kind: 'doc' as const, dirRel: 'docs/fresh', glob: /^RFC-.*\.md$/ };
      mkdirSync(join(d, 'docs', 'fresh'), { recursive: true });
      writeFileSync(join(d, 'docs', 'fresh', 'RFC-x.md'), 'x\n');
      expect(checkEvidence(d, e2)).toMatchObject({ ok: true });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('gemini(agy) backend answers the folder-trust menu', () => {
  const trustScreen = 'Accessing workspace:\n/tmp/wt\nDo you trust the contents of this project?\nAntigravity CLI requires permission to read, edit, and execute files here.\n> Yes, I trust this folder\n  No, exit\n  ↑/↓ Navigate · enter Confirm';
  test('the trust menu is confirmed with Enter (default = trust) and reported as handled', () => {
    const writes: string[] = [];
    expect(geminiBackend.handleTrust?.(trustScreen, (s) => writes.push(s))).toBe(true);
    expect(writes).toEqual(['\r']);
  });
  test('a normal prompt screen is left alone', () => {
    const writes: string[] = [];
    expect(geminiBackend.handleTrust?.('Antigravity CLI 1.2.12\n> \n? for shortcuts', (s) => writes.push(s))).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('claude backend answers the folder-trust menu (09-29 S6 실물 화면)', () => {
  const screen = (sel: 'no' | 'yes') => [
    'Accessing workspace:',
    '/Users/user/.elanous/worktrees/demo-a2a1e533/retry-demo.worktrees/s6-retry-0929c',
    'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open',
    "Claude Code'll be able to read, edit, and execute files here.",
    'Security guide',
    sel === 'no' ? '❯ No, exit' : '  No, exit',
    sel === 'yes' ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder',
    'Enter to confirm · Esc to cancel',
  ].join('\n');
  test('default «No» selected → move down, never Enter on «No»', () => {
    const writes: string[] = [];
    expect(claudeBackend.handleTrust?.(screen('no'), (s) => writes.push(s))).toBe(true);
    expect(writes).toEqual(['\x1b[B']);
  });
  test('«Yes» selected → Enter', () => {
    const writes: string[] = [];
    expect(claudeBackend.handleTrust?.(screen('yes'), (s) => writes.push(s))).toBe(true);
    expect(writes).toEqual(['\r']);
  });
  test('a normal claude prompt is left alone', () => {
    const writes: string[] = [];
    expect(claudeTrustChoice('Claude Code\n❯ \n? for shortcuts')).toBeNull();
    expect(claudeBackend.handleTrust?.('Claude Code\n❯ \n? for shortcuts', (s) => writes.push(s))).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('claude input: text and Enter go as separate writes (09-29 실물: Enter inside one chunk became a newline)', () => {
  test('a trailing Enter is split off and sent after a delay', () => {
    const writes: string[] = [];
    const later: Array<() => void> = [];
    const inject = submitSeparately((t) => { writes.push(t); return true; }, (fn) => { later.push(fn); });
    expect(inject('Address the review findings.\r')).toBe(true);
    expect(writes).toEqual(['Address the review findings.']);
    later.forEach((fn) => fn());
    expect(writes).toEqual(['Address the review findings.', '\r']);
  });
  test('a bare Enter or text without Enter is written as is', () => {
    const writes: string[] = [];
    const inject = submitSeparately((t) => { writes.push(t); return true; }, (fn) => fn());
    inject('\r'); inject('y');
    expect(writes).toEqual(['\r', 'y']);
  });
  test('a refused write does not schedule the Enter', () => {
    const later: Array<() => void> = [];
    const inject = submitSeparately(() => false, (fn) => { later.push(fn); });
    expect(inject('text\r')).toBe(false);
    expect(later).toEqual([]);
  });
});
