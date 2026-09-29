import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { debug } from '../debug/log.js';

export interface DesignSystem {
  id: string;
  name: string;
  category: string;
  summary: string;
  swatch: { bg: string; fg: string; accent: string };
  fonts: { display: string; body: string };
  sourceCommit: string;
}

export function defaultDesignSystemsDir(): string {
  return resolve(import.meta.dir, '..', '..', 'docs', 'design', 'systems');
}

export function listDesignSystems(systemsDir: string): DesignSystem[] {
  let folders: string[];
  let sourceCommit: string;
  try {
    folders = readdirSync(systemsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    sourceCommit = (JSON.parse(readFileSync(join(systemsDir, 'SOURCE.json'), 'utf8')) as { commit: string }).commit;
    if (typeof sourceCommit !== 'string' || !sourceCommit) throw new Error('missing source commit');
  } catch (error) {
    debug.log('design.systems', 'skipped', { id: 'SOURCE.json', reason: String(error) });
    return [];
  }

  const systems: DesignSystem[] = [];
  for (const id of folders) {
    try {
      const dir = join(systemsDir, id);
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { id: string; name: string; category: string };
      if (manifest.id !== id || !manifest.name || !manifest.category) throw new Error('invalid manifest');
      const document = readFileSync(join(dir, 'DESIGN.md'), 'utf8');
      const summary = document.split(/\r?\n/).filter((line) => line.startsWith('> '))[1]?.slice(2).trim();
      if (!summary) throw new Error('missing summary');
      const cssRaw = readFileSync(join(dir, 'tokens.css'), 'utf8');
      const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
      const root = /:root\s*\{([\s\S]*?)\}/.exec(css)?.[1];
      if (!root) throw new Error('missing :root tokens');
      const token = (name: string): string => {
        const value = new RegExp(`(?:^|\\n)\\s*--${name}\\s*:\\s*([^;\\n]+)\\s*;`, 'm').exec(root)?.[1]?.trim();
        if (value) return value;
        if (new RegExp(`/\\*\\s*⚪\\s*--${name}\\s*:`).test(cssRaw)) return '';
        throw new Error(`missing --${name}`);
      };
      systems.push({
        id, name: manifest.name, category: manifest.category, summary,
        swatch: { bg: token('bg'), fg: token('fg'), accent: token('accent') },
        fonts: { display: token('font-display'), body: token('font-body') },
        sourceCommit,
      });
    } catch (error) {
      debug.log('design.systems', 'skipped', { id, reason: String(error) });
    }
  }
  return systems.sort((a, b) => a.id.localeCompare(b.id));
}
