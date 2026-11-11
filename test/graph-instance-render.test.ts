import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderGraphInstanceTerminal } from '../plugins/graph-instance-view/handlers/render-terminal.js';
import type { GraphInstanceView } from '../plugins/graph-instance-view/handlers/view-model.js';

function fixture(name: string): GraphInstanceView {
  return JSON.parse(readFileSync(join(import.meta.dir, '../plugins/graph-instance-view/fixtures', `${name}.view.json`), 'utf8')) as GraphInstanceView;
}

test('graph diagram shows branch and join from one shared view model', () => {
  const lines = renderGraphInstanceTerminal(fixture('graph'), 28, 28);
  expect(lines.join('\n')).toContain('├┄> Search A');
  expect(lines.join('\n')).toContain('└┄> Synthesize');
  expect(lines.join('\n')).toContain('진행');
  expect(lines.at(-1)).toContain('진행 중');
  expect(lines.every((line) => Bun.stringWidth(line) === 28)).toBe(true);
});

test('short panels keep progress, latest log and status in the bottom band', () => {
  const lines = renderGraphInstanceTerminal(fixture('harness'), 16, 5);
  expect(lines).toHaveLength(5);
  expect(lines.at(-3)).toContain('검토 대기');
  expect(lines.at(-2)).toContain('진행');
  expect(lines.at(-1)).toContain('상태');
  expect(lines.every((line) => Bun.stringWidth(line) === 16)).toBe(true);
});

test('three-row panel keeps the progress and status rows when logs have no space', () => {
  const lines = renderGraphInstanceTerminal(fixture('harness'), 16, 3);
  expect(lines).toHaveLength(3);
  expect(lines.join('\n')).not.toContain('로그 │');
  expect(lines.at(-2)).toContain('진행');
  expect(lines.at(-1)).toContain('상태');
});

test('release failure and selected node stay visible without overflowing the panel', () => {
  const lines = renderGraphInstanceTerminal(fixture('release'), 20, 9, 'gate');
  expect(lines.join('\n')).toContain('Gate');
  expect(lines.at(-1)).toContain('게이트 실패');
  expect(lines.length).toBe(9);
});

test('resource view shows power, load, memory and work on the selected host', () => {
  const view = fixture('resource');
  const lines = renderGraphInstanceTerminal(view, 28, 18, 'aws1');
  expect(lines[0]).toBe('┌──────────────────────────┐');
  expect(lines.join('\n')).toContain('● aws1 · cloud');
  expect(lines.join('\n')).toContain('CPU █░░░░ 2.5');
  expect(lines.join('\n')).toContain('MEM ██░░░ 50%');
  expect(lines.join('\n')).toContain('review:Terra review');
  expect(lines.at(-2)).toContain('가동');
  expect(lines.at(-1)).toContain('fixture');
  expect(lines.every((line) => Bun.stringWidth(line) === 28)).toBe(true);
});
