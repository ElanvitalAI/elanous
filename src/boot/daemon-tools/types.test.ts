import { describe, expect, test } from 'bun:test';

import { ToolSafetyError } from './types.js';

// Preservation anchor for the daemon tool surface: the "tool refused" envelope
// that tools (including PtyShell) surface to the LLM keeps its exact shape.
// TUI-NO-SELF-NEST (#27) must not change it.

describe('ToolSafetyError — 거부 원장 문면 형식', () => {
  test('message 는 "tool refused: <kind> — <message>" 형식을 유지한다', () => {
    const err = new ToolSafetyError('sensitive', 'blocked path');
    expect(err.message).toBe('tool refused: sensitive — blocked path');
  });

  test('kind 와 name 은 소비자 계약 그대로다', () => {
    const err = new ToolSafetyError('unavailable', 'pty-shell missing');
    expect(err.kind).toBe('unavailable');
    expect(err.name).toBe('ToolSafetyError');
    expect(err).toBeInstanceOf(Error);
  });
});
