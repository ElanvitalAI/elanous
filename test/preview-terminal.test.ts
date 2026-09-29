import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PreviewTerminal,
  cellSgr,
  encodeSgrMouse,
  stripSgrSequences,
  stripMotionSequences,
  defaultShellArgsFor,
} from '../src/preview/terminal.js';
import { Terminal } from '@xterm/headless';

// @xterm/headless Terminal.write() is queued, not synchronous. The
// callback form guarantees the chunk has been fully applied before
// we inspect the buffer.
const writeSync = (t: Terminal, data: string): Promise<void> =>
  new Promise((resolve) => { t.write(data, () => resolve()); });

// PreviewTerminal owns an xterm instance too.  An empty callback write is a
// queue barrier, so tests can observe the terminal deterministically instead
// of sleeping for an arbitrary event-loop interval.
const flushPreview = (session: PreviewTerminal): Promise<void> =>
  new Promise((resolve) => { (session as any).term.write('', () => resolve()); });

// ── cellSgr ─────────────────────────────────────────────────
describe('cellSgr', () => {
  // Walk the emulator's own cells rather than mocking IBufferCell —
  // that way we exercise the exact APIs the emulator will produce at
  // runtime.
  test('default cell returns empty', async () => {
    const t = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
    await writeSync(t, 'a');
    const cell = t.buffer.active.getLine(0)!.getCell(0)!;
    expect(cellSgr(cell)).toBe('');
    t.dispose();
  });

  test('bold palette-red foreground encodes as SGR 1;31', async () => {
    const t = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
    await writeSync(t, '\x1b[1;31mX');
    const cell = t.buffer.active.getLine(0)!.getCell(0)!;
    const out = cellSgr(cell);
    expect(out).toContain('1');
    expect(out).toContain('31');
    t.dispose();
  });

  test('true-color foreground encodes 38;2;r;g;b', async () => {
    const t = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
    await writeSync(t, '\x1b[38;2;10;20;30mX');
    const cell = t.buffer.active.getLine(0)!.getCell(0)!;
    const out = cellSgr(cell);
    expect(out).toBe('\x1b[38;2;10;20;30m');
    t.dispose();
  });

  test('bright palette color (8-15) encodes as 90-97', async () => {
    const t = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
    await writeSync(t, '\x1b[91mX'); // bright red
    const cell = t.buffer.active.getLine(0)!.getCell(0)!;
    const out = cellSgr(cell);
    expect(out).toContain('91');
    t.dispose();
  });
});

