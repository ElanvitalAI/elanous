import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncIntakeGroundingDocs } from './grounding-docs.js';
import { intakeLedgerDir, shapeIntakeItem } from './items.js';
import { intakeOutboxDir } from './route.js';

const NOW = '2026-09-26T00:00:00.000Z';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'intake-grounding-'));
  const noteDir = join(root, 'notes');
  mkdirSync(noteDir);
  const queue = join(intakeOutboxDir(root), 'grounding.jsonl');
  mkdirSync(intakeOutboxDir(root), { recursive: true });
  function add(source: 'youtube' | 'memo', name: string, text: string, url?: string) {
    const note = join(noteDir, `${name}.md`);
    writeFileSync(note, text);
    const item = shapeIntakeItem(source, { url, text: name }, NOW)!;
    item.outputs = [{ kind: 'note', ref: note }];
    item.status = 'routed';
    writeFileSync(join(intakeLedgerDir(root), 'items.jsonl'), `${JSON.stringify(item)}\n`, { flag: 'a' });
    writeFileSync(queue, `${JSON.stringify({ id: item.id, path: note, kind: 'local-docs' })}\n`, { flag: 'a' });
    return { item, note, copy: join(intakeLedgerDir(root), 'grounding-docs', `${item.id}-${name}.md`) };
  }
  return { root, queue, add, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('copies queued notes but excludes user-private text without a URL', () => {
  const f = fixture();
  try {
    const publicNote = f.add('youtube', 'public', '# Public', 'https://example.com/a');
    const privateNote = f.add('memo', 'private', '# Secret');
    const linkedMemo = f.add('memo', 'linked', '# Public link', 'https://example.com/b');
    const first = syncIntakeGroundingDocs(f.root);
    expect(first).toMatchObject({ copied: 2, unchanged: 0, skipped: 1, removed: 0, dryRun: false });
    // dir 은 실경로다(macOS 의 /var → /private/var 조상 링크를 풀어 비교가 어긋나지 않게)
    expect(first.dir).toBe(realpathSync(join(f.root, 'intake', 'grounding-docs')));
    expect(readFileSync(publicNote.copy, 'utf8')).toBe('# Public');
    expect(readFileSync(linkedMemo.copy, 'utf8')).toBe('# Public link');
    expect(existsSync(privateNote.copy)).toBe(false);
  } finally { f.dispose(); }
});

test('repeat runs leave unchanged copies untouched, and newer source contents are recopied', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'fresh', 'before', 'https://example.com/fresh');
    expect(syncIntakeGroundingDocs(f.root).copied).toBe(1);
    const before = statSync(note.copy).mtimeMs;
    const manifest = join(intakeLedgerDir(f.root), 'grounding-docs', '.intake-copies.json');
    const manifestBefore = statSync(manifest).mtimeMs;
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, unchanged: 1, removed: 0 });
    expect(statSync(note.copy).mtimeMs).toBe(before);
    expect(statSync(manifest).mtimeMs).toBe(manifestBefore);
    writeFileSync(note.note, 'after');
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 1, unchanged: 0 });
    expect(readFileSync(note.copy, 'utf8')).toBe('after');
  } finally { f.dispose(); }
});

test('removes only previously copied notes whose sources disappear, preserving other files', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'gone', 'content', 'https://example.com/gone');
    syncIntakeGroundingDocs(f.root);
    const other = join(intakeLedgerDir(f.root), 'grounding-docs', 'manual.md');
    writeFileSync(other, 'keep');
    rmSync(note.note);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, removed: 1, skipped: 1 });
    expect(existsSync(note.copy)).toBe(false);
    expect(readFileSync(other, 'utf8')).toBe('keep');
    expect(syncIntakeGroundingDocs(f.root).removed).toBe(0);
  } finally { f.dispose(); }
});

test('a newer note output replaces the old copy rather than preserving an obsolete queued path', () => {
  const f = fixture();
  try {
    const old = f.add('youtube', 'old-note', 'old', 'https://example.com/updated');
    syncIntakeGroundingDocs(f.root);
    const next = join(f.root, 'notes', 'new-note.md');
    writeFileSync(next, 'new');
    const item = { ...old.item, outputs: [...old.item.outputs, { kind: 'note' as const, ref: next }] };
    writeFileSync(join(intakeLedgerDir(f.root), 'items.jsonl'), `${JSON.stringify(item)}\n`, { flag: 'a' });
    writeFileSync(f.queue, `${JSON.stringify({ id: item.id, path: next })}\n`, { flag: 'a' });
    const result = syncIntakeGroundingDocs(f.root);
    expect(result).toMatchObject({ copied: 1, removed: 1, skipped: 1 });
    expect(existsSync(old.copy)).toBe(false);
    expect(readFileSync(join(intakeLedgerDir(f.root), 'grounding-docs', `${item.id}-new-note.md`), 'utf8')).toBe('new');
  } finally { f.dispose(); }
});

