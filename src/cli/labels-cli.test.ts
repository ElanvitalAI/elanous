import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import type { GhCliResult } from '../git-fs/gh-cli.js';
import { PR_LABELS } from '../github/pr-labels.js';
import { registerLabelsCommands } from './labels-cli.js';

function result(labels: unknown, ok = true, maybeTruncated = false): GhCliResult {
  return {
    ok, maybeTruncated, exitCode: ok ? 0 : 1,
    stdout: Buffer.from(JSON.stringify(labels)), stderr: Buffer.from(ok ? '' : 'offline'),
  };
}

function setup(remote: unknown, options: { ok?: boolean; maybeTruncated?: boolean } = {}) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const program = new Command();
  registerLabelsCommands(program, {
    gh: args => {
      calls.push(args);
      return args[1] === 'list' ? result(remote, options.ok, options.maybeTruncated) : result([]);
    },
    out: { log: line => { lines.push(line); }, error: line => { lines.push(line); } },
  });
  return { program, calls, lines };
}

const local = PR_LABELS[0]!;
const remote = [
  { name: local.name, color: '000000', description: 'old' },
  { name: 'elanous:future', color: 'FFFFFF', description: 'not registered' },
  { name: 'external', color: '000000', description: 'outside namespace' },
];

describe('labels CLI', () => {
  test('list prints registry metadata without contacting GitHub', async () => {
    const { program, calls, lines } = setup([]);
    await program.parseAsync(['labels', 'list'], { from: 'user' });
    expect(calls).toEqual([]);
    expect(lines).toHaveLength(PR_LABELS.length);
    expect(lines[0]).toContain(`${local.name}\t${local.axis}\t#${local.color}\t${local.description}`);
    expect(lines[0]).toContain('appliedBy=');
    expect(lines[0]).toContain('sweep=');
    expect(lines.at(-1)).toContain(PR_LABELS.at(-1)!.name);
  });

  test('sync compares missing, stale and unknown labels but defaults to dry-run', async () => {
    const { program, calls, lines } = setup(remote);
    await program.parseAsync(['labels', 'sync'], { from: 'user' });
    expect(calls).toEqual([['label', 'list', '--json', 'name,color,description', '--limit', '1000']]);
    expect(lines).toContain(`edit: ${local.name}`);
    expect(lines).toContain(`create: ${PR_LABELS[1]!.name}`);
    expect(lines).toContain('unknown (preserved): elanous:future');
    expect(lines.some(line => line.includes('external'))).toBe(false);
  });

  test('--apply edits stale labels, creates missing ones, preserves existing and unknown', async () => {
    const unchanged = PR_LABELS[1]!;
    const { program, calls, lines } = setup([...remote, {
      name: unchanged.name, color: unchanged.color.toLowerCase(), description: unchanged.description,
    }]);
    await program.parseAsync(['labels', 'sync', '--apply'], { from: 'user' });
    expect(calls[0]).toEqual(['label', 'list', '--json', 'name,color,description', '--limit', '1000']);
    expect(calls[1]).toEqual(['label', 'edit', local.name, '--color', local.color, '--description', local.description]);
    expect(calls).toContainEqual(['label', 'create', PR_LABELS[2]!.name, '--color', PR_LABELS[2]!.color, '--description', PR_LABELS[2]!.description]);
    expect(calls).toHaveLength(PR_LABELS.length);
    expect(calls.slice(1).some(args => args.includes(unchanged.name) || args.includes('elanous:future') || args.includes('external'))).toBe(false);
    expect(lines).toContain(`unchanged: ${unchanged.name}`);
    expect(lines).toContain('unknown (preserved): elanous:future');
    expect(calls.every(args => !args.includes('delete'))).toBe(true);
  });

  test('a failed apply operation stops further writes and names the failed label', async () => {
    const calls: string[][] = [];
    const program = new Command();
    registerLabelsCommands(program, {
      gh: args => {
        calls.push(args);
        return args[1] === 'list' ? result([]) : result([], false);
      },
      out: { log: () => {}, error: () => {} },
    });
    await expect(program.parseAsync(['labels', 'sync', '--apply'], { from: 'user' }))
      .rejects.toThrow(`gh label create failed for ${local.name} (exit 1): offline`);
    expect(calls).toHaveLength(2);
  });

  test('a listing at or above the limit cannot drive sync, even without truncation metadata', async () => {
    for (const count of [1000, 1001]) {
      const labels = Array.from({ length: count }, (_, i) => ({
        name: i === count - 1 ? 'elanous:unseen-at-boundary' : `other:${i}`,
        color: 'FFFFFF', description: '',
      }));
      for (const apply of [false, true]) {
        const { program, calls, lines } = setup(labels);
        await expect(program.parseAsync(['labels', 'sync', ...(apply ? ['--apply'] : [])], { from: 'user' }))
          .rejects.toThrow('gh label list reached its limit; completeness cannot be verified; no labels were changed');
        expect(calls).toEqual([['label', 'list', '--json', 'name,color,description', '--limit', '1000']]);
        expect(lines).toEqual([]);
      }
    }
  });

  test('failed or incomplete label listing fails closed without writes', async () => {
    for (const options of [{ ok: false }, { maybeTruncated: true }]) {
      const { program, calls } = setup(remote, options);
      await expect(program.parseAsync(['labels', 'sync', '--apply'], { from: 'user' })).rejects.toThrow();
      expect(calls.every(args => args[1] === 'list')).toBe(true);
    }
    const { program, calls } = setup({ bad: true });
    await expect(program.parseAsync(['labels', 'sync', '--apply'], { from: 'user' })).rejects.toThrow('invalid labels');
    expect(calls).toHaveLength(1);
  });
});
