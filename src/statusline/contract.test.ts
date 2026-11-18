// STATUSLINE-CONTRACT-V1 slice 1: version · line numbers · JSON Schema in step with the loader · validate / preview.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { locateStatuslineIssue, mergeStatuslineLayers, parseStatuslineYaml, STATUSLINE_CONTRACT_VERSION } from './load.js';
import { renderStatusline } from './evaluate.js';
import { statuslineBreakpoints, statuslineWidthBand, type StatuslineDefinition } from './schema.js';
import { formatStatuslineIssue, previewStatusline, STATUSLINE_JSON_SCHEMA, validateStatuslineFile } from './contract.js';
import { registerStatuslineCommands } from '../cli/statusline-cli.js';
import { judgeNextTuiStatusline, loadNextTuiStatusline, mergeIssue } from './next-tui.js';
import { defaultStatuslineDefinition } from './legacy-parity.js';

const BUILD = { version: '0.3.28-dev.0', sha: '9956d46f714fe577094b213c1c5b04d2509e983a', source: 'installed' as const };

describe('statusline.yaml contract v1', () => {
  test('version 1 and $schema are read; another version is refused with its line', () => {
    expect(parseStatuslineYaml(`version: 1\n$schema: ./statusline-1.json\nsegments: []\n`, { partial: true }).ok).toBe(true);
    const later = parseStatuslineYaml(`segments: []\nversion: 2\n`, { partial: true });
    expect(later.ok).toBe(false);
    if (!later.ok) expect(later.issues).toEqual([{ path: 'version', message: `unsupported version: 2 (this build reads ${STATUSLINE_CONTRACT_VERSION})`, line: 2 }]);
  });

  test('every issue points at its line: a field of a row, a row by band, an unknown key, a YAML syntax error', () => {
    const source = [
      'segments:',                       // 1
      '  - id: a',                       // 2
      '    source: session',             // 3
      '    field: x',                    // 4
      '  - id: b',                       // 5
      '    source: nowhere',             // 6
      '    field: y',                    // 7
      'layouts:',                        // 8
      '  - band: sm',                    // 9
      '    lines: 1',                    // 10
      '    segments: [a]',               // 11
      '    drop: [zz]',                  // 12
      'colour: red',                     // 13
    ].join('\n');
    const parsed = parseStatuslineYaml(source, { partial: true });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const byPath = Object.fromEntries(parsed.issues.map((issue) => [`${issue.path} ${issue.message}`, issue.line]));
    expect(byPath).toEqual({
      'segments[1] unknown source: nowhere': 5,
      'layouts[0].drop drop may only name segments of this layout': 12,
      'colour unknown key': 13,
    });
    const syntax = parseStatuslineYaml('segments:\n  - id: a\n   bad: [\n', { partial: true });
    expect(syntax.ok).toBe(false);
    if (!syntax.ok) expect(syntax.issues[0]!.line).toBe(3);
  });

  // #38316 REVIEW-2: the schema and the loader refuse the same keys — top level and inside every row kind.
  test('a key the JSON Schema refuses is refused by the loader too, with its line (every row kind)', () => {
    const rows = STATUSLINE_JSON_SCHEMA.properties;
    expect(Object.keys(rows.segments.items.properties).sort()).toEqual(['field', 'format', 'id', 'label', 'source', 'when']);
    expect(Object.keys(rows.rules.items.properties).sort()).toEqual(['bands', 'color', 'glyph', 'hide', 'id', 'segments', 'when']);
    expect(Object.keys(rows.layouts.items.properties).sort()).toEqual(['band', 'drop', 'lines', 'secondLine', 'segments', 'shorten']);
    for (const kind of [rows.segments, rows.rules, rows.layouts]) expect(kind.items.additionalProperties).toBe(false);
    const source = [
      'segments:',              // 1
      '  - id: a',              // 2
      '    source: session',    // 3
      '    field: x',           // 4
      '    colour: red',        // 5
      'rules:',                 // 6
      '  - id: r',              // 7
      '    when: a > 1',        // 8
      '    glph: "!"',          // 9
      'layouts:',               // 10
      '  - band: sm',           // 11
      '    lines: 1',           // 12
      '    segments: [a]',      // 13
      '    dorp: [a]',          // 14
    ].join('\n');
    const parsed = parseStatuslineYaml(source, { partial: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues.map((issue) => [issue.path, issue.message, issue.line])).toEqual([
        ['segments[0].colour', 'unknown key', 5],
        ['rules[0].glph', 'unknown key', 9],
        ['layouts[0].dorp', 'unknown key', 14],
      ]);
    }
  });

  test('the JSON Schema names exactly the keys the loader reads', () => {
    expect(Object.keys(STATUSLINE_JSON_SCHEMA.properties).sort()).toEqual(['$schema', 'bands', 'layouts', 'position', 'rules', 'segments', 'version']);
    expect(STATUSLINE_JSON_SCHEMA.properties.version.const).toBe(STATUSLINE_CONTRACT_VERSION);
    // A key the schema does not list is one the loader refuses too.
    expect(parseStatuslineYaml('colour: red\n', { partial: true }).ok).toBe(false);
  });
});

