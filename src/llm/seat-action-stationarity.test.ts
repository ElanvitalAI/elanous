// SEAT-TURN-FOLLOWUPS ① — action stationarity: 8 identical consecutive calls → nudge · 12 → stop. Independent literals.
import { describe, expect, test } from 'bun:test';
import { createStationarityTracker, normalizeToolArgs, toolFreshnessToken, stationarityNudgeNote, stationaritySummaryPrompt, SEAT_REPEAT_NUDGE_AT, SEAT_REPEAT_STOP_AT } from './seat-action-stationarity.js';

describe('seat action stationarity', () => {
  test('thresholds are 8 and 12 (grok-build action stationarity)', () => {
    expect(SEAT_REPEAT_NUDGE_AT).toBe(8);
    expect(SEAT_REPEAT_STOP_AT).toBe(12);
  });
  test('12 identical calls: ok ×7 · nudge at 8 · ok ×3 · stop at 12', () => {
    const t = createStationarityTracker();
    const verdicts = Array.from({ length: 12 }, () => t.record('Bash', { command: 'eln seat pool' }));
    expect(verdicts).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'nudge', 'ok', 'ok', 'ok', 'stop']);
    expect(t.run).toBe(12);
    expect(t.lastTool).toBe('Bash');
  });
  test('a different call resets the run · same tool with other args is not identical', () => {
    const t = createStationarityTracker();
    for (let i = 0; i < 7; i += 1) t.record('Bash', { command: 'eln seat pool' });
    expect(t.record('Bash', { command: 'eln msg list --to OP' })).toBe('ok');
    expect(t.run).toBe(1);
    for (let i = 0; i < 6; i += 1) t.record('Bash', { command: 'eln seat pool' });
    expect(t.run).toBe(6);
  });
  test('normalized args: key order · surrounding/inner whitespace · null fields do not make a call different', () => {
    expect(normalizeToolArgs({ b: 1, a: '  eln   seat pool ', c: null })).toBe('{"a":"eln seat pool","b":1}');
    const t = createStationarityTracker(2, 3);
    expect(t.record('Bash', { command: 'eln seat pool', mode: 'json' })).toBe('ok');
    expect(t.record('Bash', { mode: 'json', command: 'eln  seat pool ' })).toBe('nudge');
    expect(t.record('Bash', { command: 'eln seat pool', mode: 'json', cwd: undefined })).toBe('stop');
  });
  test('the note names the tool and asks for a change or a summary · the stop prompt asks for done / remaining / next with tools off', () => {
    expect(stationarityNudgeNote('Bash', 8)).toContain('You are repeating Bash with identical arguments (8 calls in a row)');
    expect(stationarityNudgeNote('Bash', 8)).toContain('done / remaining / next');
    const prompt = stationaritySummaryPrompt('Bash', 12);
    expect(prompt.startsWith('Tools are off for this step')).toBe(true);
    for (const part of ['Done:', 'Remaining:', 'Next:']) expect(prompt).toContain(part);
  });
});

describe('H5 — freshness: re-reading a file that changed is not identical', () => {
  test('Read/ListDir carry mtime:size of the target · other tools and stat failures carry nothing', () => {
    const stamp = 1764054000123.7;
    const bytes = 42;
    const stat = (path: string) => { if (path === 'notes.md') return { mtimeMs: stamp, size: bytes }; throw new Error('ENOENT'); };
    expect(toolFreshnessToken('Read', { file_path: 'notes.md' }, stat)).toBe('1764054000123:42');
    expect(toolFreshnessToken('ListDir', { path: 'notes.md' }, stat)).toBe('1764054000123:42');
    expect(toolFreshnessToken('Read', { file_path: 'missing.md' }, stat)).toBe('');
    expect(toolFreshnessToken('Bash', { command: 'cat notes.md' }, stat)).toBe('');
  });
  test('same args with a different freshness token reset the run', () => {
    const t = createStationarityTracker();
    for (let i = 0; i < 7; i += 1) t.record('Read', { file_path: 'notes.md' }, 'a:1');
    expect(t.record('Read', { file_path: 'notes.md' }, 'b:2')).toBe('ok');
    expect(t.run).toBe(1);
  });
});
