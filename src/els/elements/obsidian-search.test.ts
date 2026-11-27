// ELS-OBSIDIAN-SEARCH: bounded, vault-clamped, read-only search; the pure search line and its keys; the viewer wiring.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanQuery, renderSearch, searchKey, searchVault, SEARCH_CAPS } from './obsidian-search.js';
import { hydrateObsidian, obsidianKey, obsidianProps, renderObsidian, type ObsidianProps } from './obsidian-view.js';
import { createObsidianTab } from '../obsidian-tab.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
let root = '';
let vault = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'els-obs-search-'));
  vault = join(root, 'Vault');
  mkdirSync(join(vault, 'Projects', 'Deep'), { recursive: true });
  mkdirSync(join(vault, '.obsidian'), { recursive: true });
  mkdirSync(join(root, 'outside'), { recursive: true });
  writeFileSync(join(vault, 'Roadmap.md'), '# Roadmap\n\nship the search box\n');
  writeFileSync(join(vault, 'Projects', 'Search plan.md'), '# Plan\n');
  writeFileSync(join(vault, 'Projects', 'Deep', 'Notes.md'), 'intro\n  the SEARCH line is here\nend\n');
  writeFileSync(join(vault, 'Keys.md'), 'token: OPENAI_API_KEY=sk-proj-FAKEfake0123456789FAKEfake0123 search\n');
  writeFileSync(join(vault, '.obsidian', 'search.md'), 'search hidden\n');
  writeFileSync(join(vault, 'image.png'), 'search');
  writeFileSync(join(root, 'outside', 'Leak.md'), 'search secret outside\n');
  symlinkSync(join(root, 'outside'), join(vault, 'linked-folder'));
  symlinkSync(join(root, 'outside', 'Leak.md'), join(vault, 'Leak link.md'));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test('names first, then text hits with the matching line; dot folders, non-notes and links out of the vault are never read', () => {
  const found = searchVault(realpathSync(vault), 'search');
  expect(found.capped).toBe(false);
  expect(found.hits.map((hit) => `${hit.kind}:${hit.path}`)).toEqual([
    'name:Projects/Search plan.md', 'text:Keys.md', 'text:Roadmap.md', 'text:Projects/Deep/Notes.md']);
  expect(found.hits.find((hit) => hit.path === 'Roadmap.md')?.snippet).toBe('ship the search box');
  expect(found.hits.find((hit) => hit.path === 'Projects/Deep/Notes.md')?.snippet).toBe('the SEARCH line is here');
  // the snippet goes through the shared secret redaction
  expect(found.hits.find((hit) => hit.path === 'Keys.md')?.snippet).not.toContain('FAKEfake0123456789');
  expect(JSON.stringify(found)).not.toContain('outside');
});

test('one letter matches names only; blank = nothing', () => {
  expect(searchVault(realpathSync(vault), 'r').hits.map((hit) => hit.path)).toEqual(['Roadmap.md', 'Projects/Search plan.md']);
  expect(searchVault(realpathSync(vault), '   ')).toEqual({ hits: [], capped: false });
});

test('caps: files scanned, depth, bytes per file, total bytes and wall time each stop the walk and say so', () => {
  const base = realpathSync(vault);
  expect(searchVault(base, 'search', { ...SEARCH_CAPS, files: 2 }).capped).toBe(true);
  const shallow = searchVault(base, 'search', { ...SEARCH_CAPS, depth: 1 });
  expect(shallow.capped).toBe(true);
  expect(shallow.hits.map((hit) => hit.path)).not.toContain('Projects/Deep/Notes.md');
  // the match in Notes.md sits after 8 bytes: a 6-byte head misses it
  expect(searchVault(base, 'search', { ...SEARCH_CAPS, fileBytes: 6 }).hits.map((hit) => hit.path)).toEqual(['Projects/Search plan.md']);
  expect(searchVault(base, 'search', { ...SEARCH_CAPS, totalBytes: 1 }).capped).toBe(true);
  let clock = 0;
  const slow = searchVault(base, 'search', SEARCH_CAPS, () => (clock += 100));
  expect(slow.capped).toBe(true);
  expect(searchVault(base, 'search', { ...SEARCH_CAPS, hits: 1 }).hits).toHaveLength(1);
});

test('cleanQuery refuses control characters and long input', () => {
  expect(cleanQuery('plan')).toBe('plan');
  expect(cleanQuery('a\u001b[2J')).toBeUndefined();
  expect(cleanQuery('x'.repeat(129))).toBeUndefined();
  expect(cleanQuery(3)).toBeUndefined();
});

