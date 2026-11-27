// ELS-TAKEOUT — sidechat «take out» (ctrl+e → m/o/t, y/n confirm) and the Obsidian viewer's «new note» (n → title → y/n),
// end to end through the overlay registry with a fake model stream and temp folders (never a real vault). Literals only.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOverlayRegistry } from '../overlay-registry.js';
import { createSidechatHub, pushSidechat, type SidechatStream } from '../sidechat-hub.js';
import { newNoteKey, newNoteOf } from './obsidian-new-note.js';
import { hydrateObsidian, obsidianKey, obsidianProps, renderObsidian, type ObsidianProps } from './obsidian-view.js';
import { renderSidechat } from './sidechat.js';
import { takeoutKey, takeoutMarkdown, takeoutOf } from './takeout.js';
import { createObsidianTab } from '../obsidian-tab.js';
import { writeFileSync } from 'node:fs';

const dirs: string[] = [];
const temp = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'takeout-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tick = async (): Promise<void> => { for (let at = 0; at < 6; at++) await Promise.resolve(); await new Promise((done) => setImmediate(done)); };
const plain = (rows: readonly string[]): string[] => rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ''));

const answerStream: SidechatStream = async function* () { yield 'A monad is '; yield 'a **bind** + unit.'; };

async function world(options: { vault?: string; openTab?: (file: string, title: string) => string | undefined } = {}) {
  const state = temp();
  const toasts: Array<[string, string]> = [];
  let registry: ReturnType<typeof createOverlayRegistry> | undefined;
  const hub = createSidechatHub({ stream: answerStream, push: () => pushSidechat(registry) });
  registry = createOverlayRegistry({ dir: state, context: () => ({ sidechat: hub, stateDir: state, vault: options.vault, notify: (text, level) => { toasts.push([level, text]); }, ...(options.openTab ? { openTab: options.openTab } : {}) }) });
  const id = (JSON.parse(registry.apply({ action: 'open', kind: 'sidechat', props: {} }).message) as { id: string }).id;
  for (const text of ['What is a monad?']) registry.apply({ action: 'update', id, props: { input: '', edit: { kind: 'type', text } } });
  registry.apply({ action: 'update', id, props: { input: '', edit: { kind: 'send' } } });
  await tick(); await tick();
  const props = () => registry!.stack().layers.find((one) => one.id === id)!.props as Record<string, unknown>;
  /** One key as the attach client does it: the element reducer, then the update act with its answer. */
  const key = (bytes: string): unknown => {
    const answer = takeoutKey(props() as never, bytes);
    if (answer && typeof answer === 'object') registry!.apply({ action: 'update', id, props: answer });
    return answer;
  };
  return { state, toasts, registry, id, props, key };
}

