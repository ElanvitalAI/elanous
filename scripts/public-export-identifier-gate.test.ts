import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identifierGate, runIdentifierGate, summarizeIdentifierGate } from './public-export-identifier-gate.js';

// Synthetic private value — never a real host. The 0.3.38 prepare failures (#40609 · #40614) had this shape:
// an unquoted object key spelled like a host in the off-repo redaction table.
const PRIVATE = 'zzhost7';
const PLACEHOLDER = 'host-a';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pe-ident-gate-'));
  roots.push(root);
  mkdirSync(join(root, 'release'), { recursive: true });
  writeFileSync(join(root, 'release', 'public-export.yaml'), 'include:\n  - "src/**"\nexclude:\n  - "src/private/**"\nreplace: {}\n');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const UNQUOTED = `export const HOST_MEMORY = {\n  alpha: 16,\n  ${PRIVATE}: 32,\n};\n`;
const QUOTED = `export const HOST_MEMORY = {\n  alpha: 16,\n  '${PRIVATE}': 32,\n};\n`;

describe('LAND10-SHIFT-LEFT public-export identifier gate', () => {
  test('unquoted private host key in a changed export file is RED with file:line', () => {
    const root = fixtureRoot({ 'src/kit/defaults.ts': UNQUOTED });
    const result = identifierGate(['src/kit/defaults.ts'], root, [{ from: PRIVATE, to: PLACEHOLDER }]);
    expect(result.measured).toBe(true);
    expect(result.hits.map((hit) => `${hit.file}:${hit.line}:${hit.column}`)).toEqual(['src/kit/defaults.ts:3:3']);
  });

  test('quoted key and string values pass — prepare rewrites literals, not identifiers', () => {
    const root = fixtureRoot({ 'src/kit/defaults.ts': QUOTED, 'src/kit/uses.ts': `export const h = '${PRIVATE}';\n` });
    const result = identifierGate(['src/kit/defaults.ts', 'src/kit/uses.ts'], root, [{ from: PRIVATE, to: PLACEHOLDER }]);
    expect(result.hits).toEqual([]);
    expect(result.files).toBe(2);
  });

  test('files the manifest does not export and files the PR did not change are out of scope', () => {
    const root = fixtureRoot({ 'src/private/hosts.ts': UNQUOTED, 'src/kit/untouched.ts': UNQUOTED, 'src/kit/ok.ts': QUOTED });
    const result = identifierGate(['src/private/hosts.ts', 'src/kit/ok.ts', 'src/kit/deleted.ts'], root, [{ from: PRIVATE, to: PLACEHOLDER }]);
    expect(result.hits).toEqual([]);
    expect(result.files).toBe(1);
  });

  test('missing redaction table is «못 쟀다», never a silent pass', () => {
    const root = fixtureRoot({ 'src/kit/defaults.ts': UNQUOTED });
    const result = identifierGate(['src/kit/defaults.ts'], root, null);
    expect(result.measured).toBe(false);
    expect(summarizeIdentifierGate(result)).toContain('못 쟀다');
  });

  test('CLI: exit 1 · file:line · «quote the key» hint · the private value itself is not printed', () => {
    const root = fixtureRoot({ 'src/kit/defaults.ts': UNQUOTED, 'table.tsv': `${PRIVATE}\t${PLACEHOLDER}\n` });
    const previous = process.env.ELANOUS_EXPORT_REDACTIONS;
    process.env.ELANOUS_EXPORT_REDACTIONS = join(root, 'table.tsv');
    const out: string[] = [];
    try {
      const rc = runIdentifierGate({ args: ['--changed-files', 'src/kit/defaults.ts'], cwd: root, log: (l) => out.push(l), error: (l) => out.push(l) });
      expect(rc).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_EXPORT_REDACTIONS; else process.env.ELANOUS_EXPORT_REDACTIONS = previous;
    }
    const text = out.join('\n');
    expect(text).toContain('src/kit/defaults.ts:3:3');
    expect(text).toContain('quote the key');
    expect(text).toContain('RED');
    expect(text).not.toContain(PRIVATE);
  });

  test('CLI: no redaction table → exit 0 with a «못 쟀다» line on stderr', () => {
    const root = fixtureRoot({ 'src/kit/defaults.ts': UNQUOTED });
    const previous = process.env.ELANOUS_EXPORT_REDACTIONS;
    process.env.ELANOUS_EXPORT_REDACTIONS = join(root, 'absent.tsv');
    const errors: string[] = [];
    try {
      const rc = runIdentifierGate({ args: ['--changed-files', 'src/kit/defaults.ts'], cwd: root, log: () => {}, error: (l) => errors.push(l) });
      expect(rc).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ELANOUS_EXPORT_REDACTIONS; else process.env.ELANOUS_EXPORT_REDACTIONS = previous;
    }
    expect(errors.join('\n')).toContain('못 쟀다');
  });
});
