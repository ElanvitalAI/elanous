import { expect } from 'bun:test';

type HttpResult = Response | { status: number; body: unknown };

export async function expectMalformedJson400(response: HttpResult, expectedError?: string): Promise<void> {
  expect(response.status).toBe(400);
  if (expectedError === undefined) return;
  const body = response instanceof Response ? await response.json() as { error?: unknown } : response.body as { error?: unknown };
  expect(body.error).toBe(expectedError);
}
