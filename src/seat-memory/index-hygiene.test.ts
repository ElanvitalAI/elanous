// MEMORY-INDEX-HYGIENE (내부 문서 `MEMORY-CONTRACT` §6a ①②) — a real seat store in a temp dir. Literal expectations (rule 11).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSeatMemoryIndexBlock, saveSeatMemory } from './seat-memory.js';

const NOW = Date.parse('2026-11-29T00:00:00.000Z');
const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-hygiene-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const card = (dir: string, name: string, until: string): void => {
  saveSeatMemory({ name, description: `지시 · 대상 MK · 만료 ${until}`, type: 'feedback', body: `${name} body` }, dir, 'OP');
};
const filler = (n: number): string => Array.from({ length: n }, (_, i) => `- [old-${i}](old-${i}.md) — ${'o'.repeat(40)}`).join('\n');

describe('② a new index line goes to the live list, never under a heading', () => {
  test('above the first heading, below the last live line (the blank separator stays)', () => withDir((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '- [live-rule](live-rule.md) — live\n\n## 무효로 한 것\n- [old-rule](old-rule.md) — invalid\n');
    saveSeatMemory({ name: 'new-rule', description: 'new', type: 'feedback', body: 'new body' }, dir, 'OP');
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe(
      '- [live-rule](live-rule.md) — live\n- [new-rule](new-rule.md) — new\n\n## 무효로 한 것\n- [old-rule](old-rule.md) — invalid\n');
  }));

  test('no heading → appended at the end (unchanged behaviour) · an existing line is replaced in place', () => withDir((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '- [a](a.md) — a\n');
    saveSeatMemory({ name: 'b', description: 'b', type: 'feedback', body: 'b body' }, dir, 'OP');
    saveSeatMemory({ name: 'a', description: 'a2', type: 'feedback', body: 'a body' }, dir, 'OP');
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toBe('- [a](a.md) — a2\n- [b](b.md) — b\n');
  }));
});

describe('① an overflowing session-start index keeps live crown- cards', () => {
  test('a live crown card at the bottom survives the byte cap · an expired one does not · order stays', () => withDir((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), `${filler(10)}\n`);
    card(dir, 'crown-1128-mk-docs-only', '2099-01-01T00:00:00.000Z');
    card(dir, 'crown-1101-mk-old', '2026-11-02T00:00:00.000Z');
    const built = buildSeatMemoryIndexBlock('OP', dir, { maxBytes: 300, nowMs: NOW })!;
    expect(built.truncated).toBe(true);
    expect(built.block).toContain('[crown-1128-mk-docs-only]');
    expect(built.block).not.toContain('[crown-1101-mk-old]');
    expect(built.block).toContain('- [old-0](old-0.md)');
    expect(built.block).not.toContain('- [old-9](old-9.md)');
    expect(built.block.indexOf('- [old-0]')).toBeLessThan(built.block.indexOf('[crown-1128-mk-docs-only]'));
    expect(built.bytes).toBeLessThanOrEqual(300);
  }));

  test('the line cap also leaves room for the live card', () => withDir((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), `${filler(5)}\n`);
    card(dir, 'crown-1128-tc-never-release', '2099-01-01T00:00:00.000Z');
    const built = buildSeatMemoryIndexBlock('OP', dir, { maxLines: 3, nowMs: NOW })!;
    expect(built.lines).toBe(3);
    expect(built.block).toContain('- [old-0](old-0.md)');
    expect(built.block).toContain('- [old-1](old-1.md)');
    expect(built.block).not.toContain('- [old-2](old-2.md)');
    expect(built.block).toContain('[crown-1128-tc-never-release]');
  }));

  test('no overflow → every line, same order as the file', () => withDir((dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), `${filler(2)}\n`);
    card(dir, 'crown-1128-ux-pwa-only', '2099-01-01T00:00:00.000Z');
    const built = buildSeatMemoryIndexBlock('OP', dir, { nowMs: NOW })!;
    expect(built.truncated).toBe(false);
    expect(built.lines).toBe(3);
    expect(built.block.indexOf('- [old-1]')).toBeLessThan(built.block.indexOf('[crown-1128-ux-pwa-only]'));
  }));
});
