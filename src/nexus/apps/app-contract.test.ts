import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseAppManifest } from './app-contract.js';

const validYaml = `apiVersion: elanous.app/v0
slug: voice-note
title: My voice notes
frontend:
  kind: static-export
tables:
  notes: {}
roles:
  owner: { via: nexus-session }
  viewer: { via: share-link }
rpc:
  listNotes:
    sql: SELECT id FROM notes WHERE id = :id
    params: { id: { type: text } }
    allow: [owner, viewer]
actions:
  transcribe: { builtin: stt, uses: [cred:openai.api_key] }
  summarize: { builtin: summarize, uses: [cred:openai.api_key] }
  readAloud: { builtin: tts, uses: [cred:elevenlabs.api_key] }
  makeAd: { builtin: generate, async: true, spend: owner-confirm, uses: [cred:higgsfield.secret] }
storage:
  prefix: apps/voice-note/
credentials:
  - cred:openai.api_key
`;

function replaceOnce(from: string, to: string): string {
  if (!validYaml.includes(from)) throw new Error(`fixture fragment missing: ${from}`);
  return validYaml.replace(from, to);
}

type ParseResult = ReturnType<typeof parseAppManifest>;
const errorsOf = (result: ParseResult) => result.ok ? [] : result.errors;
const warningsOf = (result: ParseResult) => result.ok ? result.warnings : [];

