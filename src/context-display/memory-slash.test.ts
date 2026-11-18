import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemorySlashCommand, listMemory, showMemory } from './memory-slash.js';

test('/memory defaults to the elanous memory root, never Claude Code\'s ~/.claude/projects folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'memslash-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    const memory = join(root, 'elanous', 'memory');
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, 'pref.md'), '---\nname: pref\ndescription: 짧은 답변 선호\ntype: feedback\n---\nbody\n');
    const out = buildMemorySlashCommand().render({ sub: 'list' });
    expect(out).toContain(memory);
    expect(out).toContain('짧은 답변 선호');
    expect(out).not.toContain('.claude');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// NEXT-TUI-SLASH-COMMAND-SWEEP 3rd pass (11-18): the TUI UI is English; /memory's notices were the last Korean lines.
test('/memory notices are English: missing folder and unreadable entry', () => {
  const missing = listMemory(join(tmpdir(), `no-memory-${process.pid}-${Date.now()}`));
  expect(missing).toContain('(no memory folder yet: ');
  expect(missing).not.toMatch(/[\u{AC00}-\u{D7A3}]/u);
  const dir = mkdtempSync(join(tmpdir(), 'memory-slash-en-'));
  try {
    mkdirSync(join(dir, 'broken.md'));
    expect(showMemory(dir, 'broken')).toMatch(/^── \/memory show ─+\n\(cannot read: /u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
