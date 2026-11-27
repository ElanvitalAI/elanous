// ELS-ATTACH — target pick, path resolution (vault clamp · remote cache · size cap), insertion through the adapter (never
// Enter), failure answers, the client helper. Fake listing / insert / remote (no ssh, no network). Literals only.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachPanes, attachToast, elnAttachPayload, pickAttachTarget, pickElnPane, requestElnAttach, serveElnAttach, type AttachListingRow, type ElnAttachDeps } from './eln-attach.js';

const dirs: string[] = [];
const temp = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eln-attach-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const row = (pane: string, kind: string, extra: Partial<AttachListingRow> = {}): AttachListingRow => ({ pane, workspace: 'demo', title: `T-${pane}`, kind, state: 'idle', ptyId: `h:${pane}`, ...extra });

function deps(rows: AttachListingRow[], opts: { focus?: string; vault?: string; remote?: Buffer | Error; refuse?: string } = {}) {
  const inserted: Array<[string, string]> = [];
  const state = temp();
  const d: ElnAttachDeps = {
    stateDir: state,
    listing: () => ({ panes: rows, workspaces: [{ id: 'w1', name: 'demo' }, { id: 'w2', name: 'other' }], ...(opts.focus ? { lastFocus: { workspaceId: 'w1', paneId: opts.focus } } : {}) }),
    insert: async (pane, text) => { if (opts.refuse) return { exitCode: 1, message: `els input: ${opts.refuse}; nothing sent` }; inserted.push([pane, text]); return { exitCode: 0, message: '' }; },
    vault: () => opts.vault,
    fetchRemote: async () => { if (opts.remote instanceof Error) throw opts.remote; return opts.remote ?? Buffer.from('remote body'); },
  };
  return { d, inserted, state };
}

describe('pick', () => {
  const panes = [
    { pane: 'a', ws: 'demo', isEln: true, lastInputAt: 10 },
    { pane: 'b', ws: 'demo', isEln: true, lastInputAt: 30 },
    { pane: 'c', ws: 'other', isEln: true, lastInputAt: 99 },
    { pane: 's', ws: 'demo', isEln: false, lastInputAt: 100 },
  ];
  test('explicit → focused → last-used in ws → none', () => {
    expect(pickAttachTarget(panes, { explicit: 'c', focused: 'a' })).toBe('c');
    expect(pickAttachTarget(panes, { explicit: 's' })).toBeUndefined();          // a shell is not a target
    expect(pickAttachTarget(panes, { focused: 'a', ws: 'demo' })).toBe('a');
    expect(pickAttachTarget(panes, { focused: 's', ws: 'demo' })).toBe('b');
    expect(pickAttachTarget(panes, { ws: 'other' })).toBe('c');
    expect(pickAttachTarget(panes, { ws: 'empty' })).toBeUndefined();
    expect(pickElnPane).toBe(pickAttachTarget);
  });
  test('attachPanes keeps live attach-capable agents only', () => {
    expect(attachPanes([row('e', 'eln'), row('c', 'claude'), row('x', 'codex', { state: 'exited' }), row('z', 'shell'), row('o', 'other'), row('d', 'claude', { ptyId: '' })]).map((one) => [one.pane, one.runtime]))
      .toEqual([['e', 'eln'], ['c', 'claude']]);
  });
  test('payload is path-based', () => {
    expect(elnAttachPayload({ path: '/a.md', bytes: 3, isText: true, text: 'abc' })).toEqual({ mode: 'path', text: '/a.md' });
  });
});

