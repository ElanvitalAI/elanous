import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { debug } from '../debug/log.js';
import { LessonLedger } from './lesson-ledger.js';

export interface LessonImportItem { id: string; incident: string; cause: string; remedy: string; source: string }
export interface LessonImportSkipped { source: string; reason: string }
export interface LessonScan { files: number; items: LessonImportItem[]; skipped: LessonImportSkipped[] }

function firstParagraph(lines: string[], heading: RegExp): string {
  const start = lines.findIndex(line => {
    const match = line.match(/^##\s+(.+)$/);
    if (!match) return false;
    const title = match[1]!.replace(/^(?:(?:\d+[.)]|§\s*\d+\.?|[a-z][.)]|[①-⑳])\s*|[\p{Extended_Pictographic}\uFE0F\u200D]+\s*|\s)+/giu, '');
    return heading.test(title);
  });
  if (start === -1) return '';
  const paragraph: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s+/.test(line)) break;
    if (/^#{3,6}\s+/.test(line)) {
      if (paragraph.length) break;
      continue;
    }
    if (!line.trim()) {
      if (paragraph.length) break;
      continue;
    }
    if (/^```|^~~~/.test(line.trim())) break;
    paragraph.push(line.trim());
  }
  return paragraph.join(' ');
}

export function scanLessonDocs(root: string): LessonScan {
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const source = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (source !== 'docs/goals' && source !== 'docs/archive') visit(source);
      } else if (entry.isFile() && /^(?:INCIDENT|FINDING)-.*\.md$/.test(entry.name)) {
        sources.push(source);
      }
    }
  };
  if (existsSync(join(root, 'docs')) && lstatSync(join(root, 'docs')).isDirectory()) visit('docs');
  sources.sort();
  const items: LessonImportItem[] = [];
  const skipped: LessonImportSkipped[] = [];
  for (const source of sources) {
    const lines = readFileSync(join(root, source), 'utf8').split(/\r?\n/);
    const title = lines.find(line => /^#\s+/.test(line));
    const incident = title?.replace(/^#\s+/, '').replace(/^(?:INCIDENT|FINDING)\s*[—–-]\s*/i, '').trim() ?? '';
    const cause = firstParagraph(lines, /^(?:원인|근본|기전|Root cause|Why|Complication|C$)/i);
    const remedy = firstParagraph(lines, /^(?:교훈|재발 방지|처방|대응|수리|Fix|Answer|A$)/i);
    if (!incident || (!cause && !remedy)) {
      skipped.push({ source, reason: !incident ? 'missing incident title' : 'missing cause and remedy' });
      continue;
    }
    const filename = basename(source, '.md');
    const date = filename.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const slug = filename.replace(/^(?:INCIDENT|FINDING)-/, '').replace(/(?:^|-)\d{4}-\d{2}-\d{2}(?=-|$)/, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
    const base = slug || 'lesson';
    // Include the source fingerprint even before a collision is observed: a later document cannot rename an earlier ID.
    const fingerprint = createHash('sha256').update(source).digest('hex');
    const id = `${base}-${date ?? 'undated'}-${fingerprint}`;
    items.push({ id, incident, cause, remedy, source });
  }
  debug.log('lessons.import', 'scanned', { files: sources.length, items: items.length, skipped: skipped.length, written: 0 });
  return { files: sources.length, items, skipped };
}

export function importLessons(ledger: LessonLedger, items: LessonImportItem[], options: { apply: boolean; by: string }): {
  items: LessonImportItem[]; skipped: LessonImportSkipped[]; written: number;
} {
  const pending: LessonImportItem[] = [];
  const skipped: LessonImportSkipped[] = [];
  const seenIds = new Set<string>();
  const seenSources = new Set<string>(existsSync(ledger.path) ? ledger.importedSources() : []);
  for (const item of items) {
    if (seenIds.has(item.id) || seenSources.has(item.source)) {
      skipped.push({ source: item.source, reason: 'already imported or duplicate in scan' });
      continue;
    }
    let exists = false;
    if (existsSync(ledger.path)) {
      try { ledger.get(item.id); exists = true; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith('lesson not found:')) throw error;
      }
    }
    if (exists) {
      skipped.push({ source: item.source, reason: 'already imported' });
      continue;
    }
    seenIds.add(item.id);
    seenSources.add(item.source);
    pending.push(item);
    if (options.apply) ledger.importDocument({ ...item, owner: options.by, by: options.by });
  }
  return { items: pending, skipped, written: options.apply ? pending.length : 0 };
}
