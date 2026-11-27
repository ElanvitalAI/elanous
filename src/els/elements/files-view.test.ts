import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanDir, isTextBytes, filesKey, filesProps, hydrateFiles, openCommand, renderFiles, type FilesProps } from './files-view.js';
import { files } from './files.js';
import { createFilesTab } from '../files-tab.js';
import { resolveWidget } from '../widget-registry.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-files-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, '프로젝트'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'README.md'), '# Title\n\nHello **bold** world.\n');
  writeFileSync(join(root, 'notes.txt'), Array.from({ length: 50 }, (_, at) => `line ${at + 1}`).join('\n'));
  writeFileSync(join(root, '.env'), 'API_KEY=do-not-show\n');
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255, 254, 65, 66]));
  writeFileSync(join(root, 'pic.png'), 'not really a png');
  writeFileSync(join(root, 'empty.txt'), '');
  writeFileSync(join(root, '가나다.md'), '# 한글 제목\n\n본문 줄\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(200_000));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const nav = (patch: Partial<FilesProps> = {}): FilesProps => ({ host: '', dir: root, cursor: 0, hidden: false, filter: '', filtering: false, scroll: 0, ...patch });
const at = (props: FilesProps, name: string): FilesProps => hydrateFiles({ ...props, cursor: props.entries!.findIndex((e) => e.name === name) });

test('props: absolute normalized dir only; data fields from a caller are dropped', () => {
  expect(cleanDir('relative/x')).toBeUndefined();
  expect(cleanDir('/a/b/../c/')).toBe('/a/c');
  expect(cleanDir('/a\0b')).toBeUndefined();
  expect(filesProps({ dir: 'nope' })).toBeUndefined();
  const props = filesProps({ dir: root, entries: [{ name: 'fake', dir: false }], preview: { name: 'x', kind: 'text', text: 'injected' } })!;
  expect(props).toEqual(nav());
});

test('hydrate: folders first, dotfiles hidden until «.», Korean names listed', () => {
  const props = hydrateFiles(nav());
  expect(props.entries!.map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`)).toEqual(['d:src', 'd:프로젝트', 'f:big.txt', 'f:blob.bin', 'f:empty.txt', 'f:notes.txt', 'f:pic.png', 'f:README.md', 'f:가나다.md']);
  const shown = hydrateFiles(filesKey(props, '.') as FilesProps);
  expect(shown.entries!.map((e) => e.name)).toContain('.env');
  expect(shown.entries!.map((e) => e.name)).toContain('.git');
});

test('preview kinds: markdown, text, binary hex, image placeholder, empty, dir, secret never read', () => {
  const props = hydrateFiles(nav({ hidden: true }));
  expect(at(props, 'README.md').preview).toMatchObject({ kind: 'markdown', text: '# Title\n\nHello **bold** world.\n' });
  expect(at(props, 'notes.txt').preview?.kind).toBe('text');
  expect(at(props, '가나다.md').preview).toMatchObject({ kind: 'markdown', text: '# 한글 제목\n\n본문 줄\n' });   // ends in a 3-byte syllable
  expect(isTextBytes(new TextEncoder().encode('본문 줄').subarray(0, 8))).toBe(true);                                   // cut mid-syllable by the window
  expect(isTextBytes(Uint8Array.from([0x41, 0xff, 0xfe, 0x41]))).toBe(false);
  const bin = at(props, 'blob.bin').preview!;
  expect(bin.kind).toBe('binary');
  expect(bin.text).toBe('00000000  00 01 02 03 ff fe 41 42                          ......AB');
  expect(at(props, 'pic.png').preview).toEqual({ name: 'pic.png', kind: 'image', size: 16 });
  expect(at(props, 'empty.txt').preview?.kind).toBe('empty');
  expect(at(props, 'src').preview).toEqual({ name: 'src', kind: 'dir', text: '  a.ts' });
  const secret = at(props, '.env').preview!;
  expect(secret).toEqual({ name: '.env', kind: 'secret', size: 20 });
  expect(JSON.stringify(at(props, '.env'))).not.toContain('do-not-show');
  const big = at(props, 'big.txt').preview!;
  expect(big.truncated).toBe(true);
  expect(big.text!.length).toBe(65_536);
});

test('permission denied and a missing folder say so instead of throwing', () => {
  const locked = join(root, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const props = hydrateFiles(nav({ dir: locked }));
    if (process.getuid?.() !== 0) expect(props.error).toBe(`${locked}: permission denied`);
  } finally { chmodSync(locked, 0o755); rmSync(locked, { recursive: true }); }
  expect(hydrateFiles(nav({ dir: join(root, 'gone') })).error).toBe(`${join(root, 'gone')}: not found`);
});

test('keys: j/k move, Enter into a folder, ⌫ up, / filter types, Enter ends the filter', () => {
  let props = hydrateFiles(nav());
  props = hydrateFiles(filesKey(props, 'j') as FilesProps);
  expect(props.entries![props.cursor]!.name).toBe('프로젝트');
  props = hydrateFiles(filesKey(props, 'k') as FilesProps);
  props = hydrateFiles(filesKey(props, '\r') as FilesProps);
  expect(props.dir).toBe(join(root, 'src'));
  props = hydrateFiles(filesKey(props, '\u007f') as FilesProps);
  expect(props.dir).toBe(root);
  props = hydrateFiles(filesKey(props, '/') as FilesProps);
  for (const ch of ['n', 'o', 't']) props = hydrateFiles(filesKey(props, ch) as FilesProps);
  expect(props.filter).toBe('not');
  expect(props.entries!.map((e) => e.name)).toEqual(['notes.txt']);
  props = hydrateFiles(filesKey(props, '\r') as FilesProps);
  expect(props.filtering).toBe(false);
  expect(filesKey(props, '\u007f')).toMatchObject({ filter: '' });       // ⌫ with a filter clears it first
  expect(filesKey({ ...props, filtering: true }, '\u001b')).toMatchObject({ filtering: false, filter: 'not' });   // Esc leaves the filter line
  expect(filesKey(props, '\u001b')).toBe('pass');                                                               // outside it: the app closes the popup
});

test('open asks: Enter pager tab · t tile · e editor · a eln attach · s sidechat with bounded context', () => {
  const props = at(hydrateFiles(nav()), 'README.md');
  const path = join(root, 'README.md');
  expect(filesKey(props, '\r')).toEqual({ open: { how: 'tab', tool: 'pager', path, title: '📄 README.md' } });
  expect(filesKey(props, 't')).toEqual({ open: { how: 'tile', tool: 'pager', path, title: '📄 README.md' } });
  expect(filesKey(props, 'e')).toEqual({ open: { how: 'tab', tool: 'editor', path, title: '📄 README.md' } });
  expect(filesKey(props, 'a')).toEqual({ open: { how: 'attach', tool: 'pager', path, title: '📄 README.md' } });
  expect(filesKey(props, 's')).toEqual({ open: { how: 'sidechat', tool: 'pager', path, title: '📄 README.md', context: `[file ${path}] # Title Hello **bold** world.` } });
});

test('openCommand: argv only (no shell), $PAGER / $EDITOR words, defaults less -R / vi', () => {
  expect(openCommand({ tool: 'pager', path: '/x/a b;rm -rf.txt' }, {})).toEqual(['less', '-R', '/x/a b;rm -rf.txt']);
  expect(openCommand({ tool: 'pager', path: '/x/a' }, { PAGER: 'bat --paging=always' })).toEqual(['bat', '--paging=always', '/x/a']);
  expect(openCommand({ tool: 'editor', path: '/x/a' }, { EDITOR: 'nvim' })).toEqual(['nvim', '/x/a']);
  expect(openCommand({ tool: 'editor', path: '/x/a' }, {})).toEqual(['vi', '/x/a']);
});

test('render: split list │ preview when wide, list alone when narrow; every row exactly the box width', () => {
  const props = at(hydrateFiles(nav()), 'README.md');
  const wide = renderFiles(props, { w: 100, h: 20 }, true);
  expect(wide).toHaveLength(20);
  for (const row of wide) expect(Bun.stringWidth(plain(row))).toBe(100);
  expect(plain(wide[1]!)).toContain('▸ src/');
  expect(wide.map(plain).join('\n')).toContain('Title');
  const narrow = renderFiles(props, { w: 40, h: 12 }, true);
  for (const row of narrow) expect(Bun.stringWidth(plain(row))).toBe(40);
  expect(narrow.map(plain).join('\n')).not.toContain('Hello');
  const korean = renderFiles(at(hydrateFiles(nav()), '가나다.md'), { w: 81, h: 10 }, false);
  for (const row of korean) expect(Bun.stringWidth(plain(row))).toBe(81);
});

test('element: key turns navigation into update, a file into open; tab hosts the same code; widget «files»', () => {
  const props = at(hydrateFiles(nav()), 'README.md');
  const layer = { id: 'ov1', kind: 'files', key: 'default', band: 'float' as const, seq: 1, rect: files.rect(props, 0), focus: 'owns' as const, props };
  expect(files.key!(layer, 'j')).toMatchObject({ update: { cursor: props.cursor + 1 } });
  expect(files.key!(layer, '\r')).toMatchObject({ open: { how: 'tab' } });
  expect(files.frames).toEqual(['popup', 'tab', 'tile']);
  const ran: string[][] = [];
  const out: string[] = [];
  const tab = createFilesTab({ dir: root, env: { PAGER: 'less' }, write: (t) => out.push(t), size: () => ({ cols: 80, rows: 24 }), run: (argv) => { ran.push([...argv]); } });
  tab.paint();
  expect(plain(out.at(-1)!)).toContain('src/');
  for (let i = 0; i < 7; i++) tab.key('j');
  expect(tab.props().entries![tab.props().cursor]!.name).toBe('README.md');
  tab.key('\r');
  expect(ran).toEqual([['less', join(root, 'README.md')]]);
  expect(tab.key('q')).toBe(true);
  expect(resolveWidget('파일')?.command({})).toEqual(['elanous', 'side', 'files']);
});
