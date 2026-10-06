import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeGoalDocumentAtomic } from './goal-document-write.js';

test('atomic goal write replaces the file and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-write-'));
  try {
    const goal = join(dir, 'GOAL.md');
    writeFileSync(goal, 'old');
    writeGoalDocumentAtomic(goal, 'new');
    expect(readFileSync(goal, 'utf8')).toBe('new');
    expect(readdirSync(dir)).toEqual(['GOAL.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed replacement of the goal itself keeps its original text and removes the temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-write-'));
  try {
    const goal = join(dir, 'GOAL.md');
    writeFileSync(goal, 'old');
    const io = { writeFileSync, rmSync, statSync, chmodSync,
      renameSync: (_from: string, _to: string) => { throw new Error('rename refused'); } };
    expect(() => writeGoalDocumentAtomic(goal, 'new', io)).toThrow('rename refused');
    expect(readFileSync(goal, 'utf8')).toBe('old');
    // The temp file is created next to the goal (same directory) — it must be gone.
    expect(readdirSync(dir)).toEqual(['GOAL.md']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('replacement keeps the goal file permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-write-'));
  try {
    const goal = join(dir, 'GOAL.md');
    writeFileSync(goal, 'old');
    chmodSync(goal, 0o600);
    writeGoalDocumentAtomic(goal, 'new');
    expect(statSync(goal).mode & 0o777).toBe(0o600);
    expect(readFileSync(goal, 'utf8')).toBe('new');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