describe('eln statusline validate / preview / schema', () => {
  const run = async (args: string[], userPath: string) => {
    const lines: string[] = [];
    const program = new Command().exitOverride();
    registerStatuslineCommands(program, { out: (line) => lines.push(line), userPath: () => userPath, build: async () => BUILD });
    const prior = process.exitCode;
    process.exitCode = 0;
    await program.parseAsync(['node', 'eln', 'statusline', ...args]);
    const code = process.exitCode;
    process.exitCode = prior ?? 0;
    return { lines, code };
  };

  test('validate: ok, or one «file:line: path: message» per issue and exit 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slc-'));
    try {
      const good = join(dir, 'good.yaml');
      writeFileSync(good, 'version: 1\nsegments: []\n');
      expect(await run(['validate', good], good)).toEqual({ lines: [`${good}: ok`], code: 0 });
      const bad = join(dir, 'bad.yaml');
      writeFileSync(bad, 'segments: []\ncolour: red\n');
      expect(await run(['validate'], bad)).toEqual({ lines: [`${bad}:2: colour: unknown key`], code: 1 });
      expect(formatStatuslineIssue('f', { path: '', message: 'm' })).toBe('f (location unknown): m');
      expect(validateStatuslineFile(join(dir, 'missing.yaml'))[0]!.message).toContain('ENOENT');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // #38316 REVIEW-1: validate must never pass a file the TUI refuses — same judgement, same reason.
  test('validate refuses every file the TUI loader refuses, for the same reason (merge, two-line layout)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slc-'));
    try {
      const cases = {
        // Parses on its own, but the md layout names a segment neither this file nor the default has.
        'unknown-segment.yaml': 'layouts:\n  - band: md\n    lines: 1\n    segments: [nowhere]\n',
        // A valid two-line layout: the Next TUI footer is one row.
        'two-line.yaml': 'segments:\n  - id: a\n    source: session\n    field: x\nlayouts:\n  - band: lg\n    lines: 2\n    segments: [a]\n    secondLine: [a]\n',
      } as const;
      for (const [name, text] of Object.entries(cases)) {
        const file = join(dir, name);
        writeFileSync(file, text);
        const tui = loadNextTuiStatusline(file);
        expect(tui.warning).toBeDefined();
        const { lines, code } = await run(['validate', file], file);
        expect(code).toBe(1);
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toBe(`${file}: ok`);
        expect(lines[0]).toStartWith(`${file}:`);
        const verdict = judgeNextTuiStatusline(text);
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) expect(tui.warning).toContain(verdict.why);
      }
      expect((await run(['validate', join(dir, 'unknown-segment.yaml')], '/x')).lines[0]).toContain(':2: layouts.md: does not merge over the default: merged layout md references unknown segment nowhere');
      expect((await run(['validate', join(dir, 'two-line.yaml')], '/x')).lines[0]).toContain(':6: layouts.lg: two-line layouts');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('preview: one line per width, never wider than that width; the default when no file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slc-'));
    try {
      const { lines, code } = await run(['preview', '--width', '40,80,140,200'], join(dir, 'none.yaml'));
      expect(code).toBe(0);
      expect(lines.map((line) => Number(line.split('│')[0]))).toEqual([40, 80, 140, 200]);
      for (const line of lines) {
        const [width, drawn] = line.split('│') as [string, string];
        expect(Bun.stringWidth(drawn)).toBeLessThanOrEqual(Number(width));
      }
      const preview = previewStatusline({ path: join(dir, 'none.yaml'), widths: [200], build: BUILD, cwd: '/home/me/app' });
      expect(preview.warning).toBeUndefined();
      expect(preview.lines[0]!.line).toContain('app');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('schema prints the JSON Schema', async () => {
    const { lines } = await run(['schema'], '/nonexistent');
    expect(JSON.parse(lines.join('\n')).$id).toBe(STATUSLINE_JSON_SCHEMA.$id);
  });
});

