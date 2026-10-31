import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { podDelegatedChildLlm, podJobManifest, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../../self-implement/run-ledger.js';

// CHILD-LLM-PIN-POD (0.2.24) — the delegated in-Pod `harness say` / `harness ask` lines carry the child LLM pair.
const CHILD = ['--child-llm-provider', 'openrouter', '--child-llm-model', 'openrouter/openai/gpt-6-luna'] as const;
const CARRIED = ` '--child-llm-provider' 'openrouter' '--child-llm-model' 'openrouter/openai/gpt-6-luna'`;

const scriptOf = (args: readonly string[], extra: Record<string, unknown>) =>
  (podJobManifest({ name: 'j', namespace: 'n', image: 'i', repoUrl: 'r', args, passEnv: [], deadlineSeconds: 60, ...extra }) as { spec: { template: { spec: { containers: Array<{ args: string[] }> } } } }).spec.template.spec.containers[0]!.args[0]!;
const lineOf = (script: string, needle: string) => script.split('\n').find((line) => line.includes(needle));

describe('CHILD-LLM-PIN-POD — delegated Pod commands carry the child LLM', () => {
  test('(a) authorSentence: harness say carries --child-llm-provider and --child-llm-model', () => {
    const script = scriptOf(['--open-pr', '--base', 'main', ...CHILD], { authorSentence: true });
    expect(script).toContain(`elanous harness say --substrate local --json '--base' 'main' --no-auto-merge${CARRIED} -- "$(cat /creds/feature)"`);
    expect(script).not.toContain('--child-llm-effort');
  });

  test('(b) goalDoc: harness ask carries --child-llm-provider and --child-llm-model', () => {
    const script = scriptOf(['--open-pr', '--base', 'main', ...CHILD], { goalDoc: 'docs/goals/X.md' });
    expect(script).toContain(`elanous harness ask 'docs/goals/X.md' --json '--base' 'main' --no-auto-merge${CARRIED} > /tmp/si.out`);
  });

  test('(c) no child-llm args: delegated lines carry no child-llm flag alongside the deadline marker', () => {
    const say = scriptOf(['--open-pr', '--base', 'main'], { authorSentence: true });
    const sayLine = lineOf(say, 'elanous harness say')!;
    expect(sayLine).toContain(`elanous harness say --substrate local --json '--base' 'main' --no-auto-merge -- "$(cat /creds/feature)"`);
    expect(sayLine).not.toContain('--child-llm');
    expect(say).toContain('/tmp/si.deadline-marker');
    const ask = scriptOf(['--open-pr', '--base', 'main'], { goalDoc: 'docs/goals/X.md' });
    const askLine = lineOf(ask, 'elanous harness ask')!;
    expect(askLine).toContain(`elanous harness ask 'docs/goals/X.md' --json '--base' 'main' --no-auto-merge`);
    expect(askLine).not.toContain('--child-llm');
    expect(ask).toContain('/tmp/si.deadline-marker');
  });

  test('(d) legacy self implement args pass through once beside the deadline marker', () => {
    const script = scriptOf(['--open-pr', '--base', 'main', ...CHILD], {});
    const legacyLine = lineOf(script, 'elanous self implement')!;
    expect(legacyLine).toContain(`elanous self implement "$(cat /creds/feature)" --json '--open-pr' '--base' 'main' '--child-llm-provider' 'openrouter' '--child-llm-model' 'openrouter/openai/gpt-6-luna'`);
    expect(legacyLine.split('--child-llm-provider').length - 1).toBe(1);
    expect(script).toContain('/tmp/si.deadline-marker');
    expect(script).not.toContain('elanous harness say');
    expect(script).not.toContain('elanous harness ask');
  });

  test('values are shell-quoted like --base', () => {
    const script = scriptOf(['--base', 'main', '--child-llm-provider', 'grok', '--child-llm-model', "it's"], { authorSentence: true });
    expect(script).toContain(` '--child-llm-provider' 'grok' '--child-llm-model' 'it'\\''s' -- "$(cat /creds/feature)"`);
  });

  test('podDelegatedChildLlm reads only a well-formed pair', () => {
    expect(podDelegatedChildLlm([...CHILD])).toEqual({ provider: 'openrouter', model: 'openrouter/openai/gpt-6-luna' });
    expect(podDelegatedChildLlm(['--child-llm-provider', 'openai-codex'])).toEqual({ provider: 'openai-codex' });
    expect(podDelegatedChildLlm(['--base', 'main'])).toBeUndefined();
    expect(podDelegatedChildLlm(['--child-llm-provider'])).toBeUndefined();
    expect(podDelegatedChildLlm(['--child-llm-provider', '--base'])).toBeUndefined();
  });
});

// ── OBS-GAP-BATCH-1030 ────────────────────────────────────────────────────────────────────────
// 무대: mock kubectl 장치 + 격리 HOME(state dir) — 생산 진입점 podSelfImplementSpawn → 자식 로그 수확
// → podChildProviderFailureFact/podChildEvidenceLedgerRow → appendRunLedgerEntry(pod-child-evidence).
// 잰 것: 자식 HTTP 401 실패 한 건에서 부모 원장 행에 provider 와 httpStatusCode 가 실리고,
// 자격증명·응답 본문은 원장 행에 남지 않는다. 정상 응답의 원장 행은 종전 그대로다.
const CREDENTIAL = 'sk-or-v1-0123456789abcdef0123456789abcdef448e';
const BODY_TEXT = 'Incorrect API key provided';
const CREDS = () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_x' });

function mockKubectl(conditions: readonly string[], logTail: string): Kubectl {
  let polls = 0;
  return (args) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.some((arg) => arg.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: conditions[Math.min(polls++, conditions.length - 1)] ?? '', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: logTail, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

async function runPodFixture(logTail: string, conditions: readonly string[], spaceId: string): Promise<{ root: string; rows: RunLedgerEntry[]; ledgerText: string }> {
  const root = mkdtempSync(join(tmpdir(), 'pod-child-llm-provider-failure-' + spaceId));
  const runId = `run-provider-failure-${spaceId}`;
  await podSelfImplementSpawn({ kubectl: mockKubectl(conditions, logTail), credentials: CREDS, pollMs: 1,
    env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: runId } })({ feature: 'x', spaceId }).done;
  const entries = loadRunLedger(runId, runLedgerDir(root)) ?? [];
  return { root, rows: entries, ledgerText: JSON.stringify(entries) };
}

describe('OBS-GAP-BATCH-1030 — HTTP 401 자식 실패의 provider·status 를 부모 원장 행에 귀속한다', () => {
  test('(a) provider 와 httpStatusCode 가 부모 pod-child-evidence 행에 저장되고 credential·body 는 없다', async () => {
    const providerErrorLine = `llm.openrouter response error: 401 { "error": { "message": "${BODY_TEXT}: ${CREDENTIAL}", "type": "invalid_request_error", "code": "invalid_api_key", "param": null }, "status": 401 }`;
    const terminal = JSON.stringify({ kind: 'self', stage: 'aborted', ok: false, error: `LLM API 401: ${BODY_TEXT}: ${CREDENTIAL}` });
    const { root, rows, ledgerText } = await runPodFixture(`${providerErrorLine}\n${terminal}\n`, ['Failed'], 'http-401');
    try {
      const evidence = rows.find((entry) => entry.event === 'pod-child-evidence')?.data as Record<string, unknown> | undefined;
      expect(evidence).toBeDefined();
      expect(evidence).toMatchObject({ provider: 'openrouter', httpStatusCode: 401 });
      expect(evidence?.job).toEqual(expect.stringContaining('si-'));
      expect(evidence?.childRunId).toEqual(expect.any(String));
      // 귀속은 두 스칼라뿐 — 응답 본문·자격증명을 싣는 새 필드/객체가 없다.
      expect(typeof evidence?.provider).toBe('string');
      expect(typeof evidence?.httpStatusCode).toBe('number');
      expect(evidence).not.toHaveProperty('providerFailure');
      expect(JSON.stringify({ provider: evidence?.provider, httpStatusCode: evidence?.httpStatusCode })).not.toContain(BODY_TEXT);
      // 자격증명은 원장 «전체»에 원문으로 남지 않는다(기존 로그 꼬리 증거는 마스킹된 채로 보존된다).
      expect(ledgerText).not.toContain(CREDENTIAL);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('(b) a normal child response keeps the ledger rows exactly as before — no provider fields', async () => {
    const success = JSON.stringify({ kind: 'self', stage: 'merged', ok: true });
    const { root, rows, ledgerText } = await runPodFixture(`${success}\n`, ['Complete'], 'normal-response');
    try {
      expect(rows.filter((entry) => entry.event === 'pod-child-evidence')).toEqual([]);
      expect(ledgerText).not.toContain('"provider":');
      expect(ledgerText).not.toContain('httpStatusCode');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('(c) a provider error before a successful terminal is not attributed to the success', async () => {
    const transient = `llm.openrouter response error: 401 { "error": { "message": "${BODY_TEXT}: ${CREDENTIAL}" }, "status": 401 }`;
    const success = JSON.stringify({ kind: 'self', stage: 'merged', ok: true });
    const { root, rows, ledgerText } = await runPodFixture(`${transient}\n${success}\n`, ['Complete'], 'provider-then-success');
    try {
      expect(rows.filter((entry) => entry.event === 'pod-child-evidence')).toEqual([]);
      expect(ledgerText).not.toContain('httpStatusCode');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('(d) a line that names no provider falls back to the Pod option, recorded as the canonical id — never the account name', async () => {
    const terminal = JSON.stringify({ kind: 'self', stage: 'aborted', ok: false, error: `LLM API 401: ${BODY_TEXT}: ${CREDENTIAL}` });
    const root = mkdtempSync(join(tmpdir(), 'pod-child-llm-provider-failure-hint'));
    const runId = 'run-provider-failure-provider-hint';
    await podSelfImplementSpawn({ kubectl: mockKubectl(['Failed'], `${terminal}\n`), credentials: CREDS, pollMs: 1,
      provider: 'openai-codex', childProviderExplicit: true,
      env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: runId } })({ feature: 'x', spaceId: 'provider-hint' }).done;
    const entries = loadRunLedger(runId, runLedgerDir(root)) ?? [];
    try {
      const evidence = entries.find((entry) => entry.event === 'pod-child-evidence')?.data as Record<string, unknown> | undefined;
      // Pod 옵션의 provider 는 정규 id 로만 — 배분 «계정» 이름(team)이 provider 자리에 오지 않는다.
      expect(evidence).toMatchObject({ provider: 'openai-codex', httpStatusCode: 401 });
      expect(JSON.stringify(entries)).not.toContain('"provider":"team"');
      expect(JSON.stringify(entries)).not.toContain(CREDENTIAL);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
