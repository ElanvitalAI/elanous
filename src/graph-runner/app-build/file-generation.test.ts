import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generatePlannedFiles } from './file-generation.js';
import { ARCHITECTURE_SECTIONS, APP_BUILD_MAX_FILES, APP_BUILD_MAX_REPAIRS } from './contracts.js';

function fixture(seedRequested = false) {
  const diagrams: Record<string, string> = {
    context: '```mermaid\ngraph TD\n Browser-->API\n API-->SQLite\n```',
    dataModel: '```mermaid\nerDiagram\n RECORD {\n string id PK\n }\n```',
    sequences: '```mermaid\nsequenceDiagram\n participant Browser\n participant API\n Browser->>API: POST record\n API-->>Browser: Created\n```',
  };
  const markdown = ARCHITECTURE_SECTIONS.map(key => '## ' + key + '\nConcrete synthetic ' + key
    + (diagrams[key] ? '\n' + diagrams[key] : '') + (key === 'api' ? '\n[API](backend/main.ts)' : '')).join('\n');
  const roles = ['architecture', 'database', 'backend', 'frontend', 'test', ...(seedRequested ? ['seed'] : [])];
  return { assumptions: [{ statement: 'assumed: Use local SQLite.', source: 'assumed' as const }],
    architecture: { markdown, sections: Object.fromEntries(ARCHITECTURE_SECTIONS.map(key => [key, 'Synthetic ' + key])) }, seedRequested,
    plan: roles.map((role, index) => ({ path: role === 'architecture' ? 'ARCHITECTURE.md' : role + '/main.ts', purpose: 'Complete ' + role,
      role, dependsOn: index ? [roles[index - 1] === 'architecture' ? 'ARCHITECTURE.md' : roles[index - 1] + '/main.ts'] : [] })) };
}
function reply(prompt: string): string {
  const { file } = JSON.parse(prompt);
  return JSON.stringify({ path: file.path, content: 'export const generated = ' + JSON.stringify(file.role) + ';' });
}

function independentFixture() {
  const input = fixture();
  input.plan = input.plan.map(file => ({ ...file, dependsOn: file.role === 'architecture' ? []
    : file.role === 'test' ? ['database/main.ts', 'backend/main.ts', 'frontend/main.ts'] : ['ARCHITECTURE.md'] }));
  return input;
}

