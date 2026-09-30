// ── Context / Attachment registry tests ──

import { describe, test, expect, afterAll } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync, symlinkSync, realpathSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, relative } from 'path';
import {
  createContextRegistry,
  addAttachment,
  pruneUnreferenced,
  clearAll,
  clearLarge,
  dropAttachment,
  getAttachment,
  listAttachments,
  totalContextBytes,
  tokenizeInput,
  formatToken,
  DEFAULT_LARGE_THRESHOLD_BYTES,
  type Attachment,
} from '../src/context';

// ── Helpers ────────────────────────────────────────────────

function seedImage(path: string, mtime = 1000, size = 1024): Omit<Attachment, 'id' | 'token' | 'pastedAt' | 'loaded'> {
  return { kind: 'image', sourcePath: path, filename: path.split('/').pop()!, sizeBytes: size, mtime };
}

function seedPdf(path: string, mtime = 2000, size = 4096): Omit<Attachment, 'id' | 'token' | 'pastedAt' | 'loaded'> {
  return { kind: 'pdf', sourcePath: path, filename: path.split('/').pop()!, sizeBytes: size, mtime };
}

// ═══════════════════════════════════════════
// 1. Token formatting
// ═══════════════════════════════════════════

describe('formatToken', () => {
  test('uses canonical label per kind', () => {
    expect(formatToken('image', 1)).toBe('[Image #1]');
    expect(formatToken('pdf',   2)).toBe('[PDF #2]');
    expect(formatToken('docx',  3)).toBe('[Docx #3]');
    expect(formatToken('xlsx',  4)).toBe('[Xlsx #4]');
    expect(formatToken('text',  5)).toBe('[Text #5]');
    expect(formatToken('md',    6)).toBe('[Md #6]');
  });
});

// ═══════════════════════════════════════════
// 2. addAttachment + id monotonicity
// ═══════════════════════════════════════════

describe('addAttachment', () => {
  test('assigns monotonic ids starting at 1', () => {
    const reg = createContextRegistry();
    const a = addAttachment(reg, seedImage('/a.png'));
    const b = addAttachment(reg, seedPdf('/b.pdf'));
    const c = addAttachment(reg, seedImage('/c.png'));

    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
    expect(c.id).toBe(3);
  });

  test('generates correct token for each kind', () => {
    const reg = createContextRegistry();
    const img = addAttachment(reg, seedImage('/shot.png'));
    const pdf = addAttachment(reg, seedPdf('/doc.pdf'));

    expect(img.token).toBe('[Image #1]');
    expect(pdf.token).toBe('[PDF #2]');
  });

  test('stamps pastedAt and loaded=false', () => {
    const reg = createContextRegistry();
    const before = Date.now();
    const att = addAttachment(reg, seedImage('/x.png'));

    expect(att.loaded).toBe(false);
    expect(att.pastedAt).toBeGreaterThanOrEqual(before);
    expect(att.pastedAt).toBeLessThanOrEqual(Date.now());
  });

  test('dedup: same sourcePath + mtime returns existing attachment', () => {
    const reg = createContextRegistry();
    const first  = addAttachment(reg, seedImage('/dup.png', 1234));
    const second = addAttachment(reg, seedImage('/dup.png', 1234));

    expect(second.id).toBe(first.id);
    expect(reg.attachments.size).toBe(1);
  });

  test('different mtime on same path creates new attachment (file changed)', () => {
    const reg = createContextRegistry();
    const v1 = addAttachment(reg, seedImage('/live.png', 1000));
    const v2 = addAttachment(reg, seedImage('/live.png', 2000));

    expect(v1.id).toBe(1);
    expect(v2.id).toBe(2);
    expect(reg.attachments.size).toBe(2);
  });

  test('different paths with same mtime do not collide', () => {
    const reg = createContextRegistry();
    const a = addAttachment(reg, seedImage('/a.png', 500));
    const b = addAttachment(reg, seedImage('/b.png', 500));

    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });
});

// ═══════════════════════════════════════════
// 3. pruneUnreferenced
// ═══════════════════════════════════════════

