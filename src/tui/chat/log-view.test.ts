import { expect, test } from 'bun:test';
import chalk from 'chalk';
import type { SerializedMessage } from '../../session/index.js';
import { TOOL_FOLD_LINE_LIMIT, fitLogLine, isToolFoldToggleKey, logViewLines, safeLogText, safeStatusText, streamReplyLines, toggleVisibleToolFold, toolFoldBlockRanges, toolFoldBlockStarts, toolFoldSummary, wheelScroll, wrapLogLines, WHEEL_SCROLL_LINES } from './log-view.js';

test('rebase keeps the main attachment-area multiline export', () => {
  expect(wrapLogLines('앞 장면 영수증', 5).join('').replace(/\s/g, '')).toContain('영수증');
});

test('history renders user and assistant text within terminal width without stored control codes', () => {
  const messages: SerializedMessage[] = [
    { role: 'system', content: 'hidden system prompt', ts: '2026-10-20T00:00:00Z' },
    { role: 'user', content: '가나다라마바\x1b[31mRED\x1b[0m\x1b]0;evil\x07', ts: '2026-10-20T00:00:01Z' },
    { role: 'assistant', content: '답변\n둘째 줄', ts: '2026-10-20T00:00:02Z' },
  ];
  const lines = logViewLines(messages, 12);
  expect(lines.join('\n')).toContain('가나다라');
  expect(lines.join('').replace(/\x1b\[[0-?]*[ -/]*m/g, '')).toContain('답변');
  expect(lines.join('\n')).not.toContain('hidden system prompt');
  expect(lines.join('\n')).not.toContain('\x1b[31m'); // stored control codes do not survive sanitization
  expect(lines.join('\n')).not.toContain('\x1b[2J');
  expect(lines.join('\n')).not.toContain('\x1b]');
  expect(lines.join('\n')).not.toContain('0;evil');
  expect(lines.every((line) => Bun.stringWidth(line) <= 12)).toBe(true);
  expect(safeLogText('title\x1b[2J')).toBe('title');
  expect(Bun.stringWidth(fitLogLine('긴 제목 가나다라마바사', 12))).toBeLessThanOrEqual(12);
});

test('resumed classic dashboard context renders only its question in Next history', () => {
  const classicUser = 'Context:\nDashboard mode: browse\n\nRecent status output:\n  ✓ resumed local session: a1b2c3d4\n  ⚠ plugin warning\n\nQuestion: 이어쓰기 1 classic 질문';
  const lines = logViewLines([{ role: 'user', content: classicUser, ts: '2026-11-12T00:00:00Z' }], 110).join('\n');
  expect(lines).toContain('나: 이어쓰기 1 classic 질문');
  expect(lines).not.toContain('나: Context:');
  expect(lines).not.toContain('Dashboard mode: browse');
  expect(lines).not.toContain('plugin warning');
  expect(classicUser).toContain('Recent status output:'); // stored history stays intact
});

test('ordinary user-authored Context prose and similar headings stay visible', () => {
  const ordinary = 'Context: This is my own note.\nDashboard mode: browse\n\nQuestion: keep this whole message';
  const nearMiss = 'Context:\nDashboard mode: browse\n\nQuestion: keep this whole message too';
  const quotedStatus = 'Context:\nDashboard mode: browse\n\nRecent status output:\nmy own notes\n\nQuestion: keep this whole message and mention ✓ resumed local session: abc123';
  for (const content of [ordinary, nearMiss, quotedStatus]) {
    const lines = logViewLines([{ role: 'user', content, ts: '2026-11-12T00:00:00Z' }], 110).join('\n');
    expect(lines).toContain('나: Context:');
    expect(lines).toContain('Question: keep this whole message');
  }
});

test('resumed classic question keeps later Question headings in the actual user text', () => {
  const classicUser = 'Context:\nDashboard mode: browse\n\nRecent status output:\n  ✓ resumed local session: a1b2c3d4\n\nQuestion: 첫 문단\n\nQuestion: 두 번째 문단';
  const lines = logViewLines([{ role: 'user', content: classicUser, ts: '2026-11-12T00:00:00Z' }], 110).join('\n');
  expect(lines).toContain('나: 첫 문단');
  expect(lines).toContain('Question: 두 번째 문단');
  expect(lines).not.toContain('Dashboard mode: browse');
});

test('assistant history reuses classic markdown rendering after sanitizing raw terminal codes', () => {
  const lines = logViewLines([
    { role: 'assistant', content: '# Heading\n\n**bold** and `code`\n\n- item\n\n\x1b[2Jsafe', ts: '2026-11-10T00:00:00Z' },
  ], 80);
  const text = lines.join('\n');
  expect(text).toContain('Heading');
  expect(text).toContain('bold');
  expect(text).toContain('code');
  expect(text).toContain('- item');
  expect(text).toContain('safe');
  expect(text).not.toContain('# Heading');
  expect(text).not.toContain('**bold**');
  expect(text).not.toContain('`code`');
  expect(text).not.toContain('\x1b[2J');
  expect(lines.every((line) => Bun.stringWidth(line) <= 80)).toBe(true);
});

test('assistant Markdown styles continue across wrapped PTY lines', () => {
  const priorColorLevel = chalk.level;
  chalk.level = 1;
  try {
    const lines = logViewLines([
      { role: 'assistant', content: '**abcdefghijklmnopqrstuvwxyz1234**', ts: '2026-11-10T00:00:00Z' },
    ], 18);
    const boldLines = lines.filter((line) => line.includes('\x1b[1m'));
    // Source: .rules/30-harness/testing-gates.md — wrapping must yield a continuation to exercise SGR replay.
    expect(boldLines.length).toBeGreaterThan(1);
    expect(lines.every((line) => Bun.stringWidth(line) <= 18)).toBe(true);
  } finally {
    chalk.level = priorColorLevel;
  }
});

test('live reply preview uses the same Markdown renderer and wrapping as saved assistant text', () => {
  const priorColorLevel = chalk.level;
  chalk.level = 1;
  try {
    // Source: .rules/30-harness/testing-gates.md — compare streaming and persisted rendering at one PTY width.
    const columns = 24;
    const content = '# Live title\n\n**bold text that intentionally crosses the PTY width boundary** and `code`\n\n- item\n\n\x1b[2Jsafe';
    const savedLines = logViewLines([
      { role: 'assistant', content, ts: '2026-11-10T00:00:00Z' },
    ], columns);
    savedLines.pop();

    const liveLines = streamReplyLines(content, columns);
    expect(liveLines).toEqual(savedLines);
    const styledLines = liveLines.filter((line) => line.includes('\x1b[1m'));
    const lastStyledLine = styledLines.pop();
    const previousStyledLine = styledLines.pop();
    expect(previousStyledLine).toContain('\x1b[1m');
    expect(lastStyledLine).toContain('\x1b[1m');
    expect(liveLines.join('\n')).not.toContain('# Live title');
    expect(liveLines.join('\n')).not.toContain('**bold**');
    expect(liveLines.join('\n')).not.toContain('`code`');
    expect(liveLines.join('\n')).not.toContain('\x1b[2J');
    expect(liveLines.every((line) => Bun.stringWidth(line) <= columns)).toBe(true);
  } finally {
    chalk.level = priorColorLevel;
  }
});

test('empty history clearly marks the first slice as read only', () => {
  expect(logViewLines([], 20)).toEqual(['대화 기록 없음']);
});

test('tool execution and its result appear in the bounded conversation view', () => {
  const lines = logViewLines([{
    role: 'tool', content: '⚙️ Bash', toolName: 'Bash', toolResult: 'mail list rc=0\n2 messages', ts: '2026-10-20T00:00:00Z',
  }], 20);
  expect(lines.join('\n')).toContain('도구: Bash');
  expect(lines.join('\n')).toContain('2 messages');
  expect(lines.every((line) => Bun.stringWidth(line) <= 20)).toBe(true);
});

test('terminal codes cannot divide a stored secret before redaction', () => {
  const token = `sk-or-v1-${'d'.repeat(64)}`;
  const stored = `${token.slice(0, 14)}\x1b[31m${token.slice(14)}`;
  const visible = safeLogText(stored);
  expect(visible).not.toContain(token);
  expect(visible).toContain('sk-or-v1-***');
});

test('OSC title terminators preserve following conversation text', () => {
  expect(safeLogText('\x1b]0;title\x1b\\첫 답변')).toBe('첫 답변');
  expect(safeLogText('\x1b]0;title\x07첫 답변')).toBe('첫 답변');
});

test('untrusted error text cannot move the status line', () => {
  expect(safeStatusText('실패\x1b[2J\n다음 줄')).toBe('실패 다음 줄');
});

test('live reply preview keeps first text visible, wraps and strips terminal controls', () => {
  const lines = streamReplyLines('첫 토큰과 이어지는 문장\n\x1b[2J둘째 줄', 12);
  expect(lines[0]).toContain('엘라누스:');
  expect(lines[0]).toContain('첫');
  expect(lines.join('\n')).toContain('토큰');
  expect(lines.join('\n')).toContain('둘째 줄');
  expect(lines.join('\n')).not.toContain('\x1b');
  expect(lines.every((line) => Bun.stringWidth(line) <= 12)).toBe(true);
});

test('chat wraps at word boundaries and indents continuation rows', () => {
  const user = logViewLines([{ role: 'user', content: 'alpha beta gamma delta', ts: '2026-11-10T00:00:00Z' }], 14);
  expect(user.slice(0, 2)).toEqual(['나: alpha beta', '  gamma delta']);
  expect(streamReplyLines('foo bar baz quux', 14)).toEqual(['엘라누스: foo ', '  bar baz quux']);
  const longWord = logViewLines([{ role: 'user', content: 'supercalifragilistic', ts: '2026-11-10T00:00:00Z' }], 10);
  expect(longWord.every((line) => Bun.stringWidth(line) <= 10)).toBe(true);
  expect(longWord.slice(1, -1).every((line) => line.startsWith('  '))).toBe(true);
});

test('narrow chat preserves wide graphemes by shrinking continuation indent', () => {
  const lines = logViewLines([{ role: 'user', content: '한글 👩‍💻', ts: '2026-11-10T00:00:00Z' }], 3);
  const visible = lines.join('');
  expect(visible).toContain('한');
  expect(visible).toContain('글');
  expect(visible).toContain('👩‍💻');
  expect(lines.every(line => Bun.stringWidth(line) <= 3)).toBe(true);
});

test('SGR in the middle of a word keeps the whole word together', () => {
  const previousLevel = chalk.level;
  chalk.level = 1;
  try {
    const lines = logViewLines([{ role: 'assistant', content: 'ab**cd** ef', ts: '2026-11-10T00:00:00Z' }], 12);
    const plain = lines.map(line => line.replace(/\x1b\[[0-?]*[ -/]*m/g, ''));
    expect(plain[0]).toBe('엘라누스: ');
    expect(plain[1]).toContain('abcd');
    expect(lines[1]).toContain('\x1b[1m');
    expect(lines.every(line => Bun.stringWidth(line) <= 12)).toBe(true);
  } finally {
    chalk.level = previousLevel;
  }
});

test('wheel scrolls the log a few lines per notch and keeps following the bottom', () => {
  // scroll = lines above the bottom; 0 means "follow the newest line".
  expect(WHEEL_SCROLL_LINES).toBe(3);
  expect(wheelScroll(0, 'up', 50)).toBe(3);
  expect(wheelScroll(3, 'up', 50)).toBe(6);
  expect(wheelScroll(48, 'up', 50)).toBe(50);
  expect(wheelScroll(6, 'down', 50)).toBe(3);
  expect(wheelScroll(2, 'down', 50)).toBe(0);
  expect(wheelScroll(0, 'down', 50)).toBe(0);
  // A history shorter than the body has nothing to scroll.
  expect(wheelScroll(0, 'up', 0)).toBe(0);
  expect(wheelScroll(0, 'up', -4)).toBe(0);
});

test('long tool output collapses to one summary line and expands on toggle', () => {
  const result30 = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
  const toolMessage: SerializedMessage = {
    role: 'tool', content: '⚙️ Bash', toolName: 'Bash', toolResult: result30, ts: '2026-10-20T00:00:00Z',
  };
  const collapsed = logViewLines([toolMessage], 40);
  // 30 wrapped lines + blank = 31 without folding; folding must shrink it to 2.
  expect(collapsed.length).toBe(2);
  expect(collapsed[0]).toBe('▸ 도구 Bash · 30줄 (접힘)');
  expect(collapsed.join('\n')).not.toContain('line-12');
  // Toggle by the collapsed block's start line index expands it fully.
  const expanded = logViewLines([toolMessage], 40, new Set([0]));
  expect(expanded.length).toBe(31);
  expect(expanded.join('\n')).toContain('line-12');
  // Short tool output (≤ limit) stays unfolded with or without a toggle set.
  const short: SerializedMessage = {
    role: 'tool', content: '⚙️ ls', toolName: 'ls', toolResult: 'a\nb\nc', ts: '2026-10-20T00:00:01Z',
  };
  expect(logViewLines([short], 40).join('\n')).toContain('도구: ls');
  // A still-running tool block (no result yet) never folds.
  const running: SerializedMessage = {
    role: 'tool', content: '⚙️ Bash', toolName: 'Bash', ts: '2026-10-20T00:00:02Z',
  };
  const runningLines = logViewLines([running], 40);
  expect(runningLines.join('\n')).toContain('도구: Bash');
  expect(runningLines.join('\n')).not.toContain('접힘');
  // Long assistant answers are out of scope for folding in this shard.
  const answer: SerializedMessage = {
    role: 'assistant', content: Array.from({ length: 30 }, (_, i) => `ans-${i}`).join('\n'), ts: '2026-10-20T00:00:03Z',
  };
  const answerLines = logViewLines([answer], 40);
  expect(answerLines.length).toBeGreaterThan(TOOL_FOLD_LINE_LIMIT);
  expect(answerLines.join('\n')).toContain('ans-12');
  expect(toolFoldSummary('Bash', 30)).toContain('Bash');
  // Toggle targets come from toolFoldBlockStarts, keyed by message index.
  expect(toolFoldBlockStarts([toolMessage], 40)).toEqual([0]);
  expect(toolFoldBlockStarts([short, running], 40)).toEqual([]);
});

test('tool path strips ANSI and OSC control bytes in folded and expanded views', () => {
  const dirty = `\x1b[2Kx\n${Array.from({ length: 29 }, (_, i) => `line-${i}`).join('\n')}\x1b]0;evil\x07`;
  const toolMessage: SerializedMessage = {
    role: 'tool', content: '⚙️ Bash', toolName: '\x1b[31mBash\x1b[0m', toolResult: dirty, ts: '2026-10-20T00:00:00Z',
  };
  const collapsed = logViewLines([toolMessage], 40);
  expect(collapsed.length).toBe(2);
  expect(collapsed.join('\n')).not.toContain('\x1b');
  expect(collapsed.join('\n')).not.toContain('0;evil');
  expect(collapsed[0]).toBe('▸ 도구 Bash · 30줄 (접힘)');
  const expanded = logViewLines([toolMessage], 40, new Set([0]));
  expect(expanded.join('\n')).not.toContain('\x1b');
  expect(expanded.join('\n')).not.toContain('0;evil');
  expect(expanded.every((line) => Bun.stringWidth(line) <= 40)).toBe(true);
  expect(toolFoldBlockStarts([toolMessage], 40)).toEqual([0]);
});

test('Enter/Tab (and F) in the log toggle the foldable block nearest the bottom of the visible window; nothing else is a toggle key', () => {
  const long = (n: number, ts: string): SerializedMessage => ({
    role: 'tool', content: '⚙️ Bash', toolName: 'Bash', toolResult: Array.from({ length: n }, (_, i) => `x-${i}`).join('\n'), ts,
  });
  const messages: SerializedMessage[] = [long(30, 'a'), { role: 'assistant', content: 'ok', ts: 'b' }, long(20, 'c'), long(3, 'd')];
  const expanded = new Set<number>();
  const all = { start: 0, rows: 1000 };
  expect(toggleVisibleToolFold(expanded, messages, 40, all)).toBe(true);
  expect([...expanded]).toEqual([2]);
  expect(toggleVisibleToolFold(expanded, messages, 40, all)).toBe(true);
  expect([...expanded]).toEqual([]);
  // No foldable block → no toggle (the key keeps its old meaning in the caller).
  expect(toggleVisibleToolFold(expanded, [long(3, 'e')], 40, all)).toBe(false);
  expect(expanded.size).toBe(0);
  for (const name of ['return', 'enter', 'tab', 'f']) expect(isToolFoldToggleKey(name)).toBe(true);
  for (const name of ['up', 'down', 'escape', 'a', undefined]) expect(isToolFoldToggleKey(name)).toBe(false);
});

test('with two long tool blocks, scrolling up to the older one and pressing Enter expands the older one', () => {
  const long = (tag: string, ts: string): SerializedMessage => ({
    role: 'tool', content: '⚙️ Bash', toolName: 'Bash', toolResult: Array.from({ length: 30 }, (_, i) => `${tag}-${i}`).join('\n'), ts,
  });
  const filler = (i: number): SerializedMessage => ({ role: 'assistant', content: `filler-${i}`, ts: `f${i}` });
  const messages: SerializedMessage[] = [long('old', 'a'), ...Array.from({ length: 10 }, (_, i) => filler(i)), long('new', 'z')];
  const expanded = new Set<number>();
  const lines = logViewLines(messages, 40, expanded);
  const ranges = toolFoldBlockRanges(messages, 40, expanded);
  expect(ranges.map((r) => r.index)).toEqual([0, 11]);
  expect(lines[ranges[0]!.start]).toBe('▸ 도구 Bash · 30줄 (접힘)');
  // Window of 5 rows at the very top: only the older block is on screen.
  expect(toggleVisibleToolFold(expanded, messages, 40, { start: 0, rows: 5 })).toBe(true);
  expect([...expanded]).toEqual([0]);
  expect(logViewLines(messages, 40, expanded).join('\n')).toContain('old-29');
  expect(logViewLines(messages, 40, expanded).join('\n')).not.toContain('new-29');
  // Window at the bottom: the newer block is the one toggled.
  const after = logViewLines(messages, 40, expanded);
  expect(toggleVisibleToolFold(expanded, messages, 40, { start: Math.max(0, after.length - 5), rows: 5 })).toBe(true);
  expect([...expanded].sort((a, b) => a - b)).toEqual([0, 11]);
  // A window that shows no foldable block toggles nothing.
  const fillerOnly = toolFoldBlockRanges(messages, 40, new Set())[0]!.end + 1;
  const none = new Set<number>();
  expect(toggleVisibleToolFold(none, messages, 40, { start: fillerOnly, rows: 3 })).toBe(false);
  expect(none.size).toBe(0);
});

test('collapsed summary line stays within the terminal width for a long tool name', () => {
  const toolMessage: SerializedMessage = {
    role: 'tool', content: '⚙️ x', toolName: 'mcp__very_long_server_name__some_extremely_long_tool_name',
    toolResult: Array.from({ length: 30 }, (_, i) => `l-${i}`).join('\n'), ts: '2026-10-20T00:00:00Z',
  };
  const lines = logViewLines([toolMessage], 20);
  expect(lines[0]!.startsWith('▸ 도구 ')).toBe(true);
  expect(lines.every((line) => Bun.stringWidth(line) <= 20)).toBe(true);
  // When the width allows it, the name is shortened and the line count + fold marker survive.
  const at30 = logViewLines([toolMessage], 30)[0]!;
  expect(Bun.stringWidth(at30)).toBeLessThanOrEqual(30);
  expect(at30.startsWith('▸ 도구 mcp__')).toBe(true);
  // N counts wrapped lines at this width (the long name itself wraps), so only its shape is fixed here.
  expect(at30).toMatch(/ · \d+줄 \(접힘\)$/);
  expect(at30).toContain('…');
  // A name that fits is kept whole.
  expect(logViewLines([{ ...toolMessage, toolName: 'Bash' }], 30)[0]).toBe('▸ 도구 Bash · 30줄 (접힘)');
});

test('folding is judged by the tool output lines, not by a long tool name wrapping', () => {
  const longName = 'mcp__very_long_server_name__some_extremely_long_tool_name_that_wraps_many_times_over_the_width_x';
  const shortOutput: SerializedMessage = { role: 'tool', content: '⚙️ x', toolName: longName, toolResult: 'ok', ts: 't' };
  // The label line alone wraps past the limit at width 10, but the output is one line → never folds.
  expect(logViewLines([shortOutput], 10).length).toBeGreaterThan(TOOL_FOLD_LINE_LIMIT);
  expect(logViewLines([shortOutput], 10).join('\n')).not.toContain('접힘');
  expect(toolFoldBlockStarts([shortOutput], 10)).toEqual([]);
  // N in the summary counts output lines.
  const out = Array.from({ length: 12 }, (_, i) => `o-${i}`).join('\n');
  expect(logViewLines([{ ...shortOutput, toolResult: out }], 40)[0]).toMatch(/ · 12줄 \(접힘\)$/);
});

// ── TUI-NEXT-TOOL-RESULT-RENDER (0.2.36 · 설치본 111c91b7 실측) — 도구 결과가 JSON 봉투 한 줄로 보이던 사고 ──
import { parseToolResultEnvelope } from '../../chat/tool-render/result-text.js';

/** The exact Read envelope seen on 10-22: 20 numbered lines, one JSON line with escaped \n. */
const READ_ENVELOPE = JSON.stringify({
  output: Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(6)}\tfold-line-${i + 1}`).join('\n'),
  linesRead: 20, totalLines: 20, totalBytes: 251, truncated: false, kind: 'text',
});
const toolMsg = (toolName: string, toolResult: string): SerializedMessage => ({ role: 'tool', content: `⚙️ ${toolName}`, ts: '2026-10-22T00:00:00Z', toolName, toolResult });

test('재현(10-22): Read 봉투는 접히면 «▸ 도구 Read · 20줄 (접힘)» 한 줄 — JSON·이스케이프 \\n 이 보이지 않는다', () => {
  expect(READ_ENVELOPE.startsWith('{"output":"     1\\tfold-line-1\\n     2\\tfold-line-2\\n')).toBe(true);
  const lines = logViewLines([toolMsg('Read', READ_ENVELOPE)], 100);
  expect(lines).toEqual(['▸ 도구 Read · 20줄 (접힘)', '']);
  expect(toolFoldBlockStarts([toolMsg('Read', READ_ENVELOPE)], 100)).toEqual([0]);
});

test('재현(10-22): 펼친 Read 봉투는 파일 20줄이 제 줄로 · 머리줄에 «20줄 · 251B»', () => {
  const lines = logViewLines([toolMsg('Read', READ_ENVELOPE)], 100, new Set([0]));
  expect(lines[0]).toBe('도구: Read · 20줄 · 251B');
  expect(lines.slice(1, 21)).toEqual(Array.from({ length: 20 }, (_, i) => `  ${String(i + 1).padStart(6)} fold-line-${i + 1}`));
  const text = lines.join('\n');
  expect(text).not.toContain('{"output"');
  expect(text).not.toContain('\\n');
  expect(text).not.toContain('linesRead');
});

test('재현: RunShell/Bash 봉투는 output 줄을 보이고 exit 코드를 머리줄에 둔다', () => {
  const output = Array.from({ length: 30 }, (_, i) => `fold-line-${String(i).padStart(2, '0')}`).join('\n');
  const envelope = JSON.stringify({ output, exitCode: 0, stdout: output, stderr: '', ok: true });
  expect(logViewLines([toolMsg('Bash', envelope)], 100)).toEqual(['▸ 도구 Bash · 30줄 (접힘)', '']);
  const open = logViewLines([toolMsg('RunShell', envelope)], 100, new Set([0]));
  expect(open[0]).toBe('도구: RunShell · exit 0');
  expect(open.slice(1, 31)).toEqual(output.split('\n').map((l) => `  ${l}`));
});

test('Bash stdout 끝 개행은 빈 출력 줄로 세거나 그리지 않는다', () => {
  const output = Array.from({ length: 30 }, (_, i) => `fold-line-${String(i).padStart(2, '0')}`).join('\n') + '\n';
  const envelope = JSON.stringify({ output, stdout: output, stderr: '', exitCode: 0 });
  const message = toolMsg('Bash', envelope);
  expect(logViewLines([message], 100)[0]).toBe('▸ 도구 Bash · 30줄 (접힘)');
  const open = logViewLines([message], 100, new Set([0]));
  expect(open[0]).toBe('도구: Bash · exit 0');
  expect(open.slice(1, -1)).toEqual(output.trimEnd().split('\n').map((line) => `  ${line}`));
});

test('짧은 봉투는 접지 않고 펼친 그대로 · 오류 봉투는 error 문면 · 일반 문자열 결과는 옛 모양', () => {
  const short = JSON.stringify({ output: '     1\tonly', linesRead: 1, totalLines: 1, totalBytes: 5, truncated: false, kind: 'text' });
  expect(logViewLines([toolMsg('Read', short)], 100)).toEqual(['도구: Read · 1줄 · 5B', '       1 only', '']);
  expect(logViewLines([toolMsg('Read', JSON.stringify({ error: 'ENOENT: no such file' }))], 100)).toEqual(['도구: Read · 오류', '  ENOENT: no such file', '']);
  expect(logViewLines([toolMsg('Echo', 'plain ok')], 100)).toEqual(['도구: Echo plain ok', '']);
});

test('잘린 봉투(truncateForPersist 2000자 · «… (+N chars)»)도 output 을 줄로 살리고 «잘림» 을 단다', () => {
  const big = JSON.stringify({ output: Array.from({ length: 200 }, (_, i) => `${String(i + 1).padStart(6)}\tline-${i + 1}`).join('\n'), linesRead: 200, totalLines: 200, totalBytes: 3000, truncated: false, kind: 'text' });
  const persisted = `${big.slice(0, 2000)}… (+${big.length - 2000} chars)`;
  const parsed = parseToolResultEnvelope(persisted);
  expect(parsed.truncated).toBe(true);
  expect(String((parsed.value as { output: string }).output).split('\n')[0]).toBe('     1\tline-1');
  const open = logViewLines([toolMsg('Read', persisted)], 100, new Set([0]));
  expect(open[0]).toBe('도구: Read · 잘림');
  expect(open[1]).toBe('       1 line-1');
  expect(open.join('\n')).not.toContain('{"output"');
  // An escape cut in half at the boundary is dropped, not shown as a stray backslash.
  expect(parseToolResultEnvelope('{"output":"a\\nb\\… (+9 chars)').value).toEqual({ output: 'a\nb' });
});