describe('NEXUS-APP-CONTRACT', () => {
  test('NEXUS-APP-CONTRACT: RFC 정본의 적용 범위를 §2꼴·§2 «검증 규칙» 표·§3내장 동작 다섯·§4', () => {
    expect(errorsOf(parseAppManifest(validYaml))).toEqual([]);
    const checks = [
      replaceOnce('kind: static-export', 'kind: server'),
      replaceOnce('allow: [owner, viewer]', 'allow: []'),
      replaceOnce('builtin: stt', 'builtin: shell'),
      replaceOnce('async: true, spend: owner-confirm,', 'async: true,'),
      replaceOnce('apps/voice-note/', 'apps/other-app/'),
    ];
    for (const source of checks) expect(errorsOf(parseAppManifest(source)).length).toBeGreaterThan(0);
  });

  test('accepts the RFC voice-note shape and checks uniqueness against caller slugs', () => {
    const result = parseAppManifest(validYaml, new Set(['another-app']));
    expect(result.ok).toBe(true);
    expect(errorsOf(result)).toEqual([]);
    expect(warningsOf(result)).toEqual([]);
    expect(result.ok && result.manifest.slug).toBe('voice-note');
    expect(errorsOf(parseAppManifest(validYaml, ['voice-note'])).map(issue => issue.path)).toContain('/slug');
  });

  test('validates app storage quota and upload role/content-type declarations', () => {
    const source = validYaml.replace(
      'storage:\n  prefix: apps/voice-note/\n',
      'storage:\n  prefix: apps/voice-note/\n  quotaBytes: 1024\n  upload: { allow: [owner], types: [audio/wav], maxBytes: 512 }\n',
    );
    expect(errorsOf(parseAppManifest(source))).toEqual([]);
    expect(parseAppManifest(source.replace('maxBytes: 512', 'maxBytes: 512, anonymous: true')).ok).toBe(true);
    for (const invalid of [
      source.replace('quotaBytes: 1024', 'quotaBytes: 0'),
      source.replace('allow: [owner]', 'allow: [missing-role]'),
      source.replace('types: [audio/wav]', 'types: [not-a-mime]'),
      source.replace('maxBytes: 512', 'maxBytes: -1'),
      source.replace('maxBytes: 512', 'maxBytes: 512, anonymous: "yes"'),
    ]) {
      expect(errorsOf(parseAppManifest(invalid)).length).toBeGreaterThan(0);
    }
  });

  test('accepts translate as a builtin with text and source/target language declarations', () => {
    const source = replaceOnce(
      '  summarize: { builtin: summarize, uses: [cred:openai.api_key] }',
      '  translate: { builtin: translate, input: { text: text, sourceLanguage: text, targetLanguage: text }, uses: [cred:openai.api_key] }',
    );
    const result = parseAppManifest(source);
    expect(result.ok).toBe(true);
    expect(errorsOf(result)).toEqual([]);
  });

  test('parses the translator template action input/output declaration', () => {
    const source = readFileSync('templates/next-app-translator/app.yaml', 'utf8');
    const result = parseAppManifest(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const actions = result.manifest.actions as Record<string, { input?: unknown; output?: { text?: string } }>;
    expect(actions.translate?.input).toEqual({ text: 'text', sourceLanguage: 'text', targetLanguage: 'text' });
    expect(actions.translate?.output).toEqual({ text: 'text' });
  });

  test('reports malformed YAML without echoing the source', () => {
    const source = 'slug: sk-super-secret-value\ninvalid: [';
    const result = parseAppManifest(source);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(errorsOf(result))).not.toContain('sk-super-secret-value');
    expect(errorsOf(result)[0]?.path).toBe('/');
  });

  test('validates slug syntax, reserved names, preview suffix, and duplicate names', () => {
    for (const slug of ['Bad_Name', 'bad--name', 'xn--n', 'app-pr42', 'www', 'a'.repeat(64)]) {
      const result = parseAppManifest(replaceOnce('slug: voice-note', `slug: ${slug}`));
      expect(errorsOf(result).some(issue => issue.path === '/slug')).toBe(true);
    }
  });

  test('only permits static export frontend kind', () => {
    const result = parseAppManifest(replaceOnce('kind: static-export', 'kind: server'));
    expect(errorsOf(result).some(issue => issue.path === '/frontend/kind')).toBe(true);
  });

  test('checks RPC SQL statement count, binds, DDL, string concatenation, and declared tables', () => {
    const cases = [
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: SELECT id FROM notes; DELETE FROM notes'],
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: SELECT id FROM notes WHERE id = ?'],
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: DROP TABLE notes'],
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: SELECT id FROM notes WHERE id = :id || :id'],
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: SELECT id FROM missing_table WHERE id = :id'],
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: SELECT id FROM notes, missing_table WHERE id = :id'],
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: SELECT id FROM "missing_table" WHERE id = :id'],
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: SELECT id FROM (missing_table) WHERE id = :id'],
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: SELECT * FROM (SELECT 1), missing_table WHERE id = :id'],
      ['sql: SELECT id FROM notes WHERE id = :id', String.raw`sql: SELECT 'a\'; DELETE FROM notes; -- '`],
    ];
    for (const [from, to] of cases) {
      const result = parseAppManifest(replaceOnce(from!, to!));
      expect(errorsOf(result).some(issue => issue.path === '/rpc/@entry:0/sql')).toBe(true);
    }
    const harmlessLiteral = parseAppManifest(replaceOnce('sql: SELECT id FROM notes WHERE id = :id', "sql: SELECT id FROM notes WHERE id = :id AND title = 'DROP TABLE'"));
    expect(errorsOf(harmlessLiteral)).toEqual([]);
  });

  test('requires nonempty allow lists containing declared roles', () => {
    for (const fragment of ['allow: []', 'allow: [admin]']) {
      const result = parseAppManifest(replaceOnce('allow: [owner, viewer]', fragment));
      expect(errorsOf(result).some(issue => issue.path === '/rpc/@entry:0/allow')).toBe(true);
    }
  });

  test('rejects unknown builtins and malformed or secret-like credential values without echoing them', () => {
    const badBuiltin = parseAppManifest(replaceOnce('builtin: stt', 'builtin: shell'));
    expect(errorsOf(badBuiltin).some(issue => issue.path === '/actions/@entry:0/builtin')).toBe(true);

    for (const value of ['raw-value', 'sk-live-secret-material', 'xai-very-secret-material', 'ghp_secret-material', 'gho_secret-material', 'github_pat_secret', 'AKIA0123456789ABCDEF', 'AIza-secret', 'xoxb-secret']) {
      const changed = replaceOnce('uses: [cred:openai.api_key]', `uses: ["${value}"]`);
      const result = parseAppManifest(changed);
      expect(errorsOf(result).some(issue => issue.path === '/actions/@entry:0/uses/0')).toBe(true);
      expect(JSON.stringify(errorsOf(result))).not.toContain(value);
    }
    const malformed = parseAppManifest(replaceOnce('- cred:openai.api_key', '- openai.api_key'));
    expect(errorsOf(malformed).some(issue => issue.path === '/credentials/0')).toBe(true);
    const secretCredential = parseAppManifest(replaceOnce('- cred:openai.api_key', '- "sk-credential-secret"'));
    expect(errorsOf(secretCredential).some(issue => issue.path === '/credentials/0')).toBe(true);
    expect(JSON.stringify(errorsOf(secretCredential))).not.toContain('sk-credential-secret');
  });

  test('requires spend for asynchronous generate and binds storage prefix to the app slug', () => {
    const noSpend = parseAppManifest(replaceOnce('async: true, spend: owner-confirm,', 'async: true,'));
    expect(errorsOf(noSpend).some(issue => issue.path === '/actions/@entry:3/spend')).toBe(true);
    const badPrefix = parseAppManifest(replaceOnce('apps/voice-note/', 'apps/other-app/'));
    expect(errorsOf(badPrefix).some(issue => issue.path === '/storage/prefix')).toBe(true);
  });

  test('warns on unknown v0 top-level keys', () => {
    const result = parseAppManifest(`${validYaml}mystery: true\n`);
    expect(errorsOf(result)).toEqual([]);
    expect(warningsOf(result).map(issue => issue.path)).toContain('/unknownTopLevelKeys/0');
  });

  test('keeps caller-controlled keys out of warnings and diagnostics', () => {
    const unknownKey = 'arbitrary-unprefixed-secret-name';
    const unknown = parseAppManifest(`${validYaml}"${unknownKey}": true\n`);
    expect(JSON.stringify(warningsOf(unknown))).not.toContain(unknownKey);
    expect(warningsOf(unknown)[0]?.path).toBe('/unknownTopLevelKeys/0');

    const rpcKey = 'arbitrary-unprefixed-rpc-secret';
    const rpc = parseAppManifest(replaceOnce('listNotes:', `"${rpcKey}":`).replace('allow: [owner, viewer]', 'allow: []'));
    expect(errorsOf(rpc).some(issue => issue.path === '/rpc/@entry:0/allow')).toBe(true);
    expect(JSON.stringify(errorsOf(rpc))).not.toContain(rpcKey);

    const actionKey = 'unprefixed-action-secret';
    const action = parseAppManifest(replaceOnce('transcribe:', `"${actionKey}":`).replace('builtin: stt', 'builtin: shell'));
    expect(errorsOf(action).some(issue => issue.path === '/actions/@entry:0/builtin')).toBe(true);
    expect(JSON.stringify(errorsOf(action))).not.toContain(actionKey);
  });

  test('uses distinct ordinal locators when a real key resembles the old redaction placeholder', () => {
    const withCollision = replaceOnce('listNotes:', '"redacted-key-0":')
      .replace('    allow: [owner, viewer]', '    allow: []\n  "sk-rpc-secret-name":\n    sql: SELECT * FROM notes\n    allow: []');
    const result = parseAppManifest(withCollision);
    const paths = errorsOf(result).map(issue => issue.path);
    expect(paths).toContain('/rpc/@entry:0/allow');
    expect(paths).toContain('/rpc/@entry:1/allow');
    expect(new Set(paths).size).toBe(paths.length);
    expect(JSON.stringify(errorsOf(result))).not.toContain('redacted-key-0');
    expect(JSON.stringify(errorsOf(result))).not.toContain('sk-rpc-secret-name');
  });

  test('keeps ordinal diagnostic locations in YAML order when a map has an integer-like key', () => {
    const numericRpcKey = replaceOnce('sql: SELECT id FROM notes WHERE id = :id', 'sql: SELECT id FROM missing_table WHERE id = :id')
      .replace('    allow: [owner, viewer]', '    allow: [owner, viewer]\n  "0":\n    sql: SELECT id FROM notes WHERE id = :id\n    params: { id: { type: text } }\n    allow: [owner, viewer]');
    const rpc = parseAppManifest(numericRpcKey);
    expect(errorsOf(rpc).some(issue => issue.path === '/rpc/@entry:0/sql')).toBe(true);

    const numericActionKey = replaceOnce(
      '  transcribe: { builtin: stt, uses: [cred:openai.api_key] }',
      '  transcribe: { builtin: shell, uses: [cred:openai.api_key] }\n  "0": { builtin: stt }',
    );
    const action = parseAppManifest(numericActionKey);
    expect(errorsOf(action).some(issue => issue.path === '/actions/@entry:0/builtin')).toBe(true);
  });
});
