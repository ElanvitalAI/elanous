#!/usr/bin/env bun
// Install after this script is available on main: bun scripts/hq-repo-maintenance-cycle.ts --install-schedule
// Reference expiry stays off unless ELANOUS_HQ_REPO_EXPIRY_ENABLED=1 is explicitly set.
import { ensureCronNodePath } from '../src/domains/cron-path.js';
import { maintainHqRepo, REF_EXPIRY_CONCURRENCY_WARNING } from '../src/hq/repo-maintenance.js';
import { installHqRepoMaintenanceSchedule } from '../src/hq/repo-maintenance-schedule.js';

if (import.meta.main) {
  ensureCronNodePath();
  try {
    if (process.argv.includes('--install-schedule')) {
      console.log(JSON.stringify(installHqRepoMaintenanceSchedule()));
    } else {
      const expireRefs = process.env.ELANOUS_HQ_REPO_EXPIRY_ENABLED === '1';
      if (expireRefs) console.error('WARNING: ' + REF_EXPIRY_CONCURRENCY_WARNING);
      const result = maintainHqRepo({ apply: true, expireRefs });
      console.log(JSON.stringify(result));
      if (result.capAlerts.length) process.exitCode = 2;
    }
  } catch (error) {
    console.error('HQ repo maintenance failed: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
