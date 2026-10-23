// TUI-SIGCONT-RESTORE-TERM — 멈췄다 돌아온(SIGCONT) TUI 가 raw 모드·키보드 프로토콜·alt 화면을 다시 세운다.
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { bunNativePtyAvailable, bunSpawnPty } from '../src/pty-shell/bun-native-pty.js';
import { ansi, restoreTerminalAfterContinue } from '../src/tui.js';

function fakeIo(isTTY = true) {
  const writes: string[] = [];
  const calls: string[] = [];
  return {
    writes,
    calls,
    io: {
      stdin: { isTTY, setRawMode: (m: boolean) => { calls.push(`raw:${m}`); }, resume: () => { calls.push('resume'); } },
      stdout: { write: (c: string) => { writes.push(c); }, emit: (e: string) => { calls.push(`emit:${e}`); } },
    },
  };
}

describe('restoreTerminalAfterContinue', () => {
  test('raw ⊕ alt 였으면 raw 모드·프로토콜·alt 화면을 다시 켜고 resize 로 전체를 다시 그리게 한다', () => {
    const f = fakeIo();
    expect(restoreTerminalAfterContinue({ raw: true, alt: true }, f.io)).toBe(true);
    expect(f.calls).toEqual(['raw:true', 'resume', 'emit:resize']);
    const out = f.writes.join('');
    for (const seq of [ansi.mouseOn, ansi.pasteOn, ansi.kittyKbOn, ansi.modKeysOn, ansi.altOn, ansi.hideCursor]) expect(out).toContain(seq);
  });
  test('alt 가 아니었으면 alt 화면은 켜지 않는다', () => {
    const f = fakeIo();
    restoreTerminalAfterContinue({ raw: true, alt: false }, f.io);
    expect(f.writes.join('')).not.toContain(ansi.altOn);
    expect(f.writes.join('')).toContain(ansi.kittyKbOn);
  });
  test('TUI 가 아무것도 안 켰으면(닫힌 뒤) 아무것도 하지 않는다', () => {
    const f = fakeIo();
    expect(restoreTerminalAfterContinue({ raw: false, alt: false }, f.io)).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});

describe('실 PTY — SIGSTOP → SIGCONT 뒤 켜기 시퀀스를 다시 낸다', () => {
  test.skipIf(!bunNativePtyAvailable())('initTui 한 자식에 STOP/CONT → CONT 뒤 출력에 kitty·modifyOtherKeys·alt 켜기', async () => {
    const script = `import { initTui } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'tui.ts'))}; initTui(); process.stdout.write('READY\\n'); setTimeout(() => process.exit(0), 8000);`;
    const pty = bunSpawnPty(process.execPath, ['-e', script], { cols: 80, rows: 24, env: { ...process.env, NODE_ENV: 'test' } as Record<string, string> });
    let out = '';
    const sub = pty.onData((d) => { out += d; });
    try {
      const until = async (pred: () => boolean, ms: number) => {
        const end = Date.now() + ms;
        while (!pred() && Date.now() < end) await Bun.sleep(25);
        return pred();
      };
      expect(await until(() => out.includes('READY'), 15_000)).toBe(true);
      process.kill(pty.pid, 'SIGSTOP');
      await Bun.sleep(150);
      const mark = out.length;
      process.kill(pty.pid, 'SIGCONT');
      const after = () => out.slice(mark);
      expect(await until(() => after().includes(ansi.kittyKbOn), 5_000)).toBe(true);
      expect(after()).toContain(ansi.modKeysOn);
      expect(after()).toContain(ansi.altOn);
    } finally {
      sub.dispose();
      try { pty.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, 30_000);
});
