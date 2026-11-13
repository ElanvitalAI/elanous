import { expect, test } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { createNextTuiCompactPainter, renderNextTuiCompactFrame } from './render.js';

function simulatedScreen(cols: number, rows: number) {
  const terminal = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
  const writes: string[] = [];
  let pending = Promise.resolve();
  const write = (data: string) => {
    writes.push(data);
    pending = pending.then(() => new Promise<void>((done) => terminal.write(data, done)));
  };
  const allLines = () => Array.from({ length: terminal.buffer.active.length }, (_, i) =>
    terminal.buffer.active.getLine(i)?.translateToString(true) ?? '');
  const visible = () => Array.from({ length: terminal.rows }, (_, i) =>
    terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? '');
  return { terminal, writes, write, settle: () => pending, allLines, visible };
}

test('multiline composer keeps both prompt rows and the editing cursor in compact mode', async () => {
  const frame = renderNextTuiCompactFrame({
    messages: [], columns: 30, rows: 6, header: ['elanous'], footer: [],
    promptLine: '❯ first', promptLines: ['❯ first', '  second'], notices: [], activity: [],
    scroll: 0, expandedToolIndexes: new Set<number>(),
  });
  expect(frame.lines).toEqual(['elanous', '❯ first', '  second']);
  expect(frame.promptRow).toBe(2);
  const screen = simulatedScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    painter.paint(frame.lines, 4, 6, 30, 1, frame.promptRow);
    await screen.settle();
    expect(screen.visible()).toContain('❯ first');
    expect(screen.visible()).toContain('  second');
    expect(screen.terminal.buffer.active.cursorY).toBe(1);
    painter.paint(frame.lines, 5, 6, 30, 1, frame.promptRow + 1);
    await screen.settle();
    expect(screen.terminal.buffer.active.cursorY).toBe(2);
  } finally { screen.terminal.dispose(); }
});

test('compact PageUp shows older rows and returning to tail does not duplicate scrollback', async () => {
  const screen = simulatedScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  const history = Array.from({ length: 18 }, (_, i) => `ROW-${String(i).padStart(2, '0')}`);
  try {
    const tail = renderNextTuiCompactFrame({ messages: [], columns: 30, rows: 6,
      header: ['elanous'], footer: ['status'], promptLine: '❯ ', notices: history,
      activity: [], scroll: 0, expandedToolIndexes: new Set<number>() });
    painter.paint(tail.lines, 3, 6, 30, tail.lines.length - 2, tail.promptRow);
    await screen.settle();
    const before = screen.allLines();
    const older = renderNextTuiCompactFrame({ messages: [], columns: 30, rows: 6,
      header: ['elanous'], footer: ['status'], promptLine: '❯ ', notices: history,
      activity: [], scroll: 10, expandedToolIndexes: new Set<number>() });
    expect(older.scroll).toBe(10);
    expect(older.maxScroll).toBeGreaterThan(older.scroll);
    painter.paintViewport(older.lines, 3, 6, 30, older.promptRow);
    await screen.settle();
    expect(screen.visible()).toContain('ROW-05');
    expect(screen.visible()).not.toContain('ROW-17');
    painter.paint(tail.lines, 3, 6, 30, tail.lines.length - 2, tail.promptRow);
    await screen.settle();
    expect(screen.visible()).toContain('ROW-17');
    expect(screen.allLines()).toEqual(before);
  } finally { screen.terminal.dispose(); }
});

test('long streaming answer commits each completed line once to scrollback', async () => {
  const screen = simulatedScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    painter.paint(['elanous', '──', '❯ '], 3, 6, 30);
    for (let i = 0; i < 30; i++) {
      const lines = Array.from({ length: i + 1 }, (_, n) => `LINE-${String(n).padStart(2, '0')}`);
      painter.paint(['elanous', '──', ...lines, '❯ '], 3, 6, 30);
    }
    await screen.settle();
    const history = screen.allLines();
    for (let i = 0; i < 30; i++) {
      const marker = `LINE-${String(i).padStart(2, '0')}`;
      expect(history.filter(line => line === marker)).toHaveLength(1);
    }
    expect(screen.visible()).toContain('LINE-29');
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});

