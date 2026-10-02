// MAT1e — the public docs' «Status» column and «Experimental» notes come from the one maturity table
// (src/maturity/feature-maturity.ts). If a grade changes there, this fails until the docs say the same.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { maturityOn, visibleOn } from '../src/maturity/feature-maturity.js';

const DOCS = join(import.meta.dir, '..', 'release', 'public', 'docs');
const MENU_ROUTE: Record<string, string> = {
  '**Chat**': '/chat', '**Terminal**': '/term', '**Intake**': '/intake', '**Approvals**': '/approvals', '**Live**': '/live',
  '**Trace**': '/trace', '**Missions**': '/tasks', '**Design**': '/design-check', '**Vault**': '/vault', '**마켓** (Market)': '/market',
  '**Schedules**': '/scheduler', '**Settings**': '/settings', '**Setup** (`/setup`)': '/setup',
};
const LABEL = { stable: 'Stable', beta: 'Experimental', tool: 'Tool', ops: 'Operator' } as const;

test('every PWA menu row states the grade the maturity table gives its route', () => {
  const rows = readFileSync(join(DOCS, 'pwa.md'), 'utf8').split('\n').filter((l) => l.startsWith('| **'));
  for (const [menu, route] of Object.entries(MENU_ROUTE)) {
    const row = rows.find((r) => r.startsWith(`| ${menu} |`));
    expect(row, menu).toBeDefined();
    const grade = maturityOn(route, 'pwa') as keyof typeof LABEL;
    const status = row!.split('|')[2]!.trim();
    expect(status.startsWith(LABEL[grade]), `${menu} ${route}`).toBe(true);
    // A non-stable screen that a general user still sees must say so («always shown»), not «hidden».
    if (grade !== 'stable' && visibleOn(route, 'pwa', 'general')) expect(status).toContain('always shown');
  }
});

test('pages for experimental screens open with the Experimental note; stable pages do not', () => {
  const pages: Record<string, string> = { 'pwa-trace.md': '/trace', 'pwa-vault.md': '/vault', 'pwa-chat.md': '/chat', 'pwa-live.md': '/live', 'pwa-terminal.md': '/term' };
  for (const [file, route] of Object.entries(pages)) {
    const head = readFileSync(join(DOCS, file), 'utf8').split('\n').slice(0, 4).join('\n');
    expect(head.includes('**Experimental.**'), file).toBe(maturityOn(route, 'pwa') === 'beta');
  }
});
