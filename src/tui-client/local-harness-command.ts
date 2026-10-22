/** Run the existing harness CLI outside the TUI import graph and stream its result. */
export async function runLocalHarnessCommand(
  command: 'ask' | 'runs',
  goal: string,
  signal: AbortSignal,
  onLine: (line: string) => void,
  cli = process.argv[1],
): Promise<void> {
  if (signal.aborted) throw new Error('하니스 호출을 취소했습니다');
  if (!cli) throw new Error('elanous CLI entry is unavailable');
  const dryRun = command === 'ask' && goal.startsWith('--dry-run ');
  const objective = dryRun ? goal.slice('--dry-run '.length).trim() : goal;
  if (command === 'ask' && !objective) throw new Error('하니스 목표가 비었습니다');
  const cmd = command === 'runs'
    ? [process.execPath, cli, 'harness', 'progress']
    : [process.execPath, cli, 'harness', 'say', '--no-auto-merge', ...(dryRun ? ['--dry-run'] : []), objective];
  const child = Bun.spawn({ cmd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env });
  let omittedRunRows = 0;
  let shownRunRows = 0;
  const emit = (line: string): void => {
    if (command === 'runs' && shownRunRows >= 16) { omittedRunRows++; return; }
    shownRunRows++;
    onLine(line);
  };
  const abort = (): void => { child.kill(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const readLines = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
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
        if (line.trim()) { emit(line); last = line; }
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      if (done) break;
    }
    if (pending.trim()) { emit(pending); last = pending; }
    return last;
  };
  try {
    const [outLast, errLast, code] = await Promise.all([
      readLines(child.stdout), readLines(child.stderr), child.exited,
    ]);
    if (signal.aborted) throw new Error('하니스 호출을 취소했습니다');
    if (code !== 0) throw new Error(errLast || outLast || `harness exit ${code}`);
    if (omittedRunRows > 0) onLine(`추가 ${omittedRunRows}행 생략 · 전체: eln harness progress`);
  } catch (error) {
    try { child.kill(); } catch { /* already exited */ }
    await child.exited;
    if (signal.aborted) throw new Error('하니스 호출을 취소했습니다');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
