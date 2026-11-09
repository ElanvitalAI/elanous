/** Local, isolated app-serving burst. Never targets a public host or production database. */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createNexusState } from '../../src/nexus/state/state.js';
import { TabRegistry } from '../../src/nexus/state/tab-registry.js';
import { NexusEventBus } from '../../src/nexus/api/event-bus.js';
import { startNexusHttpServer } from '../../src/nexus/api/http-server.js';
import { loadNexusAppHost } from '../../src/nexus/apps/app-host.js';
import { createAppAuth } from '../../src/nexus/apps/app-auth.js';

const count = Number(process.argv.find(arg => arg.startsWith('--count='))?.split('=')[1] ?? 50);
if (!Number.isSafeInteger(count) || count < 1 || count > 500) throw new Error('invalid count');

const slug = 'lecture-scrap';
const hostname = `${slug}.app.localhost`;
const root = mkdtempSync(join(tmpdir(), 'elanous-app-serve-burst-'));
const appsDir = join(root, 'apps');
const appDir = join(appsDir, slug);
const dbDir = join(root, 'db');
const key = 'isolated-lecture-scrap-burst-signing-key-at-least-32-bytes';
const templateManifestPath = join(import.meta.dir, '../../templates/next-app-lecture-scrap/app.yaml');
// Pinned to NT-3 PR #36053 until its template lands on main. The file takes precedence after landing.
const manifest = `apiVersion: elanous.app/v0
slug: lecture-scrap
title: 강의 노트 · 스크랩
template: next-app-lecture-scrap
frontend:
  kind: static-export
  out: out/
design:
  description: 강의 자료를 모으고 노트를 적어 한 번에 찾는다
  screens:
    - { path: /, title: 스크랩 목록 }
    - { path: /notes/new, title: 노트 작성 }
    - { path: /search, title: 검색 }
tables:
  scraps:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
      url: { type: text }
      excerpt: { type: text }
      created_at: { type: timestamp, default: now }
    realtime: true
  lecture_notes:
    columns:
      id: { type: text, primary: true }
      title: { type: text }
      body: { type: text }
      created_at: { type: timestamp, default: now }
    realtime: true
roles:
  owner: { via: nexus-session }
rpc:
  listScraps:
    sql: SELECT id, title, url, excerpt, created_at FROM scraps ORDER BY created_at DESC LIMIT :limit
    params:
      limit: { type: int, max: 200, default: 50 }
    allow: [owner]
  addLectureNote:
    sql: INSERT INTO lecture_notes (id, title, body, created_at) VALUES (:id, :title, :body, :created_at)
    params:
      id: { type: text }
      title: { type: text }
      body: { type: text }
      created_at: { type: timestamp }
    allow: [owner]
  searchLibrary:
    sql: SELECT id, title, excerpt FROM scraps WHERE title LIKE :query OR excerpt LIKE :query UNION ALL SELECT id, title, body AS excerpt FROM lecture_notes WHERE title LIKE :query OR body LIKE :query LIMIT :limit
    params:
      query: { type: text }
      limit: { type: int, max: 200, default: 50 }
    allow: [owner]
storage:
  prefix: apps/lecture-scrap/
`;

type Stage = 'accept' | 'page' | 'read' | 'write' | 'verify';
type Result = { statuses: Partial<Record<Stage, number>>; ms: Partial<Record<Stage, number>>; totalMs: number; error?: string };
const stages: Stage[] = ['accept', 'page', 'read', 'write', 'verify'];
const elapsed = (from: number) => Math.round((performance.now() - from) * 100) / 100;
const percentile = (values: number[], fraction: number) => values.length
  ? values.slice().sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
const counts = (values: number[]) => Object.fromEntries([...new Set(values)].sort((a, b) => a - b)
  .map(value => [value, values.filter(item => item === value).length]));