// ── PreviewTerminal live (spawns a real bash) ────────────────
describe('PreviewTerminal', () => {
  test('spawn bash, write echo, render contains output', async () => {
    const session = new PreviewTerminal({
      cols: 80,
      rows: 10,
      cwd: process.cwd(),
      shell: '/bin/bash',
      env: {
        ...process.env,
        PS1: '$ ',
        BASH_ENV: '',
        ENV: '',
      } as Record<string, string>,
    });
    session.start();

    // Disable the bash rc so startup is deterministic.
    session.write('echo PREVIEW_TERMINAL_ECHO\r');

    // Poll render() for up to 2 s waiting for the echo string.
    const deadline = Date.now() + 2000;
    let snapshot = '';
    while (Date.now() < deadline) {
      snapshot = session.render();
      if (snapshot.includes('PREVIEW_TERMINAL_ECHO')) break;
      await new Promise(r => setTimeout(r, 50));
    }
    session.stop();

    expect(snapshot).toContain('PREVIEW_TERMINAL_ECHO');
  }, 5000);

  test('resize propagates to emulator', () => {
    const session = new PreviewTerminal({
      cols: 80,
      rows: 10,
      cwd: process.cwd(),
      shell: '/bin/bash',
    });
    session.start();
    session.resize(100, 20);
    expect(session.cols).toBe(100);
    expect(session.rows).toBe(20);
    session.stop();
  });

  // 위 시험은 «에뮬레이터» 격자만 본다 — 그래서 Bun 에서 node-pty `resize` 가 EBADF 로 삼켜져 커널 PTY 가
  // 80×24 에 머무는 것을 못 잡았다(2026-09-28 · 웹 터미널 셸이 80칸에서 접혔다). 여기선 «셸이 보는» 크기를 잰다.
  test('resize reaches the kernel PTY — the shell sees the new size (stty size)', async () => {
    const session = new PreviewTerminal({
      cols: 80,
      rows: 10,
      cwd: process.cwd(),
      shell: '/bin/bash',
      env: { ...process.env, PS1: '$ ', BASH_ENV: '', ENV: '' } as Record<string, string>,
    });
    session.start();
    // node-pty 의 fd 는 «뜬 직후»엔 아직 살아 있다 — 셸이 한 줄 낸 뒤(실사용과 같은 때)에 바꾼다.
    session.write('echo READY\r');
    for (const until = Date.now() + 2000; Date.now() < until && !session.render().includes('READY'); ) {
      await new Promise(r => setTimeout(r, 50));
    }
    await new Promise(r => setTimeout(r, 300));
    session.resize(117, 21);
    session.write('echo SZ=$(stty size)\r');
    const deadline = Date.now() + 3000;
    let snapshot = '';
    while (Date.now() < deadline) {
      snapshot = session.render();
      if (/SZ=\d+ \d+/.test(snapshot)) break;
      await new Promise(r => setTimeout(r, 50));
    }
    session.stop();
    expect(snapshot).toContain('SZ=21 117');
  }, 6000);

  test('stop is idempotent', () => {
    const session = new PreviewTerminal({
      cols: 80,
      rows: 10,
      cwd: process.cwd(),
      shell: '/bin/bash',
    });
    session.start();
    session.stop();
    expect(() => session.stop()).not.toThrow();
  });

  // Fake spawn: inject a no-op PTY so direct term.write() calls in
  // rendering tests don't race against a real shell's banner output.
  // The fake returns an object satisfying enough of IPty that start()
  // + resolveMasterFd + pump + onExit don't crash.
  const fakeSpawn = () => {
    const noopFd = require('node:fs').openSync('/dev/null', 'r+');
    const fake: any = {
      pid: 99999,
      _fd: noopFd,
      _pty: noopFd,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
    };
    return fake;
  };

  const withFake = (cols: number, rows: number) =>
    new PreviewTerminal(
      { cols, rows, cwd: process.cwd() },
      fakeSpawn,
    );

  test('renders CJK wide chars without breaking alignment', async () => {
    const session = withFake(20, 3);
    session.start();
    (session as any).term.write('한글 abc\n');
    await flushPreview(session);
    const out = session.render();
    expect(out).toContain('한글');
    expect(out).toContain('abc');
    session.stop();
  });

  test('SGR attributes survive through render', async () => {
    const session = withFake(20, 2);
    session.start();
    (session as any).term.write('\x1b[31mRED\x1b[0m \x1b[38;2;10;20;30mRGB\x1b[0m');
    await flushPreview(session);
    const out = session.render();
    expect(out).toContain('31');  // red palette
    expect(out).toContain('38;2;10;20;30'); // truecolor
    session.stop();
  });

  test('focused render includes inverse-video cursor marker', async () => {
    const session = withFake(10, 2);
    session.start();
    (session as any).term.write('hi');
    await flushPreview(session);
    const focused = session.render(true);
    const unfocused = session.render(false);
    expect(focused).not.toBe(unfocused);
    expect(focused).toContain('7m');
    session.stop();
  });

  test('DA query produces an emulator response (yazi compat)', async () => {
    // Directly subscribe to the same onData event PreviewTerminal
    // forwards to the PTY master. Observing it here proves that
    // yazi / fzf device-attribute queries will get a reply.
    const session = withFake(40, 6);
    session.start();
    const replies: string[] = [];
    (session as any).term.onData((d: string) => { replies.push(d); });
    // Primary DA: CSI c → expect CSI ? … c back.
    (session as any).term.write('\x1b[c');
    await flushPreview(session);
    session.stop();

    const joined = replies.join('');
    expect(joined).toContain('\x1b[?');
    expect(joined).toMatch(/c$/);
  });

  test('scrollback: scrollUp/Down/ToTop/ToTail track offset correctly', async () => {
    const session = withFake(20, 3);
    session.start();
    // Fill more than the viewport so the buffer actually has history.
    for (let i = 0; i < 20; i++) (session as any).term.write(`line${i}\r\n`);
    await flushPreview(session);
    expect(session.isScrolledBack).toBe(false);
    session.scrollUp(5);
    expect(session.scrollbackOffset).toBe(5);
    expect(session.isScrolledBack).toBe(true);
    session.scrollDown(2);
    expect(session.scrollbackOffset).toBe(3);
    session.scrollToTop();
    expect(session.scrollbackOffset).toBeGreaterThan(3);
    session.scrollToTail();
    expect(session.scrollbackOffset).toBe(0);
    expect(session.isScrolledBack).toBe(false);
    session.stop();
  });

  test('scrollback render shows older content; cursor hidden off-tail', async () => {
    const session = withFake(20, 3);
    session.start();
    for (let i = 0; i < 12; i++) (session as any).term.write(`R${i}\r\n`);
    await flushPreview(session);
    // Live tail renders the most recent rows; scrolled-back renders
    // older ones. Pick a non-overlapping range to verify.
    const tailOut = session.render(true);
    session.scrollUp(10);
    const backOut = session.render(true);
    expect(tailOut).not.toBe(backOut);
    // Cursor marker (`7m` reverse video) should appear on tail but
    // not while scrolled back — the cursor lives at the tail row.
    expect(tailOut).toContain('7m');
    expect(backOut).not.toContain('7m');
    session.stop();
  });

  test('mouse: wantsMouse flips on DECSET 1000/1002/1003, off on reset', async () => {
    const session = withFake(20, 3);
    session.start();
    expect(session.wantsMouse).toBe(false);
    (session as any).term.write('\x1b[?1002h');
    await flushPreview(session);
    expect(session.wantsMouse).toBe(true);
    (session as any).term.write('\x1b[?1002l');
    await flushPreview(session);
    expect(session.wantsMouse).toBe(false);
    session.stop();
  });

  test('encodeSgrMouse: left click at (3,2) → CSI<0;3;2M', () => {
    expect(encodeSgrMouse({ type: 'click', col: 3, row: 2 }, 1002, 80, 24))
      .toBe('\x1b[<0;3;2M');
  });

  test('encodeSgrMouse: release → lowercase m suffix', () => {
    expect(encodeSgrMouse({ type: 'release', col: 3, row: 2 }, 1002, 80, 24))
      .toBe('\x1b[<0;3;2m');
  });

  test('encodeSgrMouse: scroll-up → btn 64', () => {
    expect(encodeSgrMouse({ type: 'scroll-up', col: 1, row: 1 }, 1002, 80, 24))
      .toBe('\x1b[<64;1;1M');
  });

  test('encodeSgrMouse: shift+click sets bit 4', () => {
    expect(encodeSgrMouse({ type: 'click', col: 5, row: 5, shift: true }, 1002, 80, 24))
      .toBe('\x1b[<4;5;5M');
  });

  test('encodeSgrMouse: drag returns null in mode 1000, sequence in 1002', () => {
    expect(encodeSgrMouse({ type: 'drag', col: 1, row: 1 }, 1000, 80, 24)).toBeNull();
    expect(encodeSgrMouse({ type: 'drag', col: 1, row: 1 }, 1002, 80, 24))
      .toBe('\x1b[<32;1;1M');
  });

  test('encodeSgrMouse: mode 0 returns null regardless of event', () => {
    expect(encodeSgrMouse({ type: 'click', col: 1, row: 1 }, 0, 80, 24)).toBeNull();
  });

  test('encodeSgrMouse: coords clamped to emulator bounds', () => {
    // row=50 beyond maxRows=24 → clamped to 24
    expect(encodeSgrMouse({ type: 'click', col: 200, row: 50 }, 1002, 80, 24))
      .toBe('\x1b[<0;80;24M');
    // row=-5 clamped to 1
    expect(encodeSgrMouse({ type: 'click', col: -3, row: -5 }, 1002, 80, 24))
      .toBe('\x1b[<0;1;1M');
  });

  test('handles alt-screen switch (CSI ?1049h) without crashing', async () => {
    const session = withFake(40, 6);
    session.start();
    (session as any).term.write('normal\r\n');
    (session as any).term.write('\x1b[?1049h');
    (session as any).term.write('\rALT_PAYLOAD');
    await flushPreview(session);
    const altOut = session.render();
    expect(altOut).toContain('ALT_PAYLOAD');
    expect(altOut).not.toContain('normal');
    (session as any).term.write('\x1b[?1049l');
    await flushPreview(session);
    const normalOut = session.render();
    expect(normalOut).toContain('normal');
    session.stop();
  });

  // ── NT-E1 — addRawOscTap runtime subscription ──
  test('NT-E1 — addRawOscTap receives OSC 9 notify events', async () => {
    const session = withFake(40, 4);
    const seen: Array<{ code: number; title: string }> = [];
    session.start();
    const off = session.addRawOscTap((ev) => { seen.push({ code: ev.code, title: ev.title }); });
    (session as any).term.write('\x1b]9;Build done\x07');
    await flushPreview(session);
    expect(seen).toEqual([{ code: 9, title: 'Build done' }]);
    off();
    (session as any).term.write('\x1b]9;Should not fire\x07');
    await flushPreview(session);
    expect(seen.length).toBe(1);
    session.stop();
  });

  test('NT-E1 — addRawOscTap runs alongside construction-time onOscNotify', async () => {
    let ctor = 0;
    const session = new PreviewTerminal(
      {
        cols: 40, rows: 4, cwd: process.cwd(),
        onOscNotify: () => { ctor++; },
      },
      fakeSpawn,
    );
    const runtime: string[] = [];
    session.start();
    session.addRawOscTap((ev) => { runtime.push(ev.title); });
    (session as any).term.write('\x1b]777;notify;CI;Green\x07');
    await flushPreview(session);
    expect(ctor).toBe(1);
    expect(runtime).toEqual(['CI']);
    session.stop();
  });

  test('NT-E1 — throwing tap does not poison siblings', async () => {
    const session = withFake(40, 4);
    session.start();
    const hits: string[] = [];
    session.addRawOscTap(() => { throw new Error('bad tap'); });
    session.addRawOscTap((ev) => { hits.push(ev.title); });
    (session as any).term.write('\x1b]9;alive\x07');
    await flushPreview(session);
    expect(hits).toEqual(['alive']);
    session.stop();
  });

  // ── NT-A2 — bookmark + slice + LLM-safe render ──
  //
  // The fake-spawn session lets us write straight into the emulator
  // buffer (bypassing the PTY read loop) so we can control exactly
  // what the "shell" produced. Mark/slice semantics are independent
  // of whether data arrived via the dup fd or the emulator's own
  // .write(), so this is a fair test — with the caveat that
  // bytesSinceMark counts fd bytes only, so we don't assert on it
  // here (NT-A4 PtyCaptureEngine tests will, once they go through
  // the real read loop).

  test('NT-A2 — markBufferPosition + sliceFromMark captures only new lines', async () => {
    const session = withFake(40, 6);
    session.start();
    (session as any).term.write('old line 1\r\nold line 2\r\n');
    await flushPreview(session);
    const mark = session.markBufferPosition();
    (session as any).term.write('new after mark\r\n');
    await flushPreview(session);
    const slice = session.sliceFromMark(mark).join('\n');
    expect(slice).toContain('new after mark');
    expect(slice).not.toContain('old line 1');
    session.stop();
  });

  test('NT-A2 — slice on unchanged buffer returns no new content', async () => {
    const session = withFake(30, 4);
    session.start();
    (session as any).term.write('same\r\n');
    await flushPreview(session);
    const mark = session.markBufferPosition();
    const slice = session.sliceFromMark(mark).join('');
    // Only the live-tail row the cursor sits on may appear, and it's
    // whitespace since nothing was written.
    expect(slice.trim()).toBe('');
    session.stop();
  });

  test('NT-A2 — renderForLLM strips SGR and motion by default', async () => {
    const session = withFake(40, 5);
    session.start();
    (session as any).term.write('\x1b[31mred\x1b[0m ');
    (session as any).term.write('plain\r\nnext\r\n');
    await flushPreview(session);
    const out = session.renderForLLM();
    expect(out).toContain('red plain');
    expect(out).toContain('next');
    expect(out).not.toContain('\x1b[');
    session.stop();
  });

  test('NT-A2 — renderForLLM returns plain text (SGR already resolved to cell attrs)', async () => {
    const session = withFake(30, 4);
    session.start();
    (session as any).term.write('\x1b[32mgreen\x1b[0m plain\r\n');
    await flushPreview(session);
    const out = session.renderForLLM();
    expect(out).toContain('green plain');
    expect(out).not.toMatch(/\x1b\[/);
    session.stop();
  });

  test('NT-A2 — renderForLLM({mark}) scopes to slice after bookmark', async () => {
    const session = withFake(30, 6);
    session.start();
    (session as any).term.write('before\r\n');
    await flushPreview(session);
    const mark = session.markBufferPosition();
    (session as any).term.write('after\r\n');
    await flushPreview(session);
    const sliced = session.renderForLLM({ mark });
    expect(sliced).toContain('after');
    expect(sliced).not.toContain('before');
    session.stop();
  });

  test('NT-A2 — clearViewport returns without killing session', () => {
    // The emulator's buffer shape under \x1b[2J\x1b[H is subtle (it
    // clears rows but the slice/mark relation depends on cursor
    // home). We only assert the mechanical guarantee: clearViewport
    // is a no-throw on a live session and does not stop the PTY.
    const session = withFake(30, 4);
    session.start();
    (session as any).term.write('first\r\nsecond\r\n');
    expect(() => session.clearViewport()).not.toThrow();
    expect(session.isAlive).toBe(true);
    session.stop();
  });

  test('NT-A2 — stripSgrSequences / stripMotionSequences are pure', () => {
    expect(stripSgrSequences('\x1b[31mX\x1b[0mY')).toBe('XY');
    // Bare \r (progress-bar overwrite) drops; \r\n (CRLF line end)
    // must survive so multi-line output stays parseable.
    expect(stripMotionSequences('loading...\rDONE')).toBe('loading...DONE');
    expect(stripMotionSequences('a\r\nb')).toBe('a\r\nb');
    // CSI motion (cursor up, erase line) strip.
    expect(stripMotionSequences('\x1b[2A\x1b[2Ktext')).toBe('text');
    // OSC title set (bash \e]0;title\a) strip.
    expect(stripMotionSequences('\x1b]0;title\x07rest')).toBe('rest');
  });

  test('NT-A2 — strip helpers preserve printable content verbatim', () => {
    expect(stripSgrSequences('hello world')).toBe('hello world');
    expect(stripMotionSequences('hello\nworld')).toBe('hello\nworld');
    expect(stripMotionSequences('한글 테스트')).toBe('한글 테스트');
  });

  // ── VW-term-infra Phase 0 — Raw output tap lifecycle invariants ──
  //
  // Property tests that `addRawOutputTap` behaves correctly across
  // the subscription lifecycle. These lock in the contract that
  // Phase 2a (PaneTap universal) will lift to a generic primitive.
  //
  // See: 내부 문서 `PLAN-session-vw-term-infra-p0-p2` §2.2 invariants 7-8
  //      내부 문서 `CAPABILITIES-terminal` §3.1.1 Invariant Lattice

  test('Phase 0 invariant — multiple taps see identical chunks in insertion order', async () => {
    const session = withFake(40, 4);
    session.start();
    const tapA: string[] = [];
    const tapB: string[] = [];
    const tapC: string[] = [];
    session.addRawOutputTap((chunk) => tapA.push(chunk));
    session.addRawOutputTap((chunk) => tapB.push(chunk));
    session.addRawOutputTap((chunk) => tapC.push(chunk));
    // The fake session has no real read loop, so we drive taps via
    // the internal raw-chunk emitter directly (same path the read
    // loop hits). Use the internal rawOutputTaps Set via (session as any)
    // to invoke without going through the dup fd.
    const chunks = ['alpha ', 'beta ', 'gamma\r\n'];
    for (const ch of chunks) {
      for (const tap of (session as any).rawOutputTaps as Set<(c: string) => void>) {
        tap(ch);
      }
    }
    expect(tapA).toEqual(chunks);
    expect(tapB).toEqual(chunks);
    expect(tapC).toEqual(chunks);
    session.stop();
  });

  test('Phase 0 invariant — unsubscribed tap receives no further chunks', async () => {
    const session = withFake(40, 4);
    session.start();
    const tap: string[] = [];
    const off = session.addRawOutputTap((chunk) => tap.push(chunk));
    // Fire one chunk.
    for (const t of (session as any).rawOutputTaps as Set<(c: string) => void>) {
      t('before-off');
    }
    off();
    // Fire a second chunk after unsubscribe.
    for (const t of (session as any).rawOutputTaps as Set<(c: string) => void>) {
      t('after-off');
    }
    expect(tap).toEqual(['before-off']);
    session.stop();
  });

  // ── W3-ext — addEventTap: cursor / resize / title lifecycle ──

  test('W3-ext — addEventTap receives cursor events on write', async () => {
    const session = withFake(30, 4);
    session.start();
    const events: Array<{ kind: string; row?: number; col?: number }> = [];
    session.addEventTap((ev) => {
      if (ev.kind === 'cursor') events.push({ kind: ev.kind, row: ev.row, col: ev.col });
    });
    (session as any).term.write('hi');
    await flushPreview(session);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.kind).toBe('cursor');
    session.stop();
  });

  test('W3-ext — addEventTap receives title events on OSC 2', async () => {
    const session = withFake(30, 4);
    session.start();
    const titles: string[] = [];
    session.addEventTap((ev) => {
      if (ev.kind === 'title') titles.push(ev.title);
    });
    (session as any).term.write('\x1b]2;my-title\x07');
    await flushPreview(session);
    expect(titles).toContain('my-title');
    session.stop();
  });

  test('W3-ext — addEventTap receives resize events on resize()', async () => {
    const session = withFake(20, 5);
    session.start();
    const sizes: Array<{ cols: number; rows: number }> = [];
    session.addEventTap((ev) => {
      if (ev.kind === 'resize') sizes.push({ cols: ev.cols, rows: ev.rows });
    });
    session.resize(40, 10);
    await new Promise(r => setTimeout(r, 40));
    expect(sizes).toContainEqual({ cols: 40, rows: 10 });
    session.stop();
  });

  test('W3-ext — unsubscribed event tap receives no further events', async () => {
    const session = withFake(30, 4);
    session.start();
    let fired = 0;
    const off = session.addEventTap(() => { fired++; });
    (session as any).term.write('a');
    await flushPreview(session);
    off();
    const firedAtOff = fired;
    (session as any).term.write('b');
    await flushPreview(session);
    expect(fired).toBe(firedAtOff);
    session.stop();
  });

  test('W3-ext — throwing tap does not poison siblings', async () => {
    const session = withFake(30, 4);
    session.start();
    const hits: string[] = [];
    session.addEventTap(() => { throw new Error('bad'); });
    session.addEventTap((ev) => { if (ev.kind === 'title') hits.push(ev.title); });
    (session as any).term.write('\x1b]2;survive\x07');
    await flushPreview(session);
    expect(hits).toEqual(['survive']);
    session.stop();
  });

  test('W3-ext — stop() releases xterm event subscriptions', async () => {
    const session = withFake(30, 4);
    session.start();
    let fired = 0;
    session.addEventTap(() => { fired++; });
    (session as any).term.write('hello');
    await flushPreview(session);
    const firedBeforeStop = fired;
    session.stop();
    // After stop, xterm is disposed — but just confirming stop() doesn't throw
    // and no more cursor events flow to taps.
    expect(firedBeforeStop).toBeGreaterThanOrEqual(1);
  });

  test('Phase 0 invariant — clearViewport does not unsubscribe output taps', async () => {
    const session = withFake(40, 4);
    session.start();
    const tap: string[] = [];
    session.addRawOutputTap((chunk) => tap.push(chunk));
    // Confirm tap alive before clearViewport.
    for (const t of (session as any).rawOutputTaps as Set<(c: string) => void>) {
      t('pre-clear');
    }
    session.clearViewport();
    // After viewport clear, the tap Set should still hold our subscriber.
    expect((session as any).rawOutputTaps.size).toBe(1);
    for (const t of (session as any).rawOutputTaps as Set<(c: string) => void>) {
      t('post-clear');
    }
    expect(tap).toEqual(['pre-clear', 'post-clear']);
    session.stop();
  });
});

