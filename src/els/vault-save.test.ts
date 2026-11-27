// ELS-TAKEOUT — the one save module (vault «00. Inbox» notes + els memos): success and every failure path (vault unset,
// vault missing, Inbox missing, name collision, write fail, link fail, symlink escape, concurrent saves, confirm tokens).
// Literal expectations; every vault is a fresh temp folder (never a real vault).
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoSlug, memoStamp, newSaveToken, planVaultNote, safeNoteName, saveMemo, saveVaultNote, spendToken, writeNewFile, type SaveFs } from './vault-save.js';

const dirs: string[] = [];
const temp = (): string => { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vault-save-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const vaultWithInbox = (): string => { const v = temp(); mkdirSync(join(v, '00. Inbox')); return v; };
const visible = (dir: string): string[] => readdirSync(dir).filter((name) => !name.startsWith('.')).sort();

describe('names', () => {
  test('safeNoteName strips separators, reserved punctuation, leading dots and caps the length', () => {
    expect(safeNoteName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(safeNoteName('..hidden')).toBe('hidden');
    expect(safeNoteName('  회의  메모.md ')).toBe('회의 메모');
    expect(safeNoteName('/// ')).toBe('');
    expect(safeNoteName('What is a monad? One sentence.')).toBe('What is a monad One sentence');
    expect(safeNoteName('end... ')).toBe('end');
    expect(safeNoteName('x'.repeat(120)).length).toBe(80);
  });
  test('memo slug and stamp', () => {
    expect(memoSlug('What is a Monad?')).toBe('what-is-a-monad');
    expect(memoSlug('한국어 질문!')).toBe('한국어-질문');
    expect(memoSlug('???')).toBe('memo');
    expect(memoStamp(new Date(2026, 10, 26, 9, 5, 7))).toBe('20261126-090507');
  });
});

describe('saveVaultNote', () => {
  test('writes into 00. Inbox and never overwrites (-2, -3)', () => {
    const v = vaultWithInbox();
    const a = saveVaultNote(v, 'Idea', '# Idea\n');
    const b = saveVaultNote(v, 'Idea', 'second\n');
    const c = saveVaultNote(v, 'Idea.md', 'third\n');
    expect([a.ok && a.rel, b.ok && b.rel, c.ok && c.rel]).toEqual(['00. Inbox/Idea.md', '00. Inbox/Idea-2.md', '00. Inbox/Idea-3.md']);
    expect(readFileSync(join(v, '00. Inbox', 'Idea.md'), 'utf8')).toBe('# Idea\n');
    expect(readFileSync(join(v, '00. Inbox', 'Idea-2.md'), 'utf8')).toBe('second\n');
    expect(readdirSync(join(v, '00. Inbox')).sort()).toEqual(['Idea-2.md', 'Idea-3.md', 'Idea.md']);   // no temp left behind
  });
  test('vault unset / missing', () => {
    expect(saveVaultNote(undefined, 'x', 'y')).toEqual({ ok: false, reason: 'vault-unset', message: 'Obsidian vault not set — elanous config set obsidian.vault <path>' });
    expect(saveVaultNote('  ', 'x', 'y')).toMatchObject({ ok: false, reason: 'vault-unset' });
    expect(saveVaultNote(join(temp(), 'gone'), 'x', 'y')).toEqual({ ok: false, reason: 'vault-missing', message: 'Obsidian vault not found' });
  });
  test('Inbox missing: created on a confirmed save, refused with createInbox false', () => {
    const v = temp();
    expect(saveVaultNote(v, 'x', 'y', { createInbox: false })).toEqual({ ok: false, reason: 'inbox-missing', message: '00. Inbox does not exist in the vault' });
    expect(existsSync(join(v, '00. Inbox'))).toBe(false);
    expect(saveVaultNote(v, 'x', 'y')).toMatchObject({ ok: true, rel: '00. Inbox/x.md' });
    expect(visible(join(v, '00. Inbox'))).toEqual(['x.md']);
  });
  test('a symlinked Inbox pointing outside the vault is refused (nothing written outside)', () => {
    const v = temp();
    const outside = temp();
    symlinkSync(outside, join(v, '00. Inbox'));
    expect(saveVaultNote(v, 'x', 'y')).toEqual({ ok: false, reason: 'outside', message: '00. Inbox points outside the vault — refused' });
    expect(planVaultNote(v, 'x')).toMatchObject({ ok: false, reason: 'outside' });
    expect(readdirSync(outside)).toEqual([]);
  });
  test('a symlinked Inbox inside the vault is fine', () => {
    const v = temp();
    mkdirSync(join(v, 'real-inbox'));
    symlinkSync(join(v, 'real-inbox'), join(v, '00. Inbox'));
    expect(saveVaultNote(v, 'n', 'y')).toMatchObject({ ok: true, rel: '00. Inbox/n.md' });
    expect(visible(join(v, 'real-inbox'))).toEqual(['n.md']);
  });
  test('an empty name is refused; a too-large text is refused', () => {
    expect(saveVaultNote(vaultWithInbox(), '///', 'y')).toEqual({ ok: false, reason: 'invalid-name', message: 'The note needs a name' });
    expect(saveVaultNote(vaultWithInbox(), 'big', 'x'.repeat(1_048_577))).toMatchObject({ ok: false, reason: 'too-large' });
  });
  test('write fail: a clean one-line message, nothing left behind', () => {
    const v = vaultWithInbox();
    const failing: SaveFs = { writeFile: () => { throw Object.assign(new Error('disk full /secret/path'), { code: 'ENOSPC' }); }, link: linkSync, unlink: rmSync };
    expect(saveVaultNote(v, 'x', 'y', { fs: failing })).toEqual({ ok: false, reason: 'write-failed', message: 'cannot write in the folder (ENOSPC)' });
    expect(readdirSync(join(v, '00. Inbox'))).toEqual([]);
  });
  test('link fail (not EEXIST): refused and the temp file is removed', () => {
    const v = vaultWithInbox();
    const failing: SaveFs = { writeFile: (f, t) => writeFileSync(f, t, { flag: 'wx' }), link: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); }, unlink: rmSync };
    expect(saveVaultNote(v, 'x', 'y', { fs: failing })).toEqual({ ok: false, reason: 'write-failed', message: 'cannot write x.md (EIO)' });
    expect(readdirSync(join(v, '00. Inbox'))).toEqual([]);
  });
  test('concurrent saves: a name taken between plan and write moves on to the next suffix (never replaced)', () => {
    const v = vaultWithInbox();
    const plan = planVaultNote(v, 'Race');
    expect(plan).toEqual({ ok: true, rel: '00. Inbox/Race.md', name: 'Race.md', inboxExists: true });
    let raced = false;
    const racing: SaveFs = {
      writeFile: (f, t) => writeFileSync(f, t, { flag: 'wx' }),
      link: (from, to) => { if (!raced) { raced = true; writeFileSync(to, 'other writer\n'); } linkSync(from, to); },
      unlink: rmSync,
    };
    expect(saveVaultNote(v, 'Race', 'mine\n', { fs: racing })).toMatchObject({ ok: true, rel: '00. Inbox/Race-2.md' });
    expect(readFileSync(join(v, '00. Inbox', 'Race.md'), 'utf8')).toBe('other writer\n');
    expect(readFileSync(join(v, '00. Inbox', 'Race-2.md'), 'utf8')).toBe('mine\n');
  });
  test('concurrent saves from separate processes all land under distinct names', async () => {
    const v = vaultWithInbox();
    const script = join(temp(), 'save.ts');
    writeFileSync(script, `import { saveVaultNote } from ${JSON.stringify(join(import.meta.dir, 'vault-save.ts'))};\nconst r = saveVaultNote(process.argv[2], 'Same', 'body ' + process.argv[3]);\nprocess.stdout.write(r.ok ? r.rel : 'FAIL ' + r.message);\n`);
    const runs = await Promise.all([1, 2, 3, 4, 5, 6].map(async (n) => {
      const child = Bun.spawn([process.execPath, script, v, String(n)], { stdout: 'pipe', stderr: 'pipe' });
      return new Response(child.stdout).text();
    }));
    expect(runs.sort()).toEqual(['00. Inbox/Same-2.md', '00. Inbox/Same-3.md', '00. Inbox/Same-4.md', '00. Inbox/Same-5.md', '00. Inbox/Same-6.md', '00. Inbox/Same.md']);
    expect(visible(join(v, '00. Inbox')).length).toBe(6);
  });
});

