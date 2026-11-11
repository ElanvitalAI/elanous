import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('test-universe TUI N decision leaves a proposal receipt and no fake project', () => {
  const root = mkdtempSync(join(tmpdir(), 'gcp-tui-deny-'));
  try {
    const result = spawnSync('python3', [join(import.meta.dir, '../../../../scripts/gcp-architect-expand/demo/tui.py'), '--test-universe',
      '--ticket-design', join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/ticketing-design.json'),
      '--pressure', join(import.meta.dir, '../../../../plugins/gcp-architect-expand/demo/fixtures/pressure.json'), '--output-root', root],
    { input: 'N\n', encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[4/5]');
    const output = join(root, readdirSync(root)[0]!);
    const receipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
    expect(receipt.status).toBe('denied-before-fake-project');
    expect(receipt.approval.decision).toBe('no');
    expect(existsSync(join(output, 'proposal.json'))).toBe(true);
    expect(existsSync(join(output, 'fake-world.json'))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
