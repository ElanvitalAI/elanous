import { expect, test } from 'bun:test';
import { dropLocalViewer, localViewerSize, noteLocalViewer, remoteResize } from './local-viewer-size.js';

/** A fake core whose «PTY» is one size per pane — what the child TUI would read with `stty size`. */
function fakeCore() {
  const pty = new Map<string, string>();
  return { pty, resize(ref: string, cols: number, rows: number) { pty.set(ref, `${cols}x${rows}`); return { exitCode: 0, message: `${cols}x${rows}` }; } };
}

test('the 04:57 case: a remote viewer cannot shrink a pane a local view is attached to', () => {
  const core = fakeCore();
  const local = {};
  core.resize('p1', 170, 58); noteLocalViewer(core, 'p1', local, { cols: 170, rows: 58 });
  const answer = remoteResize(core, 'p1', 120, 34);
  expect(answer.kept).toBe(true);
  expect(core.pty.get('p1')).toBe('170x58');
  expect(answer.result.message).toBe('170x58');
});

test('with no local view the remote size applies; after the local view ends it applies again', () => {
  const core = fakeCore();
  expect(remoteResize(core, 'p2', 120, 34).kept).toBe(false);
  expect(core.pty.get('p2')).toBe('120x34');
  const local = {};
  noteLocalViewer(core, 'p2', local, { cols: 200, rows: 59 });
  remoteResize(core, 'p2', 100, 30);
  expect(core.pty.get('p2')).toBe('200x59');
  dropLocalViewer(core, 'p2', local);
  expect(localViewerSize(core, 'p2')).toBeUndefined();
  remoteResize(core, 'p2', 100, 30);
  expect(core.pty.get('p2')).toBe('100x30');
});

test('two local views: the newest ask wins, and dropping it falls back to the other', () => {
  const core = fakeCore();
  const a = {}; const b = {};
  noteLocalViewer(core, 'p3', a, { cols: 150, rows: 40 });
  noteLocalViewer(core, 'p3', b, { cols: 199, rows: 58 });
  expect(localViewerSize(core, 'p3')).toEqual({ cols: 199, rows: 58 });
  dropLocalViewer(core, 'p3', b);
  expect(localViewerSize(core, 'p3')).toEqual({ cols: 150, rows: 40 });
  dropLocalViewer(core, 'p3', a); dropLocalViewer(core, 'p3', a);
  expect(localViewerSize(core, 'p3')).toBeUndefined();
});

/** Sim: random interleavings of local resize/fold/sidebar/attach/detach/exec and remote resizes. Invariant: whenever a
 *  local view is attached, the PTY equals that view's last asked size. */
function rng(seed: number): () => number { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
for (const seed of [3, 7, 11, 42]) {
  test(`sim seed ${seed}: the local view's size always holds while it is attached`, () => {
    const random = rng(seed);
    const core = fakeCore();
    let view: object | undefined;
    let asked = '';
    for (let step = 0; step < 400; step++) {
      const roll = random();
      if (roll < 0.15) { view = {}; const c = 100 + Math.floor(random() * 100); const r = 30 + Math.floor(random() * 30); core.resize('op', c, r); noteLocalViewer(core, 'op', view, { cols: c, rows: r }); asked = `${c}x${r}`; }   // attach
      else if (roll < 0.25 && view) { dropLocalViewer(core, 'op', view); view = undefined; }   // detach
      else if (roll < 0.5 && view) { const c = 100 + Math.floor(random() * 100); const r = 30 + Math.floor(random() * 30); core.resize('op', c, r); noteLocalViewer(core, 'op', view, { cols: c, rows: r }); asked = `${c}x${r}`; }   // resize / fold / sidebar
      else if (roll < 0.6) { /* in-place exec: the PTY keeps its winsize across execve — nothing to send */ }
      else remoteResize(core, 'op', 80 + Math.floor(random() * 40), 20 + Math.floor(random() * 15));   // remote viewer
      if (view) expect(core.pty.get('op')).toBe(asked);
    }
  });
}

import { createSizeReassert, noteResize, setResizeLog } from './local-viewer-size.js';

function clock() {
  let t = 0; const timers: { at: number; run: () => void; live: boolean }[] = [];
  return {
    now: () => t,
    schedule: (run: () => void, ms: number) => { const timer = { at: t + ms, run, live: true }; timers.push(timer); return { cancel: () => { timer.live = false; } }; },
    advance(ms: number) { const end = t + ms; for (;;) { const next = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!next) break; t = next.at; next.live = false; next.run(); } t = end; },
  };
}

