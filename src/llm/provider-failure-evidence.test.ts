import { describe, expect, test } from 'bun:test';
import { compactForLog } from '../debug/log.js';
import { ApiHttpError } from '../session-runtime/retry-api.js';
import { providerFailureEvidence } from './provider-failure-evidence.js';

describe('providerFailureEvidence', () => {
  test('keeps the structured 401 discriminator when the free-text body is longer than log compaction', () => {
    const secret = `sk-or-v1-${'x'.repeat(64)}`;
    const bodyText = JSON.stringify({
      error: {
        message: `${'x'.repeat(400)} ${secret}`,
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
      padding: 'p'.repeat(400),
    });
    const error = new ApiHttpError({
      status: 401,
      bodyText,
      provider: 'openai',
      errorPrefix: 'LLM API',
    });
    const evidence = providerFailureEvidence(error);

    expect(String(compactForLog(error.message))).not.toContain('invalid_api_key');
    expect(evidence).toEqual({
      httpStatus: 401,
      providerErrorCode: 'invalid_api_key',
      providerErrorType: 'invalid_request_error',
    });
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  test('does not invent structured discriminators for an unstructured error', () => {
    expect(providerFailureEvidence(new Error('upstream unavailable'))).toEqual({});
  });
});
