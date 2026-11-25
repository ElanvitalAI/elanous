// ── Pregate GREEN receipt lookup (COND-WATCH · 11-25) ─────────────────────────────────────────────
// A pregate PASS leaves `<PREGATE-GREEN>/<PR>-<head12>-<lane>/` (RES pregate.py). The directory is configuration, not a
// literal: `ELANOUS_PREGATE_GREEN_DIR` wins, else `<ELANOUS_HQ_ROOT | ~/elanous-hq>/seat-state/RES/evidence/PREGATE-GREEN`.
// Reading it is one readdir — cheap enough for a 1/min watch and for an fs.watch trigger on the same directory.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PREGATE_GREEN_DIR_ENV = 'ELANOUS_PREGATE_GREEN_DIR';
export const HQ_ROOT_ENV = 'ELANOUS_HQ_ROOT';

export function pregateGreenDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[PREGATE_GREEN_DIR_ENV]?.trim();
  if (explicit) return explicit;
  const hq = env[HQ_ROOT_ENV]?.trim() || join(homedir(), 'elanous-hq');
  return join(hq, 'seat-state', 'RES', 'evidence', 'PREGATE-GREEN');
}

const LANE = /^(\d+)-([0-9a-f]{12})-[\w.-]+$/;

/** The lane directory name proving a GREEN pregate for `pr` (at `head` when given — any 7..12-char prefix), or null. */
export function findPregateReceipt(dir: string, pr: number, head?: string): string | null {
  if (!existsSync(dir)) return null;
  const want = head?.toLowerCase().slice(0, 12);
  const hits = readdirSync(dir).filter((name) => {
    const m = LANE.exec(name);
    return m !== null && Number(m[1]) === pr && (want === undefined || m[2]!.startsWith(want));
  }).sort();
  return hits.length > 0 ? hits[hits.length - 1]! : null;
}