test('els.pane.resize names who changed the size, once per real change', () => {
  const core = {}; const lines: string[] = [];
  setResizeLog(core, (line) => lines.push(line));
  noteResize(core, 'op', { cols: 200, rows: 82 }, 'viewer:local', 0);
  noteResize(core, 'op', { cols: 200, rows: 82 }, 'viewer:local', 1);
  noteResize(core, 'op', { cols: 200, rows: 49 }, 'host:mbp/p1', 2);
  expect(lines.length).toBe(2);
  expect(JSON.parse(lines[1]!)).toEqual({ event: 'els.pane.resize', at: '1970-01-01T00:00:00.002Z', pane: 'op', from: { cols: 200, rows: 82 }, to: { cols: 200, rows: 49 }, by: 'host:mbp/p1' });
});

test('re-assert: matching frames send nothing; a mismatch sends the pane rect once after 500 ms', () => {
  const c = clock(); const sent: string[] = [];
  const r = createSizeReassert({ send: (s) => sent.push(`${s.cols}x${s.rows}`), now: c.now, schedule: c.schedule });
  for (let i = 0; i < 20; i++) { r.frame('op', { cols: 200, rows: 82 }, { cols: 200, rows: 82 }); c.advance(100); }
  expect(sent).toEqual([]);
  r.frame('op', { cols: 200, rows: 49 }, { cols: 200, rows: 82 });
  c.advance(499); expect(sent).toEqual([]);
  r.frame('op', { cols: 200, rows: 49 }, { cols: 200, rows: 82 });
  c.advance(1); expect(sent).toEqual(['200x82']);
});

test('re-assert: a mismatch that heals inside the debounce sends nothing; focus switch cancels', () => {
  const c = clock(); const sent: string[] = [];
  const r = createSizeReassert({ send: (s) => sent.push(`${s.cols}x${s.rows}`), now: c.now, schedule: c.schedule });
  r.frame('op', { cols: 120, rows: 30 }, { cols: 200, rows: 82 }); c.advance(200);
  r.frame('op', { cols: 200, rows: 82 }, { cols: 200, rows: 82 }); c.advance(1000);
  r.frame('op', { cols: 120, rows: 30 }, { cols: 200, rows: 82 }); c.advance(200);
  r.reset(); c.advance(1000);
  expect(sent).toEqual([]);
});

for (const seed of [3, 7, 11, 42]) {
  test(`sim seed ${seed}: two local views, a remote viewer, focus switches, flapping — PTY ends at the focused rect, no storm`, () => {
    const random = rng(seed); const c = clock();
    let pty = { cols: 200, rows: 82 };
    const want = { cols: 200, rows: 82 };
    let winches = 0; let own = 0;
    const r = createSizeReassert({ send: (s) => { pty = { ...s }; winches++; own++; }, now: c.now, schedule: c.schedule });
    for (let step = 0; step < 600; step++) {
      const roll = random();
      if (roll < 0.1) { pty = { cols: 120, rows: 34 }; winches++; }                // second local view / remote viewer shrinks it
      else if (roll < 0.13) { r.reset(); }                                          // focus switch away and back
      else if (roll < 0.2) { pty = { cols: 150 + Math.floor(random() * 50), rows: 40 + Math.floor(random() * 40) }; winches++; }   // flapping
      r.frame('op', pty, want);                                                     // a frame every 100 ms
      c.advance(100);
    }
    // quiet tail: nobody else touches it for 40 s
    for (let i = 0; i < 400; i++) { r.frame('op', pty, want); c.advance(100); }
    expect(pty).toEqual({ cols: 200, rows: 82 });
    // the view's own re-asserts are bounded: ≤ 3 per 30 s over 100 s of fighting + tail → ≤ 15
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThanOrEqual(12);
    expect(winches).toBeGreaterThan(own);
  });
}

