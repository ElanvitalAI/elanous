import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractElanousCommands } from './docs-cli-check.js';
import { LEAK_MARKERS, scanLeaks } from './public-export.js';

const root = resolve(import.meta.dir, '..');
const file = 'release/public/docs/attach-a-coding-agent-session.md';
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('seat attachment guide uses shipped commands and scopes hooks to project settings without changing permissions', () => {
  const guide = read(file);
  const commands = extractElanousCommands(file, guide);
  expect(commands.length).toBeGreaterThan(0);
  expect(scanLeaks(root, [file], LEAK_MARKERS, new Map([[file, guide]]))).toEqual([]);
  expect(guide).not.toMatch(/\b(?:OP|TC|MK|UX)\b|\/home\/|\/Users\/|\.elanous\/|(?:src|scripts)\/context-hooks\//);
  expect(commands.map(({ cmd, sub }) => [cmd, sub])).toContainEqual(['context', 'hooks']);
  expect(commands.map(({ cmd, sub }) => [cmd, sub])).toContainEqual(['context', 'day']);
  expect(guide).toContain('elanous context hooks install --print');
  expect(guide).toContain('**`--print` only prints JSON**. It does not edit your settings.');
  expect(guide).toContain('Only change this project\'s `settings.local.json` hooks.');
  expect(guide).toContain('leave any `permissions` entries exactly as they are');
  expect(guide).toContain('With no valid marker, they send **nothing**.');
  expect(guide).toContain('Codex session');
  expect(guide).toContain('explicit event is not automatic Codex hook capture');
  expect(guide).toContain('elanous context day');
  expect(guide).toContain('/.claude/seat');
  expect(guide).toContain('/.claude/settings.local.json.bak');
  expect(guide).toContain('personal global Claude Code settings');
  expect((guide.match(/^\| `elanous context day`/gm) ?? []).length).toBe(1);
  expect(read('release/public/docs/drive-from-a-coding-agent.md')).toContain('(attach-a-coding-agent-session.md)');
});
