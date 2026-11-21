import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySeatMemoryImport, planSeatMemoryImport } from './seat-memory-import.js';
import { buildSeatMemoryIndexBlock, seatMemoryDir } from './seat-memory.js';
import { buildSeatMemoryIndexSystemMessages, startSeatBootConversation } from '../seat/seat-boot-preamble.js';
import { simCli } from '../ux-sim/in-process-cli.js';

test('import keeps a curated 125-line primary index and moves 362 unindexed memories to a secondary index', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-memory-index-cap-'));
  const from = join(root, 'claude-memory');
  const storeRoot = join(root, 'store');
  const to = seatMemoryDir('OP', storeRoot);
  const home = join(root, 'home');
  mkdirSync(join(home, 'elanous-hq', 'seat-state', 'OP'), { recursive: true });
  mkdirSync(from);
  const memory = (name: string) => `---\nname: ${name}\ndescription: ${name} fact\ntype: reference\n---\n\n${name} body\n`;
  const sourceLines: string[] = [];
  try {
    for (let i = 0; i < 124; i++) {
      const name = `curated-${i}`;
      writeFileSync(join(from, `${name}.md`), memory(name));
      sourceLines.push(`- [${name}](${name}.md)`);
    }
    sourceLines.push('- [more](MEMORY-MORE.md)');
    writeFileSync(join(from, 'MEMORY-MORE.md'), '# More memories\n'); // reference file, no frontmatter
    for (let i = 0; i < 362; i++) {
      const name = `extra-${i}`;
      writeFileSync(join(from, `${name}.md`), memory(name));
    }
    const original = `${sourceLines.join('\n')}\n`;
    writeFileSync(join(from, 'MEMORY.md'), original);
    const plan = planSeatMemoryImport({ from, to, seat: 'OP' });
    expect(plan.indexDroppedLines).toBe(0);
    expect(plan.index).toBe(original);
    expect(plan.files.filter(file => file.action === 'create')).toHaveLength(487);
    applySeatMemoryImport(plan);
    expect(readFileSync(join(to, 'MEMORY.md'), 'utf8')).toBe(original);
    expect(readFileSync(join(to, 'MEMORY-MORE.md'), 'utf8')).toBe('# More memories\n');
    const extraIndex = readFileSync(join(to, 'MEMORY-UNINDEXED.md'), 'utf8');
    expect(extraIndex.split('\n').filter(line => line.startsWith('- '))).toHaveLength(362);
    expect(extraIndex).toContain('extra-361.md');
    const block = buildSeatMemoryIndexBlock('OP', to);
    expect(block).toMatchObject({ lines: 125, totalLines: 125, truncated: false });
    startSeatBootConversation({ reason: 'boot' });
    const firstTurn = buildSeatMemoryIndexSystemMessages({ cwd: join(home, 'elanous-hq', 'seats', 'OP') },
      { home, env: {}, msgPath: join(root, 'absent.db'), seatMemoryRoot: storeRoot })[0]?.content ?? '';
    expect(firstTurn).toContain('[more](MEMORY-MORE.md)');
    expect(firstTurn).not.toContain('⚠️ 색인');
    expect(planSeatMemoryImport({ from, to, seat: 'OP' }).files.every(file => file.action === 'same')).toBe(true);
  } finally { startSeatBootConversation({ reason: 'session-clear' }); rmSync(root, { recursive: true, force: true }); }
});

test('import moves old autoappend lines out of primary without overwriting an unrelated reference file', () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-memory-index-upgrade-'));
  const from = join(root, 'source');
  const to = join(root, 'target');
  mkdirSync(from);
  mkdirSync(to);
  const memory = (name: string) => `---\nname: ${name}\ndescription: safe\ntype: reference\n---\n\n${name}\n`;
  try {
    writeFileSync(join(from, 'curated.md'), memory('curated'));
    writeFileSync(join(from, 'extra.md'), memory('extra'));
    writeFileSync(join(from, 'MEMORY.md'), '- [curated](curated.md)\n');
    writeFileSync(join(to, 'legacy.md'), memory('legacy'));
    writeFileSync(join(to, 'MEMORY.md'), '- [curated](curated.md)\n- [legacy](legacy.md)\n');
    writeFileSync(join(to, 'MEMORY-UNINDEXED.md'), '# Human notes\n');
    const plan = planSeatMemoryImport({ from, to, seat: 'OP' });
    expect(plan.index).toBe('- [curated](curated.md)\n');
    expect(plan.supplementalIndex?.file).toBe('MEMORY-UNINDEXED-2.md');
    applySeatMemoryImport(plan);
    expect(readFileSync(join(to, 'MEMORY-UNINDEXED.md'), 'utf8')).toBe('# Human notes\n');
    expect(readFileSync(join(to, 'MEMORY-UNINDEXED-2.md'), 'utf8')).toContain('[legacy](legacy.md)');
    expect(readFileSync(join(to, 'MEMORY-UNINDEXED-2.md'), 'utf8')).toContain('[extra](extra.md)');
    expect(planSeatMemoryImport({ from, to, seat: 'OP' }).supplementalIndex?.file).toBe('MEMORY-UNINDEXED-2.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('registered memory import CLI applies the split index in an isolated state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seat-memory-import-cli-'));
  const from = join(root, 'source');
  const to = join(root, 'target');
  mkdirSync(from);
  writeFileSync(join(from, 'one.md'), '---\nname: one\ndescription: safe\ntype: reference\n---\n\none\n');
  writeFileSync(join(from, 'two.md'), '---\nname: two\ndescription: safe\ntype: reference\n---\n\ntwo\n');
  writeFileSync(join(from, 'MEMORY.md'), '- [one](one.md)\n');
  try {
    const run = await simCli(['memory', 'import', '--from', from, '--to', to, '--seat', 'OP', '--apply'],
      { allowPaths: [['memory'], ['memory', 'import']], stateRoot: join(root, 'state'), cwd: root });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('unindexed reference MEMORY-UNINDEXED.md');
    expect(readFileSync(join(to, 'MEMORY.md'), 'utf8')).toBe('- [one](one.md)\n');
    expect(readFileSync(join(to, 'MEMORY-UNINDEXED.md'), 'utf8')).toContain('[two](two.md)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
