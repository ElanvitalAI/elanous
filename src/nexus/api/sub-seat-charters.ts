import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../../debug/log.js';

export interface SubSeatCharter { id: string; seat: string; sub: string; title: string }

export function listSubSeatCharters(root = join(import.meta.dir, '..', '..', '..', 'docs', 'roles'), onUnreadable?: () => void): SubSeatCharter[] {
  try {
    readdirSync(root);
    const charters: SubSeatCharter[] = [];
    for (const seat of ['OP', 'MK', 'TC', 'UX']) {
      let entries;
      try { entries = readdirSync(join(root, seat), { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-z][a-z0-9-]{0,31}\.md$/.test(entry.name)) continue;
        const sub = entry.name.slice(0, -3);
        const id = `${seat}/${sub}`;
        const content = readFileSync(join(root, seat, entry.name), 'utf8');
        const heading = content.split(/\r?\n/).find((line) => line.startsWith('# '));
        const title = heading?.slice(2).startsWith(`${id} — `) ? heading.slice(2 + id.length + 3).trim() || id : id;
        charters.push({ id, seat, sub, title });
      }
    }
    return charters.sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    debug.log('ops.seats', 'charters-unreadable', { root, error: error instanceof Error ? error.message : String(error) });
    onUnreadable?.();
    return [];
  }
}
