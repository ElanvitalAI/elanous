import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export interface DashboardSource {
  path: string;
  text: string;
}

export interface DashboardMatch {
  path: string;
  line: number;
}

/** Reads every dashboard TypeScript source, including modules in subdirectories. */
export function readDashboardSources(dir = resolve(process.cwd(), 'src/dashboard')): DashboardSource[] {
  const files: DashboardSource[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push({ path: relative(process.cwd(), path), text: readFileSync(path, 'utf8') });
      }
    }
  }
  walk(dir);
  if (files.length === 0) throw new Error(`No dashboard TypeScript sources in ${dir}`);
  return files;
}

/** Keeps file boundaries intact, including for multiline patterns and occurrence counts. */
export function dashboardMatches(pattern: RegExp, sources: readonly DashboardSource[] = readDashboardSources()): DashboardMatch[] {
  const matches: DashboardMatch[] = [];
  for (const { path, text } of sources) {
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of text.matchAll(regex)) {
      const line = text.slice(0, match.index).split('\n').length;
      matches.push({ path, line });
    }
  }
  return matches;
}

export function dashboardSourceText(sources: readonly DashboardSource[]): string {
  return sources.map(({ text }) => text).join('\n');
}

export function dashboardSourceLocations(sources: readonly DashboardSource[]): string {
  return sources.map(({ path, text }) => `${path}:1-${text.split('\n').length}`).join(', ');
}