test('missing queue does not erase existing owned copies', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'queued', 'content', 'https://example.com/queued');
    syncIntakeGroundingDocs(f.root);
    rmSync(f.queue);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, removed: 0 });
    expect(readFileSync(note.copy, 'utf8')).toBe('content');
  } finally { f.dispose(); }
});

test('a confirmed private transition removes its owned copy even with a damaged or missing queue', () => {
  for (const queueState of ['damaged', 'missing'] as const) {
    const f = fixture();
    try {
      const privateNote = f.add('youtube', 'private-transition', '# Formerly public', 'https://example.com/private-transition');
      const retained = f.add('youtube', 'still-public', '# Keep', 'https://example.com/still-public');
      expect(syncIntakeGroundingDocs(f.root).copied).toBe(2);
      const changed = { ...privateNote.item, privacy: 'user-private' as const, url: undefined };
      writeFileSync(join(intakeLedgerDir(f.root), 'items.jsonl'), `${JSON.stringify(changed)}\n`, { flag: 'a' });
      if (queueState === 'damaged') writeFileSync(f.queue, '{broken');
      else rmSync(f.queue);
      const result = syncIntakeGroundingDocs(f.root);
      expect(result).toMatchObject({ copied: 0, removed: 1 });
      expect(existsSync(privateNote.copy)).toBe(false);
      expect(readFileSync(retained.copy, 'utf8')).toBe('# Keep');
      expect(JSON.parse(readFileSync(join(intakeLedgerDir(f.root), 'grounding-docs', '.intake-copies.json'), 'utf8')))
        .toEqual([retained.copy.split('/').at(-1)]);
      expect(syncIntakeGroundingDocs(f.root).removed).toBe(0);
    } finally { f.dispose(); }
  }
});

test('a truncated queue row preserves previously owned copies while valid rows still sync', () => {
  const f = fixture();
  try {
    const retained = f.add('youtube', 'retained', 'keep', 'https://example.com/retained');
    syncIntakeGroundingDocs(f.root);
    const fresh = f.add('youtube', 'fresh-row', 'fresh', 'https://example.com/fresh-row');
    writeFileSync(f.queue, `${JSON.stringify({ id: fresh.item.id, path: fresh.note })}\n{"id":"${retained.item.id}","path":`);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 1, removed: 0, skipped: 1 });
    expect(readFileSync(retained.copy, 'utf8')).toBe('keep');
    expect(readFileSync(fresh.copy, 'utf8')).toBe('fresh');
    expect(JSON.parse(readFileSync(join(intakeLedgerDir(f.root), 'grounding-docs', '.intake-copies.json'), 'utf8'))).toContain(retained.copy.split('/').at(-1));
    writeFileSync(f.queue, `${JSON.stringify({ id: fresh.item.id, path: fresh.note })}\n`);
    expect(syncIntakeGroundingDocs(f.root).removed).toBe(1);
    expect(existsSync(retained.copy)).toBe(false);
  } finally { f.dispose(); }
});

test('a confirmed missing source is removed even when another queue row is malformed', () => {
  const f = fixture();
  try {
    const gone = f.add('youtube', 'explicitly-gone', 'old', 'https://example.com/explicitly-gone');
    const unknown = f.add('youtube', 'unknown-row', 'keep', 'https://example.com/unknown-row');
    syncIntakeGroundingDocs(f.root);
    rmSync(gone.note);
    writeFileSync(f.queue, `${JSON.stringify({ id: gone.item.id, path: gone.note })}\n{broken`);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ removed: 1, skipped: 2 });
    expect(existsSync(gone.copy)).toBe(false);
    expect(readFileSync(unknown.copy, 'utf8')).toBe('keep');
  } finally { f.dispose(); }
});

test('invalid queue fields and truncated ledger rows cannot authorize pruning', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'known', 'keep', 'https://example.com/known');
    syncIntakeGroundingDocs(f.root);
    writeFileSync(f.queue, '{"id":null,"path":null}\n');
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ removed: 0, skipped: 1 });
    expect(readFileSync(note.copy, 'utf8')).toBe('keep');
    const fresh = f.add('youtube', 'ledger-fresh', 'fresh', 'https://example.com/ledger-fresh');
    writeFileSync(f.queue, `${JSON.stringify({ id: fresh.item.id, path: fresh.note })}\n`);
    writeFileSync(join(intakeLedgerDir(f.root), 'items.jsonl'), '{"id":', { flag: 'a' });
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 1, removed: 0 });
    expect(readFileSync(note.copy, 'utf8')).toBe('keep');
    expect(readFileSync(fresh.copy, 'utf8')).toBe('fresh');
  } finally { f.dispose(); }
});

test('unreadable queue and unavailable source preserve owned copies, but confirmed deletion removes them', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'unreadable', 'keep', 'https://example.com/unreadable');
    syncIntakeGroundingDocs(f.root);
    const queueText = readFileSync(f.queue, 'utf8');
    rmSync(f.queue);
    mkdirSync(f.queue);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ removed: 0, skipped: 1 });
    expect(readFileSync(note.copy, 'utf8')).toBe('keep');
    rmSync(f.queue, { recursive: true });
    writeFileSync(f.queue, queueText);
    rmSync(note.note);
    symlinkSync(note.note, note.note);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ removed: 0, skipped: 1 });
    expect(readFileSync(note.copy, 'utf8')).toBe('keep');
    rmSync(note.note);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ removed: 1, skipped: 1 });
    expect(existsSync(note.copy)).toBe(false);
  } finally { f.dispose(); }
});

