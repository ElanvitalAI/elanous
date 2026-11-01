import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childFirstLlmFact, childFirstLlmReportFact, childFirstLlmStatusLabel, createChildFirstLlmRecorder, type ChildFirstLlmEvent } from './child-first-llm-observation.js';
import { podChildEvidenceLedgerRow } from '../task-orchestrator/surfaces/pod-failure-reason.js';
import { streamLLM, type LLMProvider } from '../llm.js';
import { loadRunLedger } from '../self-implement/run-ledger.js';

test('first child provider call records start, fake 401 response, and first tool call for the parent failure row', async () => {
  const entries: ChildFirstLlmEvent[] = [];
  const recorder = createChildFirstLlmRecorder((event) => { entries.push(event); });
  await recorder.start({ runId: 'child-401', provider: 'openai-codex', model: 'gpt-6.1-terra', accountName: 'third', at: '2026-10-31T00:00:00.000Z' });
  await recorder.start({ runId: 'child-401', provider: 'openai-codex', model: 'wrong-second-call', at: '2026-10-31T00:00:01.000Z' });
  await recorder.firstToolCall({ runId: 'child-401', at: '2026-10-31T00:00:02.000Z' });
  await recorder.response({ runId: 'child-401', status: 'error', httpStatus: 401, error: new Error('401 unauthorized\ncredential detail'), at: '2026-10-31T00:00:03.000Z' });

  const fact = childFirstLlmFact(entries);
  expect(fact).toMatchObject({ status: 'error', provider: 'openai-codex', model: 'gpt-6.1-terra', accountName: 'third', httpStatus: 401, firstToolCallAt: '2026-10-31T00:00:02.000Z' });
  expect(fact?.errorFirstLine).toBe('401 unauthorized');
  expect(childFirstLlmStatusLabel(fact!)).toBe('error(401)');
  const parent = podChildEvidenceLedgerRow({ state: 'failed', job: 'fake-401', childRunId: 'child-401', firstLlm: fact });
  expect(parent?.firstLlm).toMatchObject({ status: 'error', httpStatus: 401, provider: 'openai-codex' });
  expect(childFirstLlmReportFact(entries)).toMatchObject({ statusLabel: 'error(401)', httpStatus: 401 });
});

test('normal fake child provider response records firstLlm=ok for the parent row', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'child-first-llm-ok-'));
  const savedStateDir = process.env.ELANOUS_STATE_DIR;
  const savedRunId = process.env.ELANOUS_RUN_ID;
  const runId = 'run-68e6c0a1-734c-43f7-9d2b-6f197a11fb03';
  try {
    process.env.ELANOUS_STATE_DIR = stateDir;
    process.env.ELANOUS_RUN_ID = runId;
    const provider: LLMProvider = {
      name: 'fake-child-provider',
      defaultModel: 'fake-child-model',
      available: () => true,
      async *streamChat() { yield { type: 'text', delta: 'child ok' }; },
      async *chat() { yield 'child ok'; },
    };
    const answer = await streamLLM([{ role: 'user', content: 'fake child success' }], () => {}, {
      provider,
      model: 'fake-child-model',
    });
    const entries = loadRunLedger(runId) ?? [];
    const fact = childFirstLlmFact(entries);
    expect(answer).toBe('child ok');
    expect(fact).toMatchObject({ status: 'ok', provider: 'fake-child-provider', model: 'fake-child-model' });
    expect(fact?.startedAt).toBeString();
    expect(fact?.respondedAt).toBeString();
    expect(childFirstLlmStatusLabel(fact!)).toBe('ok');
    expect(podChildEvidenceLedgerRow({ state: 'failed', job: 'fake-ok', childRunId: runId, firstLlm: fact }))
      .toMatchObject({ firstLlm: { status: 'ok', provider: 'fake-child-provider' } });
  } finally {
    if (savedStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = savedStateDir;
    if (savedRunId === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = savedRunId;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