// OP 11-18: an issue whose path cannot be found in the file carries no line (never the root «:1»), and says so.
test('a path not found in this file gets no line: a band only the default has, a row index past the list', () => {
  const merge = locateStatuslineIssue('segments: []\n', { path: 'layouts.md', message: 'm' });
  expect(merge.line).toBeUndefined();
  expect(locateStatuslineIssue('segments:\n  - id: a\n', { path: 'segments[3].when', message: 'm' }).line).toBeUndefined();
  expect(locateStatuslineIssue('segments:\n  - id: a\n', { path: '', message: 'm' }).line).toBeUndefined();
  // Found all the way → its line.
  expect(locateStatuslineIssue('segments:\n  - id: a\n    when: x\n', { path: 'segments[0].when', message: 'm' }).line).toBe(3);
  expect(formatStatuslineIssue('s.yaml', merge)).toBe('s.yaml (location unknown): layouts.md: m');
});

// #38329 REVIEW-1: a row that is here but lacks a required key points at that row — not «location unknown».
test('a required key missing from a row points at the row; a missing row still has no line', () => {
  const source = ['rules:', '  - id: r1', '    color: red', '  - id: r2', '    when: a > 1'].join('\n');
  const parsed = parseStatuslineYaml(source, { partial: true });
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.issues).toContainEqual({ path: 'rules[0].when', message: 'when is required', line: 2 });
  // A missing key one step above the last (the row itself absent) is still unknown.
  expect(locateStatuslineIssue(source, { path: 'rules[5].when', message: 'm' }).line).toBeUndefined();
  expect(locateStatuslineIssue(source, { path: 'layouts[0].drop', message: 'm' }).line).toBeUndefined();
  // A missing top-level key (a document-level requirement) points at the document's first line.
  expect(locateStatuslineIssue(source, { path: 'segments', message: 'm' }).line).toBe(1);
});

