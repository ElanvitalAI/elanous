// ELS-TAKEOUT (대표 11-26) — the ONE save module for els writes of user text: sidechat «take out» (memo · Obsidian note) and
// the Obsidian viewer's «new note». Server side only (the els server's element hydrate, or the Obsidian tab process) —
// never the attach client. Rules:
//   · nothing is written into a vault without an explicit user action + a y/n confirm (the callers own that gate);
//   · the vault root is the config key obsidian.vault (the callers pass it), notes go into «00. Inbox» only, clamped inside
//     the vault after realpath (a symlinked Inbox that points outside is refused), the Inbox is created only on confirm;
//   · atomic and never overwriting: the text goes to a temp file in the SAME folder, then link(temp, final) — link fails
//     with EEXIST instead of replacing, so a name taken (even by a concurrent save) moves on to «name-2», «name-3» …;
//   · failures come back as one clean English line (no stack, no absolute home path beyond the vault-relative name).

import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// 출처: 대표 11-26 «옵시디언 00. Inbox 에 저장» — the vault's inbox folder name.
export const INBOX_FOLDER = '00. Inbox';
// Bounds: a note title is a file name, not a paragraph; a saved text is a note, not a dump.
export const NOTE_NAME_MAX = 80;
export const SAVE_MAX_BYTES = 1_048_576;
const MAX_SUFFIX = 99;

export type SaveFailure = 'vault-unset' | 'vault-missing' | 'outside' | 'inbox-missing' | 'invalid-name' | 'too-large' | 'write-failed';
export type SaveResult =
  | { readonly ok: true; readonly path: string; readonly rel: string }
  | { readonly ok: false; readonly reason: SaveFailure; readonly message: string };
export type PlanResult =
  | { readonly ok: true; readonly rel: string; readonly name: string; readonly inboxExists: boolean }
  | { readonly ok: false; readonly reason: SaveFailure; readonly message: string };

/** Injectable fs steps (tests make a write or a link fail on purpose). */
export interface SaveFs {
  readonly writeFile: (file: string, text: string) => void;
  readonly link: (from: string, to: string) => void;
  readonly unlink: (file: string) => void;
}
const realFs: SaveFs = {
  writeFile: (file, text) => writeFileSync(file, text, { flag: 'wx', mode: 0o644 }),
  link: (from, to) => linkSync(from, to),
  unlink: (file) => unlinkSync(file),
};

const fail = (reason: SaveFailure, message: string): { ok: false; reason: SaveFailure; message: string } => ({ ok: false, reason, message });
const codeOf = (error: unknown): string => (error as { code?: string } | undefined)?.code ?? '';

/** A file-name-safe note name (no extension): path separators, reserved punctuation and control chars become spaces,
 *  leading dots go (no hidden files), runs of spaces collapse, at most NOTE_NAME_MAX characters; '' when nothing is left. */
