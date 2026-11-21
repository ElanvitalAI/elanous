// Called by an eln TUI after it captures its own boot SHA; stop when the TUI closes.
import { buildCommitTime, cliBuildIdentity, versionLabel } from '../version/build-stamp.js';
import { requestEls } from './client.js';

export function startElsBuildReporter(sha: string | undefined, env: NodeJS.ProcessEnv = process.env): () => void {
  const pane = env.ELANOUS_ELS_PANE, socket = env.ELANOUS_ELS_SOCKET;
  if (!pane || !socket || !sha) return () => {};
  const identity = cliBuildIdentity();
  const stamp = versionLabel(identity, buildCommitTime(identity)).stamp;
  const report = (): void => { void requestEls(socket, { op: 'build', pane, sha, version: identity.version, stamp }); };
  report();
  const timer = setInterval(report, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