// STATUSLINE-CONTRACT-V1 slice 2: user band edges and band-scoped rules.
describe('bands: and rules[].bands', () => {
  const SEGMENTS = ['segments:', '  - { id: a, source: session, field: a }', '  - { id: b, source: session, field: b }'];
  const LAYOUTS = ['layouts:', '  - { band: xs, lines: 1, segments: [a] }', '  - { band: sm, lines: 1, segments: [a, b] }',
    '  - { band: md, lines: 1, segments: [b, a] }', '  - { band: lg, lines: 1, segments: [b] }'];
  const snapshot = { session: { a: 'A', b: 'B' } };
  const load = (extra: string[]) => {
    const parsed = parseStatuslineYaml([...SEGMENTS, ...LAYOUTS, ...extra].join('\n'), { partial: true });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    return parsed.definition;
  };
  const shown = (definition: StatuslineDefinition, columns: number) => renderStatusline(definition, snapshot, columns).lines[0]!.map((s) => s.text).join(' ');

  test('bands: moves the edges (any subset; the rest keep 40/80/140)', () => {
    const wideSm = load(['bands: { sm: 100 }']);
    expect(statuslineWidthBand(90)).toBe('md');
    expect(statuslineWidthBand(90, statuslineBreakpoints(wideSm))).toBe('sm');
    expect(shown(wideSm, 90)).toBe('A B'); // the sm layout
    expect(shown(load([]), 90)).toBe('B A'); // the md layout by default
    expect(statuslineWidthBand(30, statuslineBreakpoints(wideSm))).toBe('xs');
  });

  test('bands: must be whole columns, known keys, and increase — each issue with its line', () => {
    const parsed = parseStatuslineYaml([...SEGMENTS, 'bands:', '  sm: 30', '  xl: 300', '  md: 0.5'].join('\n'), { partial: true });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((issue) => [issue.path, issue.line])).toEqual([
      // segments take lines 1–3; bands: is line 4 (sm 5 · xl 6 · md 7).
      ['bands.xl', 6], ['bands.md', 7], ['bands', 4],
    ]);
  });

  test('a rule with bands applies only in those bands', () => {
    const definition = load(['rules:', '  - { id: narrow-red, when: "session_a == A", color: red, glyph: "!", bands: [xs, sm], segments: [a] }']);
    expect(renderStatusline(definition, snapshot, 60).lines[0]!.find((s) => s.id === 'a')).toMatchObject({ color: 'red', text: '! A' });
    expect(renderStatusline(definition, snapshot, 120).lines[0]!.find((s) => s.id === 'a')).toEqual({ id: 'a', text: 'A' });
    const bad = parseStatuslineYaml([...SEGMENTS, 'rules:', '  - { id: r, when: "a > 1", bands: [xl] }'].join('\n'), { partial: true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toContainEqual({ path: 'rules[0].bands', message: 'unknown band: xl', line: 5 });
  });

  test('layers: a later bands: wins per key; the Next TUI footer uses the merged edges', () => {
    const merged = mergeStatuslineLayers(load(['bands: { sm: 100, md: 160 }']), undefined, load(['bands: { md: 200 }']));
    expect(merged.bands).toEqual({ sm: 100, md: 200 });
  });
});

// #38349 REVIEW-1: edges valid in each file can stop increasing once the layers merge — refused, never silent.
test('merged band edges must still increase: seat sm 100 + user md 90 is refused with a message', () => {
  const seat = parseStatuslineYaml('bands: { sm: 100 }\n', { partial: true });
  const user = parseStatuslineYaml('bands: { md: 90 }\n', { partial: true });
  expect(seat.ok && user.ok).toBe(true);
  if (!seat.ok || !user.ok) return;
  expect(() => mergeStatuslineLayers(defaultStatuslineDefinition(), seat.definition, user.definition))
    .toThrow('merged bands must increase xs < sm < md (got 40 · 100 · 90)');
  // Each file alone is fine against the defaults.
  expect(() => mergeStatuslineLayers(defaultStatuslineDefinition(), seat.definition)).not.toThrow();
  expect(() => mergeStatuslineLayers(defaultStatuslineDefinition(), undefined, user.definition)).not.toThrow();
});

test('a non-increasing merge is reported at the file\'s bands: line, or at the document when the file has none', () => {
  const message = 'merged bands must increase xs < sm < md (got 40 · 100 · 90)';
  expect(mergeIssue('segments: []\nbands: { md: 90 }\n', message)).toEqual({ path: 'bands', line: 2,
    message: `does not merge over the default: ${message}` });
  // No bands: in this file — the missing key's map (the document) is the place (#38329 REVIEW-1 rule).
  expect(mergeIssue('segments: []\n', message).line).toBe(1);
});

// DESIGN §2b: position: bottom | above-input (default bottom); the last layer that says one wins.
test('position: bottom by default, above-input by choice, anything else refused with its line', () => {
  const pick = (yaml: string) => { const parsed = parseStatuslineYaml(yaml, { partial: true }); return parsed.ok ? parsed.definition.position : parsed.issues; };
  expect(pick('segments: []\n')).toBeUndefined();
  expect(pick('position: above-input\n')).toBe('above-input');
  expect(pick('segments: []\nposition: top\n')).toEqual([{ path: 'position', message: 'position must be bottom or above-input (got top)', line: 2 }]);
  const seat = parseStatuslineYaml('position: above-input\n', { partial: true });
  const user = parseStatuslineYaml('position: bottom\n', { partial: true });
  if (!seat.ok || !user.ok) throw new Error('fixture');
  expect(mergeStatuslineLayers(defaultStatuslineDefinition(), seat.definition).position).toBe('above-input');
  expect(mergeStatuslineLayers(defaultStatuslineDefinition(), seat.definition, user.definition).position).toBe('bottom');
});
