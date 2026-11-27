// ELS-POPUP-STYLE unit tests — the ONE popup style layer: simple (the element's own frame) and fancy (title bar · chip ·
// state light · shaded panel · speaker gutters · input well · lit hint footer · ▒ shadow), the config value → style rule
// (unknown → simple) and the live config source. Literal expectations: escape codes and glyphs are written out, never
// taken from the product's constants.
import { describe, expect, test } from 'bun:test';
import { renderSidechat, sidechat, type SidechatProps } from './elements/sidechat.js';
import { obsidian } from './elements/obsidian.js';
import { toast } from './elements/toast.js';
import { memo } from './elements/memo.js';
import { files } from './elements/files.js';
import { elementRenderers } from './elements/index.js';
import { fancyFrame, paintPopup, popupStyleOf, popupStyleSource } from './popup-style.js';

const renderSidechatPopup = (props: SidechatProps, size: { w: number; h: number }, focused: boolean): string[] => [...paintPopup(sidechat, props, size, focused, 'fancy')];
const dressSidechatRows = (rows: readonly string[], focused: boolean): string[] | undefined => fancyFrame(rows, focused, { chat: true });

const plain = (rows: readonly string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ''));
const cells = (rows: readonly string[]): number[] => rows.map((row) => Bun.stringWidth(row));

