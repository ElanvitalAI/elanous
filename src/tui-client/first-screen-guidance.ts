// Source: classic TUI first-screen-band; shared cell sizing preserves its pinned output.
export function firstScreenCellWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point >= 0x1100 && (point <= 0x115f || point >= 0x2329 && point <= 0x232a
      || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3
      || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f
      || point >= 0xff01 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6
      || point >= 0x1f000 && point <= 0x1ffff)) width += 2;
    else if (point >= 0x300 && point <= 0x36f || point >= 0xfe00 && point <= 0xfe0f) continue;
    else width++;
  }
  return width;
}

export function fitFirstScreenCells(text: string, limit: number): string {
  let result = '';
  for (const char of text) {
    if (firstScreenCellWidth(result + char) > limit) break;
    result += char;
  }
  return result;
}

// Source: classic TUI first-screen-band's Korean and English action rows.
const GUIDANCE: Record<'ko' | 'en', {
  readonly actions: readonly [string, string, string];
  readonly example: string;
}> = {
  ko: {
    actions: [
      '· 대화 — 무엇이든 자연어로 물어보고 시켜보세요',
      '· 명령 — /help 로 전체 명령을 보세요',
      '· 스킬 — /run-skill <이름> 으로 설치된 스킬을 돌리세요',
    ],
    example: '바로 입력해 보세요: 무엇을 할 수 있어?',
  },
  en: {
    actions: [
      '· Chat — ask for anything in plain language',
      '· Commands — /help lists every command',
      '· Skills — /run-skill <name> runs an installed skill',
    ],
    example: 'Try typing: what can you do?',
  },
};

export function firstScreenGuidanceLines(
  locale: 'ko' | 'en',
  width: number,
  options: { includeSkills?: boolean } = {},
): string[] {
  // Select supported actions before fitting cells: a clipped command cannot
  // reliably identify the action it came from.
  const actions = options.includeSkills === false
    ? GUIDANCE[locale].actions.slice(0, 2)
    : GUIDANCE[locale].actions;
  return [...actions, GUIDANCE[locale].example]
    .map((row) => fitFirstScreenCells(row, width));
}
