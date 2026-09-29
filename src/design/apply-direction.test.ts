import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDesignDirection, type ApplyDesignDirectionDeps } from './apply-direction.js';
import { listAllDesignDirections, listDesignDirections, parseDeclaredDirection } from './design-directions.js';

const original = '# Design\n\n## Craft rulebooks\n\n- typography\n';
const systemDesign = '# System\n\n> Category: Modern\n> System summary.\n';
const css = ':root {\n--bg: #101010;\n--fg: #fefefe;\n--accent: #abc123;\n--font-display: Display;\n--font-body: Body;\n}\n';
const commit = '1234567890abcdef';

function fixture(): { root: string; document: string; systemsDir: string; destination: string } {
  const root = mkdtempSync(join(tmpdir(), 'apply-direction-'));
  const document = join(root, 'DESIGN.md');
  const systemsDir = join(root, 'systems');
  const destination = join(root, 'design', 'system');
  mkdirSync(join(systemsDir, 'web-probe'), { recursive: true });
  writeFileSync(document, original);
  writeFileSync(join(systemsDir, 'SOURCE.json'), JSON.stringify({ commit }));
  writeFileSync(join(systemsDir, 'web-probe', 'manifest.json'), JSON.stringify({ id: 'web-probe', name: 'Web Probe', category: 'Modern' }));
  writeFileSync(join(systemsDir, 'web-probe', 'DESIGN.md'), systemDesign);
  writeFileSync(join(systemsDir, 'web-probe', 'tokens.css'), css);
  return { root, document, systemsDir, destination };
}

