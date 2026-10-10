import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { getUserConfig, saveUserConfig, setUserConfigOverlay, type UserConfig } from '../user-config.js';
import * as podDispatch from './harness-pod-dispatch.js';
import { harnessLaunchPolicyConfig, resolveHarnessSubstrate } from './harness-substrate-default.js';
import { devAskPodDispatchInput } from './harness-substrate-default.js';
import { installHarnessCliCommand } from './harness-cli-command.js';
import { resolveCodexQuotaPolicy, codexPolicyAllowsCredits } from '../oauth/codex-quota-policy.js';
import { normalizeFallbackChain } from '../oauth/fallback-chain.js';
import { planPodProvider } from '../task-orchestrator/surfaces/pod-account-broker.js';
import { resolvePodPoolSpec } from '../task-orchestrator/surfaces/pod-pool.js';
import { program } from '../index.js';
import * as podPool from '../task-orchestrator/surfaces/pod-pool.js';
import * as podSurface from '../task-orchestrator/surfaces/self-implement-pod.js';
import * as accounts from '../oauth/codex-account-store.js';
import { saveTokens } from '../oauth/store.js';
import { writeQuotaSignal } from '../budget/codex-reset-credit-state.js';
import * as accountBroker from '../task-orchestrator/surfaces/pod-account-broker.js';
import * as credential from '../grok/credential.js';
import * as orchestrateCli from '../self-dev/orchestrate-cli.js';
import * as runtime from '../self-dev/self-orchestrate-runtime.js';
import * as runStore from '../self-dev/run-store.js';
import * as orchestrate from '../self-dev/orchestrate.js';
import * as instance from '../instance/resolve.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';

const config = (substrate?: 'local' | 'pod', podPool?: string): Pick<UserConfig, 'harness' | 'pod'> => ({ harness: { substrate, podPool } });

describe('LAUNCH-POLICY-UNIV judgment line (injected config readers)', () => {
  const ops = { llm: { codexQuotaPolicy: 'credits', codexAccountRotationThresholdPercentByAccount: { default: 97 }, fallbackChain: ['codex-rotate'] },
    harness: { podPool: 'pool-node-b@node-b:8' } } as unknown as UserConfig;
  test('test universe without policy → plan uses the ops policy, exactly one warning', () => {
    const warnings: string[] = [];
    const reads: string[] = [];
    const selected = harnessLaunchPolicyConfig({ derived: {} as UserConfig, derivedRoot: '/derived', operationalRoot: '/ops',
      readOperational: (path) => { reads.push(path); return ops; }, warn: (line) => warnings.push(line) });
    expect(reads).toEqual(['/ops/config.json']);
    expect(selected.llm?.codexQuotaPolicy).toBe('credits');
    expect(selected.llm?.codexAccountRotationThresholdPercentByAccount).toEqual({ default: 97 });
    expect(selected.llm?.fallbackChain).toEqual(['codex-rotate']);
    expect(selected.harness?.podPool).toBe('pool-node-b@node-b:8');
    expect(warnings).toHaveLength(1);
  });
  test('podPool differs (stale node-c) → ops wins, one warning', () => {
    const warnings: string[] = [];
    const derived = { ...ops, harness: { podPool: 'pool-node-b@node-b:8,pool-node-c@node-c:3' } } as UserConfig;
    const selected = harnessLaunchPolicyConfig({ derived, derivedRoot: '/derived', operationalRoot: '/ops',
      readOperational: () => ops, warn: (line) => warnings.push(line) });
    expect(selected.harness?.podPool).toBe('pool-node-b@node-b:8');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('운영 정책으로 발사');
  });
  test('same policy in both → no warning; ops universe itself → derived returned, reader not called', () => {
    const warnings: string[] = [];
    harnessLaunchPolicyConfig({ derived: ops, derivedRoot: '/derived', operationalRoot: '/ops', readOperational: () => ops, warn: (l) => warnings.push(l) });
    expect(warnings).toEqual([]);
    let called = false;
    expect(harnessLaunchPolicyConfig({ derived: ops, derivedRoot: '/ops', operationalRoot: '/ops', readOperational: () => { called = true; return ops; } })).toBe(ops);
    expect(called).toBe(false);
  });
});

