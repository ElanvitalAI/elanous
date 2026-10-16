import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

/**
 * Default maxBuffer for harness · Pod · gate `spawnSync` calls that read child output.
 * Node's 1 MiB default truncated `git ls-files` (1.54 MiB in W2b · 0.2.30 HARD #3) — same value as #28476.
 * The ratchet `test/spawn-sync-max-buffer.test.ts` keeps new readers in those trees on an explicit maxBuffer.
 */
export const SPAWN_SYNC_MAX_BUFFER = 16 * 1024 * 1024;

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
