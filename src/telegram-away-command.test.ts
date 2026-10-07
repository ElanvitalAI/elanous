import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerAwayCommand } from './cli/away-cli.js';
import { telegramAwaySlash, telegramReleaseStatus } from './telegram-away-command.js';

describe('AWAY-MODE-1 — 텔레그램 /away · /release', () => {
  test('/away on 은 외출을 켜고 바로 한 번 보고 발행 현황을 답한다', () => {
    const writes: Array<[boolean, string]> = [];
    let ticks = 0;
    const reply = telegramAwaySlash(['on'], {
      write: (away, by) => { writes.push([away, by]); return { away }; },
      tick: () => { ticks++; },
      release: () => '📦 0.2.19 · running',
    });
    expect(writes).toEqual([[true, 'telegram']]);
    expect(ticks).toBe(1);
    expect(reply).toContain('외출 모드 켬');
    expect(reply).toContain('📦 0.2.19 · running');
  });

  test('/away off · status · 잘못된 인자', () => {
    const writes: boolean[] = [];
    const deps = { write: (away: boolean) => { writes.push(away); return { away }; }, tick: () => undefined, release: () => 'R', read: () => ({ away: true, since: '2026-10-07T09:00:00.000Z' }) };
    expect(telegramAwaySlash(['off'], deps)).toContain('외출 모드 끔');
    expect(writes).toEqual([false]);
    expect(telegramAwaySlash([], deps)).toBe('🚶 외출 중 · 2026-10-07T09:00:00.000Z\nR');
    expect(telegramAwaySlash(['maybe'], deps)).toBe('사용법: /away on | off | status');
  });

  test('/release 는 원장을 못 읽으면 「없다」가 아니라고 말한다', () => {
    expect(telegramReleaseStatus([], () => 'unavailable')).toContain('「없다」가 아니다');
    expect(telegramReleaseStatus(['x'])).toBe('사용법: /release');
  });

  test('CLI away on: 켜고 확인 한 통 · 못 보내면 exit 1', async () => {
    const lines: string[] = [];
    let code = -1;
    const program = new Command().exitOverride();
    registerAwayCommand(program, {
      write: (away) => ({ away }), tick: () => ({ outcome: 'quiet', followed: 0 }), now: () => 'R',
      send: () => false, output: (l) => lines.push(l), setExitCode: (c) => { code = c; },
    });
    await program.parseAsync(['node', 'elanous', 'away', 'on']);
    expect(lines[0]).toBe('외출 모드 켬 · 확인 한 통 못 보냄 · 첫 확인 quiet');
    expect(code).toBe(1);
  });

  test('CLI away tick: 보내기 실패는 exit 1', async () => {
    let code = -1;
    const program = new Command().exitOverride();
    registerAwayCommand(program, { tick: () => ({ outcome: 'send-failed', followed: 1, lines: 1, urgent: true }), output: () => undefined, setExitCode: (c) => { code = c; } });
    await program.parseAsync(['node', 'elanous', 'away', 'tick']);
    expect(code).toBe(1);
  });
});
