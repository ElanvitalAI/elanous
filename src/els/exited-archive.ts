/** Durable evidence for a pane removed after its exit retention period. */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pane } from './space.js';

export function archiveExitedPane(stateRoot: string, pane: Pane): string {
  if (pane.state !== 'exited' || pane.exitedAt === undefined) throw new Error('pane is not a timed exit');
  const dir = join(stateRoot, 'els', 'reaped-panes');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // A journal id is validated for uniqueness, not for path syntax. Hash it before making a path.
  const key = createHash('sha256').update(`${pane.id}\0${pane.exitedAt}`).digest('hex');
  const target = join(dir, `${key}.json`);
  const temporary = join(dir, `${key}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const record = { pane: pane.id, tab: pane.tabId, exitedAt: pane.exitedAt,
    title: pane.title, cwd: pane.cwd, command: pane.command, screen: pane.scrollback };
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* not written or already renamed */ }
    throw error;
  }
  return target;
}
