import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runUxPackScenario, UX_PACK_SCENARIOS, UX_PACK_SLASH_COMMANDS, uxPackSummary } from './next-tui-ux-pack.js';
import { NEXT_TUI_ROUTE_REGISTRY } from '../tui/core/registry.js';

const scenario = (id: string) => UX_PACK_SCENARIOS.find((candidate) => candidate.id === id)!;
const judge = (id: string, judgeId: string) => scenario(id).judges.find((candidate) => candidate.id === judgeId)!;
const context = { cols: 60, frames: [] as string[] };

test('every requested scenario exists and declares at least one judge', () => {
  expect(UX_PACK_SCENARIOS.map((candidate) => candidate.id)).toEqual([
    'tool-burst', 'markdown-blocks', 'speaker-labels', 'input-history', 'user-turn-color', 'user-turn-no-color', 'paste-atomic', 'self-proactive-ko', 'self-proactive-en', 'worked-for', 'provider-picker', 'slash-sweep', 'long-turn-steer', 'burst-revise', 'working-row', 'graph-live', 'narrow-panel']);
  expect(UX_PACK_SCENARIOS.every((candidate) => candidate.judges.length > 0)).toBe(true);
  // The sweep is drawn from the product registry, so a new read-only command joins without editing the pack.
  const registered = new Set(NEXT_TUI_ROUTE_REGISTRY.flatMap((route) => route.slash));
  expect(UX_PACK_SLASH_COMMANDS.every((command) => registered.has(command))).toBe(true);
  expect(UX_PACK_SLASH_COMMANDS).not.toContain('/quit');
});

test('judges read rendered frames, not product internals', () => {
  const speaker = judge('speaker-labels', 'no-korean-speaker-labels');
  expect(speaker.check('나: 질문\n엘라누스: 답', context)).toBe(false);
  expect(speaker.check('› 질문\n답', context)).toBe(true);
  const indent = judge('markdown-blocks', 'bullet-hanging-indent');
  expect(indent.check('- UXPACK-LONG-BULLET-START 감긴\n  다음 줄', context)).toBe(true);
  expect(indent.check('- UXPACK-LONG-BULLET-START 감긴\n다음 줄', context)).toBe(false);
  expect(indent.check('- UXPACK-LONG-BULLET-START 감긴\n  - 새 불릿', context)).toBe(false);
  const folded = judge('tool-burst', 'tool-rows-folded');
  expect(folded.check('✓ Read ×5 · last a.txt\n✓ Bash(printf)\n✓ Read ×5 · last b.txt', context)).toBe(true);
  expect(folded.check('no tool rows at all', context)).toBe(false);
  expect(folded.check(Array.from({ length: 11 }, (_, index) => `활동 · Read · f${index}.txt · 완료`).join('\n'), context)).toBe(false);
  const resubmit = judge('burst-revise', 'esc-resubmits-queued');
  const sends = ['UXPACK-B1', 'UXPACK-B2', 'UXPACK-B3', 'UXPACK-B4', 'UXPACK-B5'];
  expect(resubmit.check(['❯ ' + sends[0], ...sends.slice(1).map((send) => '  ' + send)].join('\n'), context)).toBe(false);
  expect(resubmit.check([...sends.map((send) => '> ' + send), 'Turn idle · Queue 0', '❯ '].join('\n'), context)).toBe(true);
  const overflow = judge('narrow-panel', 'no-overflow');
  expect(overflow.check('가'.repeat(context.cols / 2), context)).toBe(true);
  expect(overflow.check('가'.repeat(context.cols), context)).toBe(false);
});

test('one real PTY scenario writes frames, raw bytes and a summary row', async () => {
  const out = mkdtempSync(join(tmpdir(), 'uxpack-test-'));
  try {
    const result = await runUxPackScenario({ scenario: scenario('speaker-labels'), cols: 100, rows: 30, outDir: out,
      repoRoot: resolve(import.meta.dir, '..', '..') });
    expect(result.error).toBeUndefined();
    expect(readFileSync(result.textPath, 'utf8')).toContain('UXPACK-SPEAKER-DONE');
    expect(existsSync(result.ansiPath)).toBe(true);
    expect(uxPackSummary([result], '# t')).toContain('| speaker-labels | next | 100 |');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 90_000);

test('working-row judges read the rendered progress row and its absence after the turn', () => {
  const running = '> UXPACK-WROW-SLOW\n⠇ Thinking (2s • esc to interrupt)\nTurn running\n❯ ';
  const settled = '> UXPACK-WROW-SLOW\nUXPACK-WROW-DONE\n✻ Worked for 6s · done 1:00 AM\n❯ ';
  expect(judge('working-row', 'row-while-running').check(settled, { cols: 60, frames: [running, settled] })).toBe(true);
  expect(judge('working-row', 'row-while-running').check(settled, { cols: 60, frames: [settled] })).toBe(false);
  expect(judge('working-row', 'row-above-prompt').check(settled, { cols: 60, frames: [running] })).toBe(true);
  expect(judge('working-row', 'row-above-prompt').check(settled, { cols: 60, frames: ['⠇ Thinking (2s • esc to interrupt)\n> UXPACK-WROW-SLOW\n❯ '] })).toBe(false);
  expect(judge('working-row', 'row-gone-after-turn').check(settled, context)).toBe(true);
  expect(judge('working-row', 'row-gone-after-turn').check(running, context)).toBe(false);
  expect(judge('working-row', 'row-fits-width').check(settled, { cols: 10, frames: [running] })).toBe(false);
  expect(judge('working-row', 'row-fits-width').check(settled, { cols: 60, frames: [running] })).toBe(true);
});
