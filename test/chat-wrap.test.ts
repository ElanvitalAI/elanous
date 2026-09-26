import { describe, expect, test } from 'bun:test';
import { urlAwareWrap } from '../src/chat/wrap.js';

function plain(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

describe('urlAwareWrap', () => {
  test('legacy mode splits long URL like plain text', () => {
    const lines = urlAwareWrap('see https://example.com/very/long/path', 12, { urlAware: false });
    expect(lines.length).toBeGreaterThan(2);
  });

  test('url-aware mode pushes long URL to its own line without splitting it', () => {
    const lines = urlAwareWrap('see https://example.com/very/long/path now', 12, { urlAware: true });
    expect(plain(lines[0] ?? '')).toBe('see ');
    expect(plain(lines[1] ?? '')).toBe('https://example.com/very/long/path');
    expect(plain(lines[2] ?? '')).toBe('now');
  });

  test('preserves OSC 8 hyperlink sequence around wrapped URL token', () => {
    const open = '\x1b]8;;https://example.com/very/long/path\x07';
    const close = '\x1b]8;;\x07';
    const lines = urlAwareWrap(`see ${open}https://example.com/very/long/path${close} now`, 12, {
      urlAware: true,
    });
    expect(lines[1]).toContain(open);
    expect(lines[1]).toContain(close);
    expect(plain(lines[1] ?? '')).toBe('https://example.com/very/long/path');
  });
});
