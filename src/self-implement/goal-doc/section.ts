interface GoalDocSection {
  readonly start: number;
  readonly end: number;
  readonly body: string;
  readonly heading?: string;
}

export interface GoalDocSourceLine {
  readonly text: string;
  readonly start: number;
}

/** Parse the command on a goal's authored decision-signal Condition line. */
function authoredSignalCommandFromCondition(condition: string | undefined): string | undefined {
  if (!condition?.trim()) return undefined;
  return condition.trim()
    .replace(/^`([^`]+)`(?=\s|를|$)/, '$1')
    .replace(/\s*를\s*실행한다[.。]?$/, '')
    .replace(/[.。]$/, '')
    .trim();
}

export function authoredSignalCommandFromBody(value: string): string | undefined {
  return authoredSignalCommandFromCondition(value.match(/^\s*- Condition:\s*(.+?)\s*$/m)?.[1]);
}

export function authoredSignalCommandFromGoal(goal: string): string | undefined {
  const lines = goal.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## 판정 신호');
  if (start < 0) return undefined;
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return authoredSignalCommandFromBody(lines.slice(start + 1, next < 0 ? lines.length : next).join('\n'));
}

type GoalDocSectionOptions =
  | {
    readonly search: 'exact-trimmed-line';
    readonly heading: string;
    readonly lines: (document: string) => readonly GoalDocSourceLine[];
    readonly endHeading: RegExp;
    readonly trimBody?: boolean;
  }
  | {
    readonly search: 'substring';
    readonly heading: string;
    readonly endHeading: string;
    readonly trimBody?: boolean;
  }
  | {
    readonly search: 'heading-regexp';
    readonly heading: RegExp;
    readonly endHeading: RegExp;
    readonly includePreamble?: boolean;
    readonly trimBody?: boolean;
  };

interface SourceLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function body(value: string, trim: boolean | undefined): string {
  return trim ? value.trim() : value;
}

/**
 * ⛔⭐⭐⭐ 줄 목록은 `document.split(/\r?\n/)` 와 **정확히 같아야 한다** — 종전 판은 `matchAll` 로
 *   훑으며 «빈 매치를 건너뛰어» 문서 끝의 빈 줄을 잃었다. 그래서 `'## A\nbody\n'` 의 본문이
 *   `"body\n"` 에서 `"body"` 로 «바뀌었다»(무인 리뷰 must-fix · 2026-08-04).
 *   ⇒ 구분자를 «캡처»해 split 하면 줄 목록은 원본과 동일하고 오프셋도 정확하다(`\r\n` 안전).
 */
function logicalLines(document: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const parts = document.split(/(\r?\n)/);
  let start = 0;
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index] ?? '';
    lines.push({ text, start, end: start + text.length });
    start += text.length + (parts[index + 1]?.length ?? 0);
  }
  return lines;
}

function regexpMatch(pattern: RegExp, line: string): RegExpExecArray | null {
  pattern.lastIndex = 0;
  return pattern.exec(line);
}

/** Extract goal-document section bodies with the caller's explicit legacy matching and boundary rules. */
export function extractGoalDocSections(document: string, options: GoalDocSectionOptions): GoalDocSection[] {
  if (options.search === 'exact-trimmed-line') {
    const selected = [...options.lines(document)];
    const headingIndex = selected.findIndex((line) => line.text.trim() === options.heading);
    if (headingIndex < 0) return [];

    const boundaryOffset = selected
      .slice(headingIndex + 1)
      .findIndex((line) => regexpMatch(options.endHeading, line.text) !== null);
    const boundaryIndex = boundaryOffset < 0 ? selected.length : headingIndex + 1 + boundaryOffset;
    const start = selected[headingIndex]!.start;
    const end = selected[boundaryIndex]?.start ?? document.length;
    return [{
      start,
      end,
      heading: options.heading,
      body: body(selected.slice(headingIndex + 1, boundaryIndex).map((line) => line.text).join('\n'), options.trimBody),
    }];
  }

  if (options.search === 'substring') {
    const start = document.indexOf(options.heading);
    if (start < 0) return [];
    const bodyStart = start + options.heading.length;
    const next = document.indexOf(options.endHeading, bodyStart);
    const end = next < 0 ? document.length : next;
    return [{ start, end, body: body(document.slice(bodyStart, end), options.trimBody), heading: options.heading }];
  }

  const headings: Array<{ start: number; end: number; text: string }> = [];
  const boundaries: number[] = [];
  for (const line of logicalLines(document)) {
    if (regexpMatch(options.endHeading, line.text) !== null) boundaries.push(line.start);
    const match = regexpMatch(options.heading, line.text);
    if (match !== null) headings.push({ start: line.start, end: line.end, text: match[1] ?? match[0] });
  }

  const sections: GoalDocSection[] = [];
  if (options.includePreamble && headings.length === 0) {
    sections.push({ start: 0, end: document.length, body: body(document, options.trimBody) });
  } else if (options.includePreamble && headings[0]!.start > 0) {
    sections.push({ start: 0, end: headings[0]!.start, body: body(document.slice(0, headings[0]!.start), options.trimBody) });
  }
  for (const heading of headings) {
    const end = boundaries.find((boundary) => boundary > heading.start) ?? document.length;
    sections.push({ start: heading.start, end, body: body(document.slice(heading.end, end), options.trimBody), heading: heading.text });
  }
  return sections;
}
