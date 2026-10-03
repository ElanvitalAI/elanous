import { describe, expect, test } from 'bun:test';
import {
  TUI_REGRESS_CHECKS, inputRow, judgeCtrlCClearsText, judgeFirstScreen, judgeHelpShown,
  judgeHintAppearsThenClears, judgePalette, judgeQueuedEcho, paletteHas,
} from './tui-regress-checks';

const INPUT = '❯ 말 한 줄로 시작';

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
    expect(judgeHelpShown(`${rows}\n  Keys\n  Enter  Send\n${INPUT}`).ok).toBe(true);
    expect(judgeHelpShown(`${rows}\n${INPUT}`).reason).toContain('Keys');
    expect(judgeHelpShown(`  /help\n  Keys\n${INPUT}`).reason).toContain('명령 줄');
    expect(judgeHelpShown(`${rows}\n  Keys`).reason).toContain('입력칸');
  });

  test('R7 queued lines appear as my lines, each above its own answer', () => {
    expect(judgeQueuedEcho('❯ Q2MARK 라고만 답해\nQ2MARK\n❯ Q3MARK 라고만 답해\nQ3MARK').ok).toBe(true);
    expect(judgeQueuedEcho('Q2MARK\nQ3MARK').reason).toContain('Q2MARK 라고만');
    expect(judgeQueuedEcho('❯ Q2MARK 라고만 답해\n❯ Q3MARK 라고만 답해\nQ2MARK\nQ3MARK').ok).toBe(false);
  });

  test('inputRow picks the last prompt line', () => {
    expect(inputRow('❯ old\nanswer\n❯ new')).toBe('❯ new');
  });
});
