import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../../debug/log.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { appendRunLedgerEntry, runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePodArtifactChunks } from './pod-artifact-return.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { CONTROL_INBOX_DIR_ENV } from '../../harness/control-inbox.js';
import { podFragmentFinished, readPodFragment } from '../../harness/self-send-target.js';
import { POD_JOB_DEADLINE_SECONDS, hostGrokCredentials, podJobManifest, podJobName, podSalvageScript, podSelfImplementSpawn, recordPodSalvage, type Kubectl } from './self-implement-pod.js';
import type { PodSource } from './pod-source-receive.js';
import { defaultGrokModel } from '../../grok/models.js';

const CREDS = () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_x' });

function fakeKubectl(conditions: string[], logs: string) {
  const calls: Array<{ args: string; input?: string }> = [];
  let polls = 0;
  const k: Kubectl = (args, input) => {
    calls.push({ args: args.join(' '), ...(input ? { input } : {}) });
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };   // 재개 존재 확인 — 새 Job
    if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: conditions[Math.min(polls++, conditions.length - 1)] ?? '', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: logs, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { k, calls };
}

describe('pod source delivery', () => {
  const bundle: PodSource = { kind: 'bundle', bundlePath: '/host/source.bundle', sha256: 'ab'.repeat(32), sizeBytes: 12, headCommit: 'cd'.repeat(20) };

  function sourceKubectl(phase: string) {
    const calls: string[] = [];
    const k: Kubectl = (args) => {
      calls.push(args.join(' '));
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.includes('pods')) return { status: 0, stdout: `si-pod ${phase}\n`, stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    return { k, calls };
  }

  test('bundle source applies the Job, then cp, then touch /tmp/source.ready', async () => {
    const { k, calls } = sourceKubectl('Running');
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, source: bundle })({ feature: 'x', spaceId: 'src-bundle' }).done;
    const applyAt = calls.findIndex((c) => c.endsWith('apply -f -') && calls.filter((x) => x.endsWith('apply -f -')).length >= 1 && c === calls.filter((x) => x.endsWith('apply -f -'))[1]);
    const cpAt = calls.findIndex((c) => c.includes(' cp ') && c.includes('/tmp/source.bundle') && c.includes('-c child'));
    const touchAt = calls.findIndex((c) => c.includes('exec') && c.includes('touch /tmp/source.ready'));
    expect(applyAt).toBeGreaterThanOrEqual(0);
    expect(cpAt).toBeGreaterThan(applyAt);
    expect(touchAt).toBeGreaterThan(cpAt);
  });

  test('omitted source never calls kubectl cp', async () => {
    const { k, calls } = sourceKubectl('Running');
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 'src-default' }).done;
    expect(calls.filter((c) => c.includes(' cp '))).toHaveLength(0);
  });
});