test('missing derived launch policy uses operational quota, per-account caps, fallback and pod pool with one warning', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-launch-policy-'));
  const operationalRoot = join(root, 'operational');
  const derivedRoot = join(root, 'derived');
  mkdirSync(operationalRoot);
  const policy = { llm: { codexQuotaPolicy: 'credits', codexAccountRotationThresholdPercentByAccount: { team: 97 }, fallbackChain: ['codex-rotate'] }, harness: { podPool: 'pool-node-b@node-b:8' } };
  writeFileSync(join(operationalRoot, 'config.json'), JSON.stringify(policy));
  const warnings: string[] = [];
  try {
    const selected = harnessLaunchPolicyConfig({ derived: getUserConfig(join(derivedRoot, 'config.json')), derivedRoot, operationalRoot, warn: (line) => warnings.push(line) });
    expect(selected.llm?.codexQuotaPolicy).toBe('credits');
    expect(selected.llm?.codexAccountRotationThresholdPercentByAccount).toEqual({ team: 97 });
    expect(selected.llm?.fallbackChain).toEqual(['codex-rotate']);
    expect(selected.harness?.podPool).toBe('pool-node-b@node-b:8');
    expect(resolvePodPoolSpec(undefined, {}, () => selected.harness?.podPool ?? selected.pod?.pool)).toBe('pool-node-b@node-b:8');
    const quota = resolveCodexQuotaPolicy(selected.llm).policy;
    expect(codexPolicyAllowsCredits(quota)).toBe(true);
    expect(normalizeFallbackChain(selected.llm?.fallbackChain).chain).toEqual(['codex-rotate']);
    expect(planPodProvider({ codexCandidates: [{ name: 'team', home: '/unused', storeKey: 'team', reached: true, usedPercent: 100 }],
      thresholdPercentByAccount: selected.llm?.codexAccountRotationThresholdPercentByAccount, creditsAllowed: codexPolicyAllowsCredits(quota),
      grokSubscription: false, grokApiKey: false, grokApiKeyOptIn: false }).provider).toBe('openai-codex');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('파생 시험 우주 정책이 없거나 운영과 다르다');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('selfOrchestrateCmd uses operational policy under NODE_ENV=test with a missing derived policy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-launch-entry-'));
  const operationalRoot = join(root, '.elanous');
  const derivedRoot = join(root, 'derived');
  mkdirSync(operationalRoot);
  mkdirSync(derivedRoot);
  const operational = { llm: { codexQuotaPolicy: 'credits', codexAccountRotationThresholdPercentByAccount: { team: 97, other: 99 }, fallbackChain: ['codex-rotate'] }, harness: { podPool: 'pool-node-b@node-b:8' } };
  writeFileSync(join(operationalRoot, 'config.json'), JSON.stringify(operational));
  const originalHome = process.env.HOME;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalConfigDirOverride = getElanousConfigDirOverride();
  const originalState = process.env.ELANOUS_STATE_DIR;
  const originalStateSource = process.env.ELANOUS_STATE_DIR_SOURCE;
  const originalEntrance = process.env.ELANOUS_HARNESS_ENTRANCE;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalPool = process.env.ELANOUS_POD_POOL;
  const originalQuota = process.env.ELANOUS_CODEX_QUOTA_POLICY;
  const warnings: string[] = [];
  const plans: unknown[] = [];
  const poolSpecs: string[] = [];
  const providerPlans: accountBroker.PodProviderPlan[] = [];
  const orchestrateCommand = program.commands.find((cmd) => cmd.name() === 'self')?.commands.find((cmd) => cmd.name() === 'orchestrate');
  if (!orchestrateCommand) throw new Error('self orchestrate command not registered');
  const originalGoalFiles = orchestrateCommand.getOptionValue('goalFile');
  orchestrateCommand.setOptionValue('goalFile', []);
  const error = spyOn(console, 'error').mockImplementation((line: unknown) => { warnings.push(String(line)); });
  const warn = spyOn(console, 'warn').mockImplementation((line: unknown) => { warnings.push(String(line)); });
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`STOP_${code}`); }) as never);
  const prepare = spyOn(runtime, 'prepareOrchestrateDecomposeGoals').mockImplementation(async (input) => ({ ok: true as const, goals: input.goals }));
  const load = spyOn(runStore, 'loadSelfDevRun').mockReturnValue(null);
  const save = spyOn(runStore, 'saveSelfDevRun').mockImplementation(() => {});
  const participant = spyOn(runStore, 'addSelfDevRunParticipant').mockImplementation(() => {});
  const pid = spyOn(orchestrate, 'writeRunPidRecord').mockImplementation(() => 'isolated-pid');
  const prodRoot = spyOn(instance, 'prodInstanceRoot').mockReturnValue(operationalRoot);
  const check = spyOn(podPool, 'checkPodPool').mockImplementation((members) => {
    poolSpecs.push(members.map((m) => `${m.context}@${m.sshHost}:${m.capacity}`).join(','));
    return { ok: true, ready: [...members], dropped: [] };
  });
  const freshness = spyOn(podSurface, 'podImageFreshness').mockImplementation(() => ({ imageCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), fresh: true, reason: 'test image' }));
  const sync = spyOn(podPool, 'syncPoolImages').mockImplementation(async (members) => new Map(members.map((m) => [m.context, { ok: true, action: 'current' as const, detail: 'test' }])) as never);
  const inspect = spyOn(accounts, 'inspectCodexRotation').mockImplementation(() => ({ candidates: [
    { name: 'team', home: '/isolated/team', storeKey: 'team', reached: true, usedPercent: 100 },
    { name: 'other', home: '/isolated/other', storeKey: 'other', reached: false, usedPercent: 98 },
  ] }) as never);
  const actualPlan = accountBroker.planPodProvider;
  const broker = spyOn(accountBroker, 'planPodProvider').mockImplementation((input) => {
    const plan = actualPlan(input);
    providerPlans.push(plan);
    return plan;
  });
  const grok = spyOn(credential, 'resolveGrokCredential').mockImplementation((() => null) as typeof credential.resolveGrokCredential);
  const run = spyOn(orchestrateCli, 'runSelfOrchestrateCliCommand').mockImplementation(async (input) => {
    plans.push({ pool: input.runtime.podTargets, account: input.runtime.spawn });
    return { ok: true, results: [], exitCode: 0 };
  });
  try {
    process.env.HOME = root;
    delete process.env.XDG_CONFIG_HOME;
    process.env.ELANOUS_STATE_DIR = derivedRoot;
    process.env.ELANOUS_STATE_DIR_SOURCE = 'derived';
    process.env.ELANOUS_HARNESS_ENTRANCE = 'harness-say';
    process.argv.push('--harness-internal');
    process.env.NODE_ENV = 'test';
    delete process.env.ELANOUS_POD_POOL;
    delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
    resetElanousConfigDir();
    expect(getElanousConfigDirOverride()).toBeUndefined();
    expect(instance.effectiveInstanceRoot()).toBe(derivedRoot);
    expect(getUserConfig().llm?.codexQuotaPolicy).toBeUndefined();
    expect(getUserConfig().harness?.podPool).toBeUndefined();
    await program.parseAsync(['node', 'elanous', 'self', 'orchestrate', 'policy probe', '--substrate', 'pod', '--no-pod-rebuild', '--no-supervise', '--json']);
    expect(plans).toHaveLength(1);
    expect((plans[0] as { account: unknown }).account).toBeFunction();
    expect((plans[0] as { pool: unknown }).pool).toEqual([{ context: 'pool-node-b', namespace: 'elanous-test' }]);
    expect(poolSpecs).toEqual(['pool-node-b@node-b:8']);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(broker).toHaveBeenCalledWith(expect.objectContaining({ thresholdPercentByAccount: { team: 97, other: 99 }, creditsAllowed: true, grokSubscription: false, grokApiKey: false }));
    expect(providerPlans).toEqual([{ provider: 'openai-codex', accounts: ['other'], excluded: [{ name: 'team', why: 'quota reached' }], grokSubscriptionEligible: false }]);
    expect(warnings.filter((line) => line.includes('launch policy: 파생 시험 우주 정책이 없거나 운영과 다르다'))).toHaveLength(1);
    expect(warnings.join('\n')).not.toContain('쓸 codex 계정이 없다');

    // The real account inspector reads the host credential store, not a worktree's stale auth.json.
    inspect.mockRestore();
    process.env.XDG_CONFIG_HOME = join(root, 'xdg');
    const credentialRoot = join(root, 'xdg', 'elanous');
    mkdirSync(credentialRoot, { recursive: true });
    const tokens = { accessToken: 'fixture', refreshToken: 'fixture', expiresAt: null };
    const teamHome = join(root, 'codex-team');
    const otherHome = join(root, 'codex-other');
    mkdirSync(teamHome);
    mkdirSync(otherHome);
    saveTokens('openai-codex:team', tokens, { codexHome: teamHome, mirrorCodex: false }, join(credentialRoot, 'auth.json'));
    saveTokens('openai-codex:other', tokens, { codexHome: otherHome, mirrorCodex: false }, join(credentialRoot, 'auth.json'));
    saveTokens('openai-codex:stale', tokens, { codexHome: join(root, 'codex-stale'), mirrorCodex: false }, join(derivedRoot, 'auth.json'));
    writeQuotaSignal(undefined, 100, teamHome);
    writeQuotaSignal(undefined, 98, otherHome);
    writeFileSync(join(derivedRoot, 'config.json'), JSON.stringify({
      ...operational, llm: { ...operational.llm, codexAccountRotationThresholdPercentByAccount: { team: 50, other: 50 } },
      harness: { podPool: 'pool-node-c@node-c:3' },
    }));
    warnings.length = 0;
    await program.parseAsync(['node', 'elanous', 'self', 'orchestrate', 'real account probe', '--substrate', 'pod', '--no-pod-rebuild', '--no-supervise', '--json']);
    expect(broker).toHaveBeenLastCalledWith(expect.objectContaining({
      codexCandidates: expect.arrayContaining([expect.objectContaining({ name: 'team', usedPercent: 100 }), expect.objectContaining({ name: 'other', usedPercent: 98 })]),
      thresholdPercentByAccount: { team: 97, other: 99 }, creditsAllowed: true,
    }));
    expect((broker.mock.calls.at(-1)?.[0].codexCandidates ?? []).map((c) => c.name).sort()).toEqual(['other', 'team']);
    expect(providerPlans.at(-1)).toEqual({ provider: 'openai-codex', accounts: ['other'], excluded: [{ name: 'team', why: 'used 100% ≥ 97%' }], grokSubscriptionEligible: false });
    expect(poolSpecs.at(-1)).toBe('pool-node-b@node-b:8');
    expect(warnings.filter((line) => line.includes('launch policy: 파생 시험 우주 정책이 없거나 운영과 다르다'))).toHaveLength(1);

    // A usable credential cannot enable Grok when only the derived chain contains Grok.
    writeFileSync(join(operationalRoot, 'config.json'), JSON.stringify({
      ...operational, llm: { ...operational.llm, codexQuotaPolicy: 'fallback', fallbackChain: ['codex-rotate'],
        codexAccountRotationThresholdPercentByAccount: { team: 97, other: 97 } },
    }));
    writeFileSync(join(derivedRoot, 'config.json'), JSON.stringify({
      ...operational, llm: { ...operational.llm, codexQuotaPolicy: 'fallback', fallbackChain: ['codex-rotate', 'grok'] },
    }));
    grok.mockImplementation((() => ({ kind: 'subscription', baseUrl: 'https://example.invalid', token: 'fixture', headers: {}, source: 'fixture' })) as typeof credential.resolveGrokCredential);
    const usable = spyOn(podSurface, 'podGrokSubscriptionUsable').mockImplementation(() => ({ usable: true }));
    try {
      warnings.length = 0;
      let refused = false;
      try { await program.parseAsync(['node', 'elanous', 'self', 'orchestrate', 'fallback probe', '--substrate', 'pod', '--no-pod-rebuild', '--no-supervise', '--json']); }
      catch (err) { expect(String(err)).toContain('STOP_1'); refused = true; }
      expect(refused).toBe(true);
      expect(broker).toHaveBeenLastCalledWith(expect.objectContaining({
        creditsAllowed: false, grokSubscription: false, grokApiKey: false,
        codexCandidates: expect.arrayContaining([expect.objectContaining({ name: 'team' }), expect.objectContaining({ name: 'other' })]),
      }));
      expect(providerPlans.at(-1)).toMatchObject({ provider: null, grokSubscriptionEligible: false });
      expect((providerPlans.at(-1) as Extract<accountBroker.PodProviderPlan, { provider: null }>).reasons.join(' ')).toContain('grok: 구독 자격 없음');
      expect(warnings.filter((line) => line.includes('launch policy: 파생 시험 우주 정책이 없거나 운영과 다르다'))).toHaveLength(1);
    } finally { usable.mockRestore(); }
  } finally {
    process.argv.splice(process.argv.lastIndexOf('--harness-internal'), 1);
    orchestrateCommand.setOptionValue('goalFile', originalGoalFiles);
    resetElanousConfigDir();
    if (originalConfigDirOverride !== undefined) setElanousConfigDir(originalConfigDirOverride);
    for (const [key, value] of Object.entries({ HOME: originalHome, XDG_CONFIG_HOME: originalXdg, ELANOUS_STATE_DIR: originalState, ELANOUS_STATE_DIR_SOURCE: originalStateSource, ELANOUS_HARNESS_ENTRANCE: originalEntrance, NODE_ENV: originalNodeEnv, ELANOUS_POD_POOL: originalPool, ELANOUS_CODEX_QUOTA_POLICY: originalQuota })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    error.mockRestore(); warn.mockRestore(); exit.mockRestore(); prepare.mockRestore(); load.mockRestore(); save.mockRestore(); participant.mockRestore(); pid.mockRestore(); prodRoot.mockRestore(); check.mockRestore(); freshness.mockRestore(); sync.mockRestore(); inspect.mockRestore(); broker.mockRestore(); grok.mockRestore(); run.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale derived launch policy cannot reintroduce a removed Pod host', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-launch-policy-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ llm: { codexQuotaPolicy: 'credits', fallbackChain: ['codex-rotate'] }, harness: { podPool: 'pool-node-b@node-b:8' } }));
  const warnings: string[] = [];
  try {
    const selected = harnessLaunchPolicyConfig({ derived: { ...getUserConfig(join(root, 'missing.json')), llm: { codexQuotaPolicy: 'fallback', fallbackChain: ['codex-rotate', 'grok'] }, harness: { podPool: 'pool-node-c@node-c:3' } } as UserConfig, operationalRoot: root, derivedRoot: '/derived', warn: (line) => warnings.push(line) });
    expect(selected.harness?.podPool).toBe('pool-node-b@node-b:8');
    expect(selected.llm?.codexQuotaPolicy).toBe('credits');
    expect(selected.llm?.fallbackChain).toEqual(['codex-rotate']);
    expect(warnings).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('derived Grok API key opt-in mismatch warns once and selects the operational value', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-launch-opt-in-'));
  const path = join(root, 'config.json');
  const policy = { llm: { codexQuotaPolicy: 'fallback', fallbackChain: ['codex-rotate', 'grok'] }, harness: { podPool: 'pool-node-b@node-b:8', pod: { grokApiKeyOptIn: true } } };
  writeFileSync(path, JSON.stringify(policy));
  const warnings: string[] = [];
  try {
    const parsed = getUserConfig(path);
    const derived = { ...parsed, harness: { ...parsed.harness, pod: { grokApiKeyOptIn: false } } } as UserConfig;
    const selected = harnessLaunchPolicyConfig({ derived, operationalRoot: root, derivedRoot: '/derived', warn: (line) => warnings.push(line) });
    expect(selected.harness?.pod?.grokApiKeyOptIn).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('launch policy: 파생 시험 우주 정책이 없거나 운영과 다르다');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no operational config on the machine keeps the derived policy and says so once', () => {
  const warnings: string[] = [];
  const derived = getUserConfig(join(tmpdir(), 'missing-derived-policy.json'));
  expect(harnessLaunchPolicyConfig({ derived, derivedRoot: '/derived', operationalRoot: join(tmpdir(), 'missing-operational-policy'),
    warn: (line) => warnings.push(line) })).toBe(derived);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('운영 config 가 없다');
});

test('an operational config that exists but cannot be read (not ENOENT) refuses', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-launch-dir-ops-'));
  mkdirSync(join(root, 'config.json'));
  try {
    expect(() => harnessLaunchPolicyConfig({ derived: {} as UserConfig, derivedRoot: '/derived', operationalRoot: root, warn: () => {} }))
      .toThrow('운영 config 를 읽을 수 없다');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('per-account caps in a different key order are the same policy (no warning)', () => {
  const ops = { llm: { codexQuotaPolicy: 'credits', codexAccountRotationThresholdPercentByAccount: { a: 97, b: 99 } } } as unknown as UserConfig;
  const derived = { llm: { codexQuotaPolicy: 'credits', codexAccountRotationThresholdPercentByAccount: { b: 99, a: 97 } } } as unknown as UserConfig;
  const warnings: string[] = [];
  harnessLaunchPolicyConfig({ derived, derivedRoot: '/derived', operationalRoot: '/ops', readOperational: () => ops, warn: (l) => warnings.push(l) });
  expect(warnings).toEqual([]);
});

test('unreadable operational config refuses rather than silently using stale policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-launch-bad-ops-'));
  writeFileSync(join(root, 'config.json'), '{ not json');
  try {
    expect(() => harnessLaunchPolicyConfig({ derived: {} as UserConfig, derivedRoot: '/derived', operationalRoot: root, warn: () => {} }))
      .toThrow('운영 config 를 읽을 수 없다');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('matching derived launch policy emits no warning and still reads the operational config', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-launch-policy-match-'));
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify({ llm: { codexQuotaPolicy: 'credits', fallbackChain: ['codex-rotate'] }, harness: { podPool: 'pool-node-b@node-b:8' } }));
  const warnings: string[] = [];
  try {
    const derived = getUserConfig(path);
    const selected = harnessLaunchPolicyConfig({ derived, operationalRoot: root, derivedRoot: '/derived', warn: (line) => warnings.push(line) });
    expect(selected.harness?.podPool).toBe('pool-node-b@node-b:8');
    expect(warnings).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit operational universe retains its current config without warning', () => {
  const derived = { ...getUserConfig(join(tmpdir(), 'nonexistent-launch-config.json')), harness: { podPool: 'local-pool' } } as UserConfig;
  const warnings: string[] = [];
  expect(harnessLaunchPolicyConfig({ derived, derivedRoot: '/same', operationalRoot: '/same', warn: (line) => warnings.push(line) })).toBe(derived);
  expect(warnings).toEqual([]);
});

test('an explicit config-dir remains isolated even when the state dir was stamped derived', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-explicit-policy-'));
  const explicit = join(root, 'explicit');
  mkdirSync(explicit);
  writeFileSync(join(explicit, 'config.json'), JSON.stringify({ llm: { codexQuotaPolicy: 'within-quota' }, harness: { podPool: 'isolated-pool' } }));
  const previousOverride = getElanousConfigDirOverride();
  const previousSource = process.env.ELANOUS_STATE_DIR_SOURCE;
  const warnings: string[] = [];
  try {
    setElanousConfigDir(explicit);
    process.env.ELANOUS_STATE_DIR_SOURCE = 'derived';
    const derived = getUserConfig(join(explicit, 'config.json'));
    expect(harnessLaunchPolicyConfig({ derived, warn: (line) => warnings.push(line) })).toBe(derived);
    expect(warnings).toEqual([]);
  } finally {
    resetElanousConfigDir();
    if (previousOverride !== undefined) setElanousConfigDir(previousOverride);
    if (previousSource === undefined) delete process.env.ELANOUS_STATE_DIR_SOURCE;
    else process.env.ELANOUS_STATE_DIR_SOURCE = previousSource;
    rmSync(root, { recursive: true, force: true });
  }
});
const context = () => 'current-context';

describe('harness substrate default', () => {
  let previousPool: string | undefined;
  beforeEach(() => {
    previousPool = process.env.ELANOUS_POD_POOL;
    delete process.env.ELANOUS_POD_POOL;
  });
  afterEach(() => {
    setUserConfigOverlay(null);
    if (previousPool === undefined) delete process.env.ELANOUS_POD_POOL;
    else process.env.ELANOUS_POD_POOL = previousPool;
  });

  test('flag, config, default and four pool layers', () => {
    expect(resolveHarnessSubstrate({ config: config(), env: {}, currentContext: context })).toEqual({ substrate: 'local', pool: null, source: 'default' });
    expect(resolveHarnessSubstrate({ config: config('pod', 'cfg'), env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'cfg', source: 'config' });
    expect(resolveHarnessSubstrate({ flag: { substrate: 'local' }, config: config('pod', 'cfg'), env: {}, currentContext: context })).toEqual({ substrate: 'local', pool: null, source: 'flag' });
    expect(resolveHarnessSubstrate({ flag: { substrate: 'pod', podPool: 'flag' }, config: config('local', 'cfg'), env: { ELANOUS_POD_POOL: 'env' }, currentContext: context })).toEqual({ substrate: 'pod', pool: 'flag', source: 'flag' });
    expect(resolveHarnessSubstrate({ config: config('pod', 'cfg'), env: { ELANOUS_POD_POOL: 'env' }, currentContext: context })).toEqual({ substrate: 'pod', pool: 'env', source: 'config' });
    expect(resolveHarnessSubstrate({ config: config('pod'), env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'current-context', source: 'config' });
    expect(resolveHarnessSubstrate({ flag: { podPool: 'flag-only' }, config: config('pod', 'cfg'), env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'flag-only', source: 'config' });
  });

  test('legacy pod.pool remains the fallback before context and after the new pool layers', () => {
    const legacy = { harness: { substrate: 'pod' as const }, pod: { pool: 'legacy-pool@host:4' } };
    expect(resolveHarnessSubstrate({ config: legacy, env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'legacy-pool@host:4', source: 'config' });
    expect(resolveHarnessSubstrate({ flag: { substrate: 'pod' }, config: { pod: { pool: 'legacy-pool@host:4' } }, env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'legacy-pool@host:4', source: 'flag' });
    expect(resolveHarnessSubstrate({ config: { ...legacy, harness: { substrate: 'pod', podPool: 'new-pool' } }, env: {}, currentContext: context }).pool).toBe('new-pool');
    expect(resolveHarnessSubstrate({ config: legacy, env: { ELANOUS_POD_POOL: 'env-pool' }, currentContext: context }).pool).toBe('env-pool');
    expect(resolveHarnessSubstrate({ flag: { podPool: 'flag-pool' }, config: legacy, env: {}, currentContext: context }).pool).toBe('flag-pool');
  });

  test('configured pod without a reachable pool fails rather than running local', () => {
    expect(() => resolveHarnessSubstrate({ config: config('pod'), env: {}, currentContext: () => undefined }))
      .toThrow('`--substrate local` 로 명시하라');
  });

  test('user configuration parses and persists both harness fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ harness: { substrate: 'pod', podPool: 'pool-node-b@node-b:8' } }));
    const parsed = getUserConfig(path);
    expect(parsed.harness).toMatchObject({ substrate: 'pod', podPool: 'pool-node-b@node-b:8' });
    saveUserConfig(parsed, path);
    expect(JSON.parse(readFileSync(path, 'utf8')).harness).toMatchObject({ substrate: 'pod', podPool: 'pool-node-b@node-b:8' });
    const updated = getUserConfig(path);
    expect(updated.harness).toMatchObject({ substrate: 'pod', podPool: 'pool-node-b@node-b:8' });
    const emptyDir = mkdtempSync(join(tmpdir(), 'harness-empty-'));
    const initial = getUserConfig(join(emptyDir, 'missing.json'));
    expect(initial.harness?.substrate).toBeUndefined();
    expect(resolveHarnessSubstrate({ config: initial, env: {}, currentContext: () => undefined })).toEqual({ substrate: 'local', pool: null, source: 'default' });
    rmSync(dir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test('a persisted legacy pod.pool is parsed and selected before current context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-legacy-pool-'));
    const path = join(dir, 'config.json');
    try {
      writeFileSync(path, JSON.stringify({ harness: { substrate: 'pod' }, pod: { pool: 'legacy-pool@host:4' } }));
      const parsed = getUserConfig(path);
      expect(parsed.pod?.pool).toBe('legacy-pool@host:4');
      expect(resolveHarnessSubstrate({ config: parsed, env: {}, currentContext: context }).pool).toBe('legacy-pool@host:4');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('ask --dry-run preserves legacy pod.pool when the new pool is absent', async () => {
    setUserConfigOverlay((cfg) => ({ ...cfg, pod: { ...cfg.pod, pool: 'legacy-pool@host:4' }, harness: { ...cfg.harness, substrate: 'pod', podPool: undefined } }));
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async () => {} });
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/missing-goal', '--dry-run']);
      expect(lines).toContain('[harness] substrate=pod pool=legacy-pool@host:4 (config)');
    } finally {
      console.log = original;
    }
  });

  test('legacy pod.pool is passed to Pod dispatch instead of the current context', async () => {
    setUserConfigOverlay((cfg) => ({ ...cfg, pod: { ...cfg.pod, pool: 'legacy-pool@host:4' }, harness: { ...cfg.harness, substrate: 'pod', podPool: undefined } }));
    const dispatched = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', say: async () => {} });
    const original = console.log;
    console.log = () => {};
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'goal']);
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ entrance: 'cli-harness-say', podPool: 'legacy-pool@host:4' }), expect.anything());
    } finally {
      console.log = original;
      dispatched.mockRestore();
    }
  });

  test('ask --dry-run exposes the configured Pod and selected pool without dispatch', async () => {
    setUserConfigOverlay((cfg) => ({ ...cfg, harness: { ...cfg.harness, substrate: 'pod', podPool: 'pool-preview:2' }, pod: { ...cfg.pod, pool: undefined } }));
    const program = new Command().exitOverride();
    const local: string[] = [];
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async () => { local.push('ask'); } });
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/missing-goal', '--dry-run']);
      expect(lines).toContain('[harness] substrate=pod pool=pool-preview:2 (config)');
      expect(local).toEqual([]);
    } finally {
      console.log = original;
    }
  });

  test('configured pod with no pool refuses ask before any local dispatch', async () => {
    setUserConfigOverlay((cfg) => ({ ...cfg, harness: { ...cfg.harness, substrate: 'pod', podPool: undefined }, pod: { ...cfg.pod, pool: undefined } }));
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    const previousExit = process.exitCode;
    process.exitCode = 0;
    const program = new Command().exitOverride();
    const received: unknown[] = [];
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async (...args) => { received.push(args); } });
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => { errors.push(line); };
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/missing-goal', '--pod-pool', ' ', '--dry-run']);
      expect(process.exitCode).toBe(1);
      expect(received).toEqual([]);
      expect(errors.some((line) => line.includes('`--substrate local` 로 명시하라'))).toBe(true);
      process.exitCode = 0;
    } finally {
      console.error = original;
      process.exitCode = previousExit;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test('configured pod dispatches on ask and say, explicit local overrides it', async () => {
    setUserConfigOverlay((cfg) => ({ ...cfg, harness: { ...cfg.harness, substrate: 'pod', podPool: 'pool-test:2' }, pod: { ...cfg.pod, pool: undefined } }));
    const dispatched = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
    const local: string[] = [];
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async () => { local.push('ask'); }, say: async () => { local.push('say'); } });
    const original = console.log;
    console.log = () => {};
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/goal']);
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'goal']);
      expect(dispatched).toHaveBeenCalledTimes(2);
      expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ entrance: 'cli-harness-ask', podPool: 'pool-test:2' }), expect.anything());
      expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ entrance: 'cli-harness-say', podPool: 'pool-test:2' }), expect.anything());
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/goal', '--substrate', 'local']);
      expect(local).toEqual(['ask']);
      expect(dispatched).toHaveBeenCalledTimes(2);
    } finally {
      console.log = original;
      dispatched.mockRestore();
    }
  });

  test('ask --dry-run prints the resolved launch substrate without dispatch', async () => {
    const received: unknown[] = [];
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async (...args) => { received.push(args); } });
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/missing-goal', '--substrate', 'local', '--dry-run']);
      expect(lines).toContain('[harness] substrate=local (flag)');
      expect(received).toEqual([]);
    } finally { console.log = original; }
  });
});

test('dev --ask on a Pod keeps --no-auto-merge (and only then sends autoMerge false)', () => {
  expect(devAskPodDispatchInput({ autoMerge: false, base: 'main' }, 'docs/goals/g.md', 'pool-node-b@node-b:8'))
    .toEqual({ entrance: 'cli-harness-ask', input: 'docs/goals/g.md', podPool: 'pool-node-b@node-b:8', base: 'main', autoMerge: false });
  expect(devAskPodDispatchInput({}, 'g.md', 'p')).toEqual({ entrance: 'cli-harness-ask', input: 'g.md', podPool: 'p' });
});

test('harness path prefers harness.podPool over pod.pool', () => {
  expect(resolveHarnessSubstrate({ config: { harness: { substrate: 'pod', podPool: 'harness:20' }, pod: { pool: 'generic:2' } } as Pick<UserConfig, 'harness' | 'pod'>, env: {}, currentContext: () => 'ctx' }).pool).toBe('harness:20');
  expect(resolveHarnessSubstrate({ config: { harness: { substrate: 'pod' }, pod: { pool: 'generic:2' } } as Pick<UserConfig, 'harness' | 'pod'>, env: {}, currentContext: () => 'ctx' }).pool).toBe('generic:2');
});
