import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  TUI_REGRESS_CHECKS, contentLines, inputRow, judgeCtrlCClearsText, judgeFirstScreen, judgeHelpShown,
  judgeHintAppearsThenClears, judgePalette, judgeQueuedEcho, paletteHas,
} from './tui-regress-checks';

const INPUT = '❯';
const fixture = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures', 'tui-regress', name), 'utf8');

describe('V1 TUI regression verdicts (screen text only)', () => {
  test('seven checks R1–R7 in order', () => {
    expect(TUI_REGRESS_CHECKS.map((c) => c.id)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7']);
  });

  test('R1 first screen: prompt and no wizard', () => {
    expect(judgeFirstScreen(`elanous\n${INPUT}\nstatus`).ok).toBe(true);
    expect(judgeFirstScreen(`Step 1/7 · LLM\n${INPUT}`).ok).toBe(false);
    expect(judgeFirstScreen('elanous | daemon: offline').ok).toBe(false);
  });

  test('R2 hint shows, then clears after 2s', () => {
    expect(judgeHintAppearsThenClears(`  한 번 더 누르면 나갑니다 · /quit\n${INPUT}`, INPUT).ok).toBe(true);
    expect(judgeHintAppearsThenClears(INPUT, INPUT).reason).toContain('안 보인다');
    expect(judgeHintAppearsThenClears('한 번 더 누르면 나갑니다', '한 번 더 누르면 나갑니다').reason).toContain('남아');
  });

  test('R3 Ctrl+C with text clears the input row and shows no exit hint', () => {
    expect(judgeCtrlCClearsText('❯ regress-abc', INPUT, 'regress-abc').ok).toBe(true);
    expect(judgeCtrlCClearsText('❯ regress-abc', '❯ regress-abc', 'regress-abc').ok).toBe(false);
    expect(judgeCtrlCClearsText('❯ regress-abc', `한 번 더 누르면 나갑니다\n${INPUT}`, 'regress-abc').ok).toBe(false);
    // the echoed text elsewhere on screen does not count as «still in the input»
    expect(judgeCtrlCClearsText('❯ regress-abc', `you: regress-abc\n${INPUT}`, 'regress-abc').ok).toBe(true);
  });

  test('R4/R5 palette: the typed prefix on the input row is not a palette entry', () => {
    const shown = '  /directive   대표 지시\n❯ /dir';
    const hidden = '  (일치하는 명령 없음)\n❯ /dir';
    expect(paletteHas(shown, 'directive')).toBe(true);
    expect(paletteHas(hidden, 'directive')).toBe(false);
    expect(paletteHas('❯ /directive', 'directive')).toBe(false);
    expect(judgePalette({ directive: shown, help: '  /help\n❯ /hel' }, { directive: true, help: true }).ok).toBe(true);
    expect(judgePalette({ directive: hidden, help: '  /help\n❯ /hel' }, { directive: false, help: true }).ok).toBe(true);
    expect(judgePalette({ directive: shown, help: '  /help\n❯ /hel' }, { directive: false, help: true }).ok).toBe(false);
    expect(judgePalette({ help: '  /help\n❯ /hel' }, { directive: true }).ok).toBe(false);
  });

  test('R6 /help drawn: Keys section, 10+ command rows, prompt kept', () => {
    const rows = Array.from({ length: 12 }, (_, i) => `  /cmd${String.fromCharCode(97 + i)}  설명`).join('\n');
    expect(judgeHelpShown(`Commands\n${rows}\n  Keys\n  Enter  Send\n${INPUT}`).ok).toBe(true);
    expect(judgeHelpShown(`Commands\n${rows}\n${INPUT}`).reason).toContain('Keys');
    expect(judgeHelpShown(`Commands\n  /help\n  Keys\n${INPUT}`).reason).toContain('명령 줄');
    expect(judgeHelpShown(`Commands\n${rows}\n  Keys`).reason).toContain('입력칸');
  });

  test('R7 queued lines appear as my lines, each above its own answer', () => {
    expect(judgeQueuedEcho('❯ Q2MARK 라고만 답해\nQ2MARK\n❯ Q3MARK 라고만 답해\nQ3MARK').ok).toBe(true);
    expect(judgeQueuedEcho('Q2MARK\nQ3MARK').reason).toContain('Q2MARK 라고만');
    expect(judgeQueuedEcho('❯ Q2MARK 라고만 답해\n❯ Q3MARK 라고만 답해\nQ2MARK\nQ3MARK').ok).toBe(false);
  });

  test('inputRow picks the last prompt line', () => {
    expect(inputRow('❯ old\nanswer\n❯ new')).toBe('❯ new');
    expect(inputRow('elanous | daemon: offline')).toBeUndefined();
  });
});

describe('R6 /help fixture screens — 2026-10-29 captures (border panels)', () => {
  test("today's real border-panel screens pass", () => {
    expect(judgeHelpShown(fixture('help-live.txt')).ok).toBe(true);
    expect(judgeHelpShown(fixture('help-original.txt')).ok).toBe(true);
  });

  test('defect — no Keys section: still fails', () => {
    const verdict = judgeHelpShown(fixture('help-missing-keys.txt'));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('Keys');
  });

  test('defect — input row pushed off the screen: still fails', () => {
    const verdict = judgeHelpShown(fixture('help-shifted-input.txt'));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('입력칸');
  });

  test('defect — too few command rows: still fails', () => {
    const verdict = judgeHelpShown(fixture('help-insufficient-commands.txt'));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('명령 줄');
  });
});

describe('border-agnostic judging — every judge reads content lines, not borders', () => {
  test('contentLines peels side borders and drops frame-only lines', () => {
    expect(contentLines('┌────┐\n│Keys│\n└────┘\n')).toEqual([' Keys ']);
    expect(contentLines('│  /help  목록  │\nplain')).toEqual(['   /help  목록   ', 'plain']);
    expect(contentLines('█▀▄░▒▓▌▐')).toEqual([]);
  });

  test('inputRow finds the prompt inside a bordered composer', () => {
    expect((inputRow('│ ❯ /help │') ?? '').trim()).toBe('❯ /help');
  });

  test('R1 first screen: a border frame is not a defect', () => {
    expect(judgeFirstScreen('┌──────┐\n│ ❯    │\n└──────┘').ok).toBe(true);
    expect(judgeFirstScreen('│ Step 1/7 · LLM │\n❯').ok).toBe(false);
  });

  test('R2 hint: the hint inside a bordered line still shows, then clears', () => {
    expect(judgeHintAppearsThenClears(`│ 한 번 더 누르면 나갑니다 · /quit │\n${INPUT}`, INPUT).ok).toBe(true);
    expect(judgeHintAppearsThenClears('│ 한 번 더 누르면 나갑니다 │', '│ 한 번 더 누르면 나갑니다 │').reason).toContain('남아');
  });

  test('R3 Ctrl+C clearing: bordered input rows still distinguish cleared from retained text', () => {
    expect(judgeCtrlCClearsText('│❯ regress-abc│', '│❯│', 'regress-abc').ok).toBe(true);
    expect(judgeCtrlCClearsText('│❯ regress-abc│', '│❯ regress-abc│', 'regress-abc').ok).toBe(false);
  });

  test('R4/R5 palette: entries inside a bordered panel are still seen', () => {
    expect(paletteHas('│ /directive   대표 지시 │\n❯ /dir', 'directive')).toBe(true);
    expect(paletteHas('│ (일치하는 명령 없음) │\n❯ /dir', 'directive')).toBe(false);
  });

  test('R7 queued echo: bordered transcript lines keep their order', () => {
    expect(judgeQueuedEcho('│ ❯ Q2MARK 라고만 답해 │\n│ Q2MARK │\n│ ❯ Q3MARK 라고만 답해 │\n│ Q3MARK │').ok).toBe(true);
  });
});