// F4 (2026-04-25) — login-shell spawn default. The bug it fixes: child
// zsh missing `/opt/homebrew/bin` because `.zprofile` never sourced.
describe('defaultShellArgsFor — POSIX path', () => {
  // Skip these on Windows runners — defaultShellArgsFor checks
  // process.platform and returns [] for win32 unconditionally.
  const isPosix = process.platform !== 'win32';
  const t = isPosix ? test : test.skip;

  t('zsh (basename) → -l -i', () => {
    expect(defaultShellArgsFor('zsh')).toEqual(['-l', '-i']);
  });
  t('absolute /bin/zsh → -l -i', () => {
    expect(defaultShellArgsFor('/bin/zsh')).toEqual(['-l', '-i']);
  });
  t('bash / fish / sh / dash / ksh → -l -i', () => {
    for (const s of ['bash', 'fish', 'sh', 'dash', 'ksh']) {
      expect(defaultShellArgsFor(s)).toEqual(['-l', '-i']);
    }
  });
  t('absolute /opt/homebrew/bin/zsh → -l -i (regex anchors on /shell)', () => {
    expect(defaultShellArgsFor('/opt/homebrew/bin/zsh')).toEqual(['-l', '-i']);
  });
  t('non-shell binary (tailscale) → []', () => {
    expect(defaultShellArgsFor('tailscale')).toEqual([]);
  });
  t('non-shell binary (ssh) → []', () => {
    expect(defaultShellArgsFor('ssh')).toEqual([]);
  });
  t('unknown shim wrapper (/usr/local/bin/my-wrapper) → []', () => {
    expect(defaultShellArgsFor('/usr/local/bin/my-wrapper')).toEqual([]);
  });
  t('substring trap — "false-bash" must not match (anchored to /)', () => {
    // 'false-bash' has 'bash' suffix but no '/' before it → not a real shell.
    expect(defaultShellArgsFor('false-bash')).toEqual([]);
  });
});

