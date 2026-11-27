// ELS-ATTACH sim — seeded scenarios over the sidechat world (REAL registry + attach apps, fake clock): the Obsidian popup's
// `a` hands the selected note to an agent pane through the REAL serveElnAttach with a fake listing (eln · claude · codex ·
// shell panes, focus varied per seed) and a fake PTY insert. Invariants per frame (sidechat-world frameViolations: rows,
// width in cells, status line) and per insert: never a CR/LF, only attach-capable targets, the runtime's own form
// («@path» quoted when needed), a toast that says where it went or «No open eln». Fake vault copy per seed.
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachToast, serveElnAttach, type AttachListingRow } from '../../../els/eln-attach.js';
import type { OverlayRegistry } from '../../../els/overlay-registry.js';
import { createSidechatWorld, type SidechatViewer, type SidechatWorld } from './sidechat-world.js';

const SEEDS = [1, 2, 3, 4, 5, 6] as const;
const roots: string[] = [];
const worlds: SidechatWorld[] = [];
afterAll(() => { for (const one of worlds) one.dispose(); for (const dir of roots) rmSync(dir, { recursive: true, force: true }); });
const plain = (rows: readonly string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''));
const text = (v: SidechatViewer): string => plain(v.last()).join('\n');

const KINDS = ['eln', 'claude', 'codex', 'shell'] as const;
interface AttachWorld { readonly w: SidechatWorld; readonly vault: string; readonly inserts: Array<[string, string]>; readonly rows: AttachListingRow[]; readonly focus: string | undefined }

function world(seed: number, rowsFor: (rand: SidechatWorld['rand']) => { rows: AttachListingRow[]; focus?: string }): AttachWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `attach-sim-${seed}-`)));
  roots.push(root);
  const source = join(root, 'fake-vault');
  mkdirSync(join(source, 'Projects'), { recursive: true });
  writeFileSync(join(source, 'Projects', 'els plan.md'), '# plan\n');
  writeFileSync(join(source, 'Welcome.md'), '# Welcome\n');
  writeFileSync(join(source, '회의.md'), '# 회의\n');
  const vault = join(root, 'vault-copy');
  cpSync(source, vault, { recursive: true });
  const inserts: Array<[string, string]> = [];
  let made: { rows: AttachListingRow[]; focus?: string } = { rows: [] };
  const w = createSidechatWorld(seed, (registry: OverlayRegistry) => ({ vault,
    attach: (path, src) => { void serveElnAttach({ stateDir: join(root, 'els'), vault: () => vault,
      listing: () => ({ panes: made.rows, workspaces: [{ id: 'w1', name: 'demo' }], ...(made.focus ? { lastFocus: { workspaceId: 'w1', paneId: made.focus } } : {}) }),
      insert: async (pane, line) => { inserts.push([pane, line]); return { exitCode: 0, message: '' }; } }, { path, source: src })
      .then((result) => { registry.apply({ action: 'open', kind: 'toast', props: attachToast(result) }); }); } }));
  made = rowsFor(w.rand);
  worlds.push(w);
  return { w, vault, inserts, rows: made.rows, focus: made.focus };
}
const pane = (id: string, kind: string, at: number): AttachListingRow => ({ pane: id, workspace: 'demo', title: `${kind.toUpperCase()}-${id}`, kind, state: 'idle', ptyId: `h:${id}`, lastEventAtMs: at });

async function openViewer(t: AttachWorld, size: { cols: number; rows: number }): Promise<SidechatViewer> {
  const v = await t.w.viewer(size);
  t.w.registry.apply({ action: 'open', kind: 'obsidian', props: {} });
  await t.w.flush();
  return v;
}
const sizes = [{ cols: 120, rows: 30 }, { cols: 80, rows: 24 }, { cols: 200, rows: 50 }, { cols: 64, rows: 18 }] as const;

describe('A1 · `a` on a note in the list → the focused agent pane gets «@path » (its runtime\'s form), a toast names it', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed, (rand) => {
      const rows = KINDS.map((kind, at) => pane(`p${at}`, kind, rand.int(1, 1000)));
      const able = rows.filter((one) => one.kind !== 'shell');
      return { rows, focus: able[rand.int(0, able.length - 1)]!.pane };
    });
    const v = await openViewer(t, sizes[t.w.rand.int(0, sizes.length - 1)]!);
    // Pick a note: Welcome or 회의 (folders first: Projects/ is row 0).
    const downs = t.w.rand.int(1, 2);
    for (let at = 0; at < downs; at++) v.press('j');
    await t.w.flush();
    v.press('a');
    await t.w.flush(); await t.w.flush();
    const target = t.rows.find((one) => one.pane === t.focus)!;
    const note = downs === 1 ? 'Welcome.md' : '회의.md';
    const path = join(t.vault, note);
    expect(t.inserts).toEqual([[target.pane, note === '회의.md' ? `@"${path}" ` : `@${path} `]]);
    expect(text(v)).toContain(`Attached to ${target.title}`);
    for (const [, line] of t.inserts) expect(/[\r\n]/.test(line)).toBe(false);
    expect(v.typed()).toEqual([]);                                             // nothing typed into the pane under the popup
    expect(v.violations).toEqual([]);
  });
});

describe('A2 · no attach-capable pane (only shells, or nothing) → «No open eln», nothing inserted', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed, (rand) => ({ rows: rand.int(0, 1) ? [pane('s1', 'shell', 5), pane('o1', 'other', 9)] : [] }));
    const v = await openViewer(t, sizes[t.w.rand.int(0, sizes.length - 1)]!);
    v.press('j', 'a');
    await t.w.flush(); await t.w.flush();
    expect(t.inserts).toEqual([]);
    expect(text(v)).toContain('No open eln');
    expect(v.violations).toEqual([]);
  });
});

describe('A3 · an open note (Projects/els plan.md, a space in the name) → quoted «@"…" »; no focus → the last-used agent', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed, (rand) => ({ rows: [pane('e', 'eln', rand.int(1, 100)), pane('c', 'claude', rand.int(101, 200)), pane('x', 'codex', rand.int(1, 100)), pane('s', 'shell', 999)] }));
    const v = await openViewer(t, sizes[t.w.rand.int(0, sizes.length - 1)]!);
    v.press('\r');                                                              // into Projects/
    await t.w.flush();
    v.press('\r');                                                              // open «els plan.md»
    await t.w.flush();
    expect(text(v)).toContain('plan');
    v.press('a');
    await t.w.flush(); await t.w.flush();
    expect(t.inserts).toEqual([['c', `@"${join(t.vault, 'Projects', 'els plan.md')}" `]]);   // claude has the newest event
    expect(text(v)).toContain('Attached to CLAUDE-c');
    expect(v.violations).toEqual([]);
  });
});

describe('A4 · `a` on a folder does nothing; `a` while typing a new-note title is text', () => {
  for (const seed of SEEDS) test(`seed ${seed}`, async () => {
    const t = world(seed, () => ({ rows: [pane('e', 'eln', 5)], focus: 'e' }));
    const v = await openViewer(t, sizes[t.w.rand.int(0, sizes.length - 1)]!);
    v.press('a');                                                               // cursor on Projects/
    await t.w.flush();
    expect(t.inserts).toEqual([]);
    v.press('n', 'a', 'b');
    await t.w.flush();
    expect(text(v)).toMatch(/New note[^\n]*ab▏/);
    expect(t.inserts).toEqual([]);
    expect(v.violations).toEqual([]);
  });
});
