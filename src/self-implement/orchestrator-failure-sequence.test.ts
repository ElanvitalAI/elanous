import { describe, expect, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { runSelfImplement, type SelfImplementSeams } from './orchestrator.js';
import { seams } from './test-seams.js';

const noQuota = (() => ({ reason: 'no-candidate', candidateCount: 0, knownAccountCount: 0 })) as SelfImplementSeams['inspectCodexRotation'];

function providerError(credential = false): void {
  debug.log('llm.router.error', 'streamLLM', {
    provider: 'openai-codex', message: 'upstream failed', ...(credential ? { authRejected: true } : {}),
  });
}

async function stoppedRun(input: {
  verdict: 'gate' | 'review';
  errorAt: 'none' | 'implement' | 'gate' | 'review' | 'preservation';
  credential?: boolean;
  queryChildProviderErrors?: SelfImplementSeams['queryChildProviderErrors'];
}) {
  return runSelfImplement({
    feature: `sequence ${input.verdict} ${input.errorAt}`,
    runId: `sequence-${input.verdict}-${input.errorAt}-${input.credential ? 'credential' : 'provider'}`,
    maxReworkRounds: 0,
    memory: false,
    seams: seams({
      inspectCodexRotation: noQuota,
      currentProviderName: () => 'openai-codex',
      resolveDesignCheck: () => ({ ok: false, blockedOn: 'design-document', path: '/wt/DESIGN.md' }),
      implement: async () => {
        if (input.errorAt === 'implement') providerError(input.credential);
        return { ok: true, summary: 'implemented' };
      },
      gate: async () => {
        if (input.errorAt === 'gate') providerError(input.credential);
        return { passed: input.verdict === 'review', log: 'gate verdict' };
      },
      reviewDiff: input.verdict === 'review' ? async () => {
        if (input.errorAt === 'review') providerError(input.credential);
        return { verdict: 'fail', mustFix: ['fix'], shouldFix: [], summary: 'review verdict', reviewed: true };
      } : undefined,
      preservationHasChanges: async () => {
        if (input.errorAt === 'preservation' && input.verdict === 'gate') providerError(input.credential);
        return false;
      },
      onProgress: (event) => {
        if (input.errorAt === 'preservation' && input.verdict === 'review' && event.stage === 'reviewed') providerError(input.credential);
      },
      ...(input.queryChildProviderErrors ? { queryChildProviderErrors: input.queryChildProviderErrors } : {}),
    }),
  });
}

describe('failure and verdict sequence wiring', () => {
  test.each(['gate', 'review'] as const)('provider error preceding %s verdict cannot mask it', async (verdict) => {
    const result = await stoppedRun({ verdict, errorAt: 'implement' });
    expect(result.providerErrors?.count).toBe(1);
    expect(result.abandonedClassification?.classification).toBe('implementation-deficit');
    expect(result.abandonedClassification?.providerError).toBeUndefined();
  });

  test.each(['gate', 'review'] as const)('credential rejection preceding %s verdict cannot mask it', async (verdict) => {
    const result = await stoppedRun({ verdict, errorAt: 'implement', credential: true });
    expect(result.abandonedClassification?.classification).toBe('implementation-deficit');
    expect(result.abandonedClassification?.credentialFailure).toBeUndefined();
  });

  test.each(['gate', 'review'] as const)('child provider and credential errors before %s verdict cannot mask it when queried again at terminal', async (verdict) => {
    let queries = 0;
    const result = await stoppedRun({
      verdict, errorAt: 'none',
      queryChildProviderErrors: async () => {
        queries++;
        return {
          status: 'found', providerErrorCount: 1, credentialFailureCount: 1,
          lastProviderError: { message: 'child auth rejected' },
          lastCredentialFailure: { message: 'child auth rejected' },
        };
      },
    });
    expect(queries).toBeGreaterThan(1);
    expect(result.providerErrors?.count).toBe(1);
    expect(result.abandonedClassification?.classification).toBe('implementation-deficit');
    expect(result.abandonedClassification?.credentialFailure).toBeUndefined();
    expect(result.abandonedClassification?.providerError).toBeUndefined();
  });

  test.each(['gate', 'review'] as const)('child provider and credential errors first seen after %s verdict remain classifiable', async (verdict) => {
    let queries = 0;
    const result = await stoppedRun({
      verdict, errorAt: 'none',
      queryChildProviderErrors: async () => {
        queries++;
        return queries === 1 ? { status: 'none' } : {
          status: 'found', providerErrorCount: 1, credentialFailureCount: 1,
          lastProviderError: { message: 'new child auth rejected' },
          lastCredentialFailure: { message: 'new child auth rejected' },
        };
      },
    });
    expect(queries).toBeGreaterThan(1);
    expect(result.abandonedClassification?.classification).toBe('credential-failure');
    expect(result.abandonedClassification?.credentialFailure).toBe(true);
  });

  test('provider error after failed gate remains classifiable', async () => {
    const result = await stoppedRun({ verdict: 'gate', errorAt: 'preservation' });
    expect(result.abandonedClassification?.classification).toBe('provider-error');
    expect(result.abandonedClassification?.providerError).toBe(true);
  });

  test('credential rejection after failed gate remains classifiable', async () => {
    const result = await stoppedRun({ verdict: 'gate', errorAt: 'preservation', credential: true });
    expect(result.abandonedClassification?.classification).toBe('credential-failure');
    expect(result.abandonedClassification?.credentialFailure).toBe(true);
  });

  test('provider error after must-fix review remains classifiable', async () => {
    const result = await stoppedRun({ verdict: 'review', errorAt: 'preservation' });
    expect(result.abandonedClassification?.classification).toBe('provider-error');
    expect(result.abandonedClassification?.providerError).toBe(true);
  });

  test('credential rejection after must-fix review remains classifiable', async () => {
    const result = await stoppedRun({ verdict: 'review', errorAt: 'preservation', credential: true });
    expect(result.abandonedClassification?.classification).toBe('credential-failure');
    expect(result.abandonedClassification?.credentialFailure).toBe(true);
  });

  test.each(['implement', 'preservation'] as const)('classifyUnfinishedRun %s provider error follows verdict only when later', async (errorAt) => {
    const result = await stoppedRun({ verdict: 'gate', errorAt });
    expect(result.providerErrors?.category).toBe('other');
    expect(result.abandonedClassification?.providerErrorCategory).toBe(errorAt === 'implement' ? undefined : 'other');
    expect(result.abandonedClassification?.providerError).toBe(errorAt === 'implement' ? undefined : true);
  });

  test.each(['implement', 'preservation'] as const)('salvageHardCap %s provider error follows verdict only when later', async (errorAt) => {
    const classifications: Array<Record<string, unknown>> = [];
    const result = await runSelfImplement({
      feature: `salvage sequence ${errorAt}`, runId: `salvage-sequence-${errorAt}`,
      maxReworkRounds: 0, memory: false,
      seams: seams({
        inspectCodexRotation: noQuota,
        currentProviderName: () => 'openai-codex',
        resolveDesignCheck: () => ({ ok: false, blockedOn: 'design-document', path: '/wt/DESIGN.md' }),
        implement: async () => {
          if (errorAt === 'implement') providerError();
          return { ok: true, summary: 'implemented' };
        },
        gate: async () => ({ passed: false, log: 'gate verdict' }),
        diagnose: async () => 'BUDGET: EXTEND\nREASON: retry after gate',
        preservationHasChanges: async () => {
          if (errorAt === 'preservation') providerError();
          return false;
        },
        readReworkSalvageEvidence: async () => ({ clean: false, aheadCommits: 0 }),
        writeRunLedger: ({ event, data }) => {
          if (event === 'rework-salvage-classification') classifications.push(data);
        },
      }),
    });
    expect(result.providerErrors?.category).toBe('other');
    expect(result.abandonedClassification?.providerErrorCategory).toBe(errorAt === 'implement' ? undefined : 'other');
    expect(classifications).toHaveLength(1);
    expect(classifications[0]?.providerErrorCategory).toBe(errorAt === 'implement' ? undefined : 'other');
    expect(classifications[0]?.providerError).toBe(errorAt === 'implement' ? undefined : true);
    expect(classifications[0]?.classification).toBe(errorAt === 'implement' ? 'implementation-deficit' : 'provider-error');
    expect(result.salvage).toBe('parked');
    expect(result.abandonedClassification?.classification).toBe(errorAt === 'implement' ? 'implementation-deficit' : 'provider-error');
  });

  test('parent sink and child query retain their independent provider error counts', async () => {
    let calls = 0;
    const result = await stoppedRun({
      verdict: 'gate', errorAt: 'preservation',
      queryChildProviderErrors: async () => {
        calls++;
        return { status: 'found', providerErrorCount: 1, credentialFailureCount: 0, lastProviderError: { message: 'upstream failed' } };
      },
    });
    expect(calls).toBeGreaterThan(0);
    expect(result.providerErrors?.count).toBe(2);
  });
});
