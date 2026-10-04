import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { effectiveInstanceRoot, prodInstanceRoot } from '../instance/resolve.js';

function physicalPath(path: string): string {
  // Resolve one component at a time: lexical normalization of `link/..` before
  // realpathSync would discard the link even though the filesystem follows it.
  const raw = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  let current: string = sep;
  for (const component of raw.split(sep)) {
    if (!component || component === '.') continue;
    if (component === '..') {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, component);
    try { current = realpathSync(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      current = candidate;
    }
  }
  return current;
}

function within(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

/** Only writes inside this process's non-operational instance universe bypass the HQ ledger lease. */
export function isIsolatedLedgerWriteRoot(
  ledgerRoot: string,
  instanceRoot = effectiveInstanceRoot(),
  operationalRoot = prodInstanceRoot(),
): boolean {
  const target = physicalPath(ledgerRoot);
  const instance = physicalPath(instanceRoot);
  const prod = physicalPath(operationalRoot);
  return instance !== prod && within(instance, target) && !within(prod, target);
}
