// PWA · log ring buffer behavior tests (Phase N-4 PR ρ)

import { describe, test, expect } from 'bun:test';
import { appendLogLine, type LogLineEntry } from './use-tab-logs-stream';

function entry(seq: number, stream: LogLineEntry['stream'], line: string): LogLineEntry {
  return { seq, stream, line, ts: 0 };
}

describe('ring buffer append + cap', () => {
  test('first append retains the supplied entry', () => {
    const first = entry(1, 'stdout', 'a');
    expect(appendLogLine([], first, 10)).toEqual([first]);
  });

  test('preserves sequence numbers and append order', () => {
    let lines: LogLineEntry[] = [];
    for (let i = 1; i <= 5; i += 1) {
      lines = appendLogLine(lines, entry(i, 'stdout', `line-${i}`), 100);
    }
    expect(lines.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test('cap drops oldest first (FIFO) without mutating the previous buffer', () => {
    let lines: LogLineEntry[] = [];
    for (let i = 0; i < 11; i += 1) {
      lines = appendLogLine(lines, entry(i + 1, 'stdout', `L${i}`), 5);
    }
    const previous = lines;
    lines = appendLogLine(lines, entry(12, 'stdout', 'L11'), 5);
    expect(lines.map((e) => e.line)).toEqual(['L7', 'L8', 'L9', 'L10', 'L11']);
    expect(previous.map((e) => e.line)).toEqual(['L6', 'L7', 'L8', 'L9', 'L10']);
  });

  test('mixed streams preserved with order', () => {
    let lines: LogLineEntry[] = [];
    lines = appendLogLine(lines, entry(1, 'stdout', 'out-a'), 100);
    lines = appendLogLine(lines, entry(2, 'stderr', 'err-x'), 100);
    lines = appendLogLine(lines, entry(3, 'stdout', 'out-b'), 100);
    expect(lines.map((e) => e.stream)).toEqual(['stdout', 'stderr', 'stdout']);
    expect(lines.map((e) => e.line)).toEqual(['out-a', 'err-x', 'out-b']);
  });

  test('cap=1 keeps only latest entry', () => {
    let lines: LogLineEntry[] = [];
    for (let i = 0; i < 10; i += 1) {
      lines = appendLogLine(lines, entry(i + 1, 'stdout', `L${i}`), 1);
    }
    expect(lines).toEqual([entry(10, 'stdout', 'L9')]);
  });
});