test('a source read failure after a successful stat retains its owned copy', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'read-failure', 'keep', 'https://example.com/read-failure');
    syncIntakeGroundingDocs(f.root);
    chmodSync(note.note, 0);
    try {
      expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ removed: 0, skipped: 1 });
      expect(readFileSync(note.copy, 'utf8')).toBe('keep');
    } finally { chmodSync(note.note, 0o600); }
  } finally { f.dispose(); }
});

test('does not overwrite an existing unowned document at a generated name', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'collision', 'source', 'https://example.com/collision');
    mkdirSync(join(intakeLedgerDir(f.root), 'grounding-docs'));
    writeFileSync(note.copy, 'user document');
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, skipped: 1 });
    expect(readFileSync(note.copy, 'utf8')).toBe('user document');
  } finally { f.dispose(); }
});

test('dangling copy links are not followed and skipped paths never become owned', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'dangling', 'source', 'https://example.com/dangling');
    const outside = join(f.root, 'outside.md');
    mkdirSync(join(intakeLedgerDir(f.root), 'grounding-docs'));
    symlinkSync(outside, note.copy);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, skipped: 1 });
    expect(existsSync(outside)).toBe(false);
    const manifest = join(intakeLedgerDir(f.root), 'grounding-docs', '.intake-copies.json');
    expect(existsSync(manifest)).toBe(false);
    rmSync(note.copy);
    writeFileSync(note.copy, 'user document');
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, skipped: 1 });
    expect(readFileSync(note.copy, 'utf8')).toBe('user document');
  } finally { f.dispose(); }
});

test('unowned directory collision cannot acquire ownership even after replacement', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'directory', 'source', 'https://example.com/directory');
    mkdirSync(join(intakeLedgerDir(f.root), 'grounding-docs'));
    mkdirSync(note.copy);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, skipped: 1 });
    rmSync(note.copy, { recursive: true });
    writeFileSync(note.copy, 'user document');
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, skipped: 1 });
    expect(readFileSync(note.copy, 'utf8')).toBe('user document');
  } finally { f.dispose(); }
});

test('dangling manifest links are rejected without creating outside files', () => {
  const f = fixture();
  try {
    f.add('youtube', 'manifest', 'source', 'https://example.com/manifest');
    const directory = join(intakeLedgerDir(f.root), 'grounding-docs');
    mkdirSync(directory);
    const outside = join(f.root, 'outside.json');
    symlinkSync(outside, join(directory, '.intake-copies.json'));
    expect(() => syncIntakeGroundingDocs(f.root)).toThrow('Invalid intake grounding manifest');
    expect(existsSync(outside)).toBe(false);
  } finally { f.dispose(); }
});

test('an owned path replaced by a symlink is not followed or re-owned', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'replaced', 'source', 'https://example.com/replaced');
    syncIntakeGroundingDocs(f.root);
    const outside = join(f.root, 'outside.md');
    rmSync(note.copy);
    symlinkSync(outside, note.copy);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, skipped: 1 });
    expect(existsSync(outside)).toBe(false);
    rmSync(note.copy);
    writeFileSync(note.copy, 'user document');
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, skipped: 1 });
    expect(readFileSync(note.copy, 'utf8')).toBe('user document');
  } finally { f.dispose(); }
});

test('an owned path replaced by a directory is unowned without deleting it', () => {
  const f = fixture();
  try {
    const note = f.add('youtube', 'owned-directory', 'source', 'https://example.com/owned-directory');
    syncIntakeGroundingDocs(f.root);
    rmSync(note.copy);
    mkdirSync(note.copy);
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ removed: 0, skipped: 1 });
    expect(statSync(note.copy).isDirectory()).toBe(true);
    rmSync(note.copy, { recursive: true });
    writeFileSync(note.copy, 'user document');
    expect(syncIntakeGroundingDocs(f.root)).toMatchObject({ copied: 0, skipped: 1 });
    expect(readFileSync(note.copy, 'utf8')).toBe('user document');
  } finally { f.dispose(); }
});

test('dry run reports copies and removals without changing the destination', () => {
  const f = fixture();
  try {
    const old = f.add('youtube', 'old', 'old', 'https://example.com/old');
    syncIntakeGroundingDocs(f.root);
    rmSync(old.note);
    const current = f.add('youtube', 'current', 'current', 'https://example.com/current');
    expect(syncIntakeGroundingDocs(f.root, { dryRun: true })).toMatchObject({ copied: 1, removed: 1, dryRun: true });
    expect(existsSync(old.copy)).toBe(true);
    expect(existsSync(current.copy)).toBe(false);
  } finally { f.dispose(); }
});