describe('fancy · sidechat', () => {
  test('a 60x22 box: exact size, title bar, chip, shadow on the right and bottom', () => {
    const rows = renderSidechatPopup({ input: '안녕', turns: [], status: 'idle' }, { w: 60, h: 22 }, true);
    expect(rows).toHaveLength(22);
    expect(cells(rows)).toEqual(Array(22).fill(60));
    const flat = plain(rows);
    expect(flat[0]!.startsWith('╭ ✦ Sidechat ')).toBe(true);
    expect(flat[0]!.endsWith(' ⚡ fast model ╮ ')).toBe(true);                // the chip on the right · the top-right cell hangs off
    expect(flat[20]!.endsWith('Enter send · Esc close ╯▒')).toBe(true);       // the hint words unchanged
    expect(flat[21]).toBe(` ${'▒'.repeat(59)}`);                              // the bottom-left cell hangs off
    for (const row of flat.slice(1, 21)) expect(row.endsWith('▒')).toBe(true);
    expect(rows[0]).toContain('\u001b[48;5;55m');                             // the filled bar
    expect(rows[1]).toContain('\u001b[48;5;235m');                            // the shaded panel
    expect(flat.find((row) => row.includes('› 안녕'))).toBeDefined();
    expect(rows.find((row) => plain([row])[0]!.includes('› 안녕'))).toContain('\u001b[48;5;233m');   // the input well
  });

  test('a 56x16 box (70% of 80x24): dressed, no shadow — the cells around it stay the layer below (the float hint line)', () => {
    const rows = renderSidechatPopup({ input: '', turns: [], status: 'idle' }, { w: 56, h: 16 }, true);
    expect(cells(rows)).toEqual(Array(16).fill(56));
    const flat = plain(rows);
    expect(flat.join('\n')).not.toContain('▒');
    expect(flat[0]!.startsWith('╭ ✦ Sidechat ')).toBe(true);
    expect(flat[15]!.endsWith('Enter send · Esc close ╯')).toBe(true);
  });

  test('title bar: the title words untouched, the state lit — thinking amber · answering green · timing grey', () => {
    const waiting = renderSidechatPopup({ input: '', turns: [{ q: 'q', a: '' }], status: 'waiting', typing: 2 }, { w: 60, h: 12 }, true);
    expect(plain(waiting)[0]).toContain('✦ Sidechat · ⠹ thinking…');
    expect(waiting[0]).toContain('\u001b[38;5;221m · ⠹ thinking…');
    const streaming = renderSidechatPopup({ input: '', turns: [{ q: 'q', a: 'a' }], status: 'streaming' }, { w: 60, h: 12 }, true);
    expect(plain(streaming)[0]).toContain('✦ Sidechat · answering…');
    expect(streaming[0]).toContain('\u001b[38;5;120m · answering…');
    const done = renderSidechatPopup({ input: '', turns: [{ q: 'q', a: 'a' }], status: 'idle', timing: { firstMs: 1200, totalMs: 3400 } }, { w: 80, h: 12 }, true);
    expect(plain(done)[0]).toContain('✦ Sidechat · 1.2s first token · 3.4s total');
    expect(done[0]).toContain('\u001b[38;5;246m · 1.2s first token');
    expect(plain(renderSidechatPopup({ input: '' }, { w: 60, h: 12 }, true))[0]).toMatch(/^╭ ✦ Sidechat +⚡ fast model ╮$/);
    // A narrow box: the title wins, the chip goes.
    const narrow = plain(renderSidechatPopup({ input: '', turns: [{ q: 'q', a: 'a' }], status: 'streaming', timing: { firstMs: 1200 } }, { w: 40, h: 10 }, true))[0]!;
    expect(narrow.startsWith('╭ ✦ Sidechat · answering… · 1.2s')).toBe(true);
    expect(narrow).not.toContain('fast model');
  });

  test('speaker gutters: the question ▌ on a bubble, the answer ▏, an error ▌ — the words keep their column', () => {
    const props = { input: '', turns: [{ q: 'els 가 뭐야?', a: '터미널 워크스페이스' }, { q: 'again', a: 'x', error: 'The model call failed' }], status: 'idle' as const };
    const rows = renderSidechatPopup(props, { w: 70, h: 20 }, true);
    const flat = plain(rows);
    const q = flat.findIndex((row) => row.includes('› els 가 뭐야?'));
    expect(flat[q]!.startsWith('│▌› els 가 뭐야?')).toBe(true);
    expect(rows[q]).toContain('\u001b[48;5;237m');
    expect(flat.find((row) => row.includes('터미널 워크스페이스'))!.startsWith('│▏터미널 워크스페이스')).toBe(true);
    expect(flat.find((row) => row.includes('⚠ The model call failed'))!.startsWith('│▌⚠ The model call failed')).toBe(true);
    // Same words as the plain frame (one cell narrower and one row shorter for the shadow), only the pad cell is a gutter.
    const bare = plain(renderSidechat(props, { w: 69, h: 19 }, true));
    const words = (rows: string[], cut: number): string[] => rows.filter((row) => row.startsWith('│')).map((row) => row.slice(2, -cut).trim());
    expect(words(flat.slice(1, 18), 2)).toEqual(words(bare.slice(1, 18), 1));
  });

  test('a scrolled transcript: rows above the first visible question are the answer (gutter), the empty state has none', () => {
    const long = Array.from({ length: 30 }, (_, at) => `line ${at}`).join('\n\n');
    const flat = plain(renderSidechatPopup({ input: '', turns: [{ q: 'q', a: long }], status: 'streaming' }, { w: 40, h: 12 }, true));
    expect(flat.find((row) => row.includes('line'))!.startsWith('│▏line')).toBe(true);
    const empty = plain(renderSidechatPopup({ input: '', turns: [], status: 'idle' }, { w: 70, h: 12 }, true));
    expect(empty.find((row) => row.includes('Ask anything'))!.startsWith('│ Ask anything')).toBe(true);
  });

  test('unfocused (another layer has the keys): the same shapes in grey', () => {
    const rows = renderSidechatPopup({ input: '' }, { w: 50, h: 10 }, false);
    expect(rows[0]).toContain('\u001b[48;5;238m');
    expect(rows[0]).not.toContain('\u001b[48;5;55m');
    expect(plain(rows)[0]).toContain('✦ Sidechat');
  });

  test('A1 context row keeps no speaker gutter; tiny boxes fall back to the plain frame; unknown rows refuse the dress', () => {
    const flat = plain(renderSidechatPopup({ input: '', context: { label: 'build log' }, turns: [{ q: 'q', a: 'a' }], status: 'idle' }, { w: 50, h: 12 }, true));
    expect(flat[1]!.startsWith('│ context: build log')).toBe(true);
    const tiny = renderSidechatPopup({ input: '' }, { w: 20, h: 6 }, true);
    expect(plain(tiny)).toEqual(plain(renderSidechat({ input: '' }, { w: 20, h: 6 }, true)));
    expect(dressSidechatRows(['not a frame', 'x'], true)).toBeUndefined();
  });

  test('the element stays centered at 70% x 70%; its own render is the simple frame', () => {
    expect(sidechat.rect({ input: '' }, 0)).toEqual({ anchor: 'center', w: '70%', h: '70%' });
    expect(plain(sidechat.render({ input: '' }, { w: 56, h: 16 }, true))[0]!.startsWith('╭─ Sidechat')).toBe(true);
  });
});

