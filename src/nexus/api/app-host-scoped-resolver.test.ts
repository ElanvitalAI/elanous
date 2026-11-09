import { expect, test } from 'bun:test';
import { createAppHostScopedResolver } from './app-host-scoped-resolver.js';

test('NEXUS-APP-HOST-SESSION caches each members API with its own app host', () => {
  const firstHost = { id: 'first' };
  const secondHost = { id: 'second' };
  const configuredFor: string[] = [];
  const resolve = createAppHostScopedResolver(host => {
    const boundHost = host as typeof firstHost | undefined;
    configuredFor.push(boundHost?.id ?? 'unbound');
    return { issueOwnerSession: () => boundHost?.id ?? 'unbound' };
  });

  const firstApi = resolve(firstHost)!;
  const secondApi = resolve(secondHost)!;

  expect(firstApi.issueOwnerSession()).toBe('first');
  expect(secondApi.issueOwnerSession()).toBe('second');
  expect(resolve(firstHost)).toBe(firstApi);
  expect(resolve(secondHost)).toBe(secondApi);
  expect(resolve()).toBe(resolve());
  expect(configuredFor).toEqual(['first', 'second', 'unbound']);
});