describe('applyDesignDirection', () => {
  test('theme id writes the direction without copying system files or changing craft rulebooks', () => {
    const f = fixture();
    try {
      const theme = listDesignDirections()[0]!.id;
      expect(applyDesignDirection(f.document, theme, { systemsDir: f.systemsDir }))
        .toEqual({ ok: true, documentPath: f.document, direction: theme });
      expect(readFileSync(f.document, 'utf8')).toBe(`# Design\n\n## Craft rulebooks\n\n- typography\n\n## Design direction\n\n- ${theme}\n`);
      expect(existsSync(f.destination)).toBe(false);
      expect(parseDeclaredDirection(readFileSync(f.document, 'utf8'), listAllDesignDirections({ systemsDir: f.systemsDir })))
        .toEqual({ declared: theme, unavailable: null });
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('system id copies DESIGN.md and tokens.css and declares id, tokens and source; selecting again is safe', () => {
    const f = fixture();
    try {
      const result = { ok: true as const, documentPath: f.document, direction: 'web-probe' };
      expect(applyDesignDirection(f.document, 'web-probe', { systemsDir: f.systemsDir })).toEqual(result);
      expect(readFileSync(join(f.destination, 'DESIGN.md'), 'utf8')).toBe(systemDesign);
      expect(readFileSync(join(f.destination, 'tokens.css'), 'utf8')).toBe(css);
      const expected = `${original}\n## Design direction\n\n- web-probe\n- tokens: design/system/tokens.css\n- source: open-design@1234567890\n`;
      expect(readFileSync(f.document, 'utf8')).toBe(expected);
      expect(applyDesignDirection(f.document, 'web-probe', { systemsDir: f.systemsDir })).toEqual(result);
      expect(readFileSync(f.document, 'utf8')).toBe(expected);
      expect(readdirSync(f.destination).sort()).toEqual(['DESIGN.md', 'tokens.css']);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('unknown id or unreadable document leaves the repository untouched', () => {
    const f = fixture();
    try {
      expect(applyDesignDirection(f.document, 'does-not-exist', { systemsDir: f.systemsDir })).toEqual({
        ok: false, reason: 'unknown-direction', documentPath: f.document,
        availableDirections: listAllDesignDirections({ systemsDir: f.systemsDir }).map((d) => d.id),
      });
      expect(applyDesignDirection(join(f.root, 'missing.md'), 'web-probe', { systemsDir: f.systemsDir }))
        .toEqual({ ok: false, reason: 'cannot-read', documentPath: join(f.root, 'missing.md') });
      expect(readFileSync(f.document, 'utf8')).toBe(original);
      expect(existsSync(f.destination)).toBe(false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('conflicting system file blocks before any other file or direction is changed', () => {
    const f = fixture();
    try {
      mkdirSync(f.destination, { recursive: true });
      const conflict = join(f.destination, 'tokens.css');
      writeFileSync(conflict, 'human-authored');
      expect(applyDesignDirection(f.document, 'web-probe', { systemsDir: f.systemsDir })).toEqual({
        ok: false, reason: 'conflicting-system-file', documentPath: f.document, path: conflict,
      });
      expect(readFileSync(conflict, 'utf8')).toBe('human-authored');
      expect(existsSync(join(f.destination, 'DESIGN.md'))).toBe(false);
      expect(readFileSync(f.document, 'utf8')).toBe(original);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('failed document replacement rolls back only newly created files and directories', () => {
    const f = fixture();
    try {
      const failRename = () => { throw new Error('rename failed'); };
      expect(applyDesignDirection(f.document, 'web-probe', { systemsDir: f.systemsDir, deps: { renameFile: failRename } }))
        .toEqual({ ok: false, reason: 'cannot-write', documentPath: f.document });
      expect(readFileSync(f.document, 'utf8')).toBe(original);
      expect(existsSync(join(f.root, 'design'))).toBe(false);
      expect(readdirSync(f.root).sort()).toEqual(['DESIGN.md', 'systems']);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('rollback preserves a pre-existing matching system file', () => {
    const f = fixture();
    try {
      mkdirSync(f.destination, { recursive: true });
      writeFileSync(join(f.destination, 'DESIGN.md'), systemDesign);
      const failRename = () => { throw new Error('rename failed'); };
      expect(applyDesignDirection(f.document, 'web-probe', { systemsDir: f.systemsDir, deps: { renameFile: failRename } }))
        .toEqual({ ok: false, reason: 'cannot-write', documentPath: f.document });
      expect(readFileSync(join(f.destination, 'DESIGN.md'), 'utf8')).toBe(systemDesign);
      expect(existsSync(join(f.destination, 'tokens.css'))).toBe(false);
      expect(readFileSync(f.document, 'utf8')).toBe(original);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('exclusive-create collision after preflight leaves a competing file intact', () => {
    const f = fixture();
    try {
      const collision = join(f.destination, 'tokens.css');
      const deps: ApplyDesignDirectionDeps = {
        readFile: (path) => readFileSync(path, 'utf8'),
        writeFile: (path, content, options) => {
          if (path === collision) {
            writeFileSync(path, 'created by another writer');
            throw Object.assign(new Error('file exists'), { code: 'EEXIST' });
          }
          writeFileSync(path, content, options?.exclusive ? { flag: 'wx' } : undefined);
          options?.onCreated?.();
        },
        readdir: (path) => readdirSync(path),
        mkdir: (path) => mkdirSync(path),
        removeFile: (path) => unlinkSync(path),
        removeDir: (path) => rmdirSync(path),
        renameFile: (from, to) => renameSync(from, to),
        documentTarget: (path) => ({ path }),
        setFileMode: (path, mode) => chmodSync(path, mode),
      };
      expect(applyDesignDirection(f.document, 'web-probe', { systemsDir: f.systemsDir, deps })).toEqual({
        ok: false, reason: 'conflicting-system-file', documentPath: f.document, path: collision,
      });
      expect(readFileSync(collision, 'utf8')).toBe('created by another writer');
      expect(existsSync(join(f.destination, 'DESIGN.md'))).toBe(false);
      expect(readFileSync(f.document, 'utf8')).toBe(original);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('system replacement preserves a symlink to a 0600 document and its target mode', () => {
    const f = fixture();
    try {
      const actual = join(f.root, 'private.md');
      writeFileSync(actual, original);
      chmodSync(actual, 0o600);
      symlinkSync(actual, f.document + '.link');
      const link = f.document + '.link';
      expect(applyDesignDirection(link, 'web-probe', { systemsDir: f.systemsDir }).ok).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(statSync(actual).mode & 0o777).toBe(0o600);
      expect(readFileSync(actual, 'utf8')).toContain('- source: open-design@1234567890');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('라이브러리 id 는 두 파일을 복사하고 셋째 줄을 source: custom@<id> 로 쓴다', () => {
    const f = fixture();
    const library = join(f.root, 'library');
    try {
      mkdirSync(join(library, 'my-ink'), { recursive: true });
      writeFileSync(join(library, 'SOURCE.json'), JSON.stringify({ commit: 'custom' }));
      writeFileSync(join(library, 'my-ink', 'manifest.json'), JSON.stringify({ id: 'my-ink', name: 'My Ink', category: 'Custom' }));
      writeFileSync(join(library, 'my-ink', 'DESIGN.md'), '# My Ink\n\n> Category: Custom\n> measured.\n');
      const customCss = ':root {\n--bg: #fff;\n--fg: #111;\n--accent: #c34;\n--font-display: Display;\n--font-body: Body;\n}\n';
      writeFileSync(join(library, 'my-ink', 'tokens.css'), customCss);
      expect(applyDesignDirection(f.document, 'my-ink', { systemsDir: f.systemsDir, librarySystemsDir: library }))
        .toEqual({ ok: true, documentPath: f.document, direction: 'my-ink' });
      expect(readFileSync(join(f.destination, 'DESIGN.md'), 'utf8')).toContain('# My Ink');
      expect(readFileSync(join(f.destination, 'tokens.css'), 'utf8')).toBe(customCss);
      const direction = readFileSync(f.document, 'utf8').split('## Design direction')[1] ?? '';
      const lines = direction.split('\n').filter((line) => line.startsWith('- '));
      expect(lines[2]).toBe('- source: custom@my-ink');
      expect(applyDesignDirection(f.document, 'web-probe', { systemsDir: f.systemsDir, librarySystemsDir: library }).ok).toBe(true);
      expect(readFileSync(f.document, 'utf8')).toContain('- source: open-design@1234567890');
      expect(readFileSync(f.document, 'utf8')).not.toContain('source: custom@');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

describe('applyDesignDirection — switching systems', () => {
  const otherDesign = '# Other\n\n> Category: Retro\n> Other summary.\n';
  const otherCss = ':root {\n--bg: #fafafa;\n--fg: #222222;\n--accent: #b5452b;\n--font-display: Georgia, serif;\n--font-body: Body;\n}\n';
  function twoSystems() {
    const f = fixture();
    mkdirSync(join(f.systemsDir, 'other-probe'), { recursive: true });
    writeFileSync(join(f.systemsDir, 'other-probe', 'manifest.json'), JSON.stringify({ id: 'other-probe', name: 'Other Probe', category: 'Retro' }));
    writeFileSync(join(f.systemsDir, 'other-probe', 'DESIGN.md'), otherDesign);
    writeFileSync(join(f.systemsDir, 'other-probe', 'tokens.css'), otherCss);
    return f;
  }

  test('an unedited copy of the declared system is replaced by the new one', () => {
    const f = twoSystems();
    try {
      expect(applyDesignDirection(f.document, 'web-probe', { systemsDir: f.systemsDir }).ok).toBe(true);
      expect(applyDesignDirection(f.document, 'other-probe', { systemsDir: f.systemsDir }))
        .toEqual({ ok: true, documentPath: f.document, direction: 'other-probe' });
      expect(readFileSync(join(f.destination, 'tokens.css'), 'utf8')).toBe(otherCss);
      expect(readFileSync(join(f.destination, 'DESIGN.md'), 'utf8')).toBe(otherDesign);
      expect(parseDeclaredDirection(readFileSync(f.document, 'utf8'), listAllDesignDirections({ systemsDir: f.systemsDir })).declared)
        .toBe('other-probe');
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('an edited copy still blocks and nothing changes', () => {
    const f = twoSystems();
    try {
      expect(applyDesignDirection(f.document, 'web-probe', { systemsDir: f.systemsDir }).ok).toBe(true);
      const tokens = join(f.destination, 'tokens.css');
      writeFileSync(tokens, `${css}/* mine */\n`);
      const before = readFileSync(f.document, 'utf8');
      expect(applyDesignDirection(f.document, 'other-probe', { systemsDir: f.systemsDir }))
        .toEqual({ ok: false, reason: 'conflicting-system-file', documentPath: f.document, path: tokens });
      expect(readFileSync(tokens, 'utf8')).toBe(`${css}/* mine */\n`);
      expect(readFileSync(join(f.destination, 'DESIGN.md'), 'utf8')).toBe(systemDesign);
      expect(readFileSync(f.document, 'utf8')).toBe(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });

  test('a failed switch puts the previous system files back', () => {
    const f = twoSystems();
    try {
      expect(applyDesignDirection(f.document, 'web-probe', { systemsDir: f.systemsDir }).ok).toBe(true);
      const before = readFileSync(f.document, 'utf8');
      // The staged document lands in a folder that does not exist, so the write
      // fails AFTER the system files were replaced — the rollback must run.
      const unreachable = () => ({ path: join(f.root, 'missing-folder', 'DESIGN.md') });
      expect(applyDesignDirection(f.document, 'other-probe', { systemsDir: f.systemsDir, deps: { documentTarget: unreachable } }))
        .toEqual({ ok: false, reason: 'cannot-write', documentPath: f.document });
      expect(readFileSync(join(f.destination, 'tokens.css'), 'utf8')).toBe(css);
      expect(readFileSync(join(f.destination, 'DESIGN.md'), 'utf8')).toBe(systemDesign);
      expect(readFileSync(f.document, 'utf8')).toBe(before);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});
