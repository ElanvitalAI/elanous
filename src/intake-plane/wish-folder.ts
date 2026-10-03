import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { CardStore } from '../task-cards/card-store.js';

export interface WishScanResult {
  added: number;
  updated: number;
  skipped: number;
}

/** Import markdown notes without writing to the Wish folder. The card event log retains intake revisions. */
export function scanWishFolder({ dir, store }: { dir: string; store: CardStore }): WishScanResult {
  let rootEntries: Dirent[];
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    rootEntries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && (error.message === 'not a directory' ||
      ('code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')))) {
      throw new Error(`Wish 폴더를 찾지 못했습니다: ${dir}`);
    }
    throw error;
  }

  const paths: string[] = [];
  const collect = (entries: typeof rootEntries, base: string) => {
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = join(base, entry.name);
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') paths.push(path);
    }
  };
  collect(rootEntries, dir);
  for (const entry of rootEntries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const subdir = join(dir, entry.name);
      collect(readdirSync(subdir, { withFileTypes: true }), subdir);
    }
  }
  paths.sort();

  const cards = new Map(store.listCards().map(card => [card.goalId, card]));
  const result: WishScanResult = { added: 0, updated: 0, skipped: 0 };
  for (const path of paths) {
    const relPath = relative(dir, path).split('\\').join('/');
    const goalId = `wish:${relPath}`;
    const mtime = statSync(path).mtimeMs;
    const old = cards.get(goalId);
    const intakeSections = old?.sections.filter(section => section.key.startsWith('intake:wish:')) ?? [];
    const lastIntake = intakeSections.at(-1);
    if (lastIntake && JSON.parse(lastIntake.content).mtime === mtime) {
      result.skipped++;
      continue;
    }
    const title = /^# (.+)$/m.exec(readFileSync(path, 'utf8'))?.[1]?.trim() || basename(path, '.md');
    const card = old ?? store.createCard({ goalId, title });
    const intake = { source: 'wish', path: relPath, mtime, title };
    store.appendSection(card.id, {
      key: `intake:wish:${intakeSections.length}`,
      owner: 'steward',
      content: JSON.stringify(intake),
    });
    if (old) result.updated++;
    else result.added++;
  }
  return result;
}