describe('serveElnAttach', () => {
  test('a local file into the focused Claude Code pane as «@path » — no Enter', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'my note.md'), '# hi\n');
    const { d, inserted } = deps([row('p1', 'claude'), row('p2', 'eln', { lastEventAtMs: 5 })], { focus: 'p1' });
    const result = await serveElnAttach(d, { path: join(dir, 'my note.md'), source: 'files' });
    expect(result).toEqual({ ok: true, pane: 'p1', title: 'T-p1', mode: 'path', bytes: 5, runtime: 'claude', inserted: `@"${join(dir, 'my note.md')}" ` });
    expect(inserted).toEqual([['p1', `@"${join(dir, 'my note.md')}" `]]);
  });
  test('vault-relative (source obsidian) resolves inside the vault; «..» and a symlink escape are refused', async () => {
    const vault = temp();
    const outside = temp();
    mkdirSync(join(vault, 'Projects'));
    writeFileSync(join(vault, 'Projects', 'els.md'), 'x');
    writeFileSync(join(outside, 'secret.md'), 's');
    symlinkSync(join(outside, 'secret.md'), join(vault, 'link.md'));
    const { d, inserted } = deps([row('p2', 'codex')], { vault });
    expect(await serveElnAttach(d, { path: 'Projects/els.md', source: 'obsidian' })).toMatchObject({ ok: true, pane: 'p2', runtime: 'codex', inserted: `@${join(vault, 'Projects', 'els.md')} ` });
    expect(await serveElnAttach(d, { path: '../x.md', source: 'obsidian' })).toEqual({ ok: false, reason: 'outside', message: 'path outside the vault' });
    expect(await serveElnAttach(d, { path: 'link.md', source: 'obsidian' })).toEqual({ ok: false, reason: 'outside', message: 'path outside the vault' });
    expect(inserted).toHaveLength(1);
    const unset = deps([row('p2', 'codex')]);
    expect(await serveElnAttach(unset.d, { path: 'a.md', source: 'obsidian' })).toEqual({ ok: false, reason: 'not-found', message: 'Obsidian vault not set' });
  });
  test('no agent pane → no-eln; a missing file → not-found; the pane refusing → deliver-failed', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.md'), 'a');
    expect(await serveElnAttach(deps([row('s', 'shell')]).d, { path: join(dir, 'a.md'), source: 'files' })).toEqual({ ok: false, reason: 'no-eln', message: 'No open eln (열린 eln 없음)' });
    expect(await serveElnAttach(deps([row('p', 'eln')]).d, { path: join(dir, 'gone.md'), source: 'files' })).toEqual({ ok: false, reason: 'not-found', message: 'gone.md not found' });
    expect(await serveElnAttach(deps([row('p', 'eln')]).d, { path: 'relative.md', source: 'files' })).toEqual({ ok: false, reason: 'not-found', message: 'the path must be absolute' });
    expect(await serveElnAttach(deps([row('p', 'eln')]).d, { path: dir, source: 'files' })).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await serveElnAttach(deps([row('p', 'eln')]).d, { path: '/a\n.md', source: 'files' })).toEqual({ ok: false, reason: 'not-found', message: 'a file path is required' });
    expect(await serveElnAttach(deps([row('p', 'eln')], { refuse: 'HITL approval pending; use an authenticated human attach key' }).d, { path: join(dir, 'a.md'), source: 'files' }))
      .toEqual({ ok: false, reason: 'deliver-failed', message: 'HITL approval pending; use an authenticated human attach key; nothing sent' });
    expect(await serveElnAttach(deps([row('p', 'eln')]).d, { path: join(dir, 'a.md'), source: 'files', pane: 'nope' })).toEqual({ ok: false, reason: 'no-eln', message: 'nope is not an open agent pane (열린 eln 없음)' });
  });
  test('a remote file is cached under <state>/attach-cache/<host>/ and that path is inserted; over the cap is refused', async () => {
    const ok = deps([row('p', 'eln')], { remote: Buffer.from('remote body') });
    const result = await serveElnAttach(ok.d, { path: 'node-b:/srv/notes/plan.md', source: 'files' });
    expect(result).toMatchObject({ ok: true, pane: 'p', bytes: 11 });
    const local = (result as { inserted: string }).inserted.replace(/^@/, '').trim();
    expect(local.startsWith(join(ok.state, 'attach-cache', 'node-b'))).toBe(true);
    expect(local.endsWith('-plan.md')).toBe(true);
    expect(readFileSync(local, 'utf8')).toBe('remote body');
    const big = deps([row('p', 'eln')], { remote: Buffer.alloc(52_428_801) });
    expect(await serveElnAttach(big.d, { path: 'node-b:/srv/big.bin', source: 'files' })).toEqual({ ok: false, reason: 'too-large', message: 'big.bin is larger than 50 MiB' });
    const down = deps([row('p', 'eln')], { remote: new Error('ssh exit 255') });
    expect(await serveElnAttach(down.d, { path: 'node-b:/srv/x.md', source: 'files' })).toEqual({ ok: false, reason: 'not-found', message: 'cannot read node-b:x.md (ssh exit 255)' });
    expect(big.inserted).toEqual([]);
  });
});

describe('client helper + toast', () => {
  test('requestElnAttach passes the op and parses; a broken answer is a clean failure', async () => {
    const seen: unknown[] = [];
    const answer = await requestElnAttach(async (r) => { seen.push(r); return { exitCode: 0, message: JSON.stringify({ ok: true, pane: 'p', title: 'T', mode: 'path', bytes: 1 }) }; }, { path: '/a.md', source: 'files', ws: 'demo' });
    expect(seen).toEqual([{ op: 'eln-attach', path: '/a.md', source: 'files', ws: 'demo' }]);
    expect(answer).toEqual({ ok: true, pane: 'p', title: 'T', mode: 'path', bytes: 1 });
    expect(await requestElnAttach(async () => ({ exitCode: 1, message: 'els: eln-attach denied — x' }), { path: '/a', source: 'files' })).toEqual({ ok: false, reason: 'denied', message: 'els: eln-attach denied — x' });
    expect(await requestElnAttach(async () => { throw new Error('ECONNREFUSED'); }, { path: '/a', source: 'files' })).toEqual({ ok: false, reason: 'deliver-failed', message: 'ECONNREFUSED' });
  });
  test('toast lines', () => {
    expect(attachToast({ ok: true, pane: 'p', title: 'OP', mode: 'path', bytes: 1 })).toEqual({ text: 'Attached to OP', level: 'success' });
    expect(attachToast({ ok: false, reason: 'no-eln', message: 'x' })).toEqual({ text: 'No open eln', level: 'warning' });
    expect(attachToast({ ok: false, reason: 'not-found', message: 'a.md not found' })).toEqual({ text: 'Not attached: a.md not found', level: 'error' });
  });
});