export function safeNoteName(raw: string): string {
  const cleaned = raw.trim().replace(/\.md$/i, '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  // No trailing dots or spaces («One sentence.» must not become «One sentence..md» — test universe 11-26).
  return Array.from(cleaned).slice(0, NOTE_NAME_MAX).join('').replace(/[.\s]+$/, '');
}

/** An ASCII-ish slug for memo file names: letters (any script) and digits kept, the rest → «-», at most 40 chars. */
export function memoSlug(raw: string): string {
  const slug = raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return Array.from(slug).slice(0, 40).join('').replace(/-+$/, '') || 'memo';
}

const insideRoot = (root: string, real: string): boolean => {
  const rel = relative(root, real);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
};

/** Write `text` as `<dir>/<base><-n>.md`, atomically, never replacing a file. `dir` must exist. */
export function writeNewFile(dir: string, base: string, text: string, fs: SaveFs = realFs): { ok: true; path: string; name: string } | { ok: false; message: string } {
  const temp = join(dir, `.${base.slice(0, 20)}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try { fs.writeFile(temp, text); } catch (error) { return { ok: false, message: `cannot write in the folder (${codeOf(error) || 'error'})` }; }
  try {
    for (let n = 1; n <= MAX_SUFFIX; n++) {
      const name = `${base}${n === 1 ? '' : `-${n}`}.md`;
      const path = join(dir, name);
      try { fs.link(temp, path); return { ok: true, path, name }; }
      catch (error) {
        if (codeOf(error) === 'EEXIST') continue;
        // A file system without hard links: exclusive create is still never-overwrite (not atomic, the fallback only).
        if (codeOf(error) === 'EPERM' || codeOf(error) === 'ENOTSUP' || codeOf(error) === 'EXDEV') {
          try { fs.writeFile(path, text); return { ok: true, path, name }; }
          catch (inner) { if (codeOf(inner) === 'EEXIST') continue; return { ok: false, message: `cannot write ${name} (${codeOf(inner) || 'error'})` }; }
        }
        return { ok: false, message: `cannot write ${name} (${codeOf(error) || 'error'})` };
      }
    }
    return { ok: false, message: `too many notes named ${base}` };
  } finally {
    try { fs.unlink(temp); } catch { /* already gone */ }
  }
}

interface InboxCheck { readonly root: string; readonly inbox: string; readonly exists: boolean }
function checkInbox(vault: string | undefined): InboxCheck | { ok: false; reason: SaveFailure; message: string } {
  if (!vault?.trim()) return fail('vault-unset', 'Obsidian vault not set — elanous config set obsidian.vault <path>');
  let root: string;
  try { root = realpathSync(vault.trim()); if (!statSync(root).isDirectory()) throw new Error('not a folder'); }
  catch { return fail('vault-missing', 'Obsidian vault not found'); }
  const inbox = join(root, INBOX_FOLDER);
  let exists = false;
  try { lstatSync(inbox); exists = true; } catch { exists = false; }
  if (!exists) return { root, inbox, exists };
  let real: string;
  try { real = realpathSync(inbox); } catch { return fail('outside', `${INBOX_FOLDER} is a broken link`); }
  if (!insideRoot(root, real)) return fail('outside', `${INBOX_FOLDER} points outside the vault — refused`);
  try { if (!statSync(real).isDirectory()) return fail('inbox-missing', `${INBOX_FOLDER} is not a folder`); } catch { return fail('inbox-missing', `${INBOX_FOLDER} is unreadable`); }
  return { root, inbox: real, exists };
}

/** The name a save would use now (no write): `00. Inbox/<name>.md` with the first free suffix. */
export function planVaultNote(vault: string | undefined, title: string): PlanResult {
  const base = safeNoteName(title);
  if (!base) return fail('invalid-name', 'The note needs a name');
  const check = checkInbox(vault);
  if ('ok' in check) return check;
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const name = `${base}${n === 1 ? '' : `-${n}`}.md`;
    if (!check.exists || !existsSync(join(check.inbox, name))) return { ok: true, rel: `${INBOX_FOLDER}/${name}`, name, inboxExists: check.exists };
  }
  return fail('write-failed', `too many notes named ${base}`);
}

/** Save a note into the vault's «00. Inbox». Call only after the user confirmed (y). `createInbox` = the confirm covers
 *  creating the missing Inbox folder (the default for a confirmed save); false refuses when it is missing. */
export function saveVaultNote(vault: string | undefined, title: string, body: string, options: { readonly createInbox?: boolean; readonly fs?: SaveFs } = {}): SaveResult {
  const base = safeNoteName(title);
  if (!base) return fail('invalid-name', 'The note needs a name');
  if (Buffer.byteLength(body) > SAVE_MAX_BYTES) return fail('too-large', 'The text is too large to save (1 MiB max)');
  const check = checkInbox(vault);
  if ('ok' in check) return check;
  let inbox = check.inbox;
  if (!check.exists) {
    if (options.createInbox === false) return fail('inbox-missing', `${INBOX_FOLDER} does not exist in the vault`);
    try { mkdirSync(inbox, { mode: 0o755 }); inbox = realpathSync(inbox); }
    catch (error) { if (codeOf(error) !== 'EEXIST') return fail('write-failed', `cannot create ${INBOX_FOLDER} (${codeOf(error) || 'error'})`); }
    if (!insideRoot(check.root, realpathSync(inbox))) return fail('outside', `${INBOX_FOLDER} points outside the vault — refused`);
  }
  const written = writeNewFile(inbox, base, body, options.fs);
  if (!written.ok) return fail('write-failed', written.message);
  return { ok: true, path: written.path, rel: `${INBOX_FOLDER}/${written.name}` };
}

/** `prefix + name + suffix` in at most `room` cells: the name is cut in the middle (…) so the question and «y/n» at the
 *  end always stay visible on a narrow popup. */
export function fitNameRow(prefix: string, name: string, suffix: string, room: number): string {
  const full = `${prefix}${name}${suffix}`;
  if (Bun.stringWidth(full) <= room) return full;
  const left = Math.max(1, room - Bun.stringWidth(prefix) - Bun.stringWidth(suffix) - 1);
  const chars = Array.from(name);
  let head = '';
  let tail = '';
  for (let at = 0, used = 0; at < chars.length; at++) {
    const front = at % 2 === 0;
    const ch = front ? chars[Math.floor(at / 2)]! : chars[chars.length - 1 - Math.floor(at / 2)]!;
    const w = Bun.stringWidth(ch);
    if (used + w > left) break;
    used += w;
    if (front) head += ch; else tail = ch + tail;
  }
  return `${prefix}${head}…${tail}${suffix}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** Local-time stamp for memo names: 20261126-193005. */
export function memoStamp(at: Date): string {
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

/** Save a memo as md under `<els state>/memos/<stamp>-<slug>.md` (atomic, never overwriting). `stateDir` = the els state
 *  folder the server already uses (the overlay registry's dir) — never a hard-coded path. */
export function saveMemo(stateDir: string | undefined, title: string, body: string, options: { readonly now?: Date; readonly fs?: SaveFs } = {}): SaveResult {
  if (!stateDir) return fail('write-failed', 'no els state folder');
  if (Buffer.byteLength(body) > SAVE_MAX_BYTES) return fail('too-large', 'The text is too large to save (1 MiB max)');
  const dir = join(stateDir, 'memos');
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (error) { return fail('write-failed', `cannot create the memo folder (${codeOf(error) || 'error'})`); }
  const written = writeNewFile(dir, `${memoStamp(options.now ?? new Date())}-${memoSlug(title)}`, body, options.fs);
  if (!written.ok) return fail('write-failed', written.message);
  return { ok: true, path: written.path, rel: `memos/${written.name}` };
}

// One confirm = one write: a confirm token is minted by the server when it shows the y/n row and spent once — a token the
// server never minted (a crafted update) or one already spent (a repeated `y` before the push lands, a re-applied update)
// writes nothing. Bounded memory.
const issued: string[] = [];
let tokenSeq = 0;
export function newSaveToken(): string {
  const token = `s${Date.now().toString(36)}${(++tokenSeq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  issued.push(token);
  if (issued.length > 64) issued.shift();
  return token;
}
export function spendToken(token: string | undefined): boolean {
  const at = token ? issued.indexOf(token) : -1;
  if (at < 0) return false;
  issued.splice(at, 1);
  return true;
}

// ── ELS-OBSIDIAN-EDIT (대표 11-26 20:4x «노트 편집도») — save an EXISTING note edited in the viewer ─────────────────────────
// Only inside the vault (realpath clamp, no symlink escape), only an existing regular .md file, never a new file. The save
// carries what the editor saw at open (mtime + size): a file changed on disk since then is refused ('changed') — never
// clobbered. Before writing, the current file is copied to a one-step backup under the els state folder
// (<state>/obsidian-backup/<vault-relative path, «/» → «__»>.md, replaced on the next save). The write is atomic: a temp
// file in the same folder, then rename over the note (its mode kept).

// 출처: ELS-OBSIDIAN-EDIT — the in-popup editor is for notes, not datasets: 64 KiB (a larger note says so and stays read-only).
export const EDIT_MAX_BYTES = 65_536;

export interface NoteStat { readonly mtimeMs: number; readonly size: number }
export type EditOpen =
  | { readonly ok: true; readonly path: string; readonly text: string; readonly stat: NoteStat }
  | { readonly ok: false; readonly reason: SaveFailure | 'not-found' | 'changed'; readonly message: string };
export type EditSave =
  | { readonly ok: true; readonly stat: NoteStat; readonly backup?: string }
  | { readonly ok: false; readonly reason: SaveFailure | 'not-found' | 'changed'; readonly message: string };

/** The note's real path inside the vault (existing regular .md file), or a failure line. */
function noteInVault(vault: string | undefined, rel: string): { ok: true; root: string; path: string } | { ok: false; reason: SaveFailure | 'not-found'; message: string } {
  if (!vault?.trim()) return fail('vault-unset', 'Obsidian vault not set — elanous config set obsidian.vault <path>');
  let root: string;
  try { root = realpathSync(vault.trim()); if (!statSync(root).isDirectory()) throw new Error('not a folder'); }
  catch { return fail('vault-missing', 'Obsidian vault not found'); }
  if (!rel || rel.startsWith('/') || rel.split('/').some((part) => part === '..' || part === '.' || part === '')) return fail('outside', 'path outside the vault');
  let real: string;
  try { real = realpathSync(join(root, rel)); } catch { return { ok: false, reason: 'not-found', message: `${rel} not found` }; }
  if (!insideRoot(root, real)) return fail('outside', 'note outside the vault — refused');
  try { if (!statSync(real).isFile() || !real.toLowerCase().endsWith('.md')) return { ok: false, reason: 'not-found', message: `${rel} is not a note` }; }
  catch { return { ok: false, reason: 'not-found', message: `${rel} not found` }; }
  return { ok: true, root, path: real };
}

const statOf = (path: string): NoteStat => { const st = statSync(path); return { mtimeMs: st.mtimeMs, size: st.size }; };

/** Read a note for editing (with the stat the save will check against). */
export function openVaultEdit(vault: string | undefined, rel: string): EditOpen {
  const note = noteInVault(vault, rel);
  if (!note.ok) return note;
  try {
    const stat = statOf(note.path);
    if (stat.size > EDIT_MAX_BYTES) return fail('too-large', 'This note is too large to edit here (64 KiB max)');
    return { ok: true, path: note.path, text: readFileSync(note.path, 'utf8'), stat };
  } catch (error) { return fail('write-failed', `cannot read ${rel} (${codeOf(error) || 'error'})`); }
}

/** Save edited text over an existing note — only if it is unchanged on disk since `base` (else 'changed'). */
export function saveVaultEdit(vault: string | undefined, rel: string, text: string, base: NoteStat, backupDir: string | undefined,
  options: { readonly write?: (file: string, text: string) => void } = {}): EditSave {
  if (Buffer.byteLength(text) > EDIT_MAX_BYTES) return fail('too-large', 'The note is too large to save here (64 KiB max)');
  const note = noteInVault(vault, rel);
  if (!note.ok) return note;
  let now: NoteStat;
  try { now = statOf(note.path); } catch { return { ok: false, reason: 'not-found', message: `${rel} not found` }; }
  if (now.mtimeMs !== base.mtimeMs || now.size !== base.size) return { ok: false, reason: 'changed', message: 'Changed outside since you opened it' };
  let backup: string | undefined;
  if (backupDir) {
    try {
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      backup = join(backupDir, `${rel.replace(/\//g, '__')}`);
      const temp = `${backup}.${process.pid}.tmp`;
      writeFileSync(temp, readFileSync(note.path), { mode: 0o600 });
      renameSync(temp, backup);
    } catch (error) { return fail('write-failed', `backup failed (${codeOf(error) || 'error'}) — not saved`); }
  }
  const temp = join(note.path, '..', `.${note.path.split('/').pop()!.slice(0, 20)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    const mode = statSync(note.path).mode & 0o777;
    (options.write ?? ((file, body) => writeFileSync(file, body, { flag: 'wx', mode })))(temp, text);
    renameSync(temp, note.path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* not created */ }
    return fail('write-failed', `cannot write ${rel} (${codeOf(error) || 'error'})`);
  }
  return { ok: true, stat: statOf(note.path), ...(backup ? { backup } : {}) };
}