describe('narrow boxes keep every cell for the text', () => {
  test('below 56 cells: dressed, no shadow, the full box for the words', () => {
    const rows = renderSidechatPopup({ input: '' }, { w: 44, h: 12 }, true);
    expect(cells(rows)).toEqual(Array(12).fill(44));
    const flat = plain(rows);
    expect(flat.join('\n')).not.toContain('▒');
    expect(flat[0]!.startsWith('╭ ✦ Sidechat')).toBe(true);
    expect(flat[11]!.endsWith('Esc close ╯')).toBe(true);
  });
});

describe('simple (the default) · the switch · unknown values', () => {
  const vault = { dir: '', cursor: 0, scroll: 0, vaultName: 'vault', entries: [{ name: 'Projects', dir: true }, { name: 'Welcome.md', dir: false }] };
  test('simple = the element frame as it draws it, byte for byte', () => {
    expect(paintPopup(sidechat, { input: 'x' }, { w: 56, h: 16 }, true, 'simple')).toEqual(renderSidechat({ input: 'x' }, { w: 56, h: 16 }, true));
    expect(paintPopup(obsidian, vault as never, { w: 64, h: 18 }, true, 'simple')).toEqual(obsidian.render(vault as never, { w: 64, h: 18 }, true));
  });
  test('fancy obsidian: ✦ title bar with its own words, panel, lit hints, shadow — no chip, no speaker gutters', () => {
    // A box wide enough for the whole hint line (the viewer's hints grow as features land — #40291 added «a attach»).
    const rows = paintPopup(obsidian, vault as never, { w: 100, h: 22 }, true, 'fancy');
    expect(cells(rows)).toEqual(Array(22).fill(100));
    const flat = plain(rows);
    expect(flat[0]).toMatch(/^╭ ✦ 📓 vault · \/ +╮ $/);
    expect(flat[1]!.startsWith('│▸ Projects/')).toBe(true);
    expect(flat[20]!.startsWith('╰─')).toBe(true);
    expect(flat[20]).toContain(' j/k move · Enter open · ');
    expect(flat[20]!.endsWith('Esc close · 1/2 ╯▒')).toBe(true);
    expect(flat[21]).toBe(` ${'▒'.repeat(99)}`);
    expect(rows[2]).toContain('\u001b[48;5;235m');
  });
  test('every registered popup but the toast wears the fancy frame (memo too)', () => {
    const props = memo.props({ text: 'buy milk' })!;
    const fancy = plain(paintPopup(memo, props, { w: 60, h: 14 }, true, 'fancy'));
    expect(fancy[0]!.startsWith('╭ ✦ ')).toBe(true);
    expect(fancy.join('\n')).toContain('buy milk');
    expect(plain(paintPopup(memo, props, { w: 60, h: 14 }, true, 'simple'))[0]!.startsWith('╭─')).toBe(true);
  });
  test('the file browser and the Obsidian note editor wear it too (same switch)', () => {
    const browse = plain(paintPopup(files, files.props({ dir: '/nonexistent-els-style' })!, { w: 70, h: 12 }, true, 'fancy'));
    expect(browse[0]!.startsWith('╭ ✦ 📁 /nonexistent-els-style')).toBe(true);
    expect(browse[11]!.endsWith('╯')).toBe(true);
    const editing = { ...vault, note: 'n.md', text: 'a', editor: { rel: 'n.md', lines: ['hello note'], row: 0, col: 0, top: 0, dirty: true, mode: 'edit' } };
    const fancy = plain(paintPopup(obsidian, editing as never, { w: 60, h: 12 }, true, 'fancy'));
    expect(fancy[0]!.startsWith('╭ ✦ ')).toBe(true);
    expect(fancy.join('\n')).toContain('hello note');
    expect(plain(paintPopup(obsidian, editing as never, { w: 60, h: 12 }, true, 'simple'))[0]!.startsWith('┌')).toBe(true);
  });
  test('an element without a dress (toast) is always its own frame', () => {
    expect(paintPopup(toast, { text: 'Build done', level: 'success' }, { w: 30, h: 3 }, true, 'fancy')).toEqual(toast.render({ text: 'Build done', level: 'success' }, { w: 30, h: 3 }, true));
  });
  test('config value → style: only «simple» and «fancy» are names; anything else is simple', () => {
    expect(popupStyleOf('fancy')).toBe('fancy');
    expect(popupStyleOf(' fancy ')).toBe('fancy');
    expect(popupStyleOf('simple')).toBe('simple');
    for (const raw of [undefined, null, '', 'Fancy', 'neon', 1, true, { style: 'fancy' }]) expect(popupStyleOf(raw)).toBe('simple');
  });
  test('the renderers read the style at every paint: one flip changes every dressed popup', () => {
    let style: 'simple' | 'fancy' = 'simple';
    const renderers = elementRenderers(() => style);
    const layer = (kind: string, props: unknown) => ({ id: kind, kind, key: 'default', band: 'popup' as const, seq: 1, rect: { anchor: 'center' as const, w: 10, h: 10 }, focus: 'owns' as const, props });
    const sc = layer('sidechat', { input: '', turns: [], status: 'idle' });
    const ob = layer('obsidian', vault);
    expect(plain(renderers.sidechat!(sc, { w: 60, h: 14 }, true))[0]).not.toContain('✦');
    expect(plain(renderers.obsidian!(ob, { w: 60, h: 14 }, true))[0]).not.toContain('✦');
    style = 'fancy';
    expect(plain(renderers.sidechat!(sc, { w: 60, h: 14 }, true))[0]).toContain('✦ Sidechat');
    expect(plain(renderers.obsidian!(ob, { w: 60, h: 14 }, true))[0]).toContain('✦ 📓 vault');
  });
  test('the live source: re-reads only when the file stamp changes, at most once per interval; unknown/broken → simple', () => {
    let clock = 0;
    let stamp: number | undefined = 1;
    let value: unknown = 'fancy';
    let reads = 0;
    const source = popupStyleSource({ now: () => clock, everyMs: 1000, stamp: () => stamp, read: () => { reads++; return value; } });
    expect(source.get()).toBe('fancy');
    value = 'simple'; stamp = 2;
    expect(source.get()).toBe('fancy');                                   // inside the interval: no look
    clock = 1000;
    expect(source.get()).toBe('simple');                                  // stamp changed: re-read
    clock = 2000;
    expect(source.get()).toBe('simple');
    expect(reads).toBe(2);                                                // same stamp: no read
    value = 'neon'; stamp = 3; clock = 3000;
    expect(source.get()).toBe('simple');
    stamp = undefined; clock = 4000;                                      // the config file is gone
    value = undefined;
    expect(source.get()).toBe('simple');
    const broken = popupStyleSource({ now: () => 0, stamp: () => 1, read: () => { throw new Error('bad json'); } });
    expect(broken.get()).toBe('simple');
  });
});
