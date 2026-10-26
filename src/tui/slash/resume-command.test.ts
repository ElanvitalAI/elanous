import { describe, expect, test } from 'bun:test';
import { RESUME_BUSY_STATUS, RESUME_LIST_LIMIT, parseResumeCommand } from './resume-command.js';

describe('Next TUI lightweight resume command parser', () => {
  test('recognizes list and load forms without importing the session store', () => {
    expect(parseResumeCommand('/resume')).toEqual({ kind: 'list' });
    expect(parseResumeCommand('/session list')).toEqual({ kind: 'list' });
    expect(parseResumeCommand('/sessions ls')).toEqual({ kind: 'list' });
    expect(parseResumeCommand('/resume abc123')).toEqual({ kind: 'load', prefix: 'abc123' });
    expect(parseResumeCommand('/session load abc123')).toEqual({ kind: 'load', prefix: 'abc123' });
    expect(parseResumeCommand('/session resume abc123')).toEqual({ kind: 'load', prefix: 'abc123' });
  });

  test('rejects non-command text and malformed command forms', () => {
    for (const text of ['/resume two words', '/session load', '/session new', '/session fork', 'resume', '이전 대화 /resume']) {
      expect(parseResumeCommand(text)).toBeNull();
    }
  });

  test('exports the lightweight status and list limit used by the command surface', () => {
    expect(RESUME_BUSY_STATUS).toContain('/resume');
    expect(RESUME_LIST_LIMIT).toBe(12);
  });
});
