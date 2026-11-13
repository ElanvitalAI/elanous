import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ScrapFolder {
  id: string;
  memberId: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

function ledgerPath(instanceRoot: string): string { return join(instanceRoot, 'scrap-folders.jsonl'); }

export function listScrapFolders(instanceRoot: string, memberId: string): ScrapFolder[] {
  const path = ledgerPath(instanceRoot);
  if (!existsSync(path)) return [];
  const byId = new Map<string, ScrapFolder>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const folder = JSON.parse(line) as ScrapFolder;
      if (folder.memberId === memberId && typeof folder.id === 'string') byId.set(folder.id, folder);
    } catch { /* A partial final line is not a folder. */ }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findScrapFolder(instanceRoot: string, memberId: string, id: string): ScrapFolder | undefined {
  return listScrapFolders(instanceRoot, memberId).find((folder) => folder.id === id);
}

export function createScrapFolder(instanceRoot: string, memberId: string, name: string, parentId: string | null, now: string): ScrapFolder {
  const folder: ScrapFolder = { id: randomUUID(), memberId, name, parentId, createdAt: now };
  mkdirSync(instanceRoot, { recursive: true });
  appendFileSync(ledgerPath(instanceRoot), `${JSON.stringify(folder)}\n`, { mode: 0o600 });
  return folder;
}

export function updateScrapFolder(instanceRoot: string, folder: ScrapFolder, patch: Pick<ScrapFolder, 'name' | 'parentId'>): ScrapFolder {
  const updated = { ...folder, ...patch };
  appendFileSync(ledgerPath(instanceRoot), `${JSON.stringify(updated)}\n`, { mode: 0o600 });
  return updated;
}

export function validScrapFolderName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 80
    && !/[\\/\x00-\x1f\x7f]/.test(value);
}
