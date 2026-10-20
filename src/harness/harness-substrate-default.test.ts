import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { buildUserConfig, getUserConfig, saveUserConfig, setUserConfigOverlay, type UserConfig } from '../user-config.js';
import * as podDispatch from './harness-pod-dispatch.js';
import { AUTO_LOCAL_MIN_AVAILABLE_MEMORY_BYTES, checkHarnessPodPool, harnessLaunchPolicyConfig, nextLocalLaneCap, readAutoSubstrateSignals, resolveHarnessSubstrate, routeAutoSubstrate } from './harness-substrate-default.js';
import { debug } from '../debug/log.js';
import { devAskPodDispatchInput } from './harness-substrate-default.js';
import { installHarnessCliCommand } from './harness-cli-command.js';
import { resolveCodexQuotaPolicy, codexPolicyAllowsCredits } from '../oauth/codex-quota-policy.js';
import { normalizeFallbackChain } from '../oauth/fallback-chain.js';
import { planPodProvider } from '../task-orchestrator/surfaces/pod-account-broker.js';
import { resolvePodPoolSpec } from '../task-orchestrator/surfaces/pod-pool.js';
import { recommendConcurrency, type PoolLeaseMeasure } from '../task-orchestrator/surfaces/pod-lease.js';
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
  // SUBSCRIPTION-EXHAUST-REROUTE: this test measures the codex account plan, so the Pod child default (openrouter) is off —
  //   otherwise the result depends on whether the runner has an OpenRouter key.
  const operational = { llm: { codexQuotaPolicy: 'credits', codexAccountRotationThresholdPercentByAccount: { team: 97, other: 99 }, fallbackChain: ['codex-rotate'] }, harness: { podPool: 'pool-node-b@node-b:8' }, tools: { selfImplement: { podChildDefault: 'off' } } };
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
  const originalOwnerAccount = process.env.ELANOUS_REMOTE_CODEX_ACCOUNT;
  const originalOwnerUsed = process.env.ELANOUS_REMOTE_CODEX_USED_PERCENT;
  const originalOwnerThreshold = process.env.ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT;
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

    // The remote-parent path enters harness say, which dispatches this self-orchestrate CLI before any Pod Job.
    // Owner markers must pin the real Pod broker despite the remote operational account cap being 99%.
    process.env.ELANOUS_REMOTE_CODEX_ACCOUNT = 'other';
    process.env.ELANOUS_REMOTE_CODEX_USED_PERCENT = '48';
    process.env.ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT = '60';
    await program.parseAsync(['node', 'elanous', 'self', 'orchestrate', 'remote owner probe', '--substrate', 'pod', '--no-pod-rebuild', '--no-supervise', '--json']);
    expect(broker.mock.calls.at(-1)?.[0]).toMatchObject({
      codexCandidates: [{ name: 'other', home: otherHome, storeKey: 'openai-codex:other', reached: false, usedPercent: 48 }],
      thresholdPercentByAccount: { other: 60 }, creditsAllowed: true,
    });
    expect(providerPlans.at(-1)).toEqual({ provider: 'openai-codex', accounts: ['other'], excluded: [], grokSubscriptionEligible: false });
    const ownerProviderCalls = broker.mock.calls.length;
    await expect(program.parseAsync(['node', 'elanous', 'self', 'orchestrate', 'remote owner probe', '--substrate', 'pod', '--child-llm-provider', 'grok', '--no-pod-rebuild', '--no-supervise', '--json'])).rejects.toThrow('STOP_1');
    expect(exit).toHaveBeenCalledWith(2);
    expect(broker).toHaveBeenCalledTimes(ownerProviderCalls);
    const callsBeforeMismatchedOverride = broker.mock.calls.length;
    await expect(program.parseAsync(['node', 'elanous', 'self', 'orchestrate', 'remote owner probe', '--substrate', 'pod', '--pod-account', 'team', '--no-pod-rebuild', '--no-supervise', '--json'])).rejects.toThrow('STOP_1');
    expect(exit).toHaveBeenCalledWith(2);
    expect(broker).toHaveBeenCalledTimes(callsBeforeMismatchedOverride);
    for (const [key, value] of [['ELANOUS_REMOTE_CODEX_ACCOUNT', originalOwnerAccount], ['ELANOUS_REMOTE_CODEX_USED_PERCENT', originalOwnerUsed], ['ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT', originalOwnerThreshold]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }

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

    // SUBSCRIPTION-EXHAUST-REROUTE — runtime wiring: with no --child-llm-* and no podChildDefault in the operational
    //   policy, the real `self orchestrate --substrate pod` action hands the Pod spawn an openrouter/glm-5.3 child and
    //   never asks the codex account broker.
    writeFileSync(join(operationalRoot, 'config.json'), JSON.stringify({ ...operational, tools: { selfImplement: {} } }));
    writeFileSync(join(derivedRoot, 'config.json'), JSON.stringify({ ...operational, tools: { selfImplement: {} } }));
    const originalOrKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key';
    const spawnOptions: Array<Record<string, unknown>> = [];
    const actualSpawn = podSurface.podSelfImplementSpawn;
    const spawn = spyOn(podSurface, 'podSelfImplementSpawn').mockImplementation(((options: Record<string, unknown>) => { spawnOptions.push(options); return actualSpawn(options as never); }) as never);
    try {
      const brokerCalls = broker.mock.calls.length;
      await program.parseAsync(['node', 'elanous', 'self', 'orchestrate', 'default probe', '--substrate', 'pod', '--no-pod-rebuild', '--no-supervise', '--json']);
      expect(broker.mock.calls.length).toBe(brokerCalls);
      expect(spawnOptions.at(-1)).toMatchObject({ provider: 'openrouter', childModel: 'openrouter/z-ai/glm-5.3', childProviderExplicit: true, account: 'openrouter' });
      expect((spawnOptions.at(-1)!.passEnv as string[])).toContain('OPENROUTER_API_KEY');
    } finally {
      spawn.mockRestore();
      if (originalOrKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalOrKey;
    }
  } finally {
    process.argv.splice(process.argv.lastIndexOf('--harness-internal'), 1);
    orchestrateCommand.setOptionValue('goalFile', originalGoalFiles);
    resetElanousConfigDir();
    if (originalConfigDirOverride !== undefined) setElanousConfigDir(originalConfigDirOverride);
    for (const [key, value] of Object.entries({ HOME: originalHome, XDG_CONFIG_HOME: originalXdg, ELANOUS_STATE_DIR: originalState, ELANOUS_STATE_DIR_SOURCE: originalStateSource, ELANOUS_HARNESS_ENTRANCE: originalEntrance, NODE_ENV: originalNodeEnv, ELANOUS_POD_POOL: originalPool, ELANOUS_CODEX_QUOTA_POLICY: originalQuota, ELANOUS_REMOTE_CODEX_ACCOUNT: originalOwnerAccount, ELANOUS_REMOTE_CODEX_USED_PERCENT: originalOwnerUsed, ELANOUS_REMOTE_CODEX_THRESHOLD_PERCENT: originalOwnerThreshold })) {
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

const spareHost = {
  podAdmission: { recommended: 0, limitedBy: 'memory' as const },
  load1: 3, cores: 8, availableMemoryBytes: AUTO_LOCAL_MIN_AVAILABLE_MEMORY_BYTES, localLaneOpen: true,
};

describe('next local lane cap', () => {
  const request = {
    current: 30, wanted: 50, lastRaisedAtMs: null, nowMs: 1_000_000,
    load1: 3, cores: 8,
  };

  test('raises a 30→50 request by at most five and emits the lane-step observation', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(nextLocalLaneCap(request)).toEqual({ cap: 35, action: 'raise', reason: 'local-load-spare' });
      expect(log).toHaveBeenCalledWith('harness.guardian', 'lane-step', {
        ...request, cap: 35, action: 'raise', reason: 'local-load-spare',
      });
    } finally { log.mockRestore(); }
  });

  test('holds another increase before fifteen minutes, then permits it at the boundary', () => {
    const lastRaisedAtMs = 1_000_000;
    expect(nextLocalLaneCap({ ...request, current: 35, lastRaisedAtMs, nowMs: lastRaisedAtMs + 15 * 60 * 1000 - 1 }))
      .toEqual({ cap: 35, action: 'hold', reason: 'raise-cooldown' });
    expect(nextLocalLaneCap({ ...request, current: 35, lastRaisedAtMs, nowMs: lastRaisedAtMs + 15 * 60 * 1000 }))
      .toEqual({ cap: 40, action: 'raise', reason: 'local-load-spare' });
  });

  test('lowers the cap immediately when load reaches the core count', () => {
    expect(nextLocalLaneCap({ ...request, load1: 8 }))
      .toEqual({ cap: 25, action: 'lower', reason: 'local-load-overloaded' });
  });

  test('holds when load or core count is unreadable', () => {
    expect(nextLocalLaneCap({ ...request, load1: null }))
      .toEqual({ cap: 30, action: 'hold', reason: 'load-unreadable' });
    expect(nextLocalLaneCap({ ...request, cores: null }))
      .toEqual({ cap: 30, action: 'hold', reason: 'load-unreadable' });
    expect(nextLocalLaneCap({ ...request, load1: Number.NaN }))
      .toEqual({ cap: 30, action: 'hold', reason: 'load-unreadable' });
  });
});

describe('auto substrate routing', () => {
  test('collector reads injected launch-host measurements, Pod admission and local lane', () => {
    const calls: string[] = [];
    const signals = readAutoSubstrateSignals({
      loadavg: () => { calls.push('loadavg'); return [3, 4, 5]; },
      cpus: () => { calls.push('cpus'); return Array(8).fill({}) as ReturnType<typeof import('node:os').cpus>; },
      freemem: () => { calls.push('freemem'); return AUTO_LOCAL_MIN_AVAILABLE_MEMORY_BYTES; },
      podAdmission: () => { calls.push('podAdmission'); return { recommended: 0, limitedBy: 'memory' }; },
      localLaneOpen: () => { calls.push('localLaneOpen'); return true; },
    });
    expect(signals).toEqual(spareHost);
    expect(calls).toEqual(['podAdmission', 'loadavg', 'cpus', 'freemem', 'localLaneOpen']);
    expect(routeAutoSubstrate(signals)).toEqual({ substrate: 'local', reason: 'pod-memory-blocked-local-spare' });
  });

  test('unavailable or throwing Pod admission remains unobserved, and local lane defaults closed', () => {
    const host = {
      loadavg: () => [3, 4, 5],
      cpus: () => Array(8).fill({}) as ReturnType<typeof import('node:os').cpus>,
      freemem: () => AUTO_LOCAL_MIN_AVAILABLE_MEMORY_BYTES,
    };
    for (const podAdmission of [() => null, () => { throw new Error('unreachable'); },
      () => ({ recommended: null, limitedBy: null })] as const) {
      const signals = readAutoSubstrateSignals({ ...host, podAdmission });
      expect(signals).toEqual({ ...spareHost, podAdmission: null, localLaneOpen: false });
      expect(routeAutoSubstrate(signals)).toEqual({ substrate: 'pod', reason: 'pod-admission-unobserved' });
    }
  });

  test('resolve collects once only for auto without supplied signals and logs the collected payload', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    let calls = 0;
    const readAutoSignals = () => { calls++; return spareHost; };
    const args = { config: config('pod', 'cfg'), env: {}, currentContext: context, readAutoSignals };
    try {
      expect(resolveHarnessSubstrate({ ...args, flag: { substrate: 'auto' } }))
        .toEqual({ substrate: 'local', pool: null, source: 'flag' });
      expect(calls).toBe(1);
      expect(log).toHaveBeenCalledWith('harness.substrate', 'auto-signals', spareHost);
      expect(resolveHarnessSubstrate({ ...args, flag: { substrate: 'auto' }, autoSignals: { ...spareHost, localLaneOpen: false } }))
        .toEqual({ substrate: 'pod', pool: 'cfg', source: 'flag' });
      expect(calls).toBe(1);
      expect(resolveHarnessSubstrate({ ...args, flag: { substrate: 'pod' } })).toEqual({ substrate: 'pod', pool: 'cfg', source: 'flag' });
      expect(resolveHarnessSubstrate({ ...args, flag: { substrate: 'local' } })).toEqual({ substrate: 'local', pool: null, source: 'flag' });
      expect(calls).toBe(1);
      expect(log.mock.calls.filter(([category, event]) => category === 'harness.substrate' && event === 'auto-signals')).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  test('default collector measures the selected flag pool, not the configured pool, and logs its admission', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    const measured: string[][] = [];
    const gi = 1024 ** 3;
    const measurePoolLease = ((members: Parameters<typeof import('../task-orchestrator/surfaces/pod-lease.js').measurePoolLease>[0], options: { measureUsage?: boolean; skipDnsProbe?: boolean }) => {
      measured.push(members.map((m) => m.context));
      expect(options).toEqual({ measureUsage: true, skipDnsProbe: true });
      return { members: members.map((m) => ({
        context: m.context, capacity: m.capacity, running: 0, pending: 0, unleasedRunning: 0,
        memoryLimitBytes: 0, allocatableMemoryBytes: m.context === 'flag-pool' ? 8 * gi : 32 * gi,
        allocatableCpuMillicores: 8_000,
        availableMemoryByNodeBytes: [m.context === 'flag-pool' ? 8 * gi : 32 * gi], reason: null,
      })) };
    }) as typeof import('../task-orchestrator/surfaces/pod-lease.js').measurePoolLease;
    const deps = {
      loadavg: () => [3, 4, 5],
      cpus: () => Array(8).fill({}) as ReturnType<typeof import('node:os').cpus>,
      freemem: () => AUTO_LOCAL_MIN_AVAILABLE_MEMORY_BYTES,
      measurePoolLease,
    };
    try {
      const args = { config: { harness: { substrate: 'auto' as const, podPool: 'default-pool:8' } }, env: {},
        currentContext: () => { throw new Error('explicit pool should not read context'); }, autoReadDeps: deps };
      expect(resolveHarnessSubstrate({ ...args, flag: { substrate: 'auto', podPool: 'flag-pool:8' } }))
        .toEqual({ substrate: 'pod', pool: 'flag-pool:8', source: 'flag' });
      expect(measured).toEqual([['flag-pool']]);
      expect(log).toHaveBeenCalledWith('harness.substrate', 'auto-signals', {
        load1: 3, cores: 8, availableMemoryBytes: AUTO_LOCAL_MIN_AVAILABLE_MEMORY_BYTES,
        podAdmission: { recommended: 0, limitedBy: 'memory' }, localLaneOpen: false,
      });
      log.mockClear();
      expect(resolveHarnessSubstrate(args)).toEqual({ substrate: 'pod', pool: 'default-pool:8', source: 'config' });
      expect(measured).toEqual([['flag-pool'], ['default-pool']]);
      expect(log).toHaveBeenCalledWith('harness.substrate', 'auto-signals', {
        load1: 3, cores: 8, availableMemoryBytes: AUTO_LOCAL_MIN_AVAILABLE_MEMORY_BYTES,
        podAdmission: { recommended: 2, limitedBy: 'memory' }, localLaneOpen: false,
      });
    } finally { log.mockRestore(); }
  });

  test('real lease recommendation limited by memory feeds auto routing', () => {
    const gi = 1024 ** 3;
    const measure: PoolLeaseMeasure = { members: [{
      context: 'pool-node-b', capacity: 8, running: 0, pending: 0, unleasedRunning: 0,
      memoryLimitBytes: 0, allocatableMemoryBytes: 8 * gi, allocatableCpuMillicores: 8_000,
      availableMemoryByNodeBytes: [8 * gi], reason: null,
    }] };
    const admission = recommendConcurrency(measure, { capacity: 8, accounts: 1, perAccount: 1 });
    expect(admission).toMatchObject({ recommended: 0, limitedBy: 'memory' });
    expect(routeAutoSubstrate({ ...spareHost, podAdmission: admission }))
      .toEqual({ substrate: 'local', reason: 'pod-memory-blocked-local-spare' });
  });

  test('memory-limited Pod admission and a spare launch host take local with one reason', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(routeAutoSubstrate(spareHost)).toEqual({ substrate: 'local', reason: 'pod-memory-blocked-local-spare' });
      expect(resolveHarnessSubstrate({ flag: { substrate: 'auto' }, config: config('pod', 'pool-node-b@node-b:8'), autoSignals: spareHost, env: {}, currentContext: context }))
        .toEqual({ substrate: 'local', pool: null, source: 'flag' });
      expect(log).toHaveBeenCalledWith('harness.substrate', 'route', { substrate: 'local', reason: 'pod-memory-blocked-local-spare', source: 'flag' });
    } finally { log.mockRestore(); }
  });

  test('Pod remains the auto default with exactly one reason when any local prerequisite fails', () => {
    for (const [signals, reason] of [
      [{ ...spareHost, podAdmission: { recommended: 1, limitedBy: 'memory' as const } }, 'pod-admission-not-memory-blocked'],
      [{ ...spareHost, podAdmission: { recommended: 0, limitedBy: 'capacity' as const } }, 'pod-admission-not-memory-blocked'],
      [{ ...spareHost, podAdmission: null }, 'pod-admission-unobserved'],
      [{ ...spareHost, podAdmission: { recommended: null, limitedBy: null } }, 'pod-admission-unobserved'],
      [{ ...spareHost, podAdmission: { recommended: 0, limitedBy: null } }, 'pod-admission-unobserved'],
      [{ ...spareHost, localLaneOpen: false }, 'local-lane-closed'],
      [{ ...spareHost, load1: 4 }, 'local-load-not-spare'],
      [{ ...spareHost, load1: null }, 'local-load-not-spare'],
      [{ ...spareHost, cores: 0 }, 'local-load-not-spare'],
      [{ ...spareHost, availableMemoryBytes: AUTO_LOCAL_MIN_AVAILABLE_MEMORY_BYTES - 1 }, 'local-memory-not-spare'],
      [{ ...spareHost, availableMemoryBytes: null }, 'local-memory-not-spare'],
    ] as const) expect(routeAutoSubstrate(signals)).toEqual({ substrate: 'pod', reason });
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(resolveHarnessSubstrate({ flag: { substrate: 'auto' }, config: config('pod', 'cfg'), env: {}, currentContext: context }))
        .toEqual({ substrate: 'pod', pool: 'cfg', source: 'flag' });
      expect(resolveHarnessSubstrate({ flag: { substrate: 'auto' }, config: config('pod', 'cfg'), autoSignals: { ...spareHost, load1: 4 }, env: {}, currentContext: context }))
        .toEqual({ substrate: 'pod', pool: 'cfg', source: 'flag' });
      expect(log).toHaveBeenCalledWith('harness.substrate', 'route', { substrate: 'pod', reason: 'local-load-not-spare', source: 'flag' });
    } finally { log.mockRestore(); }
  });

  test('auto without admission signals keeps Pod and records unobserved rather than known-unblocked', () => {
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(resolveHarnessSubstrate({ flag: { substrate: 'auto' }, config: config('pod', 'cfg'), env: {}, currentContext: context }))
        .toEqual({ substrate: 'pod', pool: 'cfg', source: 'flag' });
      expect(log).toHaveBeenCalledWith('harness.substrate', 'route', { substrate: 'pod', reason: 'pod-admission-unobserved', source: 'flag' });
      expect(log).not.toHaveBeenCalledWith('harness.substrate', 'route', { substrate: 'pod', reason: 'pod-admission-not-memory-blocked', source: 'flag' });
    } finally { log.mockRestore(); }
  });

  test('a config file auto survives the real loader and routes pod by default with an observed route', () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrate-auto-config-'));
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, JSON.stringify({ harness: { substrate: 'auto', podPool: 'cfg' } }));
      const loaded = buildUserConfig(path);
      expect(loaded.harness?.substrate).toBe('auto');
      const log = spyOn(debug, 'log').mockImplementation(() => {});
      try {
        expect(resolveHarnessSubstrate({ config: loaded, env: {}, currentContext: context }))
          .toEqual({ substrate: 'pod', pool: 'cfg', source: 'config' });
        expect(log.mock.calls.filter(([category, event]) => category === 'harness.substrate' && event === 'route'))
          .toEqual([['harness.substrate', 'route', { substrate: 'pod', reason: 'pod-admission-unobserved', source: 'config' }]]);
      } finally { log.mockRestore(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('NaN host observations never authorize local', () => {
    expect(routeAutoSubstrate({ ...spareHost, availableMemoryBytes: Number.NaN })).toEqual({ substrate: 'pod', reason: 'local-memory-not-spare' });
    expect(routeAutoSubstrate({ ...spareHost, availableMemoryBytes: Number.POSITIVE_INFINITY })).toEqual({ substrate: 'pod', reason: 'local-memory-not-spare' });
    expect(routeAutoSubstrate({ ...spareHost, cores: Number.NaN })).toEqual({ substrate: 'pod', reason: 'local-load-not-spare' });
    expect(routeAutoSubstrate({ ...spareHost, load1: Number.NaN })).toEqual({ substrate: 'pod', reason: 'local-load-not-spare' });
  });

  test('an injected auto config routes while explicit flags retain priority', () => {
    const autoConfig: Pick<UserConfig, 'harness' | 'pod'> = { harness: { substrate: 'auto', podPool: 'cfg' } };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(resolveHarnessSubstrate({ config: autoConfig, autoSignals: spareHost, env: {}, currentContext: context }))
        .toEqual({ substrate: 'local', pool: null, source: 'config' });
      expect(resolveHarnessSubstrate({ flag: { substrate: 'pod' }, config: autoConfig, autoSignals: spareHost, env: {}, currentContext: context }))
        .toEqual({ substrate: 'pod', pool: 'cfg', source: 'flag' });
      expect(resolveHarnessSubstrate({ flag: { substrate: 'local' }, config: autoConfig, autoSignals: { ...spareHost, localLaneOpen: false }, env: {}, currentContext: context }))
        .toEqual({ substrate: 'local', pool: null, source: 'flag' });
      expect(log.mock.calls.filter(([category, event]) => category === 'harness.substrate' && event === 'route')).toHaveLength(1);
    } finally { log.mockRestore(); }
  });
});

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
  /** POD-POOL-UNCAPPED-SPEC — a passing pre-launch pool check, so tests never shell out to kubectl. */
  const poolCheckOk = (pool: string) => ({ ok: true, ready: [pool], dropped: [] });

  test('flag, config, default and four pool layers', () => {
    expect(resolveHarnessSubstrate({ config: config(), env: {}, currentContext: context })).toEqual({ substrate: 'local', pool: null, source: 'default' });
    expect(resolveHarnessSubstrate({ config: config('pod', 'cfg'), env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'cfg', source: 'config' });
    expect(resolveHarnessSubstrate({ flag: { substrate: 'local' }, config: config('pod', 'cfg'), env: {}, currentContext: context })).toEqual({ substrate: 'local', pool: null, source: 'flag' });
    expect(resolveHarnessSubstrate({ flag: { substrate: 'pod', podPool: 'flag' }, config: config('local', 'cfg'), env: { ELANOUS_POD_POOL: 'env' }, currentContext: context })).toEqual({ substrate: 'pod', pool: 'flag', source: 'flag' });
    expect(resolveHarnessSubstrate({ config: config('pod', 'cfg'), env: { ELANOUS_POD_POOL: 'env' }, currentContext: context })).toEqual({ substrate: 'pod', pool: 'env', source: 'config' });
    expect(resolveHarnessSubstrate({ config: config('pod'), env: {}, currentContext: context, poolCheck: poolCheckOk })).toEqual({ substrate: 'pod', pool: 'current-context', source: 'config' });
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

  // POD-POOL-UNCAPPED-SPEC — «없는 kube 문맥»은 조용히 넘어가지 않는다: 발사 전 풀 점검이 먼저 거부한다
  //   (10-10 프로브: 문맥은 있는데 클러스터가 없으니 recommended=0 으로 35분 정지 · 6런).
  test('an implicit kube context that fails the pre-launch pool check is refused before launch', () => {
    const checked: string[] = [];
    const poolCheck = (pool: string) => {
      checked.push(pool);
      return { ok: false, ready: [], dropped: [{ context: pool, reason: 'Unable to connect to the server: dial tcp: i/o timeout' }] };
    };
    expect(() => resolveHarnessSubstrate({ config: config('pod'), env: {}, currentContext: () => 'k3d-gone', poolCheck }))
      .toThrow('현재 컨텍스트 「k3d-gone」 이 발사 전 풀 점검을 넘지 못했다');
    expect(() => resolveHarnessSubstrate({ flag: { substrate: 'pod' }, config: config(), env: {}, currentContext: () => 'k3d-gone', poolCheck }))
      .toThrow('dial tcp: i/o timeout');
    expect(checked).toEqual(['k3d-gone', 'k3d-gone']);
  });

  test('a context that passes the pre-launch check resolves exactly as before (substrate · pool · source)', () => {
    expect(resolveHarnessSubstrate({ config: config('pod'), env: {}, currentContext: () => 'k3d-elanous-pool', poolCheck: poolCheckOk }))
      .toEqual({ substrate: 'pod', pool: 'k3d-elanous-pool', source: 'config' });
  });

  test('an explicit pool (flag · env · config) is not gated here — the launch site runs checkPodPool for it', () => {
    const refuse = () => { throw new Error('must not run the context check for an explicit pool'); };
    expect(resolveHarnessSubstrate({ flag: { substrate: 'pod', podPool: 'pool-node-b@node-b:8' }, config: config(), env: {}, currentContext: () => 'k3d-gone', poolCheck: refuse }).pool).toBe('pool-node-b@node-b:8');
    expect(resolveHarnessSubstrate({ config: config('pod'), env: { ELANOUS_POD_POOL: 'env-pool' }, currentContext: () => 'k3d-gone', poolCheck: refuse }).pool).toBe('env-pool');
    expect(resolveHarnessSubstrate({ config: config('pod', 'cfg-pool'), env: {}, currentContext: () => 'k3d-gone', poolCheck: refuse }).pool).toBe('cfg-pool');
  });

  test('kubectl that cannot run at all is «unmeasured», not «unfit»; an unparseable context is a measured refusal', () => {
    expect(resolveHarnessSubstrate({ config: config('pod'), env: {}, currentContext: () => 'k3d-elanous-pool',
      poolCheck: (pool) => ({ ok: true, ready: [], dropped: [{ context: pool, reason: 'rc=null' }], unmeasured: 'kubectl 을 실행할 수 없다' }) }).pool).toBe('k3d-elanous-pool');
    expect(checkHarnessPodPool('bad context')).toMatchObject({ ok: false, ready: [], dropped: [{ context: 'bad context', reason: expect.stringContaining('못 읽는 노드') }] });
  });

  test('only a missing kubectl (spawn ENOENT) is «unmeasured»; a kubectl timeout is a measured refusal', () => {
    const missing = checkHarnessPodPool('k3d-elanous-pool', () => ({ status: null, stdout: '', stderr: 'Error: spawnSync kubectl ENOENT' }));
    expect(missing).toMatchObject({ ok: true, ready: [], unmeasured: 'kubectl 을 실행할 수 없다' });
    const timedOut = checkHarnessPodPool('k3d-elanous-pool', () => ({ status: null, stdout: '', stderr: 'Error: spawnSync kubectl ETIMEDOUT' }));
    expect(timedOut.ok).toBe(false);
    expect(timedOut.unmeasured).toBeUndefined();
    expect(timedOut.dropped).toEqual([{ context: 'k3d-elanous-pool', reason: expect.stringContaining('ETIMEDOUT') }]);
    const answered = checkHarnessPodPool('k3d-elanous-pool', () => ({ status: 1, stdout: '', stderr: 'Error from server (NotFound): namespaces "elanous-test" not found' }));
    expect(answered).toMatchObject({ ok: false, ready: [] });
    expect(answered.unmeasured).toBeUndefined();
    expect(checkHarnessPodPool('k3d-elanous-pool', () => ({ status: 0, stdout: '', stderr: '' }))).toEqual({ ok: true, ready: ['k3d-elanous-pool'], dropped: [] });
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
      process.exitCode = previousExit ?? 0;
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