test('search keys: type · ⌫ · ctrl+u · ↑/↓ · Enter opens · Esc leaves · other control keys are kept', () => {
  const hits = [{ path: 'a.md', kind: 'name' as const }, { path: 'b/c.md', kind: 'text' as const, snippet: 'x' }];
  expect(searchKey({ search: 'pl' }, 'a')).toEqual({ search: 'pla', searchAt: 0 });
  expect(searchKey({ search: 'pl' }, '\u007f')).toEqual({ search: 'p', searchAt: 0 });
  expect(searchKey({ search: '' }, '\u007f')).toBe('consumed');
  expect(searchKey({ search: 'pl' }, '\u0015')).toEqual({ search: '', searchAt: 0 });
  expect(searchKey({ search: 'pl', hits }, '\u001b[B')).toEqual({ search: 'pl', searchAt: 1 });
  expect(searchKey({ search: 'pl', searchAt: 1, hits }, '\u001b[B')).toEqual({ search: 'pl', searchAt: 1 });
  expect(searchKey({ search: 'pl', searchAt: 1, hits }, '\u001b[A')).toEqual({ search: 'pl', searchAt: 0 });
  expect(searchKey({ search: 'pl', searchAt: 1, hits }, '\r')).toEqual({ open: 'b/c.md' });
  expect(searchKey({ search: 'pl' }, '\r')).toBe('consumed');
  expect(searchKey({ search: 'pl' }, '\u001b')).toBe('leave');
  expect(searchKey({ search: 'pl' }, '\u0001')).toBe('consumed');
  expect(searchKey({ search: '가' }, '나')).toEqual({ search: '가나', searchAt: 0 });
});

test('render: the filter line, names then text hits with a snippet, the selection, the hint', () => {
  const view = renderSearch({ search: 'pl', searchAt: 1, hits: [{ path: 'Projects/Plan.md', kind: 'name' }, { path: 'Road.md', kind: 'text', snippet: 'the plan line' }] }, 40, 5, true);
  expect(view.body.map(plain).map((row) => row.trimEnd())).toEqual(['/ pl', '  Plan  Projects/', '  Road  the plan line']);
  expect(view.body[2]!.startsWith('\u001b[7m')).toBe(true);
  expect(view.hint).toBe('type to filter · ↑/↓ move · Enter open · Esc leave search · 2/2');
  expect(plain(renderSearch({ search: '' }, 40, 5, true).body[1]!)).toBe('Type to search note names and text');
  expect(plain(renderSearch({ search: 'zz', hits: [] }, 40, 5, true).body[1]!)).toBe('No matches');
});

test('viewer: / opens search, typing hydrates hits, Enter opens the note, Esc leaves search back to the list', () => {
  let props: ObsidianProps = hydrateObsidian({ dir: '', cursor: 0, scroll: 0 }, vault);
  const step = (bytes: string) => { const next = obsidianKey(props, bytes, 5); if (next !== 'pass' && next !== 'consumed') props = hydrateObsidian(obsidianProps(JSON.parse(JSON.stringify(next)))!, vault); return next; };
  step('/');
  expect(props.search).toBe('');
  for (const char of 'plan') step(char);
  expect(props.hits?.map((hit) => hit.path)).toEqual(['Projects/Search plan.md']);
  const box = renderObsidian(props, { w: 50, h: 8 }, true).map(plain);
  expect(box[1]).toContain('/ plan');
  expect(box[2]).toContain('Search plan  Projects/');
  step('\r');
  expect([props.note, props.dir, props.search]).toEqual(['Projects/Search plan.md', 'Projects', undefined]);
  expect(props.text).toContain('# Plan');
  step('/'); step('x'); expect(step('\u001b')).not.toBe('pass');
  expect(props.search).toBeUndefined();
  expect(props.note).toBe('Projects/Search plan.md');
});

test('tab: in the search line q types and Esc leaves search; ctrl+c still ends the tab', () => {
  const tab = createObsidianTab({ vault: () => vault, write: () => {}, size: () => ({ cols: 60, rows: 10 }) });
  expect(tab.key('/')).toBe(false);
  expect(tab.key('q')).toBe(false);
  expect(tab.props().search).toBe('q');
  expect(tab.key('\u001b')).toBe(false);
  expect(tab.props().search).toBeUndefined();
  expect(tab.key('/')).toBe(false);
  expect(tab.key('\u0003')).toBe(true);
});
