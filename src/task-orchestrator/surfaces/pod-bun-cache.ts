export const POD_BUN_CACHE_HOST_PATH = 'POD_BUN_CACHE_HOST_PATH';

/** A host-backed Bun install cache; only opt into it when the mounted directory is writable. */
export function podBunCacheVolume(hostPath: string) {
  return {
    volume: { name: 'bun-cache', hostPath: { path: hostPath, type: 'DirectoryOrCreate' } },
    volumeMount: { name: 'bun-cache', mountPath: '/bun-cache', readOnly: false },
    shellPrefix: 'if [ -d /bun-cache ] && [ -w /bun-cache ]; then export BUN_INSTALL_CACHE_DIR=/bun-cache; fi;',
  };
}

/** First Bun install timing in a combined shard log (including a no-op install). */
export function parseInstallSeconds(log: string): number | null {
  const match = /(?:\d+ packages? installed|Checked \d+ installs across \d+ packages(?: \(no changes\))?)\s*\[(\d+(?:\.\d+)?)(ms|s)\]/.exec(log);
  if (!match) return null;
  const duration = Number(match[1]);
  return match[2] === 'ms' ? duration / 1000 : duration;
}