describe('sidechat take-out', () => {
  test('ctrl+e opens the chooser, Esc cancels (holdEsc set while it shows, cleared after)', async () => {
    const w = await world();
    expect(w.props().turns).toEqual([{ q: 'What is a monad?', a: 'A monad is a **bind** + unit.' }]);
    w.key('\u0005');
    expect(w.props().takeout).toEqual({ step: 'choose' });
    expect(w.props().holdEsc).toBe(true);
    expect(plain(renderSidechat(w.props() as never, { w: 80, h: 10 }, true)).at(-2)).toContain('Take out: [m] memo · [o] Obsidian note · [t] new tab · Esc cancel');
    expect(w.key('\u001b')).toEqual({ input: '', takeout: null, holdEsc: false });
    expect(w.props().takeout).toBeUndefined();
    expect(w.props().holdEsc).toBeUndefined();
  });
  test('m saves the last answer as a memo under <state>/memos with a success toast', async () => {
    const w = await world();
    w.key('\u0005'); w.key('m');
    const files = readdirSync(join(w.state, 'memos'));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{8}-\d{6}-what-is-a-monad\.md$/);
    expect(readFileSync(join(w.state, 'memos', files[0]!), 'utf8')).toBe('# What is a monad?\n\nA monad is a **bind** + unit.\n');
    expect(w.toasts).toEqual([['success', `Memo saved: memos/${files[0]}`]]);
    expect(w.props().takeout).toBeUndefined();
  });
  test('o asks «Save to 00. Inbox/<name>.md? y/n» — n writes nothing, y writes once', async () => {
    const vault = temp();
    const w = await world({ vault });
    w.key('\u0005'); w.key('o');
    expect(w.props().takeout).toMatchObject({ step: 'obsidian', rel: '00. Inbox/What is a monad.md' });
    expect(plain(renderSidechat(w.props() as never, { w: 80, h: 10 }, true)).at(-2)).toContain('Save to 00. Inbox/What is a monad.md? y/n');
    expect(existsSync(join(vault, '00. Inbox'))).toBe(false);                    // nothing created before y
    w.key('n');
    expect(existsSync(join(vault, '00. Inbox'))).toBe(false);
    w.key('\u0005'); w.key('o');
    const confirmRow = w.props().takeout as Record<string, unknown>;
    w.key('y');
    expect(readFileSync(join(vault, '00. Inbox', 'What is a monad.md'), 'utf8')).toBe('# What is a monad?\n\nA monad is a **bind** + unit.\n');
    expect(w.toasts).toEqual([['success', 'Saved to 00. Inbox/What is a monad.md']]);
    // A repeated / replayed y (same token) writes nothing more.
    w.registry.apply({ action: 'update', id: w.id, props: { input: '', takeout: { ...confirmRow, go: true } } });
    expect(readdirSync(join(vault, '00. Inbox'))).toEqual(['What is a monad.md']);
    // A forged go with a token the server never minted writes nothing.
    w.registry.apply({ action: 'update', id: w.id, props: { input: '', takeout: { step: 'obsidian', rel: 'x', token: 'forged', go: true } } });
    expect(readdirSync(join(vault, '00. Inbox'))).toEqual(['What is a monad.md']);
  });
  test('o with the vault unset: a clean error toast, no row', async () => {
    const w = await world();
    w.key('\u0005'); w.key('o');
    expect(w.toasts).toEqual([['error', 'Not saved: Obsidian vault not set — elanous config set obsidian.vault <path>']]);
    expect(w.props().takeout).toBeUndefined();
  });
  test('t writes the memo and opens it in a tab via the context', async () => {
    const opened: Array<[string, string]> = [];
    const w = await world({ openTab: (file, title) => { opened.push([file, title]); return undefined; } });
    w.key('\u0005'); w.key('t');
    expect(opened.length).toBe(1);
    expect(opened[0]![0].startsWith(join(w.state, 'memos'))).toBe(true);
    expect(opened[0]![1]).toBe('▤ What is a monad?');
    expect(w.toasts).toEqual([['success', 'Opened in a new tab']]);
  });
  test('t without a tab opener: error toast', async () => {
    const w = await world();
    w.key('\u0005'); w.key('t');
    expect(w.toasts).toEqual([['error', 'Tab not opened: tabs open only in an els server']]);
  });
  test('ctrl+e with nothing answered yet, or while answering, does nothing', () => {
    expect(takeoutKey({ input: '', turns: [] }, '\u0005')).toBe('consumed');
    expect(takeoutKey({ input: '', turns: [{ q: 'a', a: 'b' }], status: 'streaming' }, '\u0005')).toBe('consumed');
    expect(takeoutKey({ input: '', turns: [{ q: 'a', a: '', error: 'x' }] }, '\u0005')).toBe('consumed');
    expect(takeoutKey({ input: 'x' }, 'q')).toBeUndefined();
  });
  test('props: rel/go are never taken without a token; junk is none', () => {
    expect(takeoutOf({ step: 'obsidian', rel: '../../etc', go: true })).toEqual({ step: 'obsidian' });
    expect(takeoutOf(null)).toBeUndefined();
    expect(takeoutOf({ step: 'rm' })).toBeUndefined();
    expect(takeoutMarkdown({ q: ' a\n b ', a: ' x ' })).toBe('# a b\n\nx\n');
  });
});

