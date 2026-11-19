// Called by an eln TUI after it captures its own boot SHA; stop when the TUI closes.
import { requestEls } from './client.js';

export function startElsBuildReporter(sha: string | undefined, env: NodeJS.ProcessEnv = process.env): () => void {
  const pane = env.ELANOUS_ELS_PANE, socket = env.ELANOUS_ELS_SOCKET;
  if (!pane || !socket || !sha) return () => {};
  const report = (): void => { void requestEls(socket, { op: 'build', pane, sha }); };
  report();
  const timer = setInterval(report, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
