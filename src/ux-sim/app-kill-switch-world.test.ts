import { describe, expect, test } from 'bun:test';
import { runAppKillSwitchSimulation } from './app-kill-switch-world.js';

describe('APP-KILL-SWITCH simulation world', () => {
  test('abuse and cost incidents stop only the selected tenant app and enforce scoped reactivation', () => {
    const result = runAppKillSwitchSimulation();

    expect(result.afterAbuseReport).toEqual({ red: true, blue: false });
    expect(result.afterIncidents).toEqual({ red: true, blue: true });
    expect(result.crossTenantRestoreDenied).toBe(true);
    expect(result.afterCrossTenantAttempt).toEqual({ red: true, blue: true });
    expect(result.afterAuthorizedRestores).toEqual({ red: false, blue: false });
    expect(result.audit).toEqual([
      { userId: 'tenant-red', appId: 'catalog', action: 'disabled', incident: 'abuse-report',
        reason: 'reported harmful content', requestedBy: 'reporter-7', actorKind: 'system', actorId: 'incident-ingress' },
      { userId: 'tenant-blue', appId: 'catalog', action: 'disabled', incident: 'cost-spike',
        reason: 'usage exceeded the cost guard', requestedBy: 'cost-guard', actorKind: 'system', actorId: 'incident-ingress' },
      { userId: 'tenant-red', appId: 'catalog', action: 'reactivated', incident: 'abuse-report',
        reason: 'reported harmful content', requestedBy: 'reporter-7', actorKind: 'user', actorId: 'tenant-red' },
      { userId: 'tenant-blue', appId: 'catalog', action: 'reactivated', incident: 'cost-spike',
        reason: 'usage exceeded the cost guard', requestedBy: 'cost-guard', actorKind: 'operator', actorId: 'operator-1' },
    ]);
  });
});
