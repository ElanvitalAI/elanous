import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

/** Read command text completely or fail closed; never return a partial stdout. */
export function spawnSyncText(
  cmd: string,
  args: readonly string[],
  opts: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf8' },
): string {
  const result = spawnSync(cmd, [...args], { ...opts, maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr?.trim() ?? '';
    throw new Error(`${cmd} ${args.join(' ')} failed (status=${result.status}${result.error ? `, error=${(result.error as NodeJS.ErrnoException).code ?? result.error.name}` : ''}): ${reason}`);
  }
  return result.stdout;
}
