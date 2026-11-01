export type ProviderFailureEvidence = {
  httpStatus?: number;
  providerErrorCode?: string;
  providerErrorType?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : undefined;
}

/** Retain only non-secret structured fields from provider failures. */
export function providerFailureEvidence(error: unknown): ProviderFailureEvidence {
  const source = record(error);
  if (!source) return {};

  let body: Record<string, unknown> | undefined;
  if (typeof source.bodyText === 'string') {
    try { body = record(JSON.parse(source.bodyText)); } catch { /* body is not structured JSON */ }
  }
  if (!body && typeof source.message === 'string') {
    const jsonStart = source.message.indexOf('{');
    if (jsonStart >= 0) {
      try { body = record(JSON.parse(source.message.slice(jsonStart))); } catch { /* message may be clipped */ }
    }
  }

  const nestedError = record(body?.error);
  const status = source.status;
  const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
  const providerErrorCode = safeCode(nestedError?.code) ?? safeCode(body?.code);
  const providerErrorType = safeCode(nestedError?.type) ?? safeCode(body?.type);

  return {
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(providerErrorCode ? { providerErrorCode } : {}),
    ...(providerErrorType ? { providerErrorType } : {}),
  };
}
