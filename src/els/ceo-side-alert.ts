// The els owner and its app view share one small, content-free CEO SLA projection. The authoritative
// receipt is createCeoIngress's onStatus: queue arrival never means 👀. Only pending-red is shown in
// the side; a real intake, answer or RES takeover clears it. The file lets separate els processes
// display the same signal without copying the representative's text or chat id into the list API.
import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { join, sep } from 'node:path';
import type { CeoReceipt, CeoSource } from '../agent-events/ceo-ingress.js';

export const ceoSideAlertPath = (stateRoot: string): string => join(stateRoot, 'els', 'ceo-side-alert.json');

const safeDir = (stateRoot: string): string => {
  mkdirSync(stateRoot, { recursive: true });
  if (lstatSync(stateRoot).isSymbolicLink()) throw new Error('CEO side root is linked');
  const dir = join(stateRoot, 'els');
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink()) throw new Error('CEO side dir is linked');
  const rootReal = realpathSync(stateRoot);
  const dirReal = realpathSync(dir);
  if (!dirReal.startsWith(`${rootReal}${sep}`)) throw new Error('CEO side dir left state root');
  return dir;
};

export type CeoSideAlertRead = { readonly kind: 'ok'; readonly pendingRed: number }
  | { readonly kind: 'absent' } | { readonly kind: 'error' };

/** Missing means the CEO channel has not started; damage/read failure is explicit so the UI can go red. */
export function readCeoSideAlert(stateRoot: string): CeoSideAlertRead {
  let fd: number | undefined;
  try {
    const dir = join(stateRoot, 'els');
    if (lstatSync(stateRoot).isSymbolicLink() || lstatSync(dir).isSymbolicLink()) return { kind: 'error' };
    const path = ceoSideAlertPath(stateRoot);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 1024) return { kind: 'error' };
    const value = JSON.parse(readFileSync(fd, 'utf8')) as { version?: unknown; pendingRed?: unknown };
    if (value.version !== 1 || typeof value.pendingRed !== 'number' || !Number.isSafeInteger(value.pendingRed)
      || value.pendingRed < 0) return { kind: 'error' };
    return { kind: 'ok', pendingRed: value.pendingRed };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'error' };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function createCeoSideAlertWriter(stateRoot: string, log?: (error: unknown) => void): {
  update(source: CeoSource, threadId: string, messageId: string, receipt: CeoReceipt): boolean;
} {
  const red = new Set<string>();
  return {
    update(source, threadId, messageId, receipt) {
      const key = JSON.stringify([source, threadId, messageId]);
      if (receipt === 'pending-red') red.add(key);
      else red.delete(key);
      let temp: string | undefined;
      try {
        const dir = safeDir(stateRoot);
        temp = join(dir, `.ceo-side-alert.${process.pid}.${randomUUID()}.tmp`);
        writeFileSync(temp, JSON.stringify({ version: 1, pendingRed: red.size, updatedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
        renameSync(temp, ceoSideAlertPath(stateRoot));
        return true;
      } catch (error) {
        if (temp) { try { unlinkSync(temp); } catch { /* not created or already renamed */ } }
        log?.(error);
        return false;
      }
    },
  };
}