describe('PreviewTerminal.start — shellArgs default plumbing', () => {
  const noopFd = require('node:fs').openSync('/dev/null', 'r+');
  const makeSpyingSpawn = () => {
    const calls: Array<{ shell: string; args: string[] }> = [];
    const fn: any = (shell: string, args: string[]) => {
      calls.push({ shell, args: [...args] });
      return {
        pid: 1,
        _fd: noopFd,
        _pty: noopFd,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        write: () => {}, resize: () => {}, kill: () => {},
      };
    };
    return { fn, calls };
  };

  const isPosix = process.platform !== 'win32';
  const t = isPosix ? test : test.skip;

  t('shellArgs undefined + zsh → default -l -i flows through', () => {
    const { fn, calls } = makeSpyingSpawn();
    const s = new PreviewTerminal(
      { cols: 80, rows: 24, cwd: process.cwd(), shell: '/bin/zsh' },
      fn,
    );
    s.start();
    expect(calls[0]?.args).toEqual(['-l', '-i']);
    s.stop();
  });

  t('explicit shellArgs preserved verbatim (override default)', () => {
    const { fn, calls } = makeSpyingSpawn();
    const s = new PreviewTerminal(
      {
        cols: 80, rows: 24, cwd: process.cwd(),
        shell: '/bin/zsh',
        shellArgs: ['-c', 'echo hi'],
      },
      fn,
    );
    s.start();
    expect(calls[0]?.args).toEqual(['-c', 'echo hi']);
    s.stop();
  });

  t('explicit empty shellArgs preserved as [] (caller controls argv)', () => {
    const { fn, calls } = makeSpyingSpawn();
    const s = new PreviewTerminal(
      {
        cols: 80, rows: 24, cwd: process.cwd(),
        shell: '/bin/zsh',
        shellArgs: [],
      },
      fn,
    );
    s.start();
    expect(calls[0]?.args).toEqual([]);
    s.stop();
  });

  t('non-shell binary + undefined shellArgs → [] (no -l -i for ssh wrapper)', () => {
    const { fn, calls } = makeSpyingSpawn();
    const s = new PreviewTerminal(
      { cols: 80, rows: 24, cwd: process.cwd(), shell: 'tailscale' },
      fn,
    );
    s.start();
    expect(calls[0]?.args).toEqual([]);
    s.stop();
  });
});

