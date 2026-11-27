import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { selfPromptPreview, selfPromptSeatDirectory, registerSelfPromptCommand } from './self-prompt.js';

it('resolves a seat safely and rejects missing seats and traversal', () => {
  const root = mkdtempSync(join(tmpdir(), 'prompt-seats-'));
  try {
    mkdirSync(join(root, 'TEST'));
    expect(selfPromptSeatDirectory('TEST', root)).toBe(join(root, 'TEST'));
    expect(() => selfPromptSeatDirectory('../TEST', root)).toThrow();
    expect(() => selfPromptSeatDirectory('MISSING', root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('real CLI --seat previews the selected seat and reports its anchor manifest', () => {
  const home = mkdtempSync(join(tmpdir(), 'prompt-home-'));
  try {
    const seat = join(home, 'elanous-hq', 'seats', 'TEST');
    mkdirSync(seat, { recursive: true });
    writeFileSync(join(seat, 'AGENTS.local.md'), '## 책임\nseat sentinel\n');
    const entry = join(import.meta.dir, '..', 'index.ts');
    const run = (args: string[]) => Bun.spawnSync([process.execPath, entry, 'self', 'prompt', '--seat', 'TEST', ...args], {
      cwd: home, env: { ...process.env, HOME: home }, stdout: 'pipe', stderr: 'pipe',
    });
    const outline = run([]);
    expect(outline.exitCode).toBe(0);
    const output = JSON.parse(outline.stdout.toString());
    expect(output.cwd).toBe(seat);
    expect(output.anchor.files.some((file: { path: string }) => file.path === join(seat, 'AGENTS.local.md'))).toBe(true);
    expect(output.anchor.truncatedBytes).toBe(0);
    const raw = run(['--raw']);
    expect(raw.exitCode).toBe(0);
    expect(raw.stdout.toString()).toContain('seat sentinel');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it('reports byte size and headings for the same raw preview returned to the CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'prompt-preview-'));
  try {
    writeFileSync(join(root, 'AGENTS.local.md'), '# 핵심\n원문\n');
    const preview = selfPromptPreview(root);
    expect(preview.prompt).toContain('원문');
    expect(preview.bytes).toBe(Buffer.byteLength(preview.prompt));
    expect(preview.sections.some(section => section.title === '핵심')).toBe(true);
    const parent = new Command('self');
    registerSelfPromptCommand(parent);
    expect(parent.commands.some(command => command.name() === 'prompt')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('real CLI raw output equals the assembled universal preamble for an isolated project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-prompt-'));
  try {
    writeFileSync(join(dir, 'AGENTS.local.md'), '## 책임\nfixture만 출력한다.\n');
    const entry = join(import.meta.dir, '..', 'index.ts');
    const proc = Bun.spawnSync([process.execPath, entry, 'self', 'prompt', '--raw'], {
      cwd: dir, stdout: 'pipe', stderr: 'pipe',
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe(selfPromptPreview(realpathSync(dir)).prompt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