test('ephemeral streaming preview is committed only after the persisted answer replaces it', async () => {
  const screen = simulatedScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    const prefix = ['elanous', '나: 질문'];
    for (let i = 0; i < 30; i++) {
      const preview = Array.from({ length: i + 1 }, (_, n) => `REPLY-${String(n).padStart(2, '0')}`);
      painter.paint([...prefix, ...preview, '❯ '], 3, 6, 30, prefix.length);
    }
    await screen.settle();
    expect(screen.allLines().filter(line => line === 'REPLY-00')).toHaveLength(0);
    const final = [...prefix, ...Array.from({ length: 30 }, (_, n) => `REPLY-${String(n).padStart(2, '0')}`), '❯ '];
    painter.paint(final, 3, 6, 30, final.length - 1);
    await screen.settle();
    for (let i = 0; i < 30; i++) {
      const marker = `REPLY-${String(i).padStart(2, '0')}`;
      expect(screen.allLines().filter(line => line === marker)).toHaveLength(1);
    }
  } finally { screen.terminal.dispose(); }
});

test('sidebar repaint on primary screen resumes without alternate-screen transition or duplicate history', async () => {
  const screen = simulatedScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    const lines = ['elanous', '──', ...Array.from({ length: 12 }, (_, i) => `ROW-${i}`), '❯ '];
    painter.paint(lines, 3, 6, 30);
    await screen.settle();
    screen.write('\x1b[H\x1b[2Jsidebar sessions');
    await screen.settle();
    painter.paint(lines, 3, 6, 30);
    await screen.settle();
    expect(screen.visible()).toContain('❯ ');
    expect(screen.visible().join('\n')).not.toContain('sidebar sessions');
    expect(screen.writes.join('')).not.toContain('\x1b[?1049h');
    expect(screen.allLines().filter(line => line === 'ROW-0')).toHaveLength(1);
  } finally { screen.terminal.dispose(); }
});

test('sidebar resize does not mark obscured chat rows as committed', async () => {
  const screen = simulatedScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  const chat = ['TITLE', 'ROW-0', 'ROW-1', 'ROW-2', 'ROW-3', '❯ '];
  try {
    painter.paint(chat, 3, 6, 30, chat.length - 1); // Source: #36690
    await screen.settle();
    painter.invalidateViewport();
    screen.write(`\x1b[H\x1b[2J${['SIDE-0', 'SIDE-1', 'SIDE-2', 'SIDE-3', 'SIDE-4', 'SIDE-5'].join('\r\n')}`);
    await screen.settle();
    screen.terminal.resize(30, 4);
    painter.paint(chat, 3, 4, 30, chat.length - 1); // Source: #36690
    await screen.settle();
    for (const row of chat.slice(0, -1)) expect(screen.allLines().filter(line => line === row)).toHaveLength(1);
    expect(screen.visible()).toContain('ROW-3');
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});

test('switching to a longer session writes every new history row before marking it committed', async () => {
  const screen = simulatedScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    painter.paint([...Array.from({ length: 18 }, (_, i) => `OLD-${i}`), '❯ '], 3, 6, 30); // Source: #36690
    painter.paint([...Array.from({ length: 25 }, (_, i) => `NEW-${i}`), '❯ '], 3, 6, 30); // Source: #36690
    await screen.settle();
    for (let i = 0; i < 25; i++) expect(screen.allLines().filter(line => line === `NEW-${i}`)).toHaveLength(1); // Source: #36690
  } finally { screen.terminal.dispose(); }
});

test('resizing while history grows writes newly committed rows without gaps', async () => {
  const screen = simulatedScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    painter.paint([...Array.from({ length: 18 }, (_, i) => `ROW-${i}`), '❯ '], 3, 6, 30); // Source: #36690
    await screen.settle();
    screen.terminal.resize(30, 4);
    painter.paint([...Array.from({ length: 24 }, (_, i) => `ROW-${i}`), '❯ '], 3, 4, 30); // Source: #36690
    await screen.settle();
    for (let i = 0; i < 24; i++) expect(screen.allLines().filter(line => line === `ROW-${i}`)).toHaveLength(1); // Source: #36690
  } finally { screen.terminal.dispose(); }
});