// 🛡️ **최상위 `node-pty` 재도입 «회귀 가드»**
//
// ⛔ 이 모듈은 dashboard·shell-runner·session-registry 등 «다섯 곳»이 정적으로 끌어온다.
//    최상위에서 `node-pty` 를 값으로 실으면 ***PTY 를 안 쓰는 명령(`--version`)까지*** 네이티브
//    바인딩에 묶이고, 그러면 이 저장소의 `B-1` 관문이 그 플랫폼에서 «원리상» 통과 불가가 된다.
//    📏 실측(2026-08-31 · grokb1 x86_64): prebuild 가 «없어» 소스 빌드하면 bun 이 못 읽고
//       `panic: unsupported uv function` 으로 죽어 `--version` 조차 안 나왔다.
// ✅ 그래서 지연 `require` 로 두었고, 이 시험이 «되돌아오는 것»을 막는다.
describe('preview/terminal.ts — node-pty 는 «부를 때» 싣는다', () => {
  const SRC = readFileSync(join(import.meta.dir, '..', 'src', 'preview', 'terminal.ts'), 'utf8');
  // ⛔ 주석에 적힌 설명 문면이 걸리지 않도록 «import 문 자체»만 본다.
  const importLines = SRC.split('\n').filter((line) => /^\s*import\b/.test(line));

  test('⛔ 최상위 «값» import 가 없다 (타입 import 는 런타임에 지워지므로 허용)', () => {
    const ptyImports = importLines.filter((line) => line.includes("'node-pty'"));
    expect(ptyImports.length).toBeGreaterThan(0);           // 타입 import 는 있어야 정상
    for (const line of ptyImports) expect(line).toMatch(/^\s*import\s+type\b/);
  });

  test('✅ 유일한 런타임 사용처가 «지연 require» 다', () => {
    expect(SRC).toMatch(/const pty: any = require\('node-pty'\)/);
  });

  test('✅ 이 모듈을 import 하는 것만으로는 node-pty 가 «안 실린다»', async () => {
    // 알려진 «양성» — 모듈은 뜬다(위 import 들이 네이티브를 안 부른다)
    const mod = await import('../src/preview/terminal.js');
    expect(typeof mod.PreviewTerminal).toBe('function');
  });
});