test('flapping storm: a fighter every 100 ms gets at most 3 re-asserts per 30 s', () => {
  const c = clock(); let sends = 0;
  const r = createSizeReassert({ send: () => { sends++; }, now: c.now, schedule: c.schedule });
  for (let i = 0; i < 300; i++) { r.frame('op', { cols: 120, rows: 34 }, { cols: 200, rows: 82 }); c.advance(100); }
  expect(sends).toBe(3);
});

import { claimSizeOwner, localResizeAllowed, isSizeOwner } from './local-viewer-size.js';

// ELS-OP-INPUT-FLICKER (대표 11-26 09:5x): live OP pane flipped 195x60 <-> 204x47 ~0.5 s apart on every keystroke (two local views).
test('two local views + one remote: last active view owns the size; typing and frames never oscillate', () => {
  const core = { resize: (_p: string, cols: number, rows: number) => { setPty({ cols, rows }); return { exitCode: 0 }; } };
  const c = clock(); let pty = { cols: 195, rows: 60 }; let winches = 0;
  const setPty = (size: { cols: number; rows: number }) => { if (pty.cols !== size.cols || pty.rows !== size.rows) winches++; pty = { ...size }; };
  const A = { v: 'A' }; const B = { v: 'B' };
  const want = new Map<object, { cols: number; rows: number }>([[A, { cols: 195, rows: 60 }], [B, { cols: 204, rows: 47 }]]);
  // server rules (serveAttach): attach = activity · input = activity · resize/re-assert only from the owner
  const attach = (v: object) => { claimSizeOwner(core, 'op', v); setPty(want.get(v)!); noteLocalViewer(core, 'op', v, want.get(v)!); };
  const input = (v: object) => { const moved = claimSizeOwner(core, 'op', v); if (moved) setPty(moved); };
  const resizeLine = (v: object, size: { cols: number; rows: number }) => { noteLocalViewer(core, 'op', v, size); if (localResizeAllowed(core, 'op', v)) setPty(size); };
  attach(A); attach(B); attach(A);     // B attached later, then the person went back to A
  winches = 0;
  const rA = createSizeReassert({ send: (s) => resizeLine(A, s), now: c.now, schedule: c.schedule });
  const rB = createSizeReassert({ send: (s) => resizeLine(B, s), now: c.now, schedule: c.schedule });
  const frames = () => { for (const [v, r] of [[A, rA], [B, rB]] as const) { if (!isSizeOwner(core, 'op', v)) r.reset(); else r.frame('op', pty, want.get(v)!); } };
  for (let i = 0; i < 600; i++) { if (i % 3 === 0) input(A); frames(); c.advance(100); }   // type in A for a minute
  expect(winches).toBe(0); expect(pty).toEqual({ cols: 195, rows: 60 });
  // an idle remote (mobile) viewer asks for its size: the local owner's size is kept
  expect(remoteResize(core, 'op', 90, 30).kept).toBe(true); expect(pty).toEqual({ cols: 195, rows: 60 });
  // the person types in B: size moves to B once, then stays while B keeps typing
  for (let i = 0; i < 300; i++) { if (i % 3 === 0) input(B); frames(); c.advance(100); }
  expect(winches).toBe(1); expect(pty).toEqual({ cols: 204, rows: 47 });
  expect(localViewerSize(core, 'op')).toEqual({ cols: 204, rows: 47 });
  // the owner leaves: the latest active remaining view (A) is promoted and its size comes back
  expect(dropLocalViewer(core, 'op', B)).toEqual({ cols: 195, rows: 60 });
  expect(isSizeOwner(core, 'op', A)).toBe(true);
  dropLocalViewer(core, 'op', A);
});
