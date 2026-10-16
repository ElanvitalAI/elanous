// Capture the real dashboard/tui renderer at the stdout boundary, then let
// the already-installed xterm parser interpret its ANSI bytes. No child PTY.
import { Terminal } from '@xterm/headless';
import { renderDashboardFrame, type DashboardFrameInput } from '../dashboard/index.js';
import { resetRenderCache } from '../tui.js';

export interface HeadlessDashboardFrame {
  lines: string[];
  input: DashboardFrameInput;
}

export interface HeadlessDashboardSnapshot {
  bytes: string;
  lines: string[];
  cursor: { row: number; col: number };
}

let capturing = false;

/** Serial-only: stdout and tui's frame cache are process globals. */
export async function simHeadlessDashboardFrames(
  frames: readonly HeadlessDashboardFrame[],
  size: { rows: number; cols: number } = { rows: 30, cols: 100 },
): Promise<HeadlessDashboardSnapshot[]> {
  if (capturing) throw new Error('headless TUI simulation is already capturing stdout');
  if (size.rows < 1 || size.cols < 1) throw new Error('headless TUI size must be positive');
  const terminal = new Terminal({ rows: size.rows, cols: size.cols, scrollback: 0, allowProposedApi: true });
  capturing = true;
  const stdout = process.stdout;
  const originalWrite = stdout.write;
  const originalRows = Object.getOwnPropertyDescriptor(stdout, 'rows');
  const originalColumns = Object.getOwnPropertyDescriptor(stdout, 'columns');
  const snapshots: HeadlessDashboardSnapshot[] = [];
  try {
    Object.defineProperty(stdout, 'rows', { configurable: true, value: size.rows });
    Object.defineProperty(stdout, 'columns', { configurable: true, value: size.cols });
    resetRenderCache();
    for (const frame of frames) {
      const chunks: string[] = [];
      stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        const done = typeof encoding === 'function' ? encoding : callback;
        done?.(null);
        return true;
      }) as typeof stdout.write;
      try {
        renderDashboardFrame(frame.lines, frame.input);
      } finally {
        stdout.write = originalWrite;
      }
      const bytes = chunks.join('');
      await new Promise<void>((resolve) => terminal.write(bytes, resolve));
      const buffer = terminal.buffer.active;
      snapshots.push({
        bytes,
        lines: Array.from({ length: size.rows }, (_, row) =>
          buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''),
        cursor: { row: buffer.cursorY + 1, col: buffer.cursorX + 1 },
      });
    }
    return snapshots;
  } finally {
    stdout.write = originalWrite;
    if (originalRows) Object.defineProperty(stdout, 'rows', originalRows);
    else Reflect.deleteProperty(stdout, 'rows');
    if (originalColumns) Object.defineProperty(stdout, 'columns', originalColumns);
    else Reflect.deleteProperty(stdout, 'columns');
    resetRenderCache();
    terminal.dispose();
    capturing = false;
  }
}