/** Host-owned oracle: never executes or trusts the model-generated test file. */
function probeGeneratedEntry(root: string, entry: string, dataDir: string, expectedTitle: string): void {
  const entryUrl = pathToFileURL(join(root, entry)).href;
  const script = `const app = await import(${JSON.stringify(entryUrl)}); const response = app.fetch(new Request('http://local/api/items')); console.log(JSON.stringify({ status: response.status, items: await response.json() }));`;
  const run = Bun.spawnSync([process.execPath, '-e', script], { cwd: root,
    env: { ELANOUS_APP_DATA_DIR: dataDir }, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error('generated entry failed: ' + new TextDecoder().decode(run.stderr));
  const response = JSON.parse(new TextDecoder().decode(run.stdout)) as { status: number; items: Array<{ title: string }> };
  if (response.status !== 200 || !Array.isArray(response.items) || response.items.length !== 1
    || response.items[0]?.title !== expectedTitle) throw new Error('generated GET list invalid');
  const db = new Database(join(dataDir, 'data.sqlite'));
  try {
    const rows = db.query('SELECT id, title FROM items').all() as Array<{ id: string; title: string }>;
    if (rows.length !== 1 || rows[0]?.id !== 'sample-1' || rows[0]?.title !== expectedTitle)
      throw new Error('generated database rows invalid');
  } finally { db.close(); }
}

for (const spec of [
  { name: 'restaurant reservation', item: '식당 예약', ask: 'Build a restaurant reservation app with sample reservations.' },
  { name: 'library loan', item: '도서 대출', ask: 'Build a library loan app with sample loans.' },
]) test(`blind ${spec.name} specification starts with one database and a nonempty list after restart`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'seed-general-'));
  const input: Parameters<typeof generatePlannedFiles>[0] = fixture(true);
  input.assumptions = [{ statement: `user: ${spec.ask}`, source: 'user' }];
  input.plan = [
    { path: 'ARCHITECTURE.md', role: 'architecture', purpose: 'Architecture', dependsOn: [] },
    { path: 'database/db.ts', role: 'database', purpose: 'Single database path', dependsOn: ['ARCHITECTURE.md'] },
    { path: 'backend/seed.ts', role: 'seed', purpose: 'Idempotent sample rows', dependsOn: ['database/db.ts'] },
    { path: 'backend/main.ts', role: 'backend', purpose: 'Runtime startup and list', dependsOn: ['database/db.ts', 'backend/seed.ts'] },
    { path: 'frontend/index.html', role: 'frontend', purpose: 'List page', dependsOn: ['backend/main.ts'] },
    { path: 'tests/seed.test.ts', role: 'test', purpose: 'Startup list and restart', dependsOn: ['backend/main.ts', 'backend/seed.ts'] },
  ];
  const prompts: Record<string, Record<string, unknown>> = {};
  try {
    const result = await generatePlannedFiles(input, { callLLM: async prompt => {
      const request = JSON.parse(prompt) as { file: { path: string; role: string }; seedRuntimeContract?: string };
      const { file } = request; prompts[file.role] = request as unknown as Record<string, unknown>;
      const content = file.role === 'database'
        ? "import { join } from 'node:path'; export const DB_PATH = join(process.env.ELANOUS_APP_DATA_DIR || join(import.meta.dir, '..'), 'data.sqlite');"
        : file.role === 'seed'
          ? `import { Database } from 'bun:sqlite'; import { DB_PATH } from '../database/db.js'; export function seed() { const db = new Database(DB_PATH, { create: true }); try { db.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, title TEXT NOT NULL)'); db.query('INSERT OR IGNORE INTO items VALUES (?, ?)').run('sample-1', ${JSON.stringify(spec.item)}); } finally { db.close(); } }`
          : file.role === 'backend'
            ? "import { Database } from 'bun:sqlite'; import { DB_PATH } from '../database/db.js'; import { seed } from './seed.js'; seed(); export function list() { const db = new Database(DB_PATH); try { return db.query('SELECT id, title FROM items').all(); } finally { db.close(); } } export function fetch(request: Request) { return new URL(request.url).pathname === '/api/items' ? Response.json(list()) : new Response('not found', { status: 404 }); }"
            : file.role === 'frontend'
              ? '<html><body><main id="items"></main></body></html>'
              : `import { expect, test } from 'bun:test'; import { existsSync, mkdirSync } from 'node:fs'; import { join } from 'node:path'; import { Database } from 'bun:sqlite'; import { DB_PATH } from '../database/db.js'; import { fetch as appFetch } from '../backend/main.js'; test('host import and local restart share one path each', async () => { const first = appFetch(new Request('http://local/api/items')); expect(first.status).toBe(200); expect((await first.json()).length).toBe(1); const hostData = join(${JSON.stringify(root)}, 'private-data'); mkdirSync(hostData); const hosted = Bun.spawnSync([process.execPath, '-e', "const mod = await import('./backend/main.ts'); const response = mod.fetch(new Request('http://local/api/items')); console.log((await response.json()).length);"], { cwd: ${JSON.stringify(root)}, env: { ELANOUS_APP_DATA_DIR: hostData }, stdout: 'pipe', stderr: 'pipe' }); expect(hosted.exitCode).toBe(0); expect(new TextDecoder().decode(hosted.stdout).trim()).toBe('1'); expect(existsSync(join(hostData, 'data.sqlite'))).toBe(true); const db = new Database(DB_PATH); db.query('UPDATE items SET title = ? WHERE id = ?').run('user edit', 'sample-1'); db.close(); for (let i = 0; i < 2; i++) { const run = Bun.spawnSync([process.execPath, 'backend/main.ts'], { cwd: ${JSON.stringify(root)} }); expect(run.exitCode).toBe(0); const response = appFetch(new Request('http://local/api/items')); expect(response.status).toBe(200); const items = await response.json(); expect(items.length).toBe(1); expect(items[0].title).toBe('user edit'); } });`;
      return JSON.stringify({ path: file.path, content });
    } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(String(prompts.database?.seedRuntimeContract)).toContain('one DB_PATH constant');
    expect(String(prompts.seed?.seedRuntimeContract)).toContain('Import DB_PATH');
    expect(String(prompts.backend?.seedRuntimeContract)).toContain('invoke the seed initializer');
    expect(String(prompts.test?.seedRuntimeContract)).toContain('at least one item');
    for (const file of result.files) {
      const path = join(root, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
      expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(file.sha256);
    }
    const run = Bun.spawnSync([process.execPath, 'test', 'tests/seed.test.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(new TextDecoder().decode(run.stderr)).toContain('1 pass');
    expect(run.exitCode).toBe(0);
    const dataDir = join(root, 'host-owned-data');
    mkdirSync(dataDir);
    const entry = input.plan.find(file => file.role === 'backend')!.path;
    probeGeneratedEntry(root, entry, dataDir, spec.item);
    const db = new Database(join(dataDir, 'data.sqlite'));
    db.query('UPDATE items SET title = ? WHERE id = ?').run('owner edit', 'sample-1');
    db.close();
    probeGeneratedEntry(root, entry, dataDir, 'owner edit');

    // A fake model can make its own test vacuous. The host oracle must still fail.
    writeFileSync(join(root, 'tests/seed.test.ts'), "import { test } from 'bun:test'; test('vacuous', () => {});");
    const vacuous = Bun.spawnSync([process.execPath, 'test', 'tests/seed.test.ts'],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    expect(vacuous.exitCode).toBe(0);
    const backend = join(root, entry);
    writeFileSync(backend, readFileSync(backend, 'utf8').replace('Response.json(list())', 'Response.json([])'));
    expect(() => probeGeneratedEntry(root, entry, dataDir, 'owner edit')).toThrow('generated GET list invalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('starts three independent files together and supplies completed dependencies before their consumer', async () => {
  const input = independentFixture(); const controller = new AbortController();
  const fixtureDeadlineMs = 1000; const timer = setTimeout(() => controller.abort(), fixtureDeadlineMs);
  const width = input.plan.find(file => file.role === 'test')!.dependsOn.length;
  let active = 0; let peak = 0; let started = 0;
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const finished = new Set<string>();
  try {
    const result = await generatePlannedFiles({ ...input, signal: controller.signal }, { callLLM: async prompt => {
      const request = JSON.parse(prompt); active++; peak = Math.max(peak, active);
      try {
        if (request.file.role !== 'test') { started++; if (started === width) release(); await barrier; }
        else {
          expect(request.dependencies.map((file: { path: string }) => file.path)).toEqual(input.plan.at(-1)!.dependsOn);
          for (const dependency of request.file.dependsOn) expect(finished.has(dependency)).toBe(true);
        }
        finished.add(request.file.path); return reply(prompt);
      } finally { active--; }
    } });
    expect(result.ok).toBe(true); expect(peak).toBe(width);
    expect(result.files.map(file => file.path)).toEqual([...input.plan.map(file => file.path), 'ARCHITECTURE.html']);
  } finally { release(); clearTimeout(timer); }
});

test('parallel failure checkpoints only a verified plan prefix and resumes with the unchanged plan digest', async () => {
  const input = independentFixture(); const attempts = new Map<string, number>();
  const failed = await generatePlannedFiles(input, { callLLM: async prompt => {
    const path = JSON.parse(prompt).file.path; attempts.set(path, (attempts.get(path) ?? 0) + 1);
    return path === 'database/main.ts' ? 'invalid synthetic reply' : reply(prompt);
  } });
  expect(failed.ok).toBe(false); if (!failed.resume) throw new Error('resume missing');
  expect(failed.files.map(file => file.path)).toEqual(['ARCHITECTURE.md']);
  expect(failed.receipts.filter(receipt => receipt.status !== 'rejected').map(receipt => receipt.path))
    .toEqual(failed.files.map(file => file.path));
  expect(failed.receipts.some(receipt => receipt.status === 'generated')).toBe(false);
  expect(attempts.get('database/main.ts')).toBe(APP_BUILD_MAX_REPAIRS + 1);
  expect([...attempts.values()].every(count => count <= APP_BUILD_MAX_REPAIRS + 1)).toBe(true);
  const context = JSON.stringify({ assumptions: input.assumptions, architecture: input.architecture, plan: input.plan, seedRequested: input.seedRequested });
  expect(failed.resume.planDigest).toBe(createHash('sha256').update(context).digest('hex'));
  const called: string[] = [];
  const resumed = await generatePlannedFiles({ ...input, resume: failed.resume }, { callLLM: async prompt => {
    called.push(JSON.parse(prompt).file.path); return reply(prompt);
  } });
  expect(resumed.ok).toBe(true);
  expect(called).not.toContain('ARCHITECTURE.md');
  expect(resumed.files.map(file => file.path)).toEqual(input.plan.map(file => file.path));
});

test('a terminal file failure cancels pending siblings without replacing the initiating error', async () => {
  const controller = new AbortController(); const fixtureDeadlineMs = 1000;
  const timer = setTimeout(() => controller.abort(), fixtureDeadlineMs); const cancelled: string[] = [];
  try {
    const result = await generatePlannedFiles({ ...independentFixture(), signal: controller.signal }, { callLLM: async (prompt, { signal }) => {
      const path = JSON.parse(prompt).file.path;
      if (path === 'database/main.ts') return 'invalid synthetic reply';
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { cancelled.push(path); reject(new Error('synthetic cancelled')); }, { once: true });
      });
    } });
    expect(result.ok).toBe(false); if (result.ok) throw new Error('unexpected completion');
    expect(result.code).toBe('FILE_OUTPUT_INVALID'); expect(controller.signal.aborted).toBe(false);
    expect(cancelled.sort()).toEqual(['backend/main.ts', 'frontend/main.ts']);
    expect(result.files.map(file => file.path)).toEqual(['ARCHITECTURE.md']);
  } finally { clearTimeout(timer); }
});

test('a retried successful sibling retains rejected diagnostics when its success is discarded', async () => {
  const attempts = new Map<string, number>();
  const result = await generatePlannedFiles(independentFixture(), { callLLM: async prompt => {
    const path = JSON.parse(prompt).file.path; const attempt = (attempts.get(path) ?? 0) + 1; attempts.set(path, attempt);
    return path === 'database/main.ts' || path === 'backend/main.ts' && attempt === 1 ? 'invalid synthetic reply' : reply(prompt);
  } });
  expect(result.ok).toBe(false);
  expect(attempts.get('backend/main.ts')).toBeGreaterThan(attempts.get('frontend/main.ts')!);
  expect(result.receipts.filter(receipt => receipt.path === 'backend/main.ts' && receipt.status === 'rejected')).toHaveLength(1);
  expect(result.receipts.some(receipt => receipt.path === 'backend/main.ts' && receipt.status === 'generated')).toBe(false);
  expect(result.receipts.filter(receipt => receipt.status !== 'rejected').map(receipt => receipt.path)).toEqual(result.files.map(file => file.path));
});

test('parallel completions cannot exceed the aggregate byte budget or reorder checkpoint files', async () => {
  const input = independentFixture();
  const first = input.plan[1]!; const content = 'export const synthetic = true;';
  const prefixBytes = Buffer.byteLength('ARCHITECTURE.md') + Buffer.byteLength(input.architecture.markdown)
    + Buffer.byteLength(first.path) + Buffer.byteLength(content);
  const result = await generatePlannedFiles({ ...input, budget: { maxTotalBytes: prefixBytes } }, { callLLM: async prompt => {
    const path = JSON.parse(prompt).file.path; return JSON.stringify({ path, content });
  } });
  expect(result.ok).toBe(false); if (result.ok) throw new Error('unexpected completion');
  expect(result.code).toBe('ARTIFACT_BUDGET');
  expect(result.files.map(file => file.path)).toEqual(['ARCHITECTURE.md', first.path]);
  expect(result.receipts.filter(receipt => receipt.status !== 'rejected').map(receipt => receipt.path))
    .toEqual(result.files.map(file => file.path));
  expect(result.receipts.some(receipt => receipt.path === 'backend/main.ts' || receipt.path === 'frontend/main.ts')).toBe(false);
  expect(result.files.reduce((sum, file) => sum + Buffer.byteLength(file.path) + Buffer.byteLength(file.content), 0)).toBe(prefixBytes);
});

test('consumes the actual A contract and preserves validated architecture while repairing a question', async () => {
  const input = fixture(true); const prompts: string[] = [];
  const result = await generatePlannedFiles(input, { callLLM: async prompt => {
    prompts.push(prompt); return prompts.length === 1 ? 'Which database would you like?' : reply(prompt);
  } });
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code);
  expect(result.files.map(file => file.path)).toEqual([...input.plan.map(file => file.path), 'ARCHITECTURE.html']);
  expect(result.files[0]?.content).toBe(input.architecture.markdown);
  expect(result.receipts.some(receipt => receipt.status === 'rejected' && receipt.attempt === 1)).toBe(true);
  expect(result.receipts.some(receipt => receipt.status === 'generated' && receipt.attempt === 2)).toBe(true);
  expect(JSON.parse(prompts[1]!).previousError).toBe('FILE_OUTPUT_INVALID');
  expect(JSON.parse(prompts.at(-1)!).dependencies[0].path).toBe('test/main.ts');
  expect(result.buildComplete).toBe(false);
});

test('structured clarification and repeated malformed output stop after initial plus two repairs', async () => {
  let calls = 0;
  const result = await generatePlannedFiles(fixture(), { callLLM: async prompt => {
    calls++; return JSON.stringify({ path: JSON.parse(prompt).file.path, content: 'Which database would you like?' });
  } });
  expect(result.ok).toBe(false); if (result.ok) throw new Error('unexpected completion');
  expect(calls).toBe(APP_BUILD_MAX_REPAIRS + 1); expect(result.attempt).toBe(calls);
  expect(result.files.map(file => file.path)).toEqual(['ARCHITECTURE.md']);
  expect(result.code).toBe('FILE_OUTPUT_INVALID');
});

test('partial failure resumes verified completed prefix without calling the model for it again', async () => {
  const input = fixture();
  const first = await generatePlannedFiles(input, { callLLM: async prompt => JSON.parse(prompt).file.role === 'backend' ? 'incomplete' : reply(prompt) });
  expect(first.ok).toBe(false); if (!first.resume) throw new Error('resume missing');
  expect(first.files.map(file => file.path)).toEqual(['ARCHITECTURE.md', 'database/main.ts']);
  const called: string[] = [];
  const resumed = await generatePlannedFiles({ ...input, resume: first.resume }, { callLLM: async prompt => { called.push(JSON.parse(prompt).file.path); return reply(prompt); } });
  expect(resumed.ok).toBe(true); expect(called).toEqual(['backend/main.ts', 'frontend/main.ts', 'test/main.ts']);
  expect(resumed.receipts.filter(receipt => receipt.status === 'reused')).toHaveLength(first.files.length);
});

test('resume rejects changed plan, changed bytes/hash, non-prefix files and altered architecture before model calls', async () => {
  const input = fixture(); const good = await generatePlannedFiles(input, { callLLM: async prompt => reply(prompt) });
  if (!good.ok) throw new Error(good.code);
  const variants = [
    { ...good.resume, planDigest: 'wrong' },
    { ...good.resume, files: [{ ...good.files[0]!, content: 'tampered' }] },
    { ...good.resume, files: [good.files[1]!] },
    { ...good.resume, files: [{ ...good.files[0]!, content: 'tampered', sha256: createHash('sha256').update('tampered').digest('hex') }] },
  ];
  for (const resume of variants) {
    let calls = 0;
    const result = await generatePlannedFiles({ ...input, resume }, { callLLM: async prompt => { calls++; return reply(prompt); } });
    expect(result.ok).toBe(false); expect(calls).toBe(0); expect(result.files).toEqual([]);
  }
  const changed = await generatePlannedFiles({ ...input, assumptions: [{ statement: 'assumed: Use another local database.', source: 'assumed' }], resume: good.resume }, { callLLM: async () => { throw new Error('must not call'); } });
  expect(changed.ok).toBe(false);
});

test('invalid A plans, unsolicited seed, unsafe paths, dependencies and excessive budgets make no model call', async () => {
  const input = fixture(); let calls = 0;
  const invalid = [
    { ...input, assumptions: [] },
    { ...input, architecture: { ...input.architecture, markdown: '# Summary only' } },
    { ...fixture(true), seedRequested: false },
    { ...input, plan: [...input.plan, { path: 'C:/outside', purpose: 'bad', role: 'asset', dependsOn: [] }] },
    { ...input, plan: [{ ...input.plan[0]!, dependsOn: ['later'] }, ...input.plan.slice(1)] },
    { ...input, plan: Array.from({ length: APP_BUILD_MAX_FILES + 1 }, (_, i) => ({ path: 'f' + i, role: 'asset', purpose: 'bad', dependsOn: [] })) },
    { ...input, maxFiles: APP_BUILD_MAX_FILES + 1 }, { ...input, maxRepairAttempts: APP_BUILD_MAX_REPAIRS + 1 },
    { ...input, budget: { maxContextBytes: Number.NaN } },
  ];
  for (const value of invalid) {
    const result = await generatePlannedFiles(value, { callLLM: async prompt => { calls++; return reply(prompt); } });
    expect(result.ok).toBe(false);
  }
  expect(calls).toBe(0);
});

test('wrong file paths and completion placeholders retry but cannot complete a file', async () => {
  for (const response of [JSON.stringify({ path: 'unplanned.ts', content: 'export {}' }), JSON.stringify({ path: 'database/main.ts', content: 'TODO' }), '{"done":true}']) {
    let calls = 0; const result = await generatePlannedFiles(fixture(), { callLLM: async () => { calls++; return response; } });
    expect(result.ok).toBe(false); expect(calls).toBe(APP_BUILD_MAX_REPAIRS + 1);
  }
});

test('transport budgets fail closed and dependency errors never leak their message', async () => {
  const input = fixture(); let calls = 0;
  const insufficientBytes = Buffer.byteLength(input.architecture.markdown) - Buffer.byteLength('x');
  const small = await generatePlannedFiles({ ...input, budget: { maxContextBytes: insufficientBytes } }, { callLLM: async prompt => { calls++; return reply(prompt); } });
  expect(small.ok).toBe(false); expect(calls).toBe(0);
  const artifact = await generatePlannedFiles({ ...input, budget: { maxTotalBytes: insufficientBytes } }, { callLLM: async prompt => reply(prompt) });
  expect(artifact.ok).toBe(false);
  const failed = await generatePlannedFiles(input, { callLLM: async () => { throw new Error('synthetic-private-diagnostic'); } });
  expect(failed.ok).toBe(false); expect(JSON.stringify(failed)).not.toContain('synthetic-private-diagnostic');
});

test('abort interrupts a pending model call and returns only the completed prefix', async () => {
  const controller = new AbortController();
  const pending = generatePlannedFiles({ ...fixture(), signal: controller.signal }, { callLLM: async (_prompt, { signal }) => {
    expect(signal).toBe(controller.signal); queueMicrotask(() => controller.abort()); return new Promise<string>(() => {});
  } });
  const result = await pending;
  expect(result.ok).toBe(false); if (result.ok) throw new Error('unexpected completion');
  expect(result.code).toBe('CANCELLED'); expect(result.files.map(file => file.path)).toEqual(['ARCHITECTURE.md']);
});

test('new responses and matching-hash resume both reject comment placeholders, multiline questions and completion notices', async () => {
  const input = fixture(); const good = await generatePlannedFiles(input, { callLLM: async prompt => reply(prompt) });
  if (!good.ok) throw new Error(good.code);
  for (const content of [' ', '// TODO: implement', '/* FIXME: implement\nnext */', '# TODO: implement', '<!-- TODO -->',
    'TODO', 'Which database would you like?\nShould I continue?', '어떤 데이터베이스를\n사용할까요?',
    '완료했습니다.', '파일 생성을 완료했습니다.', 'The file has been created.', 'Implementation complete.', 'I have implemented the file.']) {
    const fresh = await generatePlannedFiles(input, { callLLM: async prompt => JSON.stringify({ path: JSON.parse(prompt).file.path, content }) });
    expect(fresh.ok).toBe(false);
    const files = [good.files[0]!, { path: 'database/main.ts', content, sha256: createHash('sha256').update(content).digest('hex') }];
    let calls = 0;
    const resumed = await generatePlannedFiles({ ...input, resume: { ...good.resume, files } }, { callLLM: async prompt => { calls++; return reply(prompt); } });
    expect(resumed.ok).toBe(false); expect(resumed.files).toEqual([]); expect(calls).toBe(0);
  }
});

test('real source with TODO comments is retained instead of treating all comments as placeholders', async () => {
  const result = await generatePlannedFiles(fixture(), { callLLM: async prompt => JSON.stringify({ path: JSON.parse(prompt).file.path,
    content: '// TODO: optimize later\nexport const implemented = true;' }) });
  expect(result.ok).toBe(true);
});

test('OP fixed four cases have identical fresh and matching-hash resume decisions without Python false positives', async () => {
  const input = fixture(); const good = await generatePlannedFiles(input, { callLLM: async prompt => reply(prompt) });
  if (!good.ok) throw new Error(good.code);
  for (const [content, expected] of [
    ['// TODO: implement', false],
    ['Is SQLite okay?\nCan I proceed?', false],
    ['Successfully created the file.', false],
    ['file = open("done.txt", "w")', true],
  ] as const) {
    const fresh = await generatePlannedFiles(input, { callLLM: async prompt => JSON.stringify({ path: JSON.parse(prompt).file.path, content }) });
    expect(fresh.ok).toBe(expected);
    const files = good.resume.files.map((file, index) => index === 1 ? { ...file, content, sha256: createHash('sha256').update(content).digest('hex') } : file);
    let calls = 0;
    const resumed = await generatePlannedFiles({ ...input, resume: { ...good.resume, files } }, { callLLM: async prompt => { calls++; return reply(prompt); } });
    expect(resumed.ok).toBe(expected); expect(calls).toBe(0);
  }
});
