import { describe, test, expect } from 'bun:test';
import {
  buildConcisenessSystemMessages,
  getConcisenessSystemPrompt,
} from '../src/prompt-library/chat-conciseness.js';

describe('getConcisenessSystemPrompt', () => {
  test('mentions the configured final-message line cap', () => {
    const prompt = getConcisenessSystemPrompt({
      enabled: true,
      finalMessageMaxLines: 7,
      preambleMaxWords: 12,
      flatBullets: true,
    });
    expect(prompt).toContain('at most 7 lines');
  });

  test('mentions the configured preamble word cap', () => {
    const prompt = getConcisenessSystemPrompt({
      enabled: true,
      finalMessageMaxLines: 10,
      preambleMaxWords: 9,
      flatBullets: true,
    });
    expect(prompt).toContain('9 words or fewer');
  });

  test('switches formatting guidance when flatBullets is false', () => {
    const prompt = getConcisenessSystemPrompt({
      enabled: true,
      finalMessageMaxLines: 10,
      preambleMaxWords: 12,
      flatBullets: false,
    });
    expect(prompt).toContain('Use short lists only when the content is inherently list-shaped');
    expect(prompt).not.toContain('Use flat bullet lists only');
  });

  test('includes anti-narration and terminal formatting rules', () => {
    const prompt = getConcisenessSystemPrompt({
      enabled: true,
      finalMessageMaxLines: 10,
      preambleMaxWords: 12,
      flatBullets: true,
    });
    expect(prompt).toContain('Do not narrate each step');
    // TUI-INITIATIVE 0단(대표 10-15 «시키는 일만 하고 끝나는 상태부터 막자»): every brevity rule has an act-first path.
    expect(prompt).toContain('## Initiative');
    expect(prompt).toContain('Act first');
    expect(prompt).toContain('state\n  the assumption in one line');
    expect(prompt).toContain('end with up to 3 concrete next steps');
    expect(prompt).toContain('A stop always comes with a path');
    expect(prompt).toContain('Do not use tables');
    expect(prompt).toContain('monospace CommonMark');
  });
});

describe('buildConcisenessSystemMessages', () => {
  test('returns one system message when enabled', () => {
    const msgs = buildConcisenessSystemMessages({
      enabled: true,
      finalMessageMaxLines: 10,
      preambleMaxWords: 12,
      flatBullets: true,
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('Chat conciseness and terminal presentation');
  });

  test('returns empty array when disabled', () => {
    expect(buildConcisenessSystemMessages({
      enabled: false,
      finalMessageMaxLines: 10,
      preambleMaxWords: 12,
      flatBullets: true,
    })).toEqual([]);
  });
});