describe('pod grok credentials', () => {
  test('subscription: copies access token and expiry, not refresh; fake kubectl receives no codex credentials', async () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-grok-'));
    try {
      mkdirSync(join(home, '.grok'));
      const authPath = join(home, '.grok', 'auth.json');
      const original = JSON.stringify({ 'https://auth.x.ai::client': { key: 'access-x', expires_at: '2030-01-01T00:00:00Z', refresh_token: 'refresh-x', user_id: 'u' } });
      writeFileSync(authPath, original);
      const { k, calls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({ provider: 'grok', kubectl: k, sleep: async () => {}, grokCredentials: () => hostGrokCredentials({ home, env: { XAI_API_KEY: 'paid-key' }, ghToken: () => 'gh' }), passEnv: ['XAI_API_KEY'], env: { XAI_API_KEY: 'paid-key' } })({ feature: 'x', spaceId: 'grok-sub' }).done;
      const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      expect(Object.keys(secret.stringData)).toContain('grok-auth.json');
      expect(Object.keys(secret.stringData)).not.toContain('codex-auth.json');
      expect(Object.keys(secret.stringData)).not.toContain('elanous-auth.json');
      expect(secret.stringData['grok-auth.json']).toContain('access-x');
      expect(secret.stringData['grok-auth.json']).toContain('expires_at');
      expect(secret.stringData['grok-auth.json']).not.toMatch(/refresh/i);
      expect(JSON.stringify(secret)).not.toContain('paid-key');
      expect(secret.stringData['env-XAI_API_KEY']).toBeUndefined();
      expect(readFileSync(authPath, 'utf8')).toBe(original);
      const script: string = job.spec.template.spec.containers[0].args[0];
      expect(script).toContain('install -m 600 /creds/grok-auth.json ~/.grok/auth.json');
      // Pod 안 하니스 «부모»(리뷰·감독)도 grok 으로 — codex 자격이 없으니 이게 없으면 부모가 죽는다.
      expect(script).toContain('export ELANOUS_LLM_PROVIDER=grok');
      expect(script).not.toContain('export XAI_API_KEY');
      expect(script).not.toContain('/creds/codex-auth.json');
      expect(job.spec.template.spec.containers[0].env.map((entry: { name: string }) => entry.name)).not.toContain('XAI_API_KEY');
      expect(script).toContain(`'--child-llm-provider' 'grok' '--child-llm-model' '${defaultGrokModel().id}'`);
      expect(secret.stringData['env-ELANOUS_POD_CREDENTIAL_TOKEN']).toBeUndefined();
      expect(job.spec.template.spec.containers[0].env.map((entry: { name: string }) => entry.name)).not.toContain('ELANOUS_POD_CREDENTIAL_URL');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a caller cannot inject a refresh token or an unapproved API key into a Grok Secret', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    const opts = { provider: 'grok' as const, kubectl: k, sleep: async () => {}, env: {} };
    const rejected = await podSelfImplementSpawn({ ...opts, grokCredentials: () => ({ grokAuth: JSON.stringify({ scope: { key: 'access', refresh_token: 'refresh' } }), ghToken: 'gh' }) })({ feature: 'x', spaceId: 'grok-bad-sub' }).done;
    expect(rejected.error?.message).toContain('refresh');
    const paid = await podSelfImplementSpawn({ ...opts, grokCredentials: () => ({ grokApiKey: 'paid-key', ghToken: 'gh' }) })({ feature: 'x', spaceId: 'grok-bad-key' }).done;
    expect(paid.error?.message).toContain('opt-in');
    expect(calls.some((call) => call.args.endsWith('apply -f -'))).toBe(false);
  });

  test('API key alone fails closed, opt-in mounts key only without Codex credentials', async () => {
    expect(() => hostGrokCredentials({ home: '/nonexistent-grok-home', env: { XAI_API_KEY: 'paid-key' }, ghToken: () => 'gh' })).toThrow('opt-in 꺼짐');
    const { k, calls } = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({ provider: 'grok', grokApiKeyOptIn: true, kubectl: k, sleep: async () => {}, grokCredentials: () => hostGrokCredentials({ home: '/nonexistent-grok-home', env: { XAI_API_KEY: 'paid-key' }, apiKeyOptIn: true, ghToken: () => 'gh' }), passEnv: ['XAI_API_KEY'], env: { XAI_API_KEY: 'paid-key' } })({ feature: 'x', spaceId: 'grok-api' }).done;
    const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(secret.stringData['grok-api-key']).toBe('paid-key');
    expect(secret.stringData['codex-auth.json']).toBeUndefined();
    expect(secret.stringData['env-XAI_API_KEY']).toBeUndefined();
    expect(job.spec.template.spec.containers[0].args[0]).toContain('install -m 600 /creds/grok-api-key ~/.grok/api-key');
    expect(job.spec.template.spec.containers[0].args[0]).toContain('export XAI_API_KEY="$(cat ~/.grok/api-key)"');
    expect(job.spec.template.spec.containers[0].args[0]).toContain('export ELANOUS_LLM_PROVIDER=grok');
    expect(secret.stringData['env-ELANOUS_POD_CREDENTIAL_TOKEN']).toBeUndefined();
    expect(job.spec.template.spec.containers[0].env.map((entry: { name: string }) => entry.name)).not.toContain('ELANOUS_POD_CREDENTIAL_URL');
  });
});

describe('podSelfImplementSpawn', () => {
  test('job names are per-run (parallel-safe) and k8s-valid', () => {
    const a = podJobName('orch-1234/goal A');
    const b = podJobName('orch-1234/goal B');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9-]{1,58}$/);
  });

  test('applies secret then job, polls to Complete, parses the last JSON line, deletes the secret, drops the pod-internal worktreePath', async () => {
    const json = JSON.stringify({ stage: 'pr-opened', ok: true, worktreePath: '/home/ubuntu/x', prUrl: 'https://github.com/o/r/pull/9', prNumber: 9 });
    const { k, calls } = fakeKubectl(['', '', 'Complete'], `noise\n${json}\n`);
    const spawn = podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-7' } });
    const { address, done } = spawn({ feature: 'do x', spaceId: 'orch-1', openPr: true });
    expect(address).toBe('self-impl:orch-1');
    const r = await done;
    expect(r.exitCode).toBe(0);
    expect(r.disposition?.prUrl).toBe('https://github.com/o/r/pull/9');
    expect(r.disposition?.worktreePath).toBeUndefined();
    const applied = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(applied.map((m) => m.kind)).toEqual(['Secret', 'Job']);
    expect(applied[0].stringData.feature).toBe('do x');
    const env = applied[1].spec.template.spec.containers[0].env;
    expect(env).toContainEqual({ name: 'ELANOUS_RUN_ID', value: expect.stringMatching(/^run-[0-9a-f-]+$/) });
    expect(env).toContainEqual({ name: 'ELANOUS_PARENT_RUN_ID', value: 'run-7' });
    expect(env).toContainEqual({ name: 'ELANOUS_SUBSTRATE', value: 'pod' });
    expect(applied[1].spec.template.spec.containers[0].args[0]).toContain("'--open-pr'");
    expect(calls.some((c) => c.args.includes('delete secret'))).toBe(true);
  });

  test('goal document travels only by Secret and the cloned Job invokes harness ask with supported flags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-goal-doc-'));
    const previous = process.cwd();
    const goal = 'docs/goals/ASK-a.md';
    const document = '# private goal text 38fjx';
    try {
      execFileSync('git', ['init', '-q', root]);
      mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
      writeFileSync(join(root, goal), document);
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: goal } })({ feature: 'goal', spaceId: 'pod-goal', openPr: true, autoReview: true, draft: false, base: 'main' }).done;
      const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      const serializedJob = JSON.stringify(job);
      const script = job.spec.template.spec.containers[0].args[0] as string;
      expect(secret.stringData['goal-doc']).toBe(document);
      expect(serializedJob).not.toContain(document);
      expect(job.spec.template.spec.containers[0].env).not.toContainEqual(expect.objectContaining({ name: 'ELANOUS_POD_GOAL_DOC' }));
      expect(script).toContain(`cp -- /creds/goal-doc '${goal}'`);
      const clone = mkdtempSync(join(tmpdir(), 'pod-clone-'));
      try {
        const copy = script.split('\n').find((line) => line.startsWith('mkdir -p -- "$(dirname'))!;
        const source = join(root, 'secret-payload');
        writeFileSync(source, secret.stringData['goal-doc']);
        const restored = Bun.spawnSync(['bash', '-c', copy.replace('/creds/goal-doc', source)], { cwd: clone });
        expect(restored.exitCode).toBe(0);
        expect(readFileSync(join(clone, goal), 'utf8')).toBe(document);
      } finally { rmSync(clone, { recursive: true, force: true }); }
      expect(script).toContain(`elanous harness ask '${goal}' --json '--base' 'main' --no-auto-merge`);
      expect(script).not.toContain('--open-pr');
      expect(script).not.toContain('--auto-review');
      expect(script).not.toContain('--no-draft');
      expect(result.exitCode).toBe(0);
      const command = script.split('\n').find((line) => line.startsWith('elanous harness ask '))!;
      const out = mkdtempSync(join(tmpdir(), 'pod-ask-output-'));
      const outputFile = join(out, 'si.out');
      const bin = join(out, 'bin');
      mkdirSync(bin);
      const entry = join(out, 'run-ask.ts');
      writeFileSync(entry, `import { program, setRunDevAskFromGoalFileDepsForTesting } from ${JSON.stringify(import.meta.dir + '/../../index.ts')};\n`
        + `setRunDevAskFromGoalFileDepsForTesting({\n`
        + `  loadDevCli: async () => ({ assertDevCliPathOptions: () => {}, selectDevAuthorInput: (_args: unknown, opts: { ask: string }) => ({ kind: 'ask', value: opts.ask }), buildDevCliSpec: (input: unknown) => ({ input }), startDraftTriage: () => {} }),\n`
        + `  runAskFileLaunchFlow: async () => ({ kind: 'launch', goalFile: ${JSON.stringify(goal)} }),\n`
        + `  loadDevPipeline: async () => ({ runDevPipeline: async () => ({ kind: 'self', result: { stage: 'pr-opened', ok: true, prUrl: 'https://github.com/o/r/pull/9', prNumber: 9 }, plan: {} }), devResultOk: () => true }),\n`
        + `  setExitCode: () => {},\n`
        + `});\nawait program.parseAsync(['node', 'elanous', ...process.argv.slice(2)]);\n`);
      writeFileSync(join(bin, 'elanous'), `#!/bin/sh\nexec bun ${JSON.stringify(entry)} "$@"\n`);
      chmodSync(join(bin, 'elanous'), 0o755);
      try {
        const runCommand = command.replaceAll('/tmp/si.out', outputFile);
        const launched = Bun.spawnSync(['bash', '-c', runCommand], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_STATE_DIR: out, ELANOUS_CONFIG_DIR: out } });
        expect(launched.exitCode).toBe(0);
        const jobLog = readFileSync(outputFile, 'utf8');
        const actualAskLastLine = jobLog.trimEnd().split('\n').at(-1)!;
        expect(JSON.parse(actualAskLastLine)).toMatchObject({ stage: 'pr-opened', ok: true, prUrl: 'https://github.com/o/r/pull/9' });
        const { k: normalizedKubectl } = fakeKubectl(['Complete'], jobLog);
        const parsed = await podSelfImplementSpawn({ kubectl: normalizedKubectl, credentials: CREDS, env: {} })({ feature: 'goal', spaceId: 'pod-ask-result' }).done;
        expect(parsed.exitCode).toBe(0);
        expect(parsed.disposition?.stage).toBe('pr-opened');
        expect(parsed.disposition?.prUrl).toBe('https://github.com/o/r/pull/9');

        // A kind:self JSON line can omit top-level ok while its result still carries the outcome.
        writeFileSync(entry, readFileSync(entry, 'utf8').replace('devResultOk: () => true', 'devResultOk: () => undefined').replace("ok: true, prUrl:", "ok: false, prUrl:"));
        const withoutTopLevelOk = Bun.spawnSync(['bash', '-c', runCommand], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ELANOUS_STATE_DIR: out, ELANOUS_CONFIG_DIR: out } });
        expect(withoutTopLevelOk.exitCode).toBe(0);
        const missingTopLevelLog = readFileSync(outputFile, 'utf8');
        const askLine = missingTopLevelLog.trimEnd().split('\n').find((line) => line.includes('"kind":"self"'))!;
        expect(JSON.parse(askLine)).toMatchObject({ kind: 'self', result: { ok: false, stage: 'pr-opened', prUrl: 'https://github.com/o/r/pull/9' } });
        expect(Object.hasOwn(JSON.parse(askLine), 'ok')).toBe(false);
        expect(JSON.parse(missingTopLevelLog.trimEnd().split('\n').at(-1)!)).toMatchObject({ ok: false, stage: 'pr-opened', prUrl: 'https://github.com/o/r/pull/9' });
        const { k: kubectlWithoutTopLevelOk } = fakeKubectl(['Failed'], missingTopLevelLog);
        const preserved = await podSelfImplementSpawn({ kubectl: kubectlWithoutTopLevelOk, credentials: CREDS, env: {} })({ feature: 'goal', spaceId: 'pod-ask-without-top-ok' }).done;
        expect(preserved.exitCode).toBe(1);
        expect(preserved.disposition?.ok).toBe(false);
        expect(preserved.disposition?.stage).toBe('pr-opened');
        expect(preserved.disposition?.prUrl).toBe('https://github.com/o/r/pull/9');
      } finally { rmSync(out, { recursive: true, force: true }); }
      expect(result.disposition?.prUrl).toBeUndefined();
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('a root goal filename beginning with a dash is passed as a safe operand', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-dash-goal-'));
    const previous = process.cwd();
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, '-goal.md'), '# root goal');
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: '-goal.md' } })({ feature: 'goal', spaceId: 'pod-dash-goal' }).done;
      const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
      expect(secret.stringData['goal-doc']).toBe('# root goal');
      const script = job.spec.template.spec.containers[0].args[0] as string;
      expect(script).toContain("cp -- /creds/goal-doc './-goal.md'");
      expect(script).toContain("elanous harness ask './-goal.md' --json");
      expect(script).not.toContain("elanous harness ask '-goal.md'");
      const clone = mkdtempSync(join(tmpdir(), 'pod-dash-clone-'));
      try {
        const source = join(root, 'secret-payload');
        writeFileSync(source, secret.stringData['goal-doc']);
        const copy = script.split('\n').find((line) => line.startsWith('mkdir -p -- "$(dirname'))!;
        const restored = Bun.spawnSync(['bash', '-c', copy.replace('/creds/goal-doc', source)], { cwd: clone });
        expect(restored.exitCode).toBe(0);
        expect(readFileSync(join(clone, '-goal.md'), 'utf8')).toBe('# root goal');
      } finally { rmSync(clone, { recursive: true, force: true }); }
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('refuses a goal-doc path that escapes the repository through a symlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-goal-guard-'));
    const outside = mkdtempSync(join(tmpdir(), 'pod-goal-external-'));
    const previous = process.cwd();
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(outside, 'ASK.md'), '# outside');
      symlinkSync(join(outside, 'ASK.md'), join(root, 'ASK.md'));
      process.chdir(root);
      const { k, calls } = fakeKubectl(['Complete'], '');
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: 'ASK.md' } })({ feature: 'goal', spaceId: 'pod-guard' }).done;
      expect(result.exitCode).toBe(1);
      expect(result.error?.message).toContain('outside repository');
      expect(calls.some((c) => c.args.endsWith('apply -f -'))).toBe(false);
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  test('without goal document the original self implement Job script remains unchanged', () => {
    const base = { name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: ['--base', 'main'], passEnv: [], deadlineSeconds: 60 };
    const script = (podJobManifest(base) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
    expect(script).toContain('elanous self implement "$(cat /creds/feature)" --json');
    expect(script).not.toContain('harness ask');
    expect(script).not.toContain('/creds/goal-doc');
  });

  test('manifest hands off the fixed inbox and host records the active fragment until Job completion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-record-'));
    const env = { ELANOUS_STATE_DIR: root };
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => { finish = resolve; });
    let polls = 0;
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const kubectl: Kubectl = (args, input) => {
      calls.push({ args, input });
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };   // 재개 존재 확인 — 새 Job
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: ++polls > 1 ? 'Complete' : '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const { done } = podSelfImplementSpawn({ kubectl, credentials: CREDS, env, sleep: () => wait })({ feature: 'goal', spaceId: 'pod-fragment' });
      const record = readPodFragment('pod-fragment', env);
      const job = calls.filter((call) => call.args.includes('apply')).map((call) => JSON.parse(call.input!)).find((manifest) => manifest.kind === 'Job');
      expect(job.spec.template.spec.containers[0].env).toContainEqual({ name: CONTROL_INBOX_DIR_ENV, value: '/tmp/elanous-control.inbox' });
      expect(record).toEqual({ spaceId: 'pod-fragment', context: 'test-context', namespace: 'elanous-test', job: podJobName('pod-fragment'), inboxDir: '/tmp/elanous-control.inbox' });
      finish();
      await done;
      expect(readPodFragment('pod-fragment', env)).toBeNull();
      expect(podFragmentFinished('pod-fragment', env)).toBe(true);
    } finally { finish(); rmSync(root, { recursive: true, force: true }); }
  });

  test('a failed Job is a non-zero exit with a named error', async () => {
    const { k } = fakeKubectl(['Failed'], 'boom');
    const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 's' }).done;
    expect(r.exitCode).toBe(1);
    expect(r.error?.code).toBe('pod-job-failed');
  });
  test('DeadlineExceeded 는 자식 quota-exhausted 를 덮고 pod-deadline-exceeded · run-deadline-exceeded 로 남긴다', async () => {
    const child = JSON.stringify({ stage: 'aborted', ok: false, abandonedClassification: { classification: 'quota-exhausted' }, prUrl: 'https://github.com/o/r/pull/3', branch: 'si/deadline' });
    const calls: string[] = [];
    const records: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'pod-deadline-exceeded', emit: (record) => { records.push({ category: record.category, event: record.event, data: record.data as Record<string, unknown> }); } });
    const k: Kubectl = (args) => {
      calls.push(args.join(' '));
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: 'DeadlineExceeded', stderr: '' };
      if (args.includes('get') && args.includes('pods')) return { status: 0, stdout: '2026-09-27T06:40:00Z\tOOMKilled\t137\n', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: `${child}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, deadlineSeconds: 10_800 })({ feature: 'x', spaceId: 'deadline' }).done;
      expect(calls.some((c) => c.includes('jsonpath={.status.conditions[?(@.type=="Failed")].reason}'))).toBe(true);
      expect(calls.some((c) => c.includes('get pods'))).toBe(true);
      expect(r.error).toEqual({ code: 'pod-deadline-exceeded', message: `Job ${podJobName('deadline')} 이 수명 상한 10800초에 닿았다` });
      expect(r.disposition?.failureClassification).toBe('run-deadline-exceeded');
      const logged = records.find((record) => record.category === 'self-implement.pod' && record.event === 'deadline-exceeded');
      expect(logged?.data).toMatchObject({ job: podJobName('deadline'), deadlineSeconds: 10_800, childClassification: 'quota-exhausted', prUrl: 'https://github.com/o/r/pull/3', branch: 'si/deadline' });
    } finally { off(); }
  });
  test('failed Job reads the newest child termination by creation time: OOM, Error, or unknown', async () => {
    const cases = [
      { id: 'oom', pods: '2026-09-27T06:41:00Z\tOOMKilled\t137\n2026-09-27T06:40:00Z\tError\t1\n', code: 'pod-oom-killed', fragment: 'OOMKilled/137', reason: 'OOMKilled', exitCode: 137 },
      { id: 'error', pods: '2026-09-27T06:41:00Z\tError\t1\n2026-09-27T06:40:00Z\tOOMKilled\t137\n', code: 'pod-job-failed', fragment: 'container=Error/1', reason: 'Error', exitCode: 1 },
      { id: 'missing', pods: '', code: 'pod-job-failed', fragment: 'BackoffLimitExceeded', reason: null, exitCode: null },
      { id: 'newest-unavailable', pods: '2026-09-27T06:41:00Z\t\n2026-09-27T06:40:00Z\tOOMKilled\t137\n', code: 'pod-job-failed', fragment: 'BackoffLimitExceeded', reason: null, exitCode: null },
      { id: 'unreadable', pods: '2026-09-27T06:41:00Z\tOOMKilled\t137\n', status: 1, code: 'pod-job-failed', fragment: 'BackoffLimitExceeded', reason: null, exitCode: null },
    ] as const;
    for (const c of cases) {
      const calls: string[][] = [];
      const records: Array<{ event: string; data: Record<string, unknown> }> = [];
      const off = debug.registerSink({ name: `pod-termination-${c.id}`, emit: (record) => {
        if (record.category === 'self-implement.pod' && ['container-terminated', 'job-finished'].includes(record.event)) records.push({ event: record.event, data: record.data as Record<string, unknown> });
      } });
      const k: Kubectl = (args) => {
        calls.push([...args]);
        if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
        if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
        if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: 'BackoffLimitExceeded', stderr: '' };
        if (args.includes('get') && args.includes('pods')) return { status: 'status' in c ? c.status : 0, stdout: c.pods, stderr: '' };
        if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: 'boom', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      try {
        const job = podJobName(`termination-${c.id}`);
        const r = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_POD_MEMORY: '24Gi' } })({ feature: 'x', spaceId: `termination-${c.id}` }).done;
        expect(calls.filter((args) => args.includes('get') && args.includes('pods'))).toHaveLength(1);
        expect(calls.find((args) => args.includes('get') && args.includes('pods'))).toEqual(expect.arrayContaining(['-n', 'elanous-test', '-l', `job-name=${job}`]));
        expect(calls.find((args) => args.includes('get') && args.includes('pods'))!.join(' ')).toContain('containerStatuses[?(@.name=="child")]');
        expect(r.exitCode).toBe(1);
        expect(r.error?.code).toBe(c.code);
        expect(r.error?.message).toContain(c.fragment);
        if (c.id === 'oom') expect(r.error?.message).toContain('24Gi');
        else if (c.reason === null) expect(r.error?.message).not.toContain('OOMKilled');
        const terminated = records.filter((record) => record.event === 'container-terminated');
        expect(terminated).toHaveLength(1);
        expect(terminated[0]).toMatchObject({ event: 'container-terminated', data: {
          job, container: 'child', reason: c.reason, exitCode: c.exitCode, jobReason: 'BackoffLimitExceeded', memoryLimit: '24Gi',
        } });
        expect(records.find((record) => record.event === 'job-finished')?.data).toMatchObject({ job, state: 'failed', containerReason: c.reason });
      } finally { off(); }
    }
  });
  test('BackoffLimitExceeded 는 pod-job-failed 에 reason 만 더한다', async () => {
    const k: Kubectl = (args) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: 'BackoffLimitExceeded', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: 'boom', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 'backoff' }).done;
    expect(r.error).toEqual({ code: 'pod-job-failed', message: `Job ${podJobName('backoff')} failed (BackoffLimitExceeded)` });
    expect(r.disposition?.failureClassification).toBeUndefined();
  });

  test('abort deletes the Job', async () => {
    const ac = new AbortController();
    ac.abort();
    const { k, calls } = fakeKubectl([''], '');
    const r = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 's', signal: ac.signal }).done;
    expect(r.error?.code).toBe('aborted');
    expect(calls.some((c) => c.args.includes('delete job') && c.args.includes('--wait=false'))).toBe(true);
  });

  test('passEnv puts only present host keys into the secret and pod env (benchmark billing paths)', async () => {
    const { k, calls } = fakeKubectl(['Complete'], '');
    await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, passEnv: ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'], env: { OPENROUTER_API_KEY: 'sk-or-1' }, readKeyCache: () => undefined })({ feature: 'x', spaceId: 's' }).done;
    const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(Object.keys(secret.stringData)).toContain('env-OPENROUTER_API_KEY');
    expect(Object.keys(secret.stringData)).not.toContain('env-ANTHROPIC_API_KEY');
    // ⭐ 과금 키만 본다 — run-origin 칸(ELANOUS_POD_NAME 등)은 별도 시험이 문다.
    expect(job.spec.template.spec.containers[0].env.map((e: { name: string }) => e.name).filter((n: string) => n.endsWith('_API_KEY'))).toEqual(['OPENROUTER_API_KEY']);
  });

  test('manifest transfers bounded ledger chunks before the final disposition line (and emits NONE for an empty store)', () => {
    const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const script = manifest.spec.template.spec.containers[0]!.args[0]!;
    expect(script).toContain('ELANOUS_RUN_LEDGER %s %s/%s %s');
    expect(script.indexOf('ELANOUS_RUN_LEDGER')).toBeGreaterThan(script.indexOf('elanous self implement'));
    expect(script.indexOf('ELANOUS_RUN_LEDGER')).toBeLessThan(script.lastIndexOf('tail -n 1 /tmp/si.out'));
    expect(script).toContain('ELANOUS_RUN_LEDGER_NONE');
    const root = mkdtempSync(join(tmpdir(), 'pod-script-'));
    try {
      const dir = runLedgerDir(root);
      const id = 'run-12345678-1234-1234-1234-123456789abc';
      const payload = Array.from({ length: 12000 }, (_, n) => `line${n}`).join('\n') + '\n';
      mkdirSync(dir, { recursive: true });
      writeFileSync(runLedgerPath(id, dir), payload);
      const extract = script.slice(script.indexOf('set -o pipefail\n'), script.indexOf('\ntail -n 1 /tmp/si.out'));
      const r = Bun.spawnSync(['bash', '-c', extract], { env: { ...process.env, ELANOUS_STATE_DIR: root } });
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.toString().trim().split('\n');
      const chunks = lines.map((line) => line.split(' ').at(-1)!);
      expect(lines.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= 8000)).toBe(true);
      expect(gunzipSync(Buffer.from(chunks.join(''), 'base64')).toString('utf8')).toBe(readFileSync(runLedgerPath(id, dir), 'utf8'));
      rmSync(dir, { recursive: true, force: true });
      const empty = Bun.spawnSync(['bash', '-c', extract], { env: { ...process.env, ELANOUS_STATE_DIR: root } });
      expect(empty.stdout.toString().trim()).toBe('ELANOUS_RUN_LEDGER_NONE');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('manifest exports pod observations through the bounded outbox before scanning and preserves child exit on export failure', () => {
    const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const script = manifest.spec.template.spec.containers[0]!.args[0]!;
    const exportCommand = 'elanous logs --all --include-test --since 12h --limit 20000 --json > "$HOME/outbox/pod-logs/logs.jsonl"';
    expect(script.indexOf(exportCommand)).toBeGreaterThan(script.indexOf('elanous self implement'));
    expect(script.indexOf(exportCommand)).toBeLessThan(script.indexOf('find "$HOME/outbox" -type f -print0'));
    expect(script.trimEnd()).toEndWith('exit $rc');
    const home = mkdtempSync(join(tmpdir(), 'pod-logs-home-'));
    const state = mkdtempSync(join(tmpdir(), 'pod-logs-state-'));
    try {
      const bin = join(home, 'bin');
      mkdirSync(bin);
      const stub = join(bin, 'elanous');
      const extract = script.slice(script.indexOf('if mkdir -p "$HOME/outbox/pod-logs"'), script.indexOf('\nfound=0')) + '\nexit $rc';
      const env = { ...process.env, HOME: home, ELANOUS_STATE_DIR: state, PATH: `${bin}:${process.env.PATH}` };
      writeFileSync(stub, '#!/bin/sh\nprintf "{\\"event\\":1}\\n{\\"event\\":2}\\n"\n');
      chmodSync(stub, 0o755);
      const success = Bun.spawnSync(['bash', '-c', `rc=7\n${extract}`], { env });
      expect(success.exitCode).toBe(7);
      const parsed = parsePodArtifactChunks(success.stdout.toString());
      if (!Array.isArray(parsed)) throw new Error('pod log transfer incomplete');
      expect(parsed.find((artifact) => artifact.path === 'pod-logs/logs.jsonl')?.bytes.toString()).toBe('{"event":1}\n{"event":2}\n');
      writeFileSync(stub, '#!/bin/sh\nhead -c 5242881 /dev/zero\n');
      const overLimit = Bun.spawnSync(['bash', '-c', `rc=7\n${extract}`], { env });
      expect(overLimit.exitCode).toBe(7);
      expect(overLimit.stdout.toString().split('\n')).toContain('ELANOUS_POD_ARTIFACT_SKIPPED pod-logs/logs.jsonl 5242881');
      writeFileSync(stub, '#!/bin/sh\nprintf "partial"\nexit 4\n');
      const failed = Bun.spawnSync(['bash', '-c', `rc=7\n${extract}`], { env });
      expect(failed.exitCode).toBe(7);
      expect(failed.stdout.toString().split('\n').filter((line) => line.startsWith('ELANOUS_POD_LOGS_UNAVAILABLE '))).toEqual(['ELANOUS_POD_LOGS_UNAVAILABLE export-exit-4']);
      expect(failed.stdout.toString()).not.toContain('ELANOUS_POD_ARTIFACT ');
      expect(existsSync(join(home, 'outbox', 'pod-logs', 'logs.jsonl'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
  });

  test('manifest emits outbox files ahead of ledger, skips over-limit files, and keeps final JSON last', () => {
    const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
    const script = manifest.spec.template.spec.containers[0]!.args[0]!;
    expect(script.indexOf("printf 'ELANOUS_POD_ARTIFACT %s")).toBeLessThan(script.indexOf("printf 'ELANOUS_RUN_LEDGER %s"));
    expect(script.indexOf('ELANOUS_RUN_LEDGER_NONE')).toBeLessThan(script.lastIndexOf('tail -n 1 /tmp/si.out'));
    const home = mkdtempSync(join(tmpdir(), 'pod-outbox-'));
    const state = mkdtempSync(join(tmpdir(), 'pod-state-'));
    try {
      mkdirSync(join(home, 'outbox', 'nested'), { recursive: true });
      writeFileSync(join(home, 'outbox', 'nested', 'blob'), Buffer.from([0, 255, 42]));
      writeFileSync(join(home, 'outbox', 'note'), 'hello');
      writeFileSync(join(home, 'outbox', 'oversize'), Buffer.alloc(5 * 1024 * 1024 + 1));
      for (let i = 0; i < 5; i++) writeFileSync(join(home, 'outbox', `large-${i}`), Buffer.alloc(5 * 1024 * 1024));
      const extract = script.slice(script.indexOf('set -o pipefail\n'), script.indexOf('\ntail -n 1 /tmp/si.out'));
      const r = Bun.spawnSync(['bash', '-c', extract], { env: { ...process.env, HOME: home, ELANOUS_STATE_DIR: state } });
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.toString().trim().split('\n');
      const parsed = parsePodArtifactChunks(lines.join('\n'));
      expect(Array.isArray(parsed)).toBe(true);
      if (!Array.isArray(parsed)) throw new Error('unexpected incomplete');
      const transferred = parsed.map((artifact) => artifact.path);
      expect(transferred).toContain('nested/blob');
      expect(transferred).toContain('note');
      expect(transferred.filter((path) => path.startsWith('large-'))).toHaveLength(3);
      expect(parsed.find((artifact) => artifact.path === 'nested/blob')?.bytes).toEqual(Buffer.from([0, 255, 42]));
      expect(lines).toContain('ELANOUS_POD_ARTIFACT_SKIPPED oversize 5242881');
      expect(lines.filter((line) => /^ELANOUS_POD_ARTIFACT_SKIPPED large-[0-4] 5242880$/.test(line))).toHaveLength(2);
      expect(lines.at(-1)).toBe('ELANOUS_RUN_LEDGER_NONE');
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
  });

  test('completed Job collects artifacts from full logs beside ledger without changing disposition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-artifact-runtime-'));
    const previous = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const name = podJobName('artifact-runtime');
      const json = '{"stage":"merged","ok":true}';
      const artifactLine = `ELANOUS_POD_ARTIFACT ${Buffer.from('nested/note.txt').toString('base64url')} 1/1 ${gzipSync('from pod').toString('base64')}`;
      const ledgerLine = `ELANOUS_RUN_LEDGER run-artifact-1 1/1 ${gzipSync('{"ok":true}\\n').toString('base64')}`;
      const kubectl: Kubectl = (args) => {
        if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
        if (args.includes('get')) return { status: 0, stdout: 'Complete', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? `${json}\n` : `${artifactLine}\n${ledgerLine}\n${json}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'artifact-runtime' }).done;
      expect(result.disposition?.stage).toBe('merged');
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(effectiveInstanceRoot(), 'pod-artifacts', name, 'nested/note.txt'), 'utf8')).toBe('from pod');
      expect(readFileSync(runLedgerPath('run-artifact-1', runLedgerDir(root)), 'utf8')).toBe('{"ok":true}\\n');
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('parent ledger survives while the Pod ledger is collected under a fresh child ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-parent-ledger-'));
    const parent = 'run-parent-1';
    const dir = runLedgerDir(root);
    appendRunLedgerEntry({ runId: parent, event: 'parent-start', data: {} }, dir);
    const calls: Array<{ kind: string; spec?: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } }> = [];
    const events: string[] = [];
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-parent-ledger-test', emit: (record) => {
      if (record.category !== 'self-implement.pod') return;
      events.push(record.event);
      if (record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    let child = '';
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const manifest = JSON.parse(input);
        calls.push(manifest);
        if (manifest.kind === 'Job') child = manifest.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync(JSON.stringify({ runId: child, event: 'child-start', data: {} }) + '\n').toString('base64')}\n{"stage":"merged","ok":true}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'parent-child' }).done;
      expect(child).toMatch(/^run-[0-9a-f-]{36}$/);
      expect(child).not.toBe(parent);
      expect(calls.find((m) => m.kind === 'Job')!.spec!.template.spec.containers[0]!.env).toContainEqual({ name: 'ELANOUS_PARENT_RUN_ID', value: parent });
      expect(readFileSync(runLedgerPath(child, dir), 'utf8')).toContain('child-start');
      expect(events).toContain('ledger-collected');
      expect(readFileSync(runLedgerPath(child, dir), 'utf8')).not.toContain('pod-ledger-incomplete');
      expect(readFileSync(runLedgerPath(parent, dir), 'utf8')).toContain('"event":"pod-child-run"');
      expect(readFileSync(runLedgerPath(parent, dir), 'utf8')).toContain(child);
      expect(events).not.toContain('ledger-collect-skipped');
      expect(finished).toContainEqual(expect.objectContaining({ childRunId: child, ledgerCompleteness: 'complete' }));
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('live follower tracks the child rather than an existing parent and full collection replaces its partial copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-live-child-'));
    const parent = 'run-parent-1';
    const dir = runLedgerDir(root);
    appendRunLedgerEntry({ runId: parent, event: 'parent-start', data: {} }, dir);
    let child = '';
    let polls = 0;
    const execScripts: string[] = [];
    const full = '{"event":"child-start"}\n{"event":"child-done"}\n';
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const m = JSON.parse(input);
        if (m.kind === 'Job') child = m.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job') && args.some((a) => a.includes('status.conditions[*].type'))) return { status: 0, stdout: ++polls < 2 ? '' : 'Complete', stderr: '' };
      if (args.includes('exec')) {
        execScripts.push(args.at(-1)!);
        return { status: 0, stdout: '{"event":"child-start"}\n', stderr: '' };
      }
      if (args.includes('logs')) return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync(full).toString('base64')}\n{"stage":"merged","ok":true}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: parent, ELANOUS_STATE_DIR: root }, sleep: async () => {} })({ feature: 'x', spaceId: 'live-child' }).done;
      expect(execScripts).toHaveLength(1);
      expect(execScripts[0]).toContain(`/run-ledger/${child}.jsonl`);
      expect(execScripts[0]).not.toContain(`/run-ledger/${parent}.jsonl`);
      expect(readFileSync(runLedgerPath(child, dir), 'utf8')).toBe(full);
      expect(readFileSync(runLedgerPath(parent, dir), 'utf8')).toContain('parent-start');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('failed Pod with a partial ledger marks incomplete and records its result on the host goal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-partial-ledger-'));
    const previous = process.cwd();
    const goal = 'GOAL.md';
    let child = '';
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-partial-ledger-test', emit: (record) => { if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>); } });
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const m = JSON.parse(input);
        if (m.kind === 'Job') child = m.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? '{"stage":"gate-failed","ok":false}\n' : `ELANOUS_RUN_LEDGER ${child} 1/3 ${gzipSync('partial').toString('base64')}\nELANOUS_RUN_LEDGER ${child} 2/3 AAAA\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, goal), '# Goal\n');
      process.chdir(root);
      const r = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root, ELANOUS_POD_GOAL_DOC: goal } })({ feature: 'x', spaceId: 'partial-goal' }).done;
      expect(r.exitCode).toBe(1);
      expect(readFileSync(runLedgerPath(child, runLedgerDir(root)), 'utf8')).toContain('"event":"pod-ledger-incomplete"');
      expect(finished).toContainEqual(expect.objectContaining({ childRunId: child, ledgerCompleteness: 'incomplete' }));
      const hostGoal = readFileSync(join(root, goal), 'utf8');
      expect(hostGoal).toContain('## 실행 기록');
      expect(hostGoal).toContain(`- runId: ${child}`);
      expect(hostGoal).toContain('stage: gate-failed');
      expect(hostGoal).toContain('outcome: abandoned');
      expect(hostGoal).toContain('ok: false');
    } finally { process.chdir(previous); off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('another run failing collection does not mark a fully collected child ledger incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-other-ledger-failure-'));
    const dir = runLedgerDir(root);
    const other = 'run-other-1';
    appendRunLedgerEntry({ runId: other, event: 'host-start', data: {} }, dir);
    const before = readFileSync(runLedgerPath(other, dir), 'utf8');
    let child = '';
    const finished: Array<Record<string, unknown>> = [];
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'pod-other-ledger-failure-test', emit: (record) => {
      if (record.category !== 'self-implement.pod') return;
      if (record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
      if (record.event.startsWith('ledger-collect-') || record.event === 'ledger-collected') events.push({ event: record.event, data: record.data as Record<string, unknown> });
    } });
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const m = JSON.parse(input);
        if (m.kind === 'Job') child = m.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: [
        `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync('{"event":"child"}\n').toString('base64')}`,
        `ELANOUS_RUN_LEDGER ${other} 1/1 ${gzipSync('other\n').toString('base64')}`,
        'ELANOUS_RUN_LEDGER run-broken-1 1/2 AAAA',
        '{"stage":"merged","ok":true}',
      ].join('\n'), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'other-ledger-failure' }).done;
      expect(result.exitCode).toBe(0);
      expect(events).toContainEqual(expect.objectContaining({ event: 'ledger-collect-incomplete', data: expect.objectContaining({ runId: 'run-broken-1', reason: 'missing chunk' }) }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'ledger-collect-skipped', data: expect.objectContaining({ runId: other, reason: 'exists' }) }));
      expect(events).toContainEqual(expect.objectContaining({ event: 'ledger-collected', data: expect.objectContaining({ runId: child }) }));
      expect(readFileSync(runLedgerPath(other, dir), 'utf8')).toBe(before);
      expect(readFileSync(runLedgerPath(child, dir), 'utf8')).toBe('{"event":"child"}\n');
      expect(finished).toContainEqual(expect.objectContaining({ childRunId: child, ledgerCompleteness: 'complete' }));
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('artifact recovery failure does not mark a fully collected child ledger incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-artifact-ledger-separation-'));
    let child = '';
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-artifact-ledger-separation-test', emit: (record) => {
      if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const m = JSON.parse(input);
        if (m.kind === 'Job') child = m.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) {
        return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync('{"event":"child"}\n').toString('base64')}\nELANOUS_POD_ARTIFACT ${Buffer.from('broken.txt').toString('base64url')} 1/2 ${gzipSync('partial').toString('base64')}\n{"stage":"merged","ok":true}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'artifact-ledger-separation' }).done;
      expect(finished).toContainEqual(expect.objectContaining({ childRunId: child, ledgerCompleteness: 'complete' }));
      expect(readFileSync(runLedgerPath(child, runLedgerDir(root)), 'utf8')).toBe('{"event":"child"}\n');
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('failed Job cannot turn a successful logged result into a successful host goal record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-failed-success-log-'));
    const previous = process.cwd();
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, 'GOAL.md'), '# Goal\n');
      process.chdir(root);
      const { k } = fakeKubectl(['Failed'], '{"stage":"merged","merged":true,"ok":true}\n');
      const result = await podSelfImplementSpawn({ kubectl: k, credentials: CREDS, env: { ELANOUS_STATE_DIR: root, ELANOUS_POD_GOAL_DOC: 'GOAL.md' } })({ feature: 'x', spaceId: 'failed-success-log' }).done;
      expect(result.exitCode).toBe(1);
      expect(readFileSync(join(root, 'GOAL.md'), 'utf8')).toMatch(/outcome: abandoned\n  ok: false/);
    } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test('a failed Pod without a child ledger creates an incomplete marker and an aborted host goal record once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-no-result-'));
    const previous = process.cwd();
    const finished: Array<Record<string, unknown>> = [];
    const off = debug.registerSink({ name: 'pod-no-result-test', emit: (record) => { if (record.category === 'self-implement.pod' && record.event === 'job-finished') finished.push(record.data as Record<string, unknown>); } });
    let child = '';
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('apply') && input) {
        const m = JSON.parse(input);
        if (m.kind === 'Job') child = m.spec.template.spec.containers[0].env.find((e: { name: string }) => e.name === 'ELANOUS_RUN_ID').value;
      }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: 'pod crashed before a result', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      execFileSync('git', ['init', '-q', root]);
      writeFileSync(join(root, 'GOAL.md'), '# Goal\n');
      process.chdir(root);
      const opts = { kubectl, credentials: CREDS, env: { ELANOUS_POD_GOAL_DOC: 'GOAL.md', ELANOUS_STATE_DIR: root } };
      await podSelfImplementSpawn(opts)({ feature: 'x', spaceId: 'no-result' }).done;
      expect(finished).toContainEqual(expect.objectContaining({ childRunId: child, ledgerCompleteness: 'missing' }));
      expect(JSON.parse(readFileSync(runLedgerPath(child, runLedgerDir(root)), 'utf8'))).toMatchObject({ runId: child, event: 'pod-ledger-incomplete', data: { reason: 'child-ledger-missing' } });
      const goalFile = join(root, 'GOAL.md');
      expect(readFileSync(goalFile, 'utf8')).toContain(`- runId: ${child}\n  stage: aborted\n  outcome: pod-no-result\n  ok: false`);
    } finally { process.chdir(previous); off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('completed Job collects full-log ledger at the host while preserving tail disposition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-full-logs-'));
    const id = 'run-child-1';
    const hostDir = runLedgerDir(root);
    const oldState = process.env.ELANOUS_STATE_DIR;
    const finished: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement.pod' && event === 'job-finished') finished.push(data ?? {});
    }) as typeof debug.log);
    process.env.ELANOUS_STATE_DIR = root;
    try {
      const child = mkdtempSync(join(tmpdir(), 'pod-child-'));
      let contents: string;
      try {
        appendRunLedgerEntry({ runId: id, event: 'start', data: { origin: { podName: 'job-x-abcde' } } }, runLedgerDir(child));
        contents = readFileSync(runLedgerPath(id, runLedgerDir(child)), 'utf8');
      } finally { rmSync(child, { recursive: true, force: true }); }
      const line = `ELANOUS_RUN_LEDGER ${id} 1/1 ${gzipSync(contents).toString('base64')}`;
      const json = '{"stage":"merged","ok":true,"runId":"run-child-1"}';
      const calls: string[][] = [];
      const kubectl: Kubectl = (args) => {
        calls.push([...args]);
        if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
        if (args.includes('get')) return { status: 0, stdout: 'Complete', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: args.includes('--tail=400') ? `${json}\n` : `${line}\n${json}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 's' }).done;
      expect(result.exitCode).toBe(0);
      expect(result.disposition?.stage).toBe('merged');
      expect(result.disposition?.runId).toBe(id);
      expect(result.disposition?.childRunId).toBe(id);
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({ state: 'complete', stage: 'merged', childRunId: expect.stringMatching(/^run-[0-9a-f-]{36}$/), ledgerCompleteness: 'missing' });
      expect(readFileSync(runLedgerPath(id, hostDir), 'utf8')).toBe(contents);
      expect(calls.filter((args) => args.includes('logs'))).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
      if (oldState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = oldState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('completed Job fetches full logs without --tail; collection failure leaves disposition unchanged', async () => {
    const json = JSON.stringify({ stage: 'pr-opened', ok: true });
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
      if (args.includes('get')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs') && !args.includes('--tail=400')) return { status: 1, stdout: '', stderr: 'log fetch unavailable' };
      if (args.includes('logs')) return { status: 0, stdout: `${json}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {} })({ feature: 'x', spaceId: 's' }).done;
    expect(result.exitCode).toBe(0);
    expect(result.disposition?.stage).toBe('pr-opened');
    const logCalls = calls.filter((args) => args.includes('logs'));
    expect(logCalls).toHaveLength(2);
    expect(logCalls[0]).toContain('--tail=400');
    expect(logCalls[1]).not.toContain('--tail=400');
  });

  test('every Job carries the isolation gate init container', () => {
    const m = podJobManifest({ name: 'n', namespace: 'elanous-test', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { initContainers: Array<{ name: string }> } } } };
    expect(m.spec.template.spec.initContainers[0]!.name).toBe('isolation-gate');
  });

  // 델타(대표 2026-09-26): 레지스트리 이미지는 노드가 pull 해야 한다 — Never 면 없는 층을 못 받아 ErrImageNeverPull.
  test('registry image pulls IfNotPresent; imported image stays Never', () => {
    type M = { spec: { template: { spec: { initContainers: Array<{ imagePullPolicy: string }>; containers: Array<{ image: string; imagePullPolicy: string }> } } } };
    const reg = podJobManifest({ name: 'n', namespace: 'elanous-test', image: 'k3d-elanous-registry:5050/elanous-harness:abc', imagePullPolicy: 'IfNotPresent', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as M;
    expect(reg.spec.template.spec.containers[0]!.imagePullPolicy).toBe('IfNotPresent');
    expect(reg.spec.template.spec.initContainers[0]!.imagePullPolicy).toBe('IfNotPresent');
    const local = podJobManifest({ name: 'n', namespace: 'elanous-test', image: 'elanous-harness:local', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as M;
    expect(local.spec.template.spec.containers[0]!.imagePullPolicy).toBe('Never');
  });
});

// RFC F2 — Pod 의 토큰·비용 rollup 한 줄 → 호스트 llm-usage 재방출.
import { reemitPodUsage } from './self-implement-pod.js';
import { rollup } from '../../../scripts/usage-rollup.js';
describe('pod usage rollup', () => {
  test('rollup groups llm-usage rows by site/provider/model and keeps unknown cost separate', () => {
    const rows = [
      JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', inputTokens: 100, outputTokens: 5, cost: { kind: 'known', usd: 0.5 } } }),
      JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', inputTokens: 50, outputTokens: 1, cost: { kind: 'unknown' } } }),
      JSON.stringify({ event: 'other', data: {} }),
      'elanous logs: result may be truncated (limitReached=true)',
    ];
    const r = rollup(rows);
    expect(r.truncated).toBe(true);
    expect(r.rows).toEqual([{ site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', calls: 2, inputTokens: 150, outputTokens: 6, cacheReadInputTokens: 0, usdKnown: 0.5, unknownCostCalls: 1, includedCalls: 0, apiEquivalentUsd: 0 }]);
  });
  test('the host re-emits each row as llm-usage with a pod-rollup site; partial cost when some calls were unpriced', () => {
    const out: Array<{ c: string; e: string; d: Record<string, unknown> }> = [];
    const line = `ELANOUS_USAGE_ROLLUP ${JSON.stringify({ measured: true, runId: 'run-9', rows: [{ site: 'agent-turn', provider: 'openai', model: 'gpt-6-sol', calls: 2, inputTokens: 150, outputTokens: 6, cacheReadInputTokens: 0, usdKnown: 0.5, unknownCostCalls: 1 }] })}`;
    expect(reemitPodUsage(`x\n${line}\n{"ok":true}\n`, 'si-1', (c, e, d) => out.push({ c, e, d }))).toBe(1);
    expect(out[0]).toMatchObject({ c: 'llm.usage', e: 'llm-usage', d: { site: 'pod-rollup:agent-turn', inputTokens: 150, substrate: 'pod', job: 'si-1', podRunId: 'run-9', cost: { kind: 'partial', usd: 0.5 } } });
  });
  test('no rollup line → a named miss, nothing re-emitted', () => {
    const out: string[] = [];
    expect(reemitPodUsage('{"ok":true}', 'si-2', (_c, e) => out.push(e))).toBe(0);
    expect(out).toEqual(['usage-rollup-missing']);
  });
});

// RFC fleet 슈퍼바이저 §A3·F4 — 벤치 팔.
import { benchArmEnv, benchGoals, benchPodSpawn, parseBenchArms } from './self-implement-pod.js';
import { lookupLlmTierSpec } from '../../model-tier/llm-tier-map.js';
import { resolveEscalateTarget } from '../../self-implement/rework-policy.js';
describe('bench arms', () => {
  test('parses id=provider[:model][@KEY+KEY]', () => {
    expect(parseBenchArms('codex=openai-codex; or-kimi=openrouter:openrouter/moonshotai/kimi-k3@OPENROUTER_API_KEY; claude=anthropic:claude-sonnet-5@ANTHROPIC_API_KEY')).toEqual([
      { id: 'codex', provider: 'openai-codex', model: lookupLlmTierSpec('openai-codex', 'better').model, modelSource: 'ladder', passEnv: [] },
      { id: 'or-kimi', provider: 'openrouter', model: 'openrouter/moonshotai/kimi-k3', modelSource: 'explicit', passEnv: ['OPENROUTER_API_KEY'] },
      { id: 'claude', provider: 'anthropic', model: 'claude-sonnet-5', modelSource: 'explicit', passEnv: ['ANTHROPIC_API_KEY'] },
    ]);
  });
  test('rejects a single arm, duplicate ids and malformed parts', () => {
    expect(() => parseBenchArms('a=grok')).toThrow('둘 이상');
    expect(() => parseBenchArms('a=grok;a=openai-codex')).toThrow('겹친다');
    expect(() => parseBenchArms('a grok;b=grok')).toThrow('못 읽는');
  });
  test('goals differ by exactly one label line (A/B rule ②)', () => {
    const arms = parseBenchArms('a=grok;b=openai-codex');
    const [ga, gb] = benchGoals('대상 경로: x.md · 만든다', arms);
    expect(ga!.split('\n').slice(0, -1)).toEqual(gb!.split('\n').slice(0, -1));
    expect(ga).toEndWith('[bench-arm: a]');
    expect(gb).toEndWith('[bench-arm: b]');
  });
  test('each arm pod gets its provider/model/arm id and only its own billing key', async () => {
    const calls: Array<{ args: string; input?: string }> = [];
    const k = ((args: readonly string[], input?: string) => { calls.push({ args: args.join(' '), ...(input ? { input } : {}) }); return { status: 0, stdout: args.includes('current-context') ? 'test-context' : args.includes('get') ? 'Complete' : '', stderr: '' }; });
    const arms = parseBenchArms('codex=openai-codex;or-kimi=openrouter:openrouter/moonshotai/kimi-k3@OPENROUTER_API_KEY');
    const spawn = benchPodSpawn(arms, { kubectl: k, sleep: async () => {}, credentials: CREDS, env: {}, readKeyCache: (n) => (n === 'OPENROUTER_API_KEY' ? 'sk-or-cached' : undefined) });
    const [, gKimi] = benchGoals('g', arms);
    await spawn({ feature: gKimi!, spaceId: 's-kimi' }).done;
    const [secret, job] = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!));
    expect(secret.stringData['env-OPENROUTER_API_KEY']).toBe('sk-or-cached');
    const env = job.spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>;
    expect(env).toContainEqual({ name: 'ELANOUS_LLM_PROVIDER', value: 'openrouter' });
    expect(env).toContainEqual({ name: 'ELANOUS_LLM_MODEL', value: 'openrouter/moonshotai/kimi-k3' });
    expect(env).toContainEqual({ name: 'ELANOUS_ARM_ID', value: 'pod/or-kimi' });
  });
  test('an arm without a model never falls to the legacy provider constant', () => {
    const [claude] = parseBenchArms('claude=anthropic;codex=openai-codex');
    expect(claude!.model).toBe(lookupLlmTierSpec('anthropic', 'better').model);
    expect(claude!.model).not.toContain('haiku');
  });
  test('rework escalation stays inside the arm (sol and opus tiers)', () => {
    const [claude] = parseBenchArms('claude=anthropic:claude-sonnet-5;codex=openai-codex');
    const env = benchArmEnv(claude!);
    for (const tier of ['sol', 'opus'] as const) {
      expect(resolveEscalateTarget(tier, env)).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
    }
    expect(resolveEscalateTarget('sol', {})!.provider).toBe('openai-codex');   // 대조군 — 덮지 않으면 codex 로 샌다
  });
  test('local arm: ladder model, host LLM url, and only its pod carries the local-llm egress label', async () => {
    const arms = parseBenchArms('local=local;codex=openai-codex');
    expect(arms[0]!.model).toBe(lookupLlmTierSpec('local', 'better').model);
    expect(benchArmEnv(arms[0]!).LOCAL_LLM_URL).toBe('http://host.orb.internal:1234/v1');
    expect(benchArmEnv(arms[1]!).LOCAL_LLM_URL).toBeUndefined();
    const labelsFor = async (goal: string): Promise<Record<string, string>> => {
      const calls: Array<{ args: string; input?: string }> = [];
      const k = ((args: readonly string[], input?: string) => { calls.push({ args: args.join(' '), ...(input ? { input } : {}) }); return { status: 0, stdout: args.includes('current-context') ? 'test-context' : args.includes('get') ? 'Complete' : '', stderr: '' }; });
      await benchPodSpawn(arms, { kubectl: k, sleep: async () => {}, credentials: CREDS, env: {} })({ feature: goal, spaceId: 's' }).done;
      const job = calls.filter((c) => c.args.endsWith('apply -f -')).map((c) => JSON.parse(c.input!)).find((m) => m.kind === 'Job');
      return job.spec.template.metadata.labels;
    };
    const [gLocal, gCodex] = benchGoals('g', arms);
    expect((await labelsFor(gLocal!))['elanous.egress/local-llm']).toBe('true');
    expect((await labelsFor(gCodex!))['elanous.egress/local-llm']).toBeUndefined();
  });
  test('a goal without a known arm label fails with a named error (no silent default arm)', async () => {
    const r = await benchPodSpawn(parseBenchArms('a=grok;b=openai-codex'), { credentials: CREDS })({ feature: 'no label', spaceId: 's' }).done;
    expect(r.error?.code).toBe('bench-arm-missing');
  });
});

// BACKLOG E6 — 이미지 판 대조.
import { podImageFreshness } from './self-implement-pod.js';
describe('pod image freshness', () => {
  const fake = (head: string | null, label: string | null, imageExists = true) => (cmd: string) =>
    cmd === 'git'
      ? { status: head ? 0 : 128, stdout: head ? `${head}\n` : '' }
      : { status: imageExists ? 0 : 1, stdout: label === null ? '<no value>\n' : `${label}\n` };
  test('fresh only when the image label equals HEAD', () => {
    expect(podImageFreshness({ run: fake('abc', 'abc') }).fresh).toBe(true);
    expect(podImageFreshness({ run: fake('abc', 'old') })).toMatchObject({ fresh: false, imageCommit: 'old', headCommit: 'abc' });
  });
  test('missing label, missing image, unreadable HEAD are all stale (never assumed fresh)', () => {
    expect(podImageFreshness({ run: fake('abc', null) }).fresh).toBe(false);
    expect(podImageFreshness({ run: fake('abc', 'abc', false) }).fresh).toBe(false);
    expect(podImageFreshness({ run: fake(null, 'abc') }).fresh).toBe(false);
  });
});

// BACKLOG C5·C1b — 모름을 0 으로 보이지 않고, 호스트가 다시 매긴다.
import { podRowCost } from './self-implement-pod.js';
describe('pod rollup row cost (BACKLOG C5·C1b)', () => {
  const row = { model: 'openrouter/moonshotai/kimi-k3', calls: 16, inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, usdKnown: 0, unknownCostCalls: 16 };
  test('all-unknown without a host price is unknown with usd null — never $0', () => {
    expect(podRowCost(row)).toEqual({ kind: 'unknown', usd: null, unknownCostCalls: 16 });
    expect(podRowCost(row, () => ({ kind: 'unknown' }))).toMatchObject({ kind: 'unknown', usd: null });
  });
  test('host reprice turns pod-unknown into known with its source named', () => {
    expect(podRowCost(row, () => ({ kind: 'known', usd: 3 }))).toEqual({ kind: 'known', usd: 3, source: 'host-reprice', podUnknownCostCalls: 16 });
  });
  test('fully known rows pass through; partial keeps the known share', () => {
    expect(podRowCost({ ...row, unknownCostCalls: 0, usdKnown: 1.5 })).toEqual({ kind: 'known', usd: 1.5, unknownCostCalls: 0 });
    expect(podRowCost({ ...row, unknownCostCalls: 4, usdKnown: 1.5 })).toEqual({ kind: 'partial', usd: 1.5, unknownCostCalls: 4 });
  });
});

// BACKLOG C6 — 구독·local 은 «포함»(청구 0)이고 «모름»이 아니다.
import { llmUsageCostFields } from '../../budget/llm-cost.js';
describe('included cost for subscription/local (BACKLOG C6)', () => {
  test('subscription call is included with an api-equivalent, not a known API charge', () => {
    const f = llmUsageCostFields('gpt-6-sol', { inputTokens: 1_000_000, outputTokens: 0 }, { configPricing: {} }, 'subscription');
    expect(f.cost).toMatchObject({ kind: 'included', usd: 0, billing: 'subscription', apiEquivalentUsd: 2 });
    expect(llmUsageCostFields('gpt-6-sol', { inputTokens: 1_000_000, outputTokens: 0 }, { configPricing: {} }, 'api').cost).toMatchObject({ kind: 'known', usd: 2 });
  });
  test('rollup counts included calls apart from unknown; pod row of all-included stays included', () => {
    const r = rollup([JSON.stringify({ event: 'llm-usage', data: { site: 'agent-turn', provider: 'openai', billingProvider: 'openai-codex', model: 'gpt-6-sol', inputTokens: 10, outputTokens: 1, cost: { kind: 'included', usd: 0, apiEquivalentUsd: 0.25 } } })]);
    expect(r.rows[0]).toMatchObject({ provider: 'openai-codex', calls: 1, unknownCostCalls: 0, includedCalls: 1, apiEquivalentUsd: 0.25, usdKnown: 0 });
    expect(podRowCost(r.rows[0] as unknown as Record<string, unknown>)).toMatchObject({ kind: 'included', usd: 0, apiEquivalentUsd: 0.25 });
  });
});

// 🅣 RFC run-origin(#20457 §A3) — Pod 가 자기 출처를 env 로 갖는다(칸 이름 합의).
describe('pod run-origin env (RFC run-origin §A3)', () => {
  test('downward API pod/node/namespace, supervisor hostId and image commit are in the child env', () => {
    const job = podJobManifest({ name: 'si-x', namespace: 'elanous-test', image: 'elanous-harness:local', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60, hostId: 'host-abc', imageCommit: 'deadbeef' }) as { spec: { template: { spec: { containers: Array<{ env: Array<Record<string, unknown>> }> } } } };
    const env = job.spec.template.spec.containers[0]!.env;
    expect(env).toContainEqual({ name: 'ELANOUS_POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } });
    expect(env).toContainEqual({ name: 'ELANOUS_NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } });
    expect(env).toContainEqual({ name: 'ELANOUS_POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } });
    expect(env).toContainEqual({ name: 'ELANOUS_HOST_ID', value: 'host-abc' });
    expect(env).toContainEqual({ name: 'ELANOUS_IMAGE_COMMIT', value: 'deadbeef' });
  });
  test('rollup origin fields are re-emitted on the host', () => {
    const out: Array<Record<string, unknown>> = [];
    const line = `ELANOUS_USAGE_ROLLUP ${JSON.stringify({ runId: 'r1', podName: 'si-x-abc', nodeName: 'k3d-node-0', hostId: 'host-abc', rows: [{ site: 'agent-turn', model: 'gpt-6-sol', calls: 1, inputTokens: 1, outputTokens: 1, usdKnown: 0.1, unknownCostCalls: 0 }] })}`;
    reemitPodUsage(line, 'si-x', (_c, _e, d) => out.push(d));
    expect(out[0]).toMatchObject({ podName: 'si-x-abc', nodeName: 'k3d-node-0', podHostId: 'host-abc' });
  });

  test('memory limit defaults to 12Gi (6Gi OOMKilled a real child) and follows ELANOUS_POD_MEMORY', () => {
    const base = { name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 };
    expect(JSON.stringify(podJobManifest(base))).toContain('"memory":"12Gi"');
    expect(JSON.stringify(podJobManifest({ ...base, memoryLimit: '24Gi' }))).toContain('"memory":"24Gi"');
  });
});

// P2·P3·P4 (2026-09-26 Pod 실물 미션에서 나온 셋).
import { hostCredentials } from './self-implement-pod.js';
import { join as pjoin } from 'node:path';
describe('pod remote continuity', () => {
  const jwt = (expSec: number) => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`;
  test('P4: the elanous copy carries the checked codex token, never a stale store token or any refresh token', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'pod-cred-'));
    const codexHome = pjoin(dir, 'codex'); mkdirSync(codexHome);
    const fresh = jwt(Math.floor(Date.now() / 1000) + 200 * 3600);
    writeFileSync(pjoin(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: fresh, refresh_token: 'r-codex', account_id: 'acc' } }));
    const store = pjoin(dir, 'auth.json');
    writeFileSync(store, JSON.stringify({ version: 1, providers: { 'openai-codex:third': { codexHome, tokens: { accessToken: jwt(Math.floor(Date.now() / 1000) - 3600), expiresAt: 1, refreshToken: 'r-elanous', tokenType: 'Bearer' } } } }));
    const c = hostCredentials('third', store, () => 'gh');
    const el = JSON.parse(c.elanousAuth).providers['openai-codex'].tokens;
    expect(el.accessToken).toBe(fresh);
    expect(el.expiresAt).toBeGreaterThan(Date.now() + 100 * 3600_000);
    expect(el.refreshToken).toBe('');
    expect(JSON.parse(c.codexAuth).tokens.refresh_token).toBe('');
    expect(c.elanousAuth + c.codexAuth).not.toContain('r-codex');
    expect(c.elanousAuth + c.codexAuth).not.toContain('r-elanous');
  });

  const run = (existing: string) => {
    const calls: string[][] = [];
    const k = (args: readonly string[]) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx\n', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: existing ? 0 : 1, stdout: existing, stderr: existing ? '' : 'NotFound' };
      if (args.includes('jsonpath={.metadata.uid}')) return { status: 0, stdout: 'uid-1', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    return { calls, done: podSelfImplementSpawn({ kubectl: k, pollMs: 1, imageCommit: null, sleep: async () => {}, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 't' }) })({ spaceId: 's', feature: 'f' } as Parameters<ReturnType<typeof podSelfImplementSpawn>>[0]).done };
  };
  test('failed existing Job returns child ledger and artifact before deletion and relaunch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-failed-relaunch-'));
    const previousState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const spaceId = 'failed-relaunch';
    const job = podJobName(spaceId);
    const id = 'run-failed-before-delete';
    const ledger = '{"event":"failed"}\n';
    const artifact = `ELANOUS_POD_ARTIFACT ${Buffer.from('failure.txt').toString('base64url')} 1/1 ${gzipSync('saved before delete').toString('base64')}`;
    const logText = `ELANOUS_RUN_LEDGER ${id} 1/1 ${gzipSync(ledger).toString('base64')}\n${artifact}\n`;
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Failed', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: logText, stderr: '' };
      if (args.includes('delete') && args.includes('job')) {
        expect(readFileSync(runLedgerPath(id, runLedgerDir(root)), 'utf8')).toBe(ledger);
        expect(readFileSync(join(effectiveInstanceRoot(), 'pod-artifacts', job, 'failure.txt'), 'utf8')).toBe('saved before delete');
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'f', spaceId }).done;
      expect(result.exitCode).toBe(0);
      const logs = calls.findIndex((args) => args.includes('logs'));
      const deletion = calls.findIndex((args) => args.includes('delete') && args.includes('job'));
      expect(logs).toBeGreaterThan(-1);
      expect(calls[logs]).toContain('-c');
      expect(calls[logs]).toContain('child');
      expect(calls[logs]).not.toContain('--tail=400');
      expect(deletion).toBeGreaterThan(logs);
      expect(calls.findIndex((args) => args.includes('apply'))).toBeGreaterThan(logs);
      expect(readFileSync(runLedgerPath(id, runLedgerDir(root)), 'utf8')).toBe(ledger);
      expect(readFileSync(join(effectiveInstanceRoot(), 'pod-artifacts', job, 'failure.txt'), 'utf8')).toBe('saved before delete');
    } finally {
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unreadable failed Job logs report the reason and still delete the Job', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'self-implement.pod') events.push({ event, data });
    }) as typeof debug.log);
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Failed', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs') && !args.includes('--tail=400')) return { status: 1, stdout: '', stderr: 'old logs unavailable' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {} })({ feature: 'f', spaceId: 'failed-no-logs' }).done;
      const deletion = calls.findIndex((args) => args.includes('delete') && args.includes('job'));
      expect(deletion).toBeGreaterThan(calls.findIndex((args) => args.includes('logs')));
      expect(events).toContainEqual({ event: 'failed-job-logs-unavailable', data: { job: podJobName('failed-no-logs'), reason: 'old logs unavailable' } });
    } finally { logSpy.mockRestore(); }
  });

  test('empty child logs from a failed Job are reported before it is deleted', async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'self-implement.pod') events.push({ event, data });
    }) as typeof debug.log);
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Failed', stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: {} })({ feature: 'f', spaceId: 'failed-empty-logs' }).done;
      const logs = calls.findIndex((args) => args.includes('logs'));
      const deletion = calls.findIndex((args) => args.includes('delete') && args.includes('job'));
      expect(logs).toBeGreaterThan(-1);
      expect(deletion).toBeGreaterThan(logs);
      expect(events).toContainEqual({ event: 'failed-job-logs-unavailable', data: { job: podJobName('failed-empty-logs'), reason: 'empty child logs' } });
    } finally { logSpy.mockRestore(); }
  });

  test('failed Job remains intact if either ledger or artifact cannot be stored on the host', async () => {
    for (const kind of ['ledger', 'artifact'] as const) {
      const root = mkdtempSync(join(tmpdir(), `pod-collection-${kind}-`));
      const previousState = process.env.ELANOUS_STATE_DIR;
      process.env.ELANOUS_STATE_DIR = root;
      const spaceId = `failed-collection-${kind}-${root.split('/').at(-1)}`;
      const job = podJobName(spaceId);
      const line = kind === 'ledger'
        ? `ELANOUS_RUN_LEDGER run-storage-failure 1/1 ${gzipSync('old ledger\n').toString('base64')}`
        : `ELANOUS_POD_ARTIFACT ${Buffer.from('blocked/output.txt').toString('base64url')} 1/1 ${gzipSync('old artifact').toString('base64')}`;
      const calls: string[][] = [];
      const kubectl: Kubectl = (args) => {
        calls.push([...args]);
        if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
        if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Failed', stderr: '' };
        if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
        if (args.includes('logs')) return { status: 0, stdout: `${line}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      try {
        if (kind === 'ledger') mkdirSync(runLedgerPath('run-storage-failure', runLedgerDir(root)), { recursive: true });
        else {
          mkdirSync(join(root, 'pod-artifacts', job), { recursive: true });
          writeFileSync(join(root, 'pod-artifacts', job, 'blocked'), 'not a directory');
        }
        const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ feature: 'f', spaceId }).done;
        expect(result.exitCode).toBe(1);
        expect(result.error?.code).toBe('pod-collection-incomplete');
        expect(calls.some((args) => args.includes('logs') && args.includes(`job/${job}`))).toBe(true);
        expect(calls.some((args) => args.includes('delete') && args.includes('job'))).toBe(false);
        expect(calls.some((args) => args.includes('apply'))).toBe(false);
      } finally {
        if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = previousState;
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test('P3: resuming uses the running Job child ID rather than the newly minted candidate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-reattach-'));
    const child = 'run-reattached-1';
    const calls: string[][] = [];
    const kubectl: Kubectl = (args) => {
      calls.push([...args]);
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b ', stderr: '' };
      if (args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'child', env: [{ name: 'ELANOUS_RUN_ID', value: child }] }] } } } }), stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync('{"event":"reattached"}\n').toString('base64')}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      expect((await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } })({ spaceId: 'reattach', feature: 'x' }).done).exitCode).toBe(0);
      expect(readFileSync(runLedgerPath(child, runLedgerDir(root)), 'utf8')).toContain('reattached');
      expect(calls.some((c) => c.includes('delete') && c.includes('job'))).toBe(false);
      expect(calls.some((c) => c.includes('apply'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('P3: reconnecting to an already collected complete Job preserves its child ledger and completeness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-reattach-complete-'));
    const child = 'run-reattached-complete-1';
    const ledger = '{"event":"child-start"}\n{"event":"child-done"}\n';
    const finished: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    const off = debug.registerSink({ name: 'pod-reattach-complete-test', emit: (record) => {
      if (record.category !== 'self-implement.pod') return;
      events.push(record.event);
      if (record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    } });
    let applied = false;
    const kubectl: Kubectl = (args, input) => {
      if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
      if (args.includes('apply') && input && JSON.parse(input).kind === 'Job') { applied = true; return { status: 0, stdout: '', stderr: '' }; }
      if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: applied ? 0 : 1, stdout: applied ? '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b Complete' : '', stderr: '' };
      if (args.includes('-o') && args.includes('json')) return { status: 0, stdout: JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'child', env: [{ name: 'ELANOUS_RUN_ID', value: child }] }] } } } }), stderr: '' };
      if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
      if (args.includes('logs')) return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${child} 1/1 ${gzipSync(ledger).toString('base64')}\n{"stage":"merged","ok":true}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    try {
      const opts = { kubectl, credentials: CREDS, env: { ELANOUS_STATE_DIR: root } };
      const dir = runLedgerDir(root);
      // First collection of the existing Job, then a second invocation attaches to the same Job.
      applied = true;
      expect((await podSelfImplementSpawn(opts)({ spaceId: 'reattach-complete', feature: 'x' }).done).exitCode).toBe(0);
      const before = readFileSync(runLedgerPath(child, dir), 'utf8');
      expect(before).toBe(ledger);
      expect((await podSelfImplementSpawn(opts)({ spaceId: 'reattach-complete', feature: 'x' }).done).exitCode).toBe(0);
      expect(readFileSync(runLedgerPath(child, dir), 'utf8')).toBe(before);
      expect(events).toContain('ledger-collect-already-complete');
      expect(events).not.toContain('ledger-collect-skipped');
      expect(finished).toHaveLength(2);
      expect(finished.every((row) => row.childRunId === child && row.ledgerCompleteness === 'complete')).toBe(true);
    } finally { off(); rmSync(root, { recursive: true, force: true }); }
  });

  test('P3: unreadable or invalid running Job child ID stops without inventing a ledger', async () => {
    for (const manifest of [null, { spec: { template: { spec: { containers: [{ name: 'child', env: [{ name: 'ELANOUS_RUN_ID', value: 'run-parent-1' }] }] } } } }]) {
      const root = mkdtempSync(join(tmpdir(), 'pod-reattach-missing-id-'));
      const calls: string[][] = [];
      const kubectl: Kubectl = (args) => {
        calls.push([...args]);
        if (args.includes('current-context')) return { status: 0, stdout: 'ctx', stderr: '' };
        if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 0, stdout: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b ', stderr: '' };
        if (args.includes('-o') && args.includes('json')) return { status: manifest ? 0 : 1, stdout: manifest ? JSON.stringify(manifest) : '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      };
      try {
        const result = await podSelfImplementSpawn({ kubectl, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-parent-1', ELANOUS_STATE_DIR: root } })({ spaceId: 'reattach-missing', feature: 'x' }).done;
        expect(result.error?.code).toBe('pod-child-run-id');
        expect(calls.some((c) => c.includes('exec') || c.includes('logs') || c.includes('apply') || c.includes('delete'))).toBe(false);
        expect(existsSync(runLedgerDir(root))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
  test('P2: a fresh Job owns its credential secret, so k8s reaps it with the Job', async () => {
    const r = run('');
    await r.done;
    const patch = r.calls.find((c) => c.includes('patch') && c.includes('secret'));
    expect(patch).toBeDefined();
    expect(patch!.join(' ')).toContain('"ownerReferences":[{"apiVersion":"batch/v1","kind":"Job"');
    expect(patch!.join(' ')).toContain('"uid":"uid-1"');
  });
});

// P13 원격 그라운딩 — 토큰은 Secret 으로만 · 끝나면 회수 · 주소가 없으면 발급 자체를 안 한다.
describe('pod grounding token', () => {
  const k = (applied: string[]) => ((args: readonly string[], input?: string) => {
    if (input) applied.push(input);
    if (args.includes('current-context')) return { status: 0, stdout: 'ctx\n', stderr: '' };
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }) as Kubectl;
  test('with a grounding URL: token only in the Secret, URL as plain env, revoked when the Job ends', async () => {
    const applied: string[] = [];
    const revoked: string[] = [];
    await podSelfImplementSpawn({
      kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {}, credentials: CREDS, env: { ELANOUS_RUN_ID: 'run-g1' },
      groundingUrl: 'http://100.64.0.1:31415', mintGrounding: async (c) => ({ token: `tok-for-${c.runId}`, exp: 9 }), revokeGrounding: (r) => revoked.push(r),
    })({ spaceId: 's', feature: 'f' }).done;
    const secret = applied.find((a) => a.includes('"kind":"Secret"'))!;
    const job = applied.find((a) => a.includes('"kind":"Job"'))!;
    expect(JSON.parse(secret).stringData['env-ELANOUS_GROUNDING_TOKEN']).toBe('tok-for-run-g1');
    expect(job).not.toContain('tok-for-run-g1');   // 매니페스트에는 값이 없다 — secretKeyRef 만
    expect(job).toContain('"name":"ELANOUS_GROUNDING_TOKEN","valueFrom":{"secretKeyRef"');
    expect(job).toContain('"name":"ELANOUS_GROUNDING_URL","value":"http://100.64.0.1:31415"');
    expect(revoked).toEqual(['run-g1']);
  });
  test('grok subscription with a grounding URL mints llm-credential onto the same run and the same revoke', async () => {
    const applied: string[] = [];
    const minted: Array<{ runId: string; job: string; ttlMs: number; scope?: string }> = [];
    const revoked: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement.pod' && (event === 'credential-relay' || event === 'credential-relay-skipped')) events.push({ event, ...(data ?? {}) });
    }) as typeof debug.log);
    try {
      await podSelfImplementSpawn({
        provider: 'grok', kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {},
        grokCredentials: () => ({ grokAuth: JSON.stringify({ scope: { key: 'access-x' } }), ghToken: 'gh' }),
        env: { ELANOUS_RUN_ID: 'run-g1' }, deadlineSeconds: 180,
        groundingUrl: 'https://host:31415',
        mintGrounding: async (c) => { minted.push({ ...c }); return { token: c.scope === 'llm-credential' ? 'relay-tok' : `tok-for-${c.runId}`, exp: 9 }; },
        revokeGrounding: (r) => revoked.push(r),
      })({ spaceId: 's', feature: 'f' }).done;
    } finally { logSpy.mockRestore(); }
    const secret = JSON.parse(applied.find((a) => a.includes('"kind":"Secret"'))!);
    const job = applied.find((a) => a.includes('"kind":"Job"'))!;
    expect(minted).toEqual([
      { runId: 'run-g1', job: podJobName('s'), ttlMs: 180_000 },
      { runId: 'run-g1', job: podJobName('s'), ttlMs: 180_000, scope: 'llm-credential' },
    ]);
    expect(secret.stringData['env-ELANOUS_GROUNDING_TOKEN']).toBe('tok-for-run-g1');
    expect(secret.stringData['env-ELANOUS_POD_CREDENTIAL_TOKEN']).toBe('relay-tok');
    expect(job).not.toContain('relay-tok');
    expect(job).toContain('"name":"ELANOUS_POD_CREDENTIAL_TOKEN","valueFrom":{"secretKeyRef"');
    expect(job).toContain('"name":"ELANOUS_POD_CREDENTIAL_URL","value":"https://host:31415/v1/pod/credential/grok"');
    expect(job).not.toContain('elanous.egress/host-grounding');
    expect(revoked).toEqual(['run-g1']);
    expect(events).toEqual([{ event: 'credential-relay', job: podJobName('s'), runId: 'run-g1', exp: 9 }]);
    expect(JSON.stringify(events)).not.toContain('relay-tok');
  });
  test('codex with a grounding URL does not mint llm-credential', async () => {
    const applied: string[] = [];
    const minted: Array<{ scope?: string }> = [];
    await podSelfImplementSpawn({
      kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {},
      credentials: () => ({ ...CREDS(), grokAuth: JSON.stringify({ scope: { key: 'access-x' } }) }),
      env: { ELANOUS_RUN_ID: 'run-g1' },
      groundingUrl: 'https://host:31415',
      mintGrounding: async (c) => { minted.push({ ...(c.scope ? { scope: c.scope } : {}) }); return { token: `tok-for-${c.runId}`, exp: 9 }; },
      revokeGrounding: () => {},
    })({ spaceId: 's', feature: 'f' }).done;
    const secret = JSON.parse(applied.find((a) => a.includes('"kind":"Secret"'))!);
    const job = applied.find((a) => a.includes('"kind":"Job"'))!;
    expect(minted).toEqual([{}]);
    expect(secret.stringData['env-ELANOUS_POD_CREDENTIAL_TOKEN']).toBeUndefined();
    expect(job).not.toContain('ELANOUS_POD_CREDENTIAL');
    expect(job).toContain('"name":"ELANOUS_GROUNDING_URL","value":"https://host:31415"');
  });
  test('without a grounding URL nothing is minted', async () => {
    const applied: string[] = [];
    let minted = 0;
    await podSelfImplementSpawn({
      kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {}, credentials: CREDS, env: {},
      mintGrounding: async () => { minted++; return { token: 't', exp: 1 }; }, revokeGrounding: () => { throw new Error('must not revoke'); },
    })({ spaceId: 's', feature: 'f' }).done;
    expect(minted).toBe(0);
    expect(applied.join('')).not.toContain('GROUNDING');
  });
  test('grok subscription without a grounding URL skips the credential relay', async () => {
    const applied: string[] = [];
    const minted: unknown[] = [];
    const events: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement.pod' && event === 'credential-relay-skipped') events.push(data ?? {});
    }) as typeof debug.log);
    try {
      await podSelfImplementSpawn({
        provider: 'grok', kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {},
        grokCredentials: () => ({ grokAuth: JSON.stringify({ scope: { key: 'access-x' } }), ghToken: 'gh' }),
        env: {},
        mintGrounding: async (c) => { minted.push(c); return { token: 't', exp: 1 }; },
        revokeGrounding: () => { throw new Error('must not revoke'); },
      })({ spaceId: 's', feature: 'f' }).done;
    } finally { logSpy.mockRestore(); }
    expect(minted).toEqual([]);
    expect(applied.join('')).not.toContain('ELANOUS_POD_CREDENTIAL');
    expect(applied.join('')).not.toContain('GROUNDING');
    expect(events).toEqual([{ reason: 'no-host-url' }]);
  });
  test('grok API key with a grounding URL does not mint llm-credential', async () => {
    const applied: string[] = [];
    const minted: Array<{ scope?: string }> = [];
    await podSelfImplementSpawn({
      provider: 'grok', grokApiKeyOptIn: true, kubectl: k(applied), pollMs: 1, imageCommit: null, sleep: async () => {},
      grokCredentials: () => ({ grokApiKey: 'paid-key', ghToken: 'gh' }),
      env: {}, groundingUrl: 'https://host:31415',
      mintGrounding: async (c) => { minted.push({ ...(c.scope ? { scope: c.scope } : {}) }); return { token: 'ground-tok', exp: 1 }; },
      revokeGrounding: () => {},
    })({ spaceId: 's', feature: 'f' }).done;
    const secret = JSON.parse(applied.find((a) => a.includes('"kind":"Secret"'))!);
    const job = applied.find((a) => a.includes('"kind":"Job"'))!;
    expect(minted).toEqual([{}]);
    expect(secret.stringData['env-ELANOUS_POD_CREDENTIAL_TOKEN']).toBeUndefined();
    expect(job).not.toContain('ELANOUS_POD_CREDENTIAL');
  });
});

describe('pod job deadline', () => {
  test('기본 Job 수명 상한은 180분이다', () => {
    expect(POD_JOB_DEADLINE_SECONDS).toBe(10_800);
  });
});

function jobScript(): string {
  const manifest = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } };
  return manifest.spec.template.spec.containers[0]!.args[0]!;
}

describe('pod salvage', () => {
  test('manifest salvages only when rc is not 0, pushes only under salvage/, and keeps exit $rc last', () => {
    const script = jobScript();
    const salvage = podSalvageScript();
    expect(script).toContain(salvage);
    expect(script.trimEnd().endsWith('exit $rc')).toBe(true);
    expect(script.indexOf(salvage)).toBeLessThan(script.lastIndexOf('exit $rc'));
    expect(salvage.startsWith('if [ "${rc:-0}" -ne 0 ]; then')).toBe(true);
    expect(salvage).toContain('git worktree list --porcelain');
    expect(salvage).toContain('branch="salvage/${job_name}/${wt_name}"');
    expect(salvage).toContain('git push origin "HEAD:refs/heads/${branch}"');
    expect(salvage).toContain('git commit -m "salvage: ${job_name} rc=${rc}"');
    expect(salvage).toContain("printf 'ELANOUS_POD_SALVAGE %s %s\\n'");
    expect(salvage).toContain("printf 'ELANOUS_POD_SALVAGE_NONE clean\\n'");
    expect(salvage).not.toMatch(/git push[^\\n]*\bmain\b/);
    expect(salvage).not.toMatch(/git push[^\\n]*self-impl\//);
    const rc0 = Bun.spawnSync(['bash', '-c', `rc=0\n${salvage}\necho AFTER:$?`], { env: { ...process.env, ELANOUS_POD_NAME: 'job-a' } });
    expect(rc0.exitCode).toBe(0);
    expect(rc0.stdout.toString()).toBe('AFTER:0\n');
    expect(rc0.stdout.toString()).not.toContain('ELANOUS_POD_SALVAGE');
  });

  test('real bash against a local bare remote salvages a dirty worktree and prints NONE for a clean one', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-salvage-'));
    try {
      const bare = join(root, 'remote.git');
      const main = join(root, 'main');
      const dirty = join(root, 'wt-dirty');
      const clean = join(root, 'wt-clean');
      execFileSync('git', ['init', '--bare', '-q', bare]);
      execFileSync('git', ['clone', '-q', bare, main]);
      execFileSync('git', ['-C', main, 'config', 'user.email', 'pod@example.com']);
      execFileSync('git', ['-C', main, 'config', 'user.name', 'pod']);
      writeFileSync(join(main, 'README'), 'base\n');
      execFileSync('git', ['-C', main, 'add', 'README']);
      execFileSync('git', ['-C', main, 'commit', '-qm', 'base']);
      execFileSync('git', ['-C', main, 'push', '-q', 'origin', 'HEAD:refs/heads/main']);
      execFileSync('git', ['-C', main, 'fetch', '-q', 'origin']);
      execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'child-dirty', dirty, 'origin/main']);
      execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'child-clean', clean, 'origin/main']);
      writeFileSync(join(dirty, 'changed.txt'), 'kept\n');
      const salvage = podSalvageScript();
      const env = { ...process.env, ELANOUS_POD_NAME: 'job-a', GIT_AUTHOR_NAME: 'pod', GIT_AUTHOR_EMAIL: 'pod@example.com', GIT_COMMITTER_NAME: 'pod', GIT_COMMITTER_EMAIL: 'pod@example.com' };
      const failed = Bun.spawnSync(['bash', '-c', `cd ${main} && rc=7\n${salvage}\nexit $rc`], { env });
      expect(failed.exitCode).toBe(7);
      const lines = failed.stdout.toString().trim().split('\n');
      const pushed = lines.find((line) => line.startsWith('ELANOUS_POD_SALVAGE '));
      expect(pushed).toBeDefined();
      const [, branch, commit] = pushed!.split(' ');
      expect(branch).toBe('salvage/job-a/wt-dirty');
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
      expect(lines).toContain('ELANOUS_POD_SALVAGE_NONE clean');
      expect(execFileSync('git', ['-C', bare, 'rev-parse', branch], { encoding: 'utf8' }).trim()).toBe(commit);
      expect(execFileSync('git', ['-C', bare, 'ls-tree', '-r', '--name-only', commit], { encoding: 'utf8' })).toContain('changed.txt');
      const subject = execFileSync('git', ['-C', bare, 'log', '-1', '--format=%s', commit], { encoding: 'utf8' }).trim();
      expect(subject).toBe('salvage: job-a rc=7');
      expect(execFileSync('git', ['-C', bare, 'branch', '--list', 'salvage/*'], { encoding: 'utf8' })).toContain('salvage/job-a/wt-dirty');
      // `--format` — `* main` 여부는 bare 저장소 HEAD(= git 기본 브랜치 설정)에 따라 달라진다(Pod linux ↔ mac).
      expect(execFileSync('git', ['-C', bare, 'branch', '--list', 'main', '--format=%(refname:short)'], { encoding: 'utf8' }).trim()).toBe('main');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('Job log salvage line is recorded as salvage-pushed and appended to the human run-result line', async () => {
    const branch = 'salvage/job-a/wt-dirty';
    const commit = 'abc123def456';
    const json = JSON.stringify({ stage: 'gate-failed', ok: false });
    const logs = `noise\nELANOUS_POD_SALVAGE ${branch} ${commit}\n${json}\n`;
    const events: Array<Record<string, unknown>> = [];
    const logSpy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement.pod' && event === 'salvage-pushed') events.push(data ?? {});
    }) as typeof debug.log);
    const { k } = fakeKubectl(['Failed'], logs);
    try {
      const result = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS })({ feature: 'x', spaceId: 'salvage-host' }).done;
      expect(events).toEqual([{ job: podJobName('salvage-host'), branch, commit }]);
      expect(result.output).toContain(`수확할 브랜치: ${branch}`);
      expect(recordPodSalvage('ELANOUS_POD_SALVAGE main deadbeef\nELANOUS_POD_SALVAGE_NONE clean\n', 'j', () => { throw new Error('must not log'); })).toEqual([]);
    } finally { logSpy.mockRestore(); }
  });
});

describe('Pod 자식 요청(requests) — 예약은 실사용에, 상한은 그대로 (2026-09-27)', () => {
  test('podJobManifest 는 cpu 1 · 메모리 4Gi 를 요청하고 상한 cpu 4 · 12Gi 를 유지한다', () => {
    const m = podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ resources: { requests?: Record<string, string>; limits: Record<string, string> } }> } } } };
    const r = m.spec.template.spec.containers[0]!.resources;
    expect(r.requests).toEqual({ cpu: '1', memory: '4Gi' });
    expect(r.limits).toEqual({ memory: '12Gi', cpu: '4' });
  });
});

