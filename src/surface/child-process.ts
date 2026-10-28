/** Forward a piped child stderr stream through the current surface's stderr
 *  owner. TUI boot captures this stream into logs and one-line notices. */
export function forwardChildStderr(stream: NodeJS.ReadableStream | null | undefined): void {
  stream?.on('data', (chunk: Buffer | string) => process.stderr.write(chunk));
}

/** Shared child-process boundary for commands that need terminal progress.
 *  stdin is closed, stdout/stderr are piped, and stderr is forwarded through
 *  the owning surface's stderr stream, so TUI boot can turn it into a log
 *  entry and a one-line notice. */
export function spawnWithOwnedStderr(
  command: string[],
  options: Omit<Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'>, 'cmd' | 'stdin' | 'stdout' | 'stderr'> = {},
): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn(command, { ...options, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  if (child.stderr) {
    const reader = child.stderr.getReader();
    void (async () => {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          process.stderr.write(next.value);
        }
      } finally {
        reader.releaseLock();
      }
    })();
  }
  return child;
}