describe('pruneUnreferenced', () => {
  test('keeps attachments whose token appears in input', () => {
    const reg = createContextRegistry();
    const a = addAttachment(reg, seedImage('/a.png'));
    const b = addAttachment(reg, seedPdf('/b.pdf'));

    const input = `요약해줘 ${a.token} 그리고 ${b.token}`;
    const removed = pruneUnreferenced(reg, input);

    expect(removed).toBe(0);
    expect(reg.attachments.size).toBe(2);
  });

  test('drops attachments whose token is missing from input', () => {
    const reg = createContextRegistry();
    const a = addAttachment(reg, seedImage('/a.png'));
    const b = addAttachment(reg, seedPdf('/b.pdf'));

    const input = `이거만 봐줘 ${a.token}`;
    const removed = pruneUnreferenced(reg, input);

    expect(removed).toBe(1);
    expect(reg.attachments.has(a.id)).toBe(true);
    expect(reg.attachments.has(b.id)).toBe(false);
  });

  test('empty input drops everything', () => {
    const reg = createContextRegistry();
    addAttachment(reg, seedImage('/a.png'));
    addAttachment(reg, seedPdf('/b.pdf'));

    expect(pruneUnreferenced(reg, '')).toBe(2);
    expect(reg.attachments.size).toBe(0);
  });

  test('preserves ids after prune (no renumbering)', () => {
    const reg = createContextRegistry();
    const a = addAttachment(reg, seedImage('/a.png'));
    const b = addAttachment(reg, seedPdf('/b.pdf'));
    const c = addAttachment(reg, seedImage('/c.png'));

    pruneUnreferenced(reg, `${a.token} ${c.token}`);  // drops b

    expect([...reg.attachments.keys()]).toEqual([a.id, c.id]);
    // nextId should not rewind — subsequent add uses 4, not 2.
    const d = addAttachment(reg, seedImage('/d.png'));
    expect(d.id).toBe(4);
  });
});

// ═══════════════════════════════════════════
// 4. clearAll / clearLarge / dropAttachment
// ═══════════════════════════════════════════

describe('clearAll', () => {
  test('removes every attachment and returns count', () => {
    const reg = createContextRegistry();
    addAttachment(reg, seedImage('/a.png'));
    addAttachment(reg, seedPdf('/b.pdf'));

    expect(clearAll(reg)).toBe(2);
    expect(reg.attachments.size).toBe(0);
  });

  test('returns 0 on empty registry', () => {
    const reg = createContextRegistry();
    expect(clearAll(reg)).toBe(0);
  });

  test('does not reset nextId (tokens stay unique across clears)', () => {
    const reg = createContextRegistry();
    addAttachment(reg, seedImage('/a.png'));
    clearAll(reg);
    const next = addAttachment(reg, seedImage('/b.png'));
    expect(next.id).toBe(2);
  });
});

describe('clearLarge', () => {
  test('uses default threshold (100KB) when omitted', () => {
    const reg = createContextRegistry();
    addAttachment(reg, seedImage('/small.png', 1, 50 * 1024));                // 50KB — keep
    addAttachment(reg, seedImage('/big.png',   2, DEFAULT_LARGE_THRESHOLD_BYTES + 1)); // > 100KB — drop

    expect(clearLarge(reg)).toBe(1);
    expect(reg.attachments.size).toBe(1);
    expect(listAttachments(reg)[0]!.filename).toBe('small.png');
  });

  test('respects custom threshold', () => {
    const reg = createContextRegistry();
    addAttachment(reg, seedImage('/a.png', 1, 1024));
    addAttachment(reg, seedImage('/b.png', 2, 10 * 1024));

    expect(clearLarge(reg, 5 * 1024)).toBe(1);  // only b (>5KB)
    expect(listAttachments(reg)[0]!.filename).toBe('a.png');
  });

  test('threshold boundary is strict (> not >=)', () => {
    const reg = createContextRegistry();
    addAttachment(reg, seedImage('/exact.png', 1, 1000));
    expect(clearLarge(reg, 1000)).toBe(0);
    expect(reg.attachments.size).toBe(1);
  });
});

describe('dropAttachment', () => {
  test('removes by id and returns true', () => {
    const reg = createContextRegistry();
    const a = addAttachment(reg, seedImage('/a.png'));
    expect(dropAttachment(reg, a.id)).toBe(true);
    expect(reg.attachments.size).toBe(0);
  });

  test('returns false for unknown id', () => {
    const reg = createContextRegistry();
    expect(dropAttachment(reg, 999)).toBe(false);
  });
});

// ═══════════════════════════════════════════
// 5. Queries: listAttachments / totalContextBytes / getAttachment
// ═══════════════════════════════════════════

describe('listAttachments', () => {
  test('returns attachments sorted by id ascending', () => {
    const reg = createContextRegistry();
    const a = addAttachment(reg, seedImage('/a.png'));
    const b = addAttachment(reg, seedPdf('/b.pdf'));
    const c = addAttachment(reg, seedImage('/c.png'));

    const ids = listAttachments(reg).map(x => x.id);
    expect(ids).toEqual([a.id, b.id, c.id]);
  });
});

