import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hydrateObsidian, markdownRows, obsidianKey, obsidianProps, renderObsidian, wrapToWidth, keyHint } from './obsidian-view.js';
import { createObsidianTab } from '../obsidian-tab.js';
import { resolveWidget, widgetLaunch } from '../widget-registry.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
let root = '';
let vault = '';
let outside = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-obs-'));
  vault = join(root, 'Vault');
  outside = join(root, 'outside');
  mkdirSync(join(vault, 'Projects'), { recursive: true });
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(vault, 'Welcome.md'), '# Welcome\n\nHello **vault** with [[Projects/Plan|the plan]].\n\n- one\n- two\n\n```\ncode line\n```\n');
  writeFileSync(join(vault, 'Projects', 'Plan.md'), `# Plan\n\n${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')}\n`);
  writeFileSync(join(vault, 'image.png'), 'x');
  writeFileSync(join(outside, 'secret.md'), 'secret');
  symlinkSync(outside, join(vault, 'escape'));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test('hydrate lists folders first then .md notes; hidden folders and other files are left out', () => {
  const props = hydrateObsidian({ dir: '', cursor: 0, scroll: 0 }, vault);
  expect(props.vaultName).toBe('Vault');
  expect(props.entries?.map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`)).toEqual(['d:escape', 'd:Projects', 'f:Welcome.md']);
});

test('a symlink out of the vault is refused (folder and note)', () => {
  expect(hydrateObsidian({ dir: 'escape', cursor: 0, scroll: 0 }, vault).error).toBe('folder outside the vault');
  const note = hydrateObsidian({ dir: '', cursor: 0, scroll: 0, note: 'escape/secret.md' }, vault);
  expect(note.text).toBeUndefined();
  expect(note.error).toBe('note outside the vault');
});

test('no vault configured / missing vault = a clear message, never a throw', () => {
  expect(hydrateObsidian({ dir: '', cursor: 0, scroll: 0 }, undefined).error).toContain('obsidian.vault');
  expect(hydrateObsidian({ dir: '', cursor: 0, scroll: 0 }, join(root, 'nope')).error).toContain('not found');
  expect(plain(renderObsidian(hydrateObsidian({ dir: '', cursor: 0, scroll: 0 }, undefined), { w: 60, h: 6 }, true).join('\n'))).toContain('obsidian.vault');
});

test('obsidianProps takes navigation only and refuses .. and absolute paths', () => {
  expect(obsidianProps({ dir: 'Projects', cursor: 2, entries: [{ name: 'x', dir: false }], text: 'injected' })).toEqual({ dir: 'Projects', cursor: 2, scroll: 0 });
  expect(obsidianProps(undefined)).toEqual({ dir: '', cursor: 0, scroll: 0 });
  expect(obsidianProps({ dir: '../etc' })).toBeUndefined();
  expect(obsidianProps({ dir: '/etc' })).toBeUndefined();
  expect(obsidianProps({ note: 'a/../../b.md' })).toBeUndefined();
  expect(obsidianProps({ note: '' })).toBeUndefined();
  expect(obsidianProps({ cursor: -3, scroll: 1.5 })).toEqual({ dir: '', cursor: 0, scroll: 0 });
});

test('keys: j/k move the cursor, Enter opens a folder then a note, scroll, ⌫ back to the list, ⌫ up a folder', () => {
  let props = hydrateObsidian({ dir: '', cursor: 0, scroll: 0 }, vault);
  const step = (bytes: string) => { const next = obsidianKey(props, bytes, 5); if (next !== 'pass' && next !== 'consumed') props = hydrateObsidian(next, vault); return next; };
  step('j');
  expect(props.cursor).toBe(1);
  step('\r');
  expect(props.dir).toBe('Projects');
  step('\r');
  expect(props.note).toBe('Projects/Plan.md');
  expect(props.text).toContain('line 40');
  step('j'); step(' ');
  expect(props.scroll).toBe(6);
  step('k');
  expect(props.scroll).toBe(5);
  step('\u007f');
  expect(props.note).toBeUndefined();
  expect(props.dir).toBe('Projects');
  step('\u007f');
  expect(props.dir).toBe('');
  expect(step('\u007f')).toBe('pass');                 // at the root ⌫ is not ours
  expect(step('x')).toBe('pass');
  step('G');
  expect(props.cursor).toBe(2);
  step('g');
  expect(props.cursor).toBe(0);
  step('k');
  expect(props.cursor).toBe(0);
});

test('render: the list with the cursor in reverse video and a key hint; exactly h rows of w cells', () => {
  const props = hydrateObsidian({ dir: '', cursor: 2, scroll: 0 }, vault);
  const rows = renderObsidian(props, { w: 50, h: 8 }, true);
  expect(rows).toHaveLength(8);
  for (const row of rows) expect(Bun.stringWidth(plain(row))).toBe(50);
  const text = rows.map(plain);
  expect(text[0]).toContain('📓 Vault · /');
  expect(text.some((row) => row.includes('▸ Projects/'))).toBe(true);
  expect(rows.find((row) => plain(row).includes('Welcome'))).toContain('\u001b[7m');
  expect(text.at(-1)).toContain('Enter open');
});

test('render: an open note shows light markdown (heading, bullets, wiki link text, fence) and its position', () => {
  const props = hydrateObsidian({ dir: '', cursor: 2, scroll: 0, note: 'Welcome.md' }, vault);
  const text = renderObsidian(props, { w: 50, h: 14 }, true).map(plain);
  expect(text[0]).toContain('Welcome.md');
  expect(text.some((row) => row.includes('│Welcome'))).toBe(true);
  expect(text.some((row) => row.includes('Hello vault with the plan.'))).toBe(true);
  expect(text.some((row) => row.includes('• one'))).toBe(true);
  expect(text.some((row) => row.includes('code line'))).toBe(true);
  expect(text.at(-1)).toContain('⌫ back');
});

test('render never throws on tiny boxes', () => {
  const props = hydrateObsidian({ dir: '', cursor: 0, scroll: 0 }, vault);
  expect(renderObsidian(props, { w: 3, h: 2 }, false)).toHaveLength(2);
  expect(renderObsidian(props, { w: 10, h: 3 }, false)).toHaveLength(3);
});

test('wrapToWidth wraps by cells (wide glyphs count 2) and collapses blank runs; markdownRows strips wiki links', () => {
  expect(wrapToWidth('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc']);
  expect(wrapToWidth('가나다라', 5)).toEqual(['가나', '다라']);
  expect(wrapToWidth('a\n\n\n\nb', 5)).toEqual(['a', '', 'b']);
  expect(wrapToWidth('x', 0)).toEqual([]);
  expect(markdownRows('see [[Note]] and [[A|B]]', 40).map(plain)).toEqual(['see Note and B']);
});

test('the tab host paints, follows keys and ends on q / Esc', () => {
  const writes: string[] = [];
  const tab = createObsidianTab({ vault: () => vault, write: (text) => { writes.push(text); }, size: () => ({ cols: 60, rows: 12 }) });
  tab.paint();
  expect(plain(writes.at(-1)!)).toContain('Projects/');
  expect(tab.key('j')).toBe(false);
  expect(tab.props().cursor).toBe(1);
  expect(tab.key('\r')).toBe(false);
  expect(plain(writes.at(-1)!)).toContain('Plan');
  expect(tab.key('q')).toBe(true);
  expect(tab.key('\u001b')).toBe(true);
});

test('widget «obsidian» (and its aliases) opens the viewer tab', () => {
  expect(resolveWidget('옵시디언')?.name).toBe('obsidian');
  expect(resolveWidget('vault')?.name).toBe('obsidian');
  expect(widgetLaunch('obsidian', {})).toEqual({ ok: true, name: 'obsidian', title: '▦ obsidian', command: ['elanous', 'side', 'obsidian'] });
});

describe('keyHint — the position count survives a narrow footer', () => {
  test('fits: every key, then the count', () => {
    expect(keyHint(['j/k move', 'Enter open', 'n new', 'Esc close'], '3/30', 80)).toBe('j/k move · Enter open · n new · Esc close · 3/30');
  });
  test('narrow: keys before «Esc close» drop backwards; the first key, Esc close and the count stay', () => {
    expect(keyHint(['j/k move', 'Enter open', 'n new', 'a attach', '⌫ up', 'Esc close'], '3/30', 50)).toBe('j/k move · Enter open · n new · Esc close · 3/30');
    expect(keyHint(['j/k move', 'Enter open', 'n new', 'a attach', '⌫ up', 'Esc close'], '3/30', 10)).toBe('j/k move · Esc close · 3/30');
  });
});