describe('Obsidian new note', () => {
  const vaultWith = (): string => { const v = temp(); mkdirSync(join(v, 'notes')); writeFileSync(join(v, 'notes', 'a.md'), '# a\n'); return v; };
  /** Keys through the reducer + hydrate (what the popup's server does per update). */
  const drive = (vault: string, keys: readonly string[], toasts: Array<[string, string]> = []): ObsidianProps => {
    let props = hydrateObsidian({ dir: '', cursor: 0, scroll: 0 }, vault);
    for (const bytes of keys) {
      const next = obsidianKey(props, bytes);
      if (next === 'pass' || next === 'consumed') continue;
      props = hydrateObsidian(obsidianProps(next)!, vault, (text, level) => { toasts.push([level, text]); });
    }
    return props;
  };
  test('n → title → Enter → y creates «00. Inbox/<title>.md» with a # title line and opens it', () => {
    const vault = vaultWith();
    const toasts: Array<[string, string]> = [];
    const asked = drive(vault, ['n', ...'Plan 회의', '\r']);
    expect(asked.create).toMatchObject({ title: 'Plan 회의', confirm: true, rel: '00. Inbox/Plan 회의.md' });
    expect(plain(renderObsidian(asked, { w: 70, h: 8 }, true)).at(-1)).toContain('Create 00. Inbox/Plan 회의.md? y/n');
    const done = drive(vault, ['n', ...'Plan 회의', '\r', 'y'], toasts);
    expect(readFileSync(join(vault, '00. Inbox', 'Plan 회의.md'), 'utf8')).toBe('# Plan 회의\n');
    expect(done.note).toBe('00. Inbox/Plan 회의.md');
    expect(done.notice).toBe('Created 00. Inbox/Plan 회의.md');
    expect(toasts).toEqual([['success', 'Created 00. Inbox/Plan 회의.md']]);
  });
  test('Esc or n cancels; nothing is written', () => {
    const vault = vaultWith();
    expect(drive(vault, ['n', 'x', '\u001b']).create).toBeUndefined();
    expect(drive(vault, ['n', 'x', '\r', 'n']).create).toBeUndefined();
    expect(existsSync(join(vault, '00. Inbox'))).toBe(false);
  });
  test('typing edits: Backspace, ctrl+u, an empty title cannot confirm', () => {
    const vault = vaultWith();
    expect(drive(vault, ['n', 'a', 'b', '\u007f']).create).toEqual({ title: 'a' });
    expect(drive(vault, ['n', 'a', '\u0015']).create).toEqual({ title: '' });
    expect(drive(vault, ['n', '\r']).create).toEqual({ title: '' });
  });
  test('a name collision gets -2; the vault unset gives a notice', () => {
    const vault = vaultWith();
    drive(vault, ['n', 'X', '\r', 'y']);
    expect(drive(vault, ['n', 'X', '\r']).create?.rel).toBe('00. Inbox/X-2.md');
    const none = hydrateObsidian(obsidianProps({ create: { title: 'X', confirm: true } })!, undefined);
    expect(none.notice).toBe('Not created: Obsidian vault not set — elanous config set obsidian.vault <path>');
    expect(none.create).toBeUndefined();
  });
  test('n inside an open note is not «new note»; q while typing is text', () => {
    expect(newNoteKey({ dir: '', cursor: 0, scroll: 0, note: 'a.md' }, 'n')).toBeUndefined();
    expect(newNoteKey({ dir: '', cursor: 0, scroll: 0, create: { title: '' } }, 'q')).toEqual({ dir: '', cursor: 0, scroll: 0, create: { title: 'q' }, holdEsc: true });
    expect(newNoteOf({ title: 'x', go: true, token: 'abc' })).toEqual({ title: 'x' });   // go needs confirm + token
  });
  test('the tab: q types into the title, then y creates; q quits otherwise', () => {
    const vault = vaultWith();
    const tab = createObsidianTab({ vault: () => vault, write: () => undefined, size: () => ({ cols: 80, rows: 20 }) });
    expect(tab.key('n')).toBe(false);
    for (const k of ['q', '1', '\r']) expect(tab.key(k)).toBe(false);
    expect(tab.key('y')).toBe(false);
    expect(readFileSync(join(vault, '00. Inbox', 'q1.md'), 'utf8')).toBe('# q1\n');
    expect(tab.key('q')).toBe(true);
  });
  test('the file tab shows one md read-only and scrolls', () => {
    const dir = temp();
    writeFileSync(join(dir, 'm.md'), '# Title\n\nbody\n');
    const tab = createObsidianTab({ vault: () => undefined, file: join(dir, 'm.md'), write: () => undefined, size: () => ({ cols: 60, rows: 10 }) });
    expect(tab.props().note).toBe('m.md');
    expect(tab.props().text).toBe('# Title\n\nbody\n');
    expect(tab.key('n')).toBe(false);
    expect(tab.props().create).toBeUndefined();
    expect(tab.key('\u007f')).toBe(false);                                      // no navigation away from the file
    expect(tab.props().note).toBe('m.md');
  });
});
