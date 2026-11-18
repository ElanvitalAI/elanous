import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SeatControlMode } from './seat-control.js';

export interface SeatControlHandoff {
  readonly seat: string;
  readonly sessionId: string;
  readonly mode: SeatControlMode;
  readonly createdAt: string;
}

/** Publish one complete, private handoff without replacing an earlier request's checkpoint. */
export async function writeSeatControlHandoff(root: string, requestId: string, handoff: SeatControlHandoff): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error('invalid request id');
  if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(handoff.seat) || !handoff.sessionId.trim()) throw new Error('invalid handoff identity');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${requestId}.json`);
  const temp = join(root, `.${requestId}.${crypto.randomUUID()}.tmp`);
  const file = await open(temp, 'wx', 0o600);
  try {
    try { await file.writeFile(`${JSON.stringify({ version: 1, ...handoff })}\n`, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await link(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
  return path;
}
