import { expect, test } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { createNextTuiCompactPainter } from './render.js';
import { showNextTui } from '../entry.js';

function terminalScreen(columns: number, rows: number) {
  const terminal = new Terminal({ cols: columns, rows, scrollback: 200, allowProposedApi: true });
  let pending = Promise.resolve();
  const write = (text: string) => {
    pending = pending.then(() => new Promise<void>((done) => terminal.write(text, done)));
  };
  const lines = () => Array.from({ length: terminal.buffer.normal.length }, (_, index) =>
    terminal.buffer.normal.getLine(index)?.translateToString(true) ?? '');
  const visible = () => Array.from({ length: terminal.rows }, (_, index) =>
    terminal.buffer.active.getLine(terminal.buffer.active.viewportY + index)?.translateToString(true) ?? '');
  return { terminal, write, settle: () => pending, lines, visible };
}

// Every first clear-screen route through showNextTui is represented here.
const PRIMARY_FIRST_PAINT_CASES = [
  { name: 'sidetab open', columns: 40, rows: 8, output: 'SIDETAB│❯ ' },
] as const;

for (const boundary of PRIMARY_FIRST_PAINT_CASES) {
  test(`first-paint boundary matrix: ${boundary.name} keeps shell rows`, async () => {
    const screen = terminalScreen(boundary.columns, boundary.rows);
    const painter = createNextTuiCompactPainter(screen.write);
    try {
      screen.write('SHELL-VIEW-0\r\nSHELL-VIEW-1');
      await screen.settle();
      expect(screen.visible()).toContain('SHELL-VIEW-0');
      // These entry routes use paintScreen, not the compact chat painter.
      painter.beforeExternalPaint?.(boundary.rows);
      screen.write(`\x1b[H\x1b[2J${boundary.output}`);
      await screen.settle();
      expect(screen.lines().filter((line) => line === 'SHELL-VIEW-0')).toHaveLength(1);
      expect(screen.lines().filter((line) => line === 'SHELL-VIEW-1')).toHaveLength(1);
      expect(screen.visible().join('\n')).toContain(boundary.output);
    } finally { screen.terminal.dispose(); }
  });
}

for (const boundary of [
  { name: 'initial width below 20', columns: 18, rows: 8 },
  { name: 'initial height below 6', columns: 30, rows: 5 },
] as const) {
  test(`first-paint boundary matrix: ${boundary.name} refuses before any clear`, async () => {
    const priorTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const priorColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const priorRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    const priorWrite = process.stdout.write;
    const writes: string[] = [];
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: boundary.columns, configurable: true });
      Object.defineProperty(process.stdout, 'rows', { value: boundary.rows, configurable: true });
      process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
      await expect(showNextTui()).rejects.toThrow('requires at least 20 columns and 6 rows');
      expect(writes).toEqual([]);
    } finally {
      process.stdout.write = priorWrite;
      if (priorTty) Object.defineProperty(process.stdin, 'isTTY', priorTty);
      else Reflect.deleteProperty(process.stdin, 'isTTY');
      if (priorColumns) Object.defineProperty(process.stdout, 'columns', priorColumns);
      else Reflect.deleteProperty(process.stdout, 'columns');
      if (priorRows) Object.defineProperty(process.stdout, 'rows', priorRows);
      else Reflect.deleteProperty(process.stdout, 'rows');
    }
  });
}

test('first-paint boundary matrix: same-width compact-normal-compact keeps the old segment', async () => {
  const screen = terminalScreen(30, 4);
  const painter = createNextTuiCompactPainter(screen.write);
  const history = [...Array.from({ length: 12 }, (_, index) => `MATRIX-${index}`), '❯ '];
  try {
    painter.paint(history, 3, 4, 30, history.length - 1);
    await screen.settle();
    screen.write('\x1b[?1049h');
    screen.terminal.resize(30, 8);
    painter.invalidateViewport();
    screen.write('NORMAL-VIEW');
    await screen.settle();
    screen.terminal.resize(30, 4);
    screen.write('\x1b[?1049l');
    painter.invalidateViewport(true);
    painter.paint([...history.slice(0, -1), 'NEW-SEGMENT', '❯ '], 3, 4, 30, history.length);
    await screen.settle();
    const all = screen.lines();
    const separator = all.indexOf('── resize 30x4 ──');
    expect(all).toContain('── resize 30x4 ──');
    expect(all.filter((line) => line === 'MATRIX-10')).toHaveLength(1);
    expect(all.filter((line) => line === 'MATRIX-11')).toHaveLength(1);
    expect(all.indexOf('MATRIX-11')).toBeLessThan(separator);
    expect(all.indexOf('NEW-SEGMENT')).toBeGreaterThan(separator);
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});

test('first-paint boundary matrix: normal initial shell survives alternate screen', async () => {
  const screen = terminalScreen(40, 12);
  try {
    screen.write('SHELL-NORMAL-0\r\nSHELL-NORMAL-1');
    await screen.settle();
    screen.write('\x1b[?1049h\x1b[H\x1b[2JNORMAL-TUI');
    await screen.settle();
    expect(screen.visible().join('\n')).toContain('NORMAL-TUI');
    screen.write('\x1b[?1049l');
    await screen.settle();
    expect(screen.lines().filter((line) => line === 'SHELL-NORMAL-0')).toHaveLength(1);
    expect(screen.lines().filter((line) => line === 'SHELL-NORMAL-1')).toHaveLength(1);
  } finally { screen.terminal.dispose(); }
});

test('first-paint boundary matrix: removing welcome header does not replay committed long chat', async () => {
  const screen = terminalScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  const chat = Array.from({ length: 24 }, (_, index) => `HISTORY-${String(index).padStart(2, '0')}`);
  try {
    painter.paint(['WELCOME', ...chat, '❯ '], 3, 6, 30, chat.length + 1, chat.length + 2, 1);
    await screen.settle();
    painter.paint([...chat, '❯ '], 3, 6, 30, chat.length, chat.length + 1, 0);
    await screen.settle();
    for (const line of chat) expect(screen.lines().filter((row) => row === line)).toHaveLength(1);
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});

test('first-paint boundary matrix: uncommitted welcome header remains visible', async () => {
  const screen = terminalScreen(30, 6);
  const painter = createNextTuiCompactPainter(screen.write);
  try {
    painter.paint(['WELCOME', '❯ '], 3, 6, 30, 1, 2, 1);
    await screen.settle();
    expect(screen.visible()).toContain('WELCOME');
    expect(screen.visible()).toContain('❯ ');
  } finally { screen.terminal.dispose(); }
});
