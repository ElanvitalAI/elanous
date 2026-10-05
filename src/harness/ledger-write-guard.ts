import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';

function physicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return resolve(physicalPath(parent), relative(parent, absolute));
  }
}

/** Refuse a test's write to the production instance, including an explicitly supplied ledger directory. */
export function refuseProductionLedgerWriteInTest(
  root: string,
  store: string,
  env: NodeJS.ProcessEnv = process.env,
  productionRoot = prodInstanceRoot(),
  instanceRoot = effectiveInstanceRoot(),
): boolean {
  if (env.NODE_ENV !== 'test' && !env.ELANOUS_TEST_HOME) return false;
  const target = physicalPath(root);
  const production = physicalPath(productionRoot);
  const withinProduction = relative(production, target);
  if (withinProduction === '..' || withinProduction.startsWith(`..${sep}`) || isAbsolute(withinProduction)) return false;
  try {
    debug.log('harness.incidents', 'write-refused', { store, root: target, effectiveInstanceRoot: instanceRoot });
  } catch { /* Observation cannot reopen a closed write boundary. */ }
  return true;
}
