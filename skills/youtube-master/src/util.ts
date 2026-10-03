import { execFileSync } from 'node:child_process';

/** Check if a binary exists on PATH */
export function which(name: string): string {
  try {
    return execFileSync('which', [name], { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error(`필수 바이너리가 없습니다: ${name}`);
  }
}

/** Sanitize a title for use as a filename (max 60 chars) */
export function safeName(text: string): string {
  const compact = String(text || 'untitled')
    .replace(/[\\/:*?"<>|#^\[\]]/g, ' ')
    .replace(/[^0-9A-Za-z가-힣\s_-]/g, ' ')
    .replace(/\s+/g, '_')
    .trim();
  if (!compact) return 'untitled';
  if (compact.length <= 60) return compact;
  return compact.substring(0, 60).replace(/_$/, '');
}

/** Remove emoji prefix from title */
export function cleanTitle(text: string): string {
  return String(text || '').replace(/^📝\s+/, '').replace(/\s+/g, ' ').trim();
}

/** YYYYMMDD date string */
export function dateStamp(d = new Date()): string {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('');
}

/** ISO datetime string */
export function nowISO(): string {
  return new Date().toISOString();
}

/** YYYY-MM-DD HH:MM */
export function nowFull(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time}`;
}

/** YYYYMMDD_HHMMSS timestamp */
export function stamp(): string {
  const d = new Date();
  const date = dateStamp(d);
  const time = [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${date}_${time}`;
}

/** Escape pipe chars for markdown tables */
export function escapeTable(text: string): string {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Escape double quotes */
export function escapeQuotes(text: string): string {
  return String(text || '').replace(/"/g, '\\"');
}

/** Slugify for directory names */
export function slugify(value: string): string {
  return safeName(value).replace(/_/g, '-').toLowerCase();
}

/** Reflow paragraphs: strip list markers, join on double newlines */
export function reflowParagraphs(text: string): string {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/^[-*]\s+/gm, '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Compact transcript: keep 65% head + 35% tail if too long */
export function compactTranscript(text: string, maxLen = 18000): string {
  if (text.length <= maxLen) return text;
  const headLen = Math.floor(maxLen * 0.65);
  const tailLen = maxLen - headLen;
  return text.slice(0, headLen) + '\n\n[...중간 생략...]\n\n' + text.slice(-tailLen);
}