test('growing compact viewport restores scrollback rows without losing or duplicating history', async () => {
  const screen = simulatedScreen(30, 4);
  const painter = createNextTuiCompactPainter(screen.write);
  const history = [...Array.from({ length: 18 }, (_, i) => `GROW-${i}`), '❯ '];
  try {
    painter.paint(history, 3, 4, 30, history.length - 1);
    await screen.settle();
    screen.terminal.resize(30, 6);
    painter.paint(history, 3, 6, 30, history.length - 1);
    await screen.settle();
    for (let i = 0; i < 18; i++) expect(screen.allLines().filter(line => line === `GROW-${i}`)).toHaveLength(1);
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});

test('width reflow preserves shell scrollback and does not replay committed chat rows', async () => {
  const screen = simulatedScreen(30, 4);
  const painter = createNextTuiCompactPainter(screen.write);
  const wide = [...Array.from({ length: 18 }, (_, i) => `WIDTH-${i}-abcdefghijklmnop`), '❯ '];
  const reflowed = [...wide.slice(0, -1).flatMap((line) => [line.slice(0, 20), line.slice(20)]), '❯ '];
  try {
    screen.write([...Array.from({ length: 8 }, (_, i) => i === 0 ? 'SHELL-PRE-TUI' : `SHELL-${i}`), ''].join('\r\n'));
    await screen.settle();
    painter.paint(wide, 3, 4, 30, wide.length - 1);
    await screen.settle();
    expect(screen.allLines()).toContain('SHELL-PRE-TUI');
    screen.terminal.resize(20, 4);
    painter.paint(reflowed, 3, 4, 20, reflowed.length - 1);
    await screen.settle();
    expect(screen.allLines()).toContain('SHELL-PRE-TUI');
    for (let i = 0; i < 18; i++) {
      expect(screen.allLines().filter(line => line.startsWith(`WIDTH-${i}-`))).toHaveLength(1);
    }
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});

test('first compact paint preserves shell output still in the physical viewport', async () => {
  const screen = simulatedScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    screen.write('SHELL-IN-VIEW-0\r\nSHELL-IN-VIEW-1');
    await screen.settle();
    expect(screen.visible()).toContain('SHELL-IN-VIEW-0');
    expect(screen.visible()).toContain('SHELL-IN-VIEW-1');
    painter.paint(['elanous', '❯ '], 3, 6, 30, 1, 2);
    await screen.settle();
    expect(screen.allLines()).toContain('SHELL-IN-VIEW-0');
    expect(screen.allLines()).toContain('SHELL-IN-VIEW-1');
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});

test('width reflow writes stable reply rows appended during the resize', async () => {
  const screen = simulatedScreen(30, 4);
  const painter = createNextTuiCompactPainter(screen.write);
  const oldRows = Array.from({ length: 18 }, (_, i) => `WIDTH-${i}-abcdefghijklmnop`);
  const nextRows = [...oldRows, ...Array.from({ length: 6 }, (_, i) => `NEW-${i}-abcdefghijklmnop`)];
  try {
    painter.paint([...oldRows, '❯ '], 3, 4, 30, oldRows.length);
    await screen.settle();
    screen.terminal.resize(20, 4);
    const reflowed = [...nextRows.flatMap((line) => [line.slice(0, 20), line.slice(20)]), '❯ '];
    painter.paint(reflowed, 3, 4, 20, reflowed.length - 1);
    await screen.settle();
    for (let i = 0; i < 18; i++) expect(screen.allLines().filter(line => line.startsWith(`WIDTH-${i}-`))).toHaveLength(1);
    for (let i = 0; i < 6; i++) expect(screen.allLines().filter(line => line.startsWith(`NEW-${i}-`))).toHaveLength(1);
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});

test('width reflow does not count newly inserted blank stable rows as old output', async () => {
  const screen = simulatedScreen(30, 4);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    painter.paint(['OLD', '❯ '], 3, 4, 30, 1);
    await screen.settle();
    screen.terminal.resize(20, 4);
    painter.paint(['OLD', '', '', '', '', '', '', 'NEW', '❯ '], 3, 4, 20, 8);
    await screen.settle();
    expect(screen.allLines().filter(line => line === 'OLD')).toHaveLength(1);
    expect(screen.allLines().filter(line => line === 'NEW')).toHaveLength(1);
  } finally { screen.terminal.dispose(); }
});

test('width reflow with an edited prefix keeps the old segment and prints later events once', async () => {
  const screen = simulatedScreen(30, 4);
  const painter = createNextTuiCompactPainter(screen.write);
  const oldRows = Array.from({ length: 18 }, (_, i) => `HISTORY-${i}-abcdefghijklmnop`);
  try {
    painter.paint([...oldRows, '❯ '], 3, 4, 30, oldRows.length);
    await screen.settle();
    screen.terminal.resize(20, 4);
    const nextRows = ['EDITED-0-abcdefghijklmnop', ...oldRows.slice(1), 'NEW-0-abcdefghijklmnop'];
    painter.paint([...nextRows.flatMap(line => [line.slice(0, 20), line.slice(20)]), '❯ '], 3, 4, 20, nextRows.length * 2);
    await screen.settle();
    for (let i = 1; i < 18; i++) expect(screen.allLines().filter(line => line.startsWith(`HISTORY-${i}-`))).toHaveLength(1);
    expect(screen.allLines()).toContain('── resize 20x4 ──');
    const later = 'LATER-0-abcdefghijklmno';
    const laterRows = [...nextRows, later].flatMap(line => [line.slice(0, 20), line.slice(20)]);
    painter.paint([...laterRows, '❯ '], 3, 4, 20, laterRows.length);
    await screen.settle();
    expect(screen.allLines().filter(line => line.startsWith('LATER-0-'))).toHaveLength(1);
  } finally { screen.terminal.dispose(); }
});

test('width reflow starts a new segment when old history is edited before a familiar tail', async () => {
  const screen = simulatedScreen(30, 4);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    painter.paint(['PREV', 'TAIL', '❯ '], 3, 4, 30, 2);
    await screen.settle();
    screen.terminal.resize(20, 4);
    painter.paint(['EDIT', 'A', 'B', 'C', 'TAIL', 'END', '❯ '], 3, 4, 20, 6);
    await screen.settle();
    expect(screen.allLines()).toContain('── resize 20x4 ──');
    expect(screen.allLines().filter(line => line === 'TAIL')).toHaveLength(1);
    painter.paint(['EDIT', 'A', 'B', 'C', 'TAIL', 'END', 'FUTURE', '❯ '], 3, 4, 20, 7);
    await screen.settle();
    expect(screen.allLines().filter(line => line === 'FUTURE')).toHaveLength(1);
  } finally { screen.terminal.dispose(); }
});

test('shrinking an underfilled viewport preserves prior rows above the new segment', async () => {
  const screen = simulatedScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    painter.paint(['TITLE', 'ROW-0', '❯ '], 3, 6, 30, 2); // Source: #36690
    await screen.settle();
    screen.terminal.resize(30, 4);
    painter.paint(['TITLE', 'ROW-0', '❯ '], 3, 4, 30, 2); // Source: #36690
    await screen.settle();
    expect(screen.allLines()).toContain('── resize 30x4 ──');
    expect(screen.allLines().filter(line => line === 'TITLE')).toHaveLength(1);
    expect(screen.allLines().filter(line => line === 'ROW-0')).toHaveLength(1);
    expect(screen.allLines().indexOf('TITLE')).toBeLessThan(screen.allLines().indexOf('ROW-0'));
    expect(screen.allLines().indexOf('ROW-0')).toBeLessThan(screen.allLines().indexOf('── resize 30x4 ──'));
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});

test('compact to normal and back at the same width starts an append-only resize segment', async () => {
  const screen = simulatedScreen(30, 4);
  const painter = createNextTuiCompactPainter(screen.write);
  const history = [...Array.from({ length: 12 }, (_, i) => `ROUND-${i}`), '❯ '];
  try {
    painter.paint(history, 3, 4, 30, history.length - 1);
    await screen.settle();
    screen.write('\x1b[?1049h');
    await screen.settle();
    screen.terminal.resize(30, 8);
    painter.invalidateViewport();
    screen.write('NORMAL-SCREEN');
    await screen.settle();
    screen.terminal.resize(30, 4);
    screen.write('\x1b[?1049l');
    await screen.settle();
    painter.invalidateViewport(true);
    painter.paint([...history.slice(0, -1), 'AFTER-ROUNDTRIP', '❯ '], 3, 4, 30, history.length);
    await screen.settle();
    const all = screen.allLines();
    const marker = all.indexOf('── resize 30x4 ──');
    expect(all).toContain('── resize 30x4 ──');
    for (const line of ['ROUND-0', 'ROUND-10', 'ROUND-11']) {
      expect(all.filter((row) => row === line)).toHaveLength(1);
      expect(all.indexOf(line)).toBeLessThan(marker);
    }
    expect(all.filter((line) => line === 'AFTER-ROUNDTRIP')).toHaveLength(1);
    expect(all.indexOf('AFTER-ROUNDTRIP')).toBeGreaterThan(marker);
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});

for (const size of [{ cols: 20, rows: 6 }, { cols: 30, rows: 4 }]) {
  test(`resize to ${size.cols}x${size.rows} resynchronizes the visible reply`, async () => {
    const screen = simulatedScreen(30, 6);
    const painter = createNextTuiCompactPainter(screen.write);
    try {
      painter.paint(['elanous', 'one', 'two', '❯ '], 3, 6, 30);
      await screen.settle();
      screen.terminal.resize(size.cols, size.rows);
      painter.paint(['elanous', 'one', 'two', '❯ '], 3, size.rows, size.cols);
      painter.paint(['elanous', 'one', 'two', 'answer', '❯ '], 3, size.rows, size.cols);
      await screen.settle();
      expect(screen.visible()).toContain('answer');
      expect(screen.visible()).toContain('❯ ');
    } finally { screen.terminal.dispose(); }
  });
}
