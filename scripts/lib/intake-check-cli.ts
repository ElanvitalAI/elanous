import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface IntakeCheckInvocation {
  command: 'bun' | 'eln';
  args: string[];
}

/** Source checkouts use their local entrypoint; installed collectors use the installed `eln`. */
export function buildIntakeCheckInvocation(facts: readonly string[], packageRoot: string): IntakeCheckInvocation {
  const root = resolve(packageRoot);
  const checkArgs = ['intake', 'check', ...facts.flatMap((fact) => ['--fact', fact]), '--json'];
  if (!existsSync(join(root, '.git'))) return { command: 'eln', args: checkArgs };
  return { command: 'bun', args: [join(root, 'bin', 'elanous.mjs'), ...checkArgs] };
}