let server: ReturnType<typeof startNexusHttpServer> | undefined;
let appHost: ReturnType<typeof loadNexusAppHost>['appHost'] | undefined;
try {
  mkdirSync(join(appDir, 'out'), { recursive: true });
  writeFileSync(join(appDir, 'app.yaml'), existsSync(templateManifestPath) ? readFileSync(templateManifestPath) : manifest);
  for (const [path, title] of [['index.html', '스크랩 목록'], ['notes/new/index.html', '노트 작성'], ['search/index.html', '검색']]) {
    const target = join(appDir, 'out', path!);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, `<!doctype html><title>${title}</title><main>lecture-scrap</main>`);
  }
  const mounted = loadNexusAppHost(appsDir, undefined, {
    dir: join(root, 'auth'), databaseDirectory: dbDir,
    key,
  });
  appHost = mounted.appHost;
  if (mounted.issues.length || !appHost.slugs.includes(slug)) throw new Error(`app mount failed: ${JSON.stringify(mounted.issues)}`);
  const state = createNexusState({ nexusVersion: 'test', phase: 'app-serve-burst' });
  const eventBus = new NexusEventBus();
  state.bus = eventBus;
  server = startNexusHttpServer({
    state, eventBus, registry: new TabRegistry(state), appHost,
    startPort: 46000 + Math.floor(Math.random() * 1000), portRange: 100,
  });
  const baseUrl = server.url;
  const origin = `http://${hostname}:${server.port}`;
  // The current template has owner-only RPCs. Create isolated owner sessions via the
  // trusted auth seam; this does not prove that public attendees can get access.
  const auth = createAppAuth({ dir: join(root, 'auth', slug), key });
  const invitations = Array.from({ length: count }, (_, index) => auth.issueInvitation({ appSlug: slug, invitedBy: `attendee-${index}`, role: 'owner' }));

  async function attendee(index: number): Promise<Result> {
    const startedAt = performance.now();
    const statuses: Result['statuses'] = {};
    const ms: Result['ms'] = {};
    let current: Stage = 'accept';
    async function request(stage: Stage, path: string, init: RequestInit = {}): Promise<Response> {
      current = stage;
      const at = performance.now();
      const response = await fetch(`${baseUrl}${path}`, {
        ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { host: `${hostname}:${server!.port}`, ...init.headers },
      });
      statuses[stage] = response.status;
      ms[stage] = elapsed(at);
      return response;
    }
    try {
      const accepted = await request('accept', `/__auth/accept?token=${encodeURIComponent(invitations[index]!.token)}`);
      if (accepted.status !== 303) throw new Error('invitation rejected');
      const cookie = accepted.headers.get('set-cookie')?.split(';', 1)[0];
      if (!cookie) throw new Error('session cookie missing');
      const pagePath = ['/', '/notes/new', '/search'][index % 3]!;
      const page = await request('page', pagePath, { headers: { cookie } });
      if (page.status !== 200 || !(await page.text()).includes('lecture-scrap')) throw new Error('app page missing');
      const rpc = (stage: Stage, name: string, params: Record<string, unknown>) => request(stage, `/__rpc/${name}`, {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ params }),
      });
      const id = `attendee-${String(index).padStart(4, '0')}`;
      const title = `Lecture scrap ${index}`;
      // Opposite orders put reads and writes on the same HTTP server concurrently.
      if (index % 2 === 0) {
        const read = await rpc('read', 'listScraps', {});
        if (read.status !== 200 || !Array.isArray((await read.json() as { rows?: unknown[] }).rows)) throw new Error('initial read failed');
      }
      const write = await rpc('write', 'addLectureNote', { id, title, body: `Note by ${id}`, created_at: '2026-11-09T00:00:00.000Z' });
      if (write.status !== 200) throw new Error('write failed');
      await write.json();
      if (index % 2 !== 0) {
        const read = await rpc('read', 'listScraps', {});
        if (read.status !== 200 || !Array.isArray((await read.json() as { rows?: unknown[] }).rows)) throw new Error('post-write read failed');
      }
      const verified = await rpc('verify', 'searchLibrary', { query: `%${id}%` });
      if (verified.status !== 200) throw new Error('verification read failed');
      const body = await verified.json() as { rows?: { id: string; title: string }[] };
      if (!body.rows?.some(row => row.id === id && row.title === title)) throw new Error('own scrap missing after write');
      return { statuses, ms, totalMs: elapsed(startedAt) };
    } catch (error) {
      statuses[current] ??= 0;
      return { statuses, ms, totalMs: elapsed(startedAt), error: `attendee ${index}: ${String(error)}` };
    }
  }

  const wallAt = performance.now();
  const results = await Promise.all(Array.from({ length: count }, (_, index) => attendee(index)));
  const db = new Database(join(dbDir, `${slug}.db`), { readonly: true });
  const rows = Number((db.query('SELECT COUNT(*) AS n FROM lecture_notes').get() as { n: number }).n);
  const uniqueRows = Number((db.query('SELECT COUNT(DISTINCT id) AS n FROM lecture_notes').get() as { n: number }).n);
  db.close();
  const successful = results.filter(result => !result.error && stages.every(stage => result.statuses[stage] === (stage === 'accept' ? 303 : 200))).length;
  const summary = {
    universe: 'loopback Nexus HTTP + isolated app host, sessions and SQLite',
    fixture: existsSync(templateManifestPath) ? 'NT-3 app.yaml + synthetic static pages; isolated owner sessions' : 'NT-3 PR #36053 app.yaml snapshot + synthetic static pages; isolated owner sessions',
    accessLimit: 'owner-only contract; public attendee access and production VM not measured',
    latencyScope: 'stage p95 ends at response headers; total p95 includes body consumption and parsing',
    count, successful, successRate: successful / count, wallMs: elapsed(wallAt),
    p95Ms: Object.fromEntries([...stages, 'total'].map(stage => [stage, percentile(results.flatMap(result => {
      const value = stage === 'total' ? result.totalMs : result.ms[stage as Stage];
      return value === undefined ? [] : [value];
    }), 0.95)])),
    statuses: Object.fromEntries(stages.map(stage => [stage, counts(results.flatMap(result =>
      result.statuses[stage] === undefined ? [] : [result.statuses[stage]!]))])),
    http409: results.filter(result => Object.values(result.statuses).includes(409)).length,
    http429: results.filter(result => Object.values(result.statuses).includes(429)).length,
    rows: { lectureNotes: rows, uniqueLectureNotes: uniqueRows },
    errors: results.flatMap(result => result.error ? [result.error] : []).slice(0, 5),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (successful !== count || rows !== count || uniqueRows !== count) process.exitCode = 1;
} finally {
  server?.stop();
  appHost?.close();
  rmSync(root, { recursive: true, force: true });
}