describe('saveMemo / writeNewFile / tokens', () => {
  test('memo under <state>/memos/<stamp>-<slug>.md', () => {
    const state = temp();
    const at = new Date(2026, 10, 26, 19, 30, 5);
    expect(saveMemo(state, 'Hello World', '# Hello\n', { now: at })).toMatchObject({ ok: true, rel: 'memos/20261126-193005-hello-world.md' });
    expect(saveMemo(state, 'Hello World', 'again\n', { now: at })).toMatchObject({ ok: true, rel: 'memos/20261126-193005-hello-world-2.md' });
    expect(readFileSync(join(state, 'memos', '20261126-193005-hello-world.md'), 'utf8')).toBe('# Hello\n');
    expect(saveMemo(undefined, 'x', 'y')).toEqual({ ok: false, reason: 'write-failed', message: 'no els state folder' });
  });
  test('writeNewFile falls back to exclusive create on a file system without hard links', () => {
    const dir = temp();
    const noLinks: SaveFs = { writeFile: (f, t) => writeFileSync(f, t, { flag: 'wx' }), link: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }, unlink: rmSync };
    expect(writeNewFile(dir, 'n', 'a', noLinks)).toMatchObject({ ok: true, name: 'n.md' });
    expect(writeNewFile(dir, 'n', 'b', noLinks)).toMatchObject({ ok: true, name: 'n-2.md' });
    expect(readdirSync(dir).sort()).toEqual(['n-2.md', 'n.md']);
  });
  test('a confirm token is server-minted and spent once', () => {
    const token = newSaveToken();
    expect(spendToken('forged')).toBe(false);
    expect(spendToken(undefined)).toBe(false);
    expect(spendToken(token)).toBe(true);
    expect(spendToken(token)).toBe(false);
  });
});
