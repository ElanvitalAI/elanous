import { isAbsolute, relative, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';
import { isInsideOpsRoot, physicalPath, testProcessSignal } from '../instance/test-write-guard.js';

/** Refuse a test's write to the production instance, including an explicitly supplied ledger directory. */
export function refuseProductionLedgerWriteInTest(
  root: string,
  store: string,
  env: NodeJS.ProcessEnv = process.env,
  productionRoot = prodInstanceRoot(),
  instanceRoot = effectiveInstanceRoot(),
): boolean {
  if (!testProcessSignal(env, env === process.env ? undefined : '')) return false;
  const target = physicalPath(root);
  const production = physicalPath(productionRoot);
  const withinProduction = relative(production, target);
  const outsideHomeRoot = withinProduction === '..' || withinProduction.startsWith(`..${sep}`) || isAbsolute(withinProduction);
  // The account's real ~/.elanous is production too when a runner redirected HOME (TEST-PROD-LEAK).
  if (outsideHomeRoot && !isInsideOpsRoot(root)) return false;
  try {
    debug.log('harness.incidents', 'write-refused', { store, root: target, effectiveInstanceRoot: instanceRoot });
  } catch { /* Observation cannot reopen a closed write boundary. */ }
  return true;
}
