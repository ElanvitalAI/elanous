import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppKillSwitch } from '../relay/app-kill-switch.js';

/** Fake multi-tenant incident feed. It exercises the real kill-switch store without a live relay or provider. */
export function runAppKillSwitchSimulation() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-kill-switch-world-')));
  const control = createAppKillSwitch(join(root, 'kill-switch.sqlite'), {
    authorizeReactivation: ({ actor }) => actor.kind === 'operator'
      ? actor.id === 'operator-1'
      : actor.id === 'tenant-red' || actor.id === 'tenant-blue',
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 10, 7, 0, 0, tick++));
    })(),
  });
  try {
    control.applyIncident({
      userId: 'tenant-red', appId: 'catalog', incident: 'abuse-report',
      reason: 'reported harmful content', requestedBy: 'reporter-7',
    });
    const afterAbuseReport = {
      red: control.isDown('tenant-red', 'catalog'),
      blue: control.isDown('tenant-blue', 'catalog'),
    };
    control.applyIncident({
      userId: 'tenant-blue', appId: 'catalog', incident: 'cost-spike',
      reason: 'usage exceeded the cost guard', requestedBy: 'cost-guard',
    });

    const afterIncidents = {
      red: control.isDown('tenant-red', 'catalog'),
      blue: control.isDown('tenant-blue', 'catalog'),
    };
    let crossTenantRestoreDenied = false;
    try {
      control.reactivate({ userId: 'tenant-red', appId: 'catalog', actor: { kind: 'user', id: 'tenant-blue' } });
    } catch (error) {
      crossTenantRestoreDenied = error instanceof Error && error.message === 'app kill switch reactivation denied';
    }
    const afterCrossTenantAttempt = {
      red: control.isDown('tenant-red', 'catalog'),
      blue: control.isDown('tenant-blue', 'catalog'),
    };

    control.reactivate({ userId: 'tenant-red', appId: 'catalog', actor: { kind: 'user', id: 'tenant-red' } });
    control.reactivate({ userId: 'tenant-blue', appId: 'catalog', actor: { kind: 'operator', id: 'operator-1' } });

    return {
      afterAbuseReport,
      afterIncidents,
      crossTenantRestoreDenied,
      afterCrossTenantAttempt,
      afterAuthorizedRestores: {
        red: control.isDown('tenant-red', 'catalog'),
        blue: control.isDown('tenant-blue', 'catalog'),
      },
      audit: ['tenant-red', 'tenant-blue'].flatMap((userId) => control.audit(userId, 'catalog'))
        .sort((a, b) => a.id - b.id)
        .map(({ userId, appId, action, incident, reason, requestedBy, actorKind, actorId }) => ({
          userId, appId, action, incident, reason, requestedBy, actorKind, actorId,
        })),
    };
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
}
