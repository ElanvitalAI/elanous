import { spawn } from 'node:child_process';
import { browserLaunchCommand } from '../oauth/codex-browser-login.js';

/** A launcher that exits non-zero this soon has failed; one still running (or exiting 0) handed the URL off. */
const LAUNCH_GRACE_MS = 1_000;

/** Open a URL in the owner's browser — only ever called from an explicit key press. Rejects when the launcher fails. */
export function openPublishApprovalUrl(url: string): Promise<void> {
  const { command, args } = browserLaunchCommand(url);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (ok: boolean): void => { if (!settled) { settled = true; if (ok) resolve(); else reject(new Error('browser launcher failed')); } };
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.once('error', () => settle(false));
      child.once('exit', (code) => settle(code === 0));
      child.unref();
      setTimeout(() => settle(true), LAUNCH_GRACE_MS).unref();
    } catch { settle(false); }
  });
}