describe('totalContextBytes', () => {
  test('sums sizeBytes across all attachments', () => {
    const reg = createContextRegistry();
    addAttachment(reg, seedImage('/a.png', 1, 1000));
    addAttachment(reg, seedPdf('/b.pdf',   2, 2500));

    expect(totalContextBytes(reg)).toBe(3500);
  });

  test('returns 0 on empty registry', () => {
    expect(totalContextBytes(createContextRegistry())).toBe(0);
  });
});

describe('getAttachment', () => {
  test('returns entry by id', () => {
    const reg = createContextRegistry();
    const a = addAttachment(reg, seedImage('/a.png'));
    expect(getAttachment(reg, a.id)?.token).toBe('[Image #1]');
  });

  test('returns undefined for unknown id', () => {
    expect(getAttachment(createContextRegistry(), 42)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════
// 6. tokenizeInput
// ═══════════════════════════════════════════

// Canonicalize the temp dir (macOS /var/folders → /private/var/folders) so
// fixture paths match what tokenizeInput stores after its realpathSync pass.
const tokDir = realpathSync(mkdtempSync(join(tmpdir(), 'elanous-tok-')));

function fixture(name: string, body = 'hi'): string {
  const p = join(tokDir, name);
  writeFileSync(p, body);
  return p;
}

afterAll(() => {
  try { rmSync(tokDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('tokenizeInput', () => {
  test('replaces absolute paths with tokens and registers attachments', () => {
    const reg = createContextRegistry();
    const pdf = fixture('a.pdf');
    const txt = fixture('b.txt');

    const { text, added } = tokenizeInput(`요약해줘 ${pdf} 그리고 ${txt}`, reg);

    expect(added).toHaveLength(2);
    expect(added[0]!.attachment.kind).toBe('pdf');
    expect(added[1]!.attachment.kind).toBe('text');
    expect(added[0]!.isNew).toBe(true);
    expect(added[1]!.isNew).toBe(true);
    expect(text).toBe(`요약해줘 ${added[0]!.attachment.token} 그리고 ${added[1]!.attachment.token}`);
  });

  test('maps each supported extension to the right kind', () => {
    const reg = createContextRegistry();
    const exts: [string, string][] = [
      ['pic.png',   'image'],
      ['pic.jpeg',  'image'],
      ['doc.md',    'md'],
      ['note.txt',  'text'],
      ['slides.pdf', 'pdf'],
      ['memo.docx', 'docx'],
      ['data.xlsx', 'xlsx'],
    ];
    for (const [name, kind] of exts) {
      const p = fixture(name);
      const { added } = tokenizeInput(`see ${p}`, reg);
      expect(added[0]?.attachment.kind).toBe(kind as Attachment['kind']);
    }
  });

  test('supports ~/ home-relative paths', () => {
    const home = homedir();
    const name = `.elanous-tok-fixture-${Date.now()}.txt`;
    const abs = join(home, name);
    writeFileSync(abs, 'x');
    try {
      const reg = createContextRegistry();
      const { added, text } = tokenizeInput(`read ~/${name}`, reg);
      expect(added).toHaveLength(1);
      expect(added[0]!.attachment.sourcePath).toBe(realpathSync(abs));
      expect(text).toBe(`read ${added[0]!.attachment.token}`);
    } finally {
      rmSync(abs, { force: true });
    }
  });

  test('supports ./ relative paths (resolved against cwd)', () => {
    // Create a fixture and pass a ./-prefixed relative reference.
    const abs = fixture('rel.md');
    const rel = './' + relative(process.cwd(), abs);

    const reg = createContextRegistry();
    const { added } = tokenizeInput(`check ${rel}`, reg);
    expect(added).toHaveLength(1);
    expect(added[0]!.attachment.sourcePath).toBe(abs);
  });

  test('supports quoted paths with spaces', () => {
    const abs = fixture('name with space.txt');
    const reg = createContextRegistry();

    const { text, added } = tokenizeInput(`open "${abs}"`, reg);
    expect(added).toHaveLength(1);
    expect(added[0]!.attachment.filename).toBe('name with space.txt');
    expect(text).toBe(`open ${added[0]!.attachment.token}`);
  });

  test('supports single-quoted paths with spaces (Finder drag)', () => {
    // macOS Terminal wraps dragged filenames with spaces in single
    // quotes: `cat '~/my notes.txt'`. Tokenizer needs to peel
    // those quotes off too, not just double quotes.
    const abs = fixture('name with space.txt');
    const reg = createContextRegistry();

    const { text, added } = tokenizeInput(`summarize '${abs}' please`, reg);
    expect(added).toHaveLength(1);
    expect(added[0]!.attachment.filename).toBe('name with space.txt');
    expect(text).toBe(`summarize ${added[0]!.attachment.token} please`);
  });

  test('leaves non-existent paths alone and records a warning', () => {
    const reg = createContextRegistry();
    const { text, added, warnings } = tokenizeInput('read /does/not/exist.pdf please', reg);
    expect(added).toHaveLength(0);
    expect(text).toBe('read /does/not/exist.pdf please');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.raw).toBe('/does/not/exist.pdf');
    expect(warnings[0]!.reason).toBe('not-found');
  });

  test('no warning for URL-embedded paths (regex correctly skips them)', () => {
    const reg = createContextRegistry();
    const { added, warnings } = tokenizeInput('visit https://example.com/pic.png here', reg);
    expect(added).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test('multiple missing paths in one input each produce a warning', () => {
    const reg = createContextRegistry();
    const { warnings } = tokenizeInput('/a/x.pdf and ./y.txt please', reg);
    expect(warnings).toHaveLength(2);
    expect(warnings.map(w => w.raw).sort()).toEqual(['./y.txt', '/a/x.pdf']);
  });

  test('ignores unsupported extensions', () => {
    const abs = fixture('thing.mp4');
    const reg = createContextRegistry();
    const { added, text } = tokenizeInput(`see ${abs}`, reg);
    expect(added).toHaveLength(0);
    expect(text).toContain('thing.mp4');
  });

  test('does not match paths embedded in URLs', () => {
    const reg = createContextRegistry();
    const { added, text } = tokenizeInput('visit https://example.com/assets/pic.png today', reg);
    // URL starts with `h`, not a path boundary; the path segment after `https:` is
    // `//example.com/…` but would need to resolve on disk to register. It won't.
    expect(added).toHaveLength(0);
    expect(text).toContain('https://example.com/assets/pic.png');
  });

  test('dedups repeated paths within the same input', () => {
    const abs = fixture('dup.md');
    const reg = createContextRegistry();

    const { added, text } = tokenizeInput(`${abs} and again ${abs}`, reg);
    expect(reg.attachments.size).toBe(1);
    expect(added).toHaveLength(2);              // one per match occurrence
    expect(added[0]!.attachment.id).toBe(added[1]!.attachment.id);   // same Attachment
    expect(added[0]!.isNew).toBe(true);         // first occurrence created the entry
    expect(added[1]!.isNew).toBe(false);        // second occurrence dedup'd
    expect(text).toBe(`${added[0]!.attachment.token} and again ${added[0]!.attachment.token}`);
  });

  test('repeat tokenize calls report dedup on the second pass', () => {
    // Real-world flow: user picks file via @-picker (call 1), then types
    // the same path again or @-picks it again (call 2). The second pass
    // must mark the result `isNew: false` so the dashboard can render
    // `(already attached)` instead of the noisy size line again.
    const abs = fixture('repeat.md');
    const reg = createContextRegistry();

    const first = tokenizeInput(abs, reg);
    expect(first.added).toHaveLength(1);
    expect(first.added[0]!.isNew).toBe(true);

    const second = tokenizeInput(abs, reg);
    expect(reg.attachments.size).toBe(1);       // no new registration
    expect(second.added).toHaveLength(1);
    expect(second.added[0]!.attachment.id).toBe(first.added[0]!.attachment.id);
    expect(second.added[0]!.isNew).toBe(false);
  });

  test('symlinks resolve to canonical path and dedup with the target', () => {
    // target file + two symlinks pointing at it. All three references should
    // collapse into a single Attachment keyed by the realpath of the target.
    const target = fixture('target.pdf');
    const link1 = join(tokDir, 'link-a.pdf');
    const link2 = join(tokDir, 'link-b.pdf');
    symlinkSync(target, link1);
    symlinkSync(target, link2);

    const reg = createContextRegistry();
    const { added } = tokenizeInput(`${target} and ${link1} and ${link2}`, reg);

    expect(reg.attachments.size).toBe(1);
    expect(added).toHaveLength(3);
    expect(new Set(added.map(a => a.attachment.id)).size).toBe(1);
    expect(added[0]!.attachment.sourcePath).toBe(target);  // canonical, not the symlink path
    // First reference is fresh, the two symlink references dedup.
    expect(added[0]!.isNew).toBe(true);
    expect(added[1]!.isNew).toBe(false);
    expect(added[2]!.isNew).toBe(false);
  });
});
