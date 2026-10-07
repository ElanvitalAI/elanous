import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPreviewResult, runPrPreview } from './pr-preview.js';

const HEAD = 'a'.repeat(40);

test('one PR preview checks out the exact head, builds PWA, drives inner PTY and comments the friction table', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-unit-'));
  const calls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
  let snapshots = 0;
  try {
    const result = await runPrPreview({ target: '42', repoRoot: root, scenario: 'S3' }, {
      makeDir: () => join(root, 'isolated'), dispose: () => {}, wait: async () => {}, probePwa: async () => true,
      run: (command, args, cwd) => {
        calls.push({ command, args, cwd });
        if (command === 'gh' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 42, headRefOid: HEAD }), stderr: '' };
        if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: HEAD, stderr: '' };
        if (command === 'bun' && args.includes('--version')) return { status: 0, stdout: '0.2.18', stderr: '' };
        if (command === 'bun' && args.includes('run') && args.includes('--test')) return { status: 0, stdout: '  nexus     :31450  (test lease)', stderr: '' };
        if (command === 'bun' && args.includes('--hold')) return { status: 0, stdout: '{"held":true,"ptyId":"pty_123"}', stderr: '' };
        if (command === 'bun' && args.includes('snapshot')) return { status: 0, stdout: ++snapshots === 1 ? 'ready' : '/status · model and connection', stderr: '' };
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });
    expect(result).toMatchObject({ head: HEAD, status: 'passed', commented: true, prNumber: 42 });
    expect(calls.some((call) => call.command === 'git' && call.args.join(' ').includes(`worktree add --detach`) && call.args.includes(HEAD))).toBe(true);
    expect(calls.some((call) => call.command === 'bun' && call.args.includes('build') && call.args.includes('nexus'))).toBe(true);
    expect(calls.some((call) => call.command === 'bun' && call.args.includes('text') && call.args.includes('/status') && call.args.includes('--enter'))).toBe(true);
    const comment = calls.find((call) => call.command === 'gh' && call.args[1] === 'comment');
    expect(comment?.args[2]).toBe('42');
    expect(comment?.args.at(-1)).toContain('Inner PTY snapshot');
    expect(readPreviewResult(join(root, '.elanous-test'))?.status).toBe('passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('branch preview finds its unique open PR and rejects a stale local branch before build', async () => {
  const calls: string[] = [];
  await expect(runPrPreview({ target: 'feature/demo', repoRoot: '/repo' }, {
    run: (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'gh' && args[1] === 'list') return { status: 0, stdout: JSON.stringify([{ number: 42, headRefOid: 'b'.repeat(40) }]), stderr: '' };
      if (command === 'gh' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ headRefName: 'feature/demo', headRefOid: 'b'.repeat(40) }), stderr: '' };
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: HEAD, stderr: '' };
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  })).rejects.toThrow('branch does not match the target PR head');
  expect(calls.some((line) => line.includes('worktree add'))).toBe(false);
  expect(calls.some((line) => line.includes('gh pr list --head feature/demo'))).toBe(true);
});

test('main flags require an explicit PR and nonexistent config is friction, not a green preview', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-flags-'));
  try {
    await expect(runPrPreview({ target: 'main', repoRoot: root, flags: ['loops.demo.enabled'] }, { run: () => { throw Error('unexpected'); } })).rejects.toThrow('--comment-pr');
    const calls: string[] = [];
    const result = await runPrPreview({ target: 'main', repoRoot: root, flags: ['loops.demo.enabled'], commentPr: 43 }, {
      makeDir: () => join(root, 'isolated'), dispose: () => {},
      run: (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: HEAD, stderr: '' };
        if (command === 'bun' && args.includes('get')) return { status: 1, stdout: '', stderr: 'config path not found' };
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });
    expect(result.status).toBe('friction');
    expect(result.report).toContain('config path not found');
    expect(calls.some((line) => line.includes('config set loops.demo.enabled'))).toBe(false);
    expect(calls.some((line) => line.includes('gh pr comment 43'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('P-1 waits for the detached daemon to listen, and the held TUI is stopped with a key the PTY resolver accepts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-ready-'));
  const calls: Array<readonly string[]> = [];
  let probes = 0;
  let snapshots = 0;
  try {
    const result = await runPrPreview({ target: '42', repoRoot: root, scenario: 'S2' }, {
      makeDir: () => join(root, 'isolated'), dispose: () => {}, wait: async () => {},
      probePwa: async () => ++probes >= 3,
      run: (command, args) => {
        calls.push([command, ...args]);
        if (command === 'gh' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 42, headRefOid: HEAD }), stderr: '' };
        if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: HEAD, stderr: '' };
        if (command === 'bun' && args.includes('run') && args.includes('--test') && !args.includes('--stop')) return { status: 0, stdout: '  nexus     :31450  (test lease)', stderr: '' };
        if (command === 'bun' && args.includes('--hold')) return { status: 0, stdout: '{"held":true,"ptyId":"pty_123"}', stderr: '' };
        if (command === 'bun' && args.includes('snapshot')) return { status: 0, stdout: ++snapshots === 1 ? 'ready' : '/help · commands', stderr: '' };
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });
    expect(probes).toBe(3);
    expect(result.status).toBe('passed');
    const stop = calls.find((call) => call.includes('key'));
    expect(stop?.at(-1)).toBe('ctrl+c');
    const { resolvePtySpecialKey } = await import('../pty-shell/pty-special-keys.js');
    expect(resolvePtySpecialKey(stop!.at(-1)!)).toBe('\x03');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('report table rows stay single-line even when the daemon prints a multi-line banner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preview-table-'));
  let snapshots = 0;
  try {
    const result = await runPrPreview({ target: '42', repoRoot: root }, {
      makeDir: () => join(root, 'isolated'), dispose: () => {}, wait: async () => {}, probePwa: async () => true,
      run: (command, args) => {
        if (command === 'gh' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 42, headRefOid: HEAD }), stderr: '' };
        if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: HEAD, stderr: '' };
        if (command === 'bun' && args.includes('run') && args.includes('--test') && !args.includes('--stop')) return { status: 0, stdout: 'elanous nexus: started in background\n  pid  1\n  nexus     :31450  (test lease)\n', stderr: '' };
        if (command === 'bun' && args.includes('--hold')) return { status: 0, stdout: '{"held":true,"ptyId":"pty_1"}', stderr: '' };
        if (command === 'bun' && args.includes('snapshot')) return { status: 0, stdout: ++snapshots === 1 ? 'ready' : '/help list', stderr: '' };
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });
    const table = result.report.split('<details>')[0]!.split('\n').filter((line) => line.startsWith('|'));
    expect(table.find((line) => line.startsWith('| P-1 PWA |'))).toBe('| P-1 PWA | `http://127.0.0.1:31450/app/` served the built PWA |');
    expect(result.report).not.toContain('started in background');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
