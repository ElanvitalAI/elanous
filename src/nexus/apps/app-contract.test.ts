import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAppManifest } from './app-contract.js';
import { createAppDatabase } from './app-db.js';
import { createAppSimulationStore } from './app-simulation-db.js';
import { createAppSimulationRoute } from './app-simulation-route.js';
import { runRegisteredAppSimulation } from './app-simulation-runner.js';
import { createFakeAppHost } from '../../ux-sim/fake-app-host.js';

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
  transcribe: { builtin: stt, input: { audio: object-ref }, output: { text: text }, uses: [cred:openai.api_key] }
  summarize: { builtin: summarize, input: { text: text }, output: { text: text }, uses: [cred:openai.api_key] }
  readAloud: { builtin: tts, input: { text: text, voiceId: text }, output: { audioBase64: text, mimeType: text }, uses: [cred:elevenlabs.api_key] }
  makeAd: { builtin: generate, async: true, spend: owner-confirm, uses: [cred:higgsfield.secret] }
storage:
  prefix: apps/voice-note/
credentials:
  - cred:openai.api_key
`;

function replaceInOnce(source: string, from: string, to: string): string {
  if (!source.includes(from)) throw new Error(`fixture fragment missing: ${from}`);
  return source.replace(from, to);
}

function replaceOnce(from: string, to: string): string {
  return replaceInOnce(validYaml, from, to);
}

type ParseResult = ReturnType<typeof parseAppManifest>;
const errorsOf = (result: ParseResult) => result.ok ? [] : result.errors;
const warningsOf = (result: ParseResult) => result.ok ? result.warnings : [];

describe('NEXUS-APP-CONTRACT', () => {
  test('KAIST URL extract action declares the executable contract without a credential', () => {
    const source = readFileSync(join(import.meta.dir, '../../../templates/next-app-lecture-scrap/app.yaml'), 'utf8');
    const parsed = parseAppManifest(source);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect((parsed.manifest.actions as Record<string, unknown> | undefined)?.['extract']).toMatchObject({
      builtin: 'extract', input: { url: 'text' },
      output: { url: 'text', title: 'text', excerpt: 'text', content: 'text', provider: 'text' }, uses: [],
    });
  });
  test('lecture note input is owner-only and pages to the first note after reopening the app database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lecture-scrap-live-note-'));
    try {
      const parsed = parseAppManifest(readFileSync(join(import.meta.dir, '../../../templates/next-app-lecture-scrap/app.yaml'), 'utf8'));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const first = createAppDatabase([parsed.manifest], { directory });
      try {
        expect(() => first.rpc('lecture-scrap', 'addLectureNote', {
          id: 'note-1', title: '첫 노트', body: '실제 저장', created_at: '2026-11-12T00:00:00.000Z',
        }, 'public')).toThrow('app role is not allowed');
        first.rpc('lecture-scrap', 'addLectureNote', {
          id: 'note-1', title: '첫 노트', body: '실제 저장', created_at: '2026-11-12T00:00:00.000Z',
        }, 'owner');
      } finally { first.close(); }
      const reopened = createAppDatabase([parsed.manifest], { directory });
      try {
        expect(reopened.rpc('lecture-scrap', 'listLectureNotes', {}, 'owner'))
          .toMatchObject([{ id: 'note-1', title: '첫 노트', body: '실제 저장' }]);
        // Source: #23480; twenty later saves make the original the twenty-first note.
        for (let index = 2; index <= 21; index++) reopened.rpc('lecture-scrap', 'addLectureNote', {
          id: `note-${index}`, title: `나중 노트 ${index}`, body: '다음 페이지 검증',
          created_at: new Date(Date.parse('2026-11-12T00:00:00.000Z') + index * 1000).toISOString(),
        }, 'owner');
        const firstPage = reopened.rpc('lecture-scrap', 'listLectureNotes', {}, 'owner') as Array<{ id: string; created_at: string }>;
        expect(firstPage).toHaveLength(20);
        expect(firstPage.some(note => note.id === 'note-1')).toBe(false);
        const cursor = firstPage.at(-1)!;
        expect(reopened.rpc('lecture-scrap', 'listLectureNotes', { beforeCreatedAt: cursor.created_at, beforeId: cursor.id }, 'owner'))
          .toMatchObject([{ id: 'note-1', title: '첫 노트', body: '실제 저장' }]);
        expect(() => reopened.rpc('lecture-scrap', 'listLectureNotes', {}, 'public'))
          .toThrow('app role is not allowed');
      } finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  test('KAIST lecture-scrap static build is served at canonical routes by the registered simulation and receipt route', async () => {
    const root = join(import.meta.dir, '../../../templates/next-app-lecture-scrap');
    const generatedRoot = mkdtempSync(join(tmpdir(), 'kaist-lecture-scrap-app-'));
    try {
      const generatedApp = join(generatedRoot, 'generated-app');
      cpSync(root, generatedApp, { recursive: true });
      const manifest = parseAppManifest(readFileSync(join(generatedApp, 'app.yaml'), 'utf8'));
      expect(manifest.ok).toBe(true);
      if (!manifest.ok) return;
      expect(manifest.manifest).toMatchObject({ slug: 'lecture-scrap', frontend: { kind: 'static-export' },
        roles: { owner: { via: 'nexus-session' }, public: { via: 'public-read' } },
        tables: { scraps: expect.anything(), lecture_notes: expect.anything() },
        rpc: { listScraps: { allow: ['owner', 'public'] }, addLectureNote: { allow: ['owner'] }, searchLibrary: { allow: ['owner', 'public'] } } });
      expect(JSON.parse(readFileSync(join(generatedApp, 'package.json'), 'utf8'))).toMatchObject({
        name: 'next-app-lecture-scrap', scripts: { build: 'next build' },
      });
      const simulation = createAppSimulationStore(join(generatedRoot, 'simulation.sqlite'));
      let builtFiles: Readonly<Record<string, string>> | undefined;
      let simulationError: unknown;
      try {
        const route = createAppSimulationRoute({ store: simulation, authorize: () => true, hasApp: slug => slug === 'lecture-scrap',
          publish: () => undefined, runSimulation: () => runRegisteredAppSimulation('lecture-scrap', {
            onStaticExport: files => { builtFiles = files; },
          }), observeError: error => { simulationError = error; } });
        const response = await route(new Request('http://nexus.invalid/v1/apps/lecture-scrap/simulations/run', { method: 'POST' }));
        expect(response?.status, String(simulationError)).toBe(200);
        const responseBody = await response?.json() as { simulation: { runId: string } };
        const snapshot = simulation.snapshot('lecture-scrap');
        expect(snapshot).toMatchObject({ status: 'passed', runId: responseBody.simulation.runId, receipts: [{ outcome: 'passed' }] });
        expect(builtFiles).toBeDefined();
        const artifactPaths = ['index.html', 'notes/new.html', 'search.html'] as const;
        const expectedHashes = artifactPaths.map(path => createHash('sha256').update(builtFiles![path]!).digest('hex'));
        expect(snapshot.events.map((event) => ({ step: event.data.step, path: event.data.path, status: event.data.status, assetCount: event.data.assetCount, artifactSha256: event.data.artifactSha256 }))).toEqual([
          { step: 'screen-list', path: '/', status: 200, assetCount: expect.any(Number), artifactSha256: expectedHashes[0] },
          { step: 'screen-note-create', path: '/notes/new', status: 200, assetCount: expect.any(Number), artifactSha256: expectedHashes[1] },
          { step: 'screen-search', path: '/search', status: 200, assetCount: expect.any(Number), artifactSha256: expectedHashes[2] },
        ]);
        expect(snapshot.events.every(event => Number(event.data.assetCount) > 0)).toBe(true);
        const appHost = createFakeAppHost([{ slug: 'lecture-scrap', versions: [] }]);
        appHost.deployArtifact('lecture-scrap', { id: `sim-${responseBody.simulation.runId}`, files: builtFiles! });
        const hostedScreens = ['/','/notes/new','/search'].map(path => ({ path,
          response: appHost.fetch('lecture-scrap.app.sim.invalid', path) }));
        expect(hostedScreens.map(({ path, response }) => ({ path, status: response.status }))).toEqual([
          { path: '/', status: 200 }, { path: '/notes/new', status: 200 }, { path: '/search', status: 200 },
        ]);
        expect(hostedScreens[0]?.response.body).toContain('날짜별 기록');
        expect(hostedScreens[0]?.response.body).toContain('2026-11-14');
        expect(hostedScreens[0]?.response.body).toContain('2026-11-13');
        expect(hostedScreens[0]?.response.body).toContain('강의 자료 폴더');
        expect(hostedScreens[1]?.response.body).toContain('노트 작성');
        expect(hostedScreens[1]?.response.body).toContain('수업일');
        expect(hostedScreens[1]?.response.body).toContain('논리 분류');
        expect(hostedScreens[2]?.response.body).toContain('검색');
        expect(hostedScreens.map(({ response }) => response.headers['x-app-version'])).toEqual(
          Array(3).fill(`sim-${responseBody.simulation.runId}`));
        const hostedHashes = hostedScreens.map(({ response }) => createHash('sha256').update(response.body).digest('hex'));
        expect(hostedHashes).toEqual(expectedHashes);
        expect(hostedScreens.map(({ response }) => response.headers['x-app-sha256'])).toEqual(hostedHashes);
      } finally { simulation.close(); }
    } finally {
      rmSync(generatedRoot, { recursive: true, force: true });
    }
  }, 30_000);

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

  test('action allow lists accept declared roles and reject empty or undeclared roles', () => {
    const allowed = replaceOnce('builtin: summarize, input: { text: text }, output: { text: text }, uses: [cred:openai.api_key]',
      'builtin: summarize, input: { text: text }, output: { text: text }, allow: [viewer], uses: [cred:openai.api_key]');
    expect(parseAppManifest(allowed).ok).toBe(true);
    for (const allow of ['[]', '[admin]']) {
      const invalid = replaceOnce('builtin: summarize, input: { text: text }, output: { text: text }, uses: [cred:openai.api_key]',
        `builtin: summarize, input: { text: text }, output: { text: text }, allow: ${allow}, uses: [cred:openai.api_key]`);
      expect(errorsOf(parseAppManifest(invalid))).toContainEqual(expect.objectContaining({ path: '/actions/@entry:1/allow' }));
    }
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

  test('public-read is limited to read-only RPCs and cannot upload objects', () => {
    const source = validYaml
      .replace('viewer: { via: share-link }', 'public: { via: public-read }')
      .replace('allow: [owner, viewer]', 'allow: [owner, public]');
    expect(parseAppManifest(source).ok).toBe(true);
    const publicWrite = source.replace('sql: SELECT id FROM notes WHERE id = :id', 'sql: INSERT INTO notes (id) VALUES (:id)');
    expect(errorsOf(parseAppManifest(publicWrite)).map(issue => issue.path)).toContain('/rpc/@entry:0/allow');
    const publicUpload = source.replace('  prefix: apps/voice-note/\n', '  prefix: apps/voice-note/\n  upload: { allow: [owner, public], types: [audio/wav] }\n');
    expect(errorsOf(parseAppManifest(publicUpload)).map(issue => issue.path)).toContain('/storage/upload/allow');
  });

  test('accepts translate as a builtin with text and source/target language declarations', () => {
    const source = replaceOnce(
      '  summarize: { builtin: summarize, input: { text: text }, output: { text: text }, uses: [cred:openai.api_key] }',
      '  translate: { builtin: translate, input: { text: text, sourceLanguage: text, targetLanguage: text }, output: { text: text }, uses: [cred:openai.api_key] }',
    );
    const result = parseAppManifest(source);
    expect(result.ok).toBe(true);
    expect(errorsOf(result)).toEqual([]);
  });

  test('rejects builtin input/output declarations that differ from the executable contracts', () => {
    const translate = replaceOnce(
      '  summarize: { builtin: summarize, input: { text: text }, output: { text: text }, uses: [cred:openai.api_key] }',
      '  translate: { builtin: translate, input: { text: text, sourceLanguage: text, targetLanguage: text }, output: { text: text }, uses: [cred:openai.api_key] }',
    );
    const invalid = [
      { source: replaceOnce('input: { audio: object-ref }', 'input: { audio: text }'), path: '/actions/@entry:0/input' },
      { source: replaceOnce('input: { audio: object-ref }, output: { text: text }', 'output: { text: text }'), path: '/actions/@entry:0/input' },
      { source: replaceOnce('output: { text: text }', 'output: { text: text, unexpected: text }'), path: '/actions/@entry:0/output' },
      { source: replaceOnce('output: { text: text }', 'output: { transcript: text }'), path: '/actions/@entry:0/output' },
      { source: replaceOnce('output: { audioBase64: text, mimeType: text }', 'output: { audioBase64: text }'), path: '/actions/@entry:2/output' },
      { source: replaceOnce('  summarize: { builtin: summarize, input: { text: text }, output: { text: text }, uses: [cred:openai.api_key] }', '  summarize: { builtin: summarize, input: { text: object-ref }, output: { text: text }, uses: [cred:openai.api_key] }'), path: '/actions/@entry:1/input' },
      { source: replaceInOnce(translate, 'sourceLanguage: text, targetLanguage: text', 'sourceLanguage: text'), path: '/actions/@entry:1/input' },
      { source: replaceInOnce(translate,
        'translate: { builtin: translate, input: { text: text, sourceLanguage: text, targetLanguage: text }, output: { text: text }, uses: [cred:openai.api_key] }',
        'translate: { builtin: translate, input: { text: text, sourceLanguage: text, targetLanguage: text }, output: { text: object-ref }, uses: [cred:openai.api_key] }'), path: '/actions/@entry:1/output' },
    ];
    for (const { source, path } of invalid) {
      expect(errorsOf(parseAppManifest(source)).some(issue => issue.path === path)).toBe(true);
    }
    expect(parseAppManifest(replaceOnce('input: { text: text, voiceId: text }', 'input: { text: text, voiceId: text, modelId: text }')).ok).toBe(true);
  });

  test('parses the voice-note and translator template action input/output declarations', () => {
    const expectations: Record<string, Record<string, { input: Record<string, string>; output: Record<string, string> }>> = {
      'templates/next-app-voice-note/app.yaml': {
        transcribe: { input: { audio: 'object-ref' }, output: { text: 'text' } },
        summarize: { input: { text: 'text' }, output: { text: 'text' } },
        readAloud: { input: { text: 'text', voiceId: 'text' }, output: { audioBase64: 'text', mimeType: 'text' } },
      },
      'templates/next-app-translator/app.yaml': {
        transcribe: { input: { audio: 'object-ref' }, output: { text: 'text' } },
        translate: { input: { text: 'text', sourceLanguage: 'text', targetLanguage: 'text' }, output: { text: 'text' } },
        readAloud: { input: { text: 'text', voiceId: 'text' }, output: { audioBase64: 'text', mimeType: 'text' } },
      },
    };
    for (const [path, expectedActions] of Object.entries(expectations)) {
      const result = parseAppManifest(readFileSync(path, 'utf8'));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const actions = result.manifest.actions as Record<string, { input?: Record<string, string>; output?: Record<string, string> }>;
      for (const [name, expected] of Object.entries(expectedActions)) {
        expect(actions[name]).toBeDefined();
        expect(actions[name]?.input).toEqual(expected.input);
        expect(actions[name]?.output).toEqual(expected.output);
      }
    }
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
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: PRAGMA user_version = 7'],
      ['sql: SELECT id FROM notes WHERE id = :id', 'sql: VACUUM'],
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
      '  transcribe: { builtin: stt, input: { audio: object-ref }, output: { text: text }, uses: [cred:openai.api_key] }',
      '  transcribe: { builtin: shell, input: { audio: object-ref }, output: { text: text }, uses: [cred:openai.api_key] }\n  "0": { builtin: stt }',
    );
    const action = parseAppManifest(numericActionKey);
    expect(errorsOf(action).some(issue => issue.path === '/actions/@entry:0/builtin')).toBe(true);
  });
});
