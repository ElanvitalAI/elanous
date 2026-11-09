import { expect, test } from 'bun:test';
import { resolveAppDeploymentOwner } from './app-deployment-owner.js';

test('app deployment resolves the configured owner only from a Nexus owner session', () => {
  expect(resolveAppDeploymentOwner('nexus-owner', 'kaist-demo')).toBe('kaist-demo');
  expect(resolveAppDeploymentOwner('member', 'kaist-demo', {
    memberId: 'member-1', userSlug: 'kaist-demo', plan: 'free', entitlements: {},
  })).toBe('kaist-demo');
  expect(() => resolveAppDeploymentOwner('member', 'kaist-demo')).toThrow('verified member owner response');
  expect(() => resolveAppDeploymentOwner('member', 'different-user', {
    memberId: 'member-1', userSlug: 'kaist-demo', plan: 'free', entitlements: {},
  })).toThrow('--public-user-id must match');
  expect(() => resolveAppDeploymentOwner('anonymous', 'kaist-demo')).toThrow('authenticated owner session');
  expect(() => resolveAppDeploymentOwner('nexus-owner', undefined)).toThrow('ELANOUS_PUBLIC_APP_USER_ID is required');
});
