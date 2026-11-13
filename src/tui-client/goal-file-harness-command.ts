import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Only explicit existing goal documents take the shared `harness ask` entrance. */
export function goalFilePath(input: string): string | null {
  const trimmed = input.trim();
  const path = (/^(["'])(.*)\1$/su.exec(trimmed)?.[2] ?? trimmed).trim();
  if (!path) return null;
  try { return statSync(path).isFile() ? path : null; } catch { return null; }
}

export async function runGoalFileHarnessCommand(
  path: string,
  dryRun: boolean,
  signal: AbortSignal,
  onLine: (line: string) => void,
  cli = process.argv[1],
): Promise<void> {
  if (signal.aborted) throw new Error('하니스 호출을 취소했습니다');
  if (!cli) throw new Error('elanous CLI entry is unavailable');
  const child = Bun.spawn({
    cmd: [process.execPath, cli, 'harness', 'ask', resolve(path), '--no-auto-merge', ...(dryRun ? ['--dry-run'] : [])],
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env,
  });
  const abort = (): void => { child.kill(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let last = '';
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        if (line.trim()) { onLine(line); last = line; }
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      if (done) break;
    }
    if (pending.trim()) { onLine(pending); last = pending; }
    return last;
  };
  try {
    const [outLast, errLast, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
    if (signal.aborted) throw new Error('하니스 호출을 취소했습니다');
    if (code !== 0) throw new Error(errLast || outLast || `harness exit ${code}`);
  } catch (error) {
    try { child.kill(); } catch { /* already exited */ }
    await child.exited;
    if (signal.aborted) throw new Error('하니스 호출을 취소했습니다');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
