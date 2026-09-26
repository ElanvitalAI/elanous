import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureRefRepo } from './ensure-grounding.js';

function git(...args: string[]): void {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function fixture(root: string, base: 'mirror' | 'upstream', id: string): string {
  const work = join(root, `work-${id}`);
  const bare = join(root, base, `${id}.git`);
  mkdirSync(work, { recursive: true });
  mkdirSync(join(root, base), { recursive: true });
  git('init', '-q', work);
  git('-C', work, 'config', 'user.email', 'test@example.com');
  git('-C', work, 'config', 'user.name', 'Test');
  writeFileSync(join(work, 'README'), `${id}\n`);
  if (base === 'mirror') writeFileSync(join(work, '.last-sync'), '2026-09-27T00:00:00Z\n');
  git('-C', work, 'add', '.');
  git('-C', work, 'commit', '-qm', 'initial');
  git('clone', '-q', '--bare', work, bare);
  return bare;
}

function inTemp(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'ensure-ref-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('real file:// mirror obtains files and refreshes an existing checkout with fetch', () => inTemp((root) => {
  fixture(root, 'mirror', 'hono');
  const destRoot = join(root, 'dest');
  const options = { mirrorBase: pathToFileURL(join(root, 'mirror')).href, destRoot, need: 'code' as const };
  const first = ensureRefRepo('hono', options);
  expect(first).toMatchObject({ rung: 'mirror', path: join(destRoot, 'hono'), lastSync: '2026-09-27T00:00:00Z', fellThrough: [] });
  expect(readFileSync(join(first.path!, 'README'), 'utf8')).toBe('hono\n');
  writeFileSync(join(first.path!, 'local-untracked'), 'keep');
  const work = join(root, 'work-hono');
  writeFileSync(join(work, 'README'), 'updated\n');
  git('-C', work, 'add', 'README');
  git('-C', work, 'commit', '-qm', 'update');
  git('-C', work, 'push', '-q', join(root, 'mirror', 'hono.git'), 'HEAD');
  const again = ensureRefRepo('hono', options);
  expect(again.rung).toBe('mirror');
  expect(existsSync(join(first.path!, 'local-untracked'))).toBe(true);
  const fetched = spawnSync('git', ['-C', first.path!, 'show', 'FETCH_HEAD:README'], { encoding: 'utf8' });
  expect(fetched.status).toBe(0);
  expect(fetched.stdout).toBe('updated\n');
}));

test('default mirror base reads the environment when no override was provided', () => inTemp((root) => {
  fixture(root, 'mirror', 'hono');
  const old = process.env.ELANOUS_REF_MIRROR_URL;
  process.env.ELANOUS_REF_MIRROR_URL = pathToFileURL(join(root, 'mirror')).href;
  try {
    const result = ensureRefRepo('hono', { destRoot: join(root, 'dest'), need: 'code' });
    expect(result.rung).toBe('mirror');
    expect(readFileSync(join(result.path!, 'README'), 'utf8')).toBe('hono\n');
  } finally {
    if (old === undefined) delete process.env.ELANOUS_REF_MIRROR_URL;
    else process.env.ELANOUS_REF_MIRROR_URL = old;
  }
}));

test('missing mirror falls through to a real file:// upstream only with the test opt-in', () => inTemp((root) => {
  const bare = fixture(root, 'upstream', 'ghost');
  const result = ensureRefRepo('ghost', {
    mirrorBase: pathToFileURL(join(root, 'mirror')).href,
    upstream: pathToFileURL(bare).href,
    allowFileUpstream: true,
    destRoot: join(root, 'dest'), need: 'code',
  });
  expect(result.rung).toBe('upstream');
  expect(result.fellThrough).toHaveLength(1);
  expect(result.fellThrough[0]?.rung).toBe('mirror');
  expect(result.fellThrough[0]?.reason).toBeTruthy();
  expect(readFileSync(join(result.path!, 'README'), 'utf8')).toBe('ghost\n');
  expect(result.lastSync).toBeUndefined();
}));

test('absent mirror and upstream record both failures without claiming absence of files', () => inTemp((root) => {
  const result = ensureRefRepo('ghost', { mirrorBase: pathToFileURL(join(root, 'mirror')).href, destRoot: join(root, 'dest'), need: 'code' });
  expect(result.rung).toBe('none');
  expect(result.path).toBeUndefined();
  expect(result.fellThrough.map(({ rung }) => rung)).toEqual(['mirror', 'upstream']);
  expect(result.fellThrough[0]?.reason).toBeTruthy();
  expect(result.fellThrough[1]?.reason).toBe('upstream-not-provided');
}));

test('question need records the unavailable nexus before retrieving the mirror', () => inTemp((root) => {
  fixture(root, 'mirror', 'hono');
  const result = ensureRefRepo('hono', { mirrorBase: pathToFileURL(join(root, 'mirror')).href, destRoot: join(root, 'dest'), need: 'question' });
  expect(result.rung).toBe('mirror');
  expect(result.fellThrough).toEqual([{ rung: 'nexus', reason: 'not-available' }]);
  expect(readFileSync(join(result.path!, 'README'), 'utf8')).toBe('hono\n');
}));

test('invalid IDs stop before contacting any rung', () => inTemp((root) => {
  const result = ensureRefRepo('Bad_Id', { destRoot: join(root, 'dest'), need: 'question' });
  expect(result).toMatchObject({ rung: 'none', fellThrough: [{ rung: 'none', reason: 'bad-id' }] });
  expect(existsSync(join(root, 'dest'))).toBe(false);
}));

test('upstream URL must be public HTTPS, without credentials, unless file fixtures opt in', () => inTemp((root) => {
  const options = { mirrorBase: pathToFileURL(join(root, 'mirror')).href, destRoot: join(root, 'dest'), need: 'code' as const };
  for (const [upstream, reason] of [
    ['file:///tmp/ghost.git', 'upstream-not-https'],
    ['http://github.com/owner/ghost', 'upstream-not-https'],
    ['https://user:secret@github.com/owner/ghost', 'upstream-has-credentials'],
    ['https://127.0.0.1/ghost', 'upstream-not-public'],
    ['https://github.com/owner/ghost?access_token=secret', 'token-query'],
  ]) {
    const result = ensureRefRepo('ghost', { ...options, upstream });
    expect(result.rung).toBe('none');
    expect(result.fellThrough[1]).toEqual({ rung: 'upstream', reason });
  }
}));

test('mirror failure records only the first 200 chars of stderr', () => inTemp((root) => {
  const mirrorBase = pathToFileURL(join(root, 'x'.repeat(100), 'y'.repeat(100), 'mirror')).href;
  const result = ensureRefRepo('hono', { mirrorBase, destRoot: join(root, 'dest'), need: 'code' });
  expect(result.fellThrough[0]?.reason.length).toBeLessThanOrEqual(200);
  expect(result.fellThrough[0]?.reason).not.toContain('\n');
}));

test('a directory within another Git repository is not mistaken for an existing reference checkout', () => inTemp((root) => {
  fixture(root, 'mirror', 'hono');
  const destRoot = join(root, 'dest');
  git('init', '-q', destRoot);
  mkdirSync(join(destRoot, 'hono'));
  const result = ensureRefRepo('hono', { mirrorBase: pathToFileURL(join(root, 'mirror')).href, destRoot, need: 'code' });
  expect(result.rung).toBe('none');
  expect(result.path).toBeUndefined();
  expect(result.fellThrough).toEqual([
    { rung: 'mirror', reason: 'destination-not-checkout' },
    { rung: 'upstream', reason: 'upstream-not-provided' },
  ]);
  expect(existsSync(join(destRoot, 'hono', 'README'))).toBe(false);
}));

test('a failed concurrent clone cannot remove another caller’s published checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ensure-ref-race-'));
  fixture(root, 'mirror', 'hono');
  const destRoot = join(root, 'dest');
  const server = spawn('python3', ['-u', '-c', [
    'import socket, time',
    's = socket.socket()',
    's.bind(("127.0.0.1", 0))',
    's.listen(1)',
    'print(s.getsockname()[1], flush=True)',
    'c, _ = s.accept()',
    `open(${JSON.stringify(join(root, 'accepted'))}, 'w').close()`,
    'time.sleep(0.3)',
    'c.close()',
  ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let slow: ReturnType<typeof spawn> | undefined;
  try {
    const port = Number(await new Promise<string>((resolve, reject) => {
      server.stdout.once('data', (data: Buffer) => resolve(data.toString().trim()));
      server.once('error', reject);
      server.once('exit', () => reject(new Error('slow server exited early')));
    }));
    expect(port).toBeGreaterThan(0);
    const source = pathToFileURL(join(import.meta.dir, 'ensure-grounding.ts')).href;
    const code = `import { ensureRefRepo } from ${JSON.stringify(source)}; console.log(JSON.stringify(ensureRefRepo('hono', ${JSON.stringify({ mirrorBase: `git://127.0.0.1:${port}`, destRoot, need: 'code', timeoutMs: 5000 })})))`;
    slow = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    const completed = new Promise<number | null>((resolve) => slow!.once('exit', resolve));
    let slowOutput = '';
    slow.stdout!.on('data', (data: Buffer) => { slowOutput += data.toString(); });
    for (let attempt = 0; !existsSync(join(root, 'accepted')) && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(existsSync(join(root, 'accepted'))).toBe(true);
    const good = ensureRefRepo('hono', { mirrorBase: pathToFileURL(join(root, 'mirror')).href, destRoot, need: 'code' });
    expect(good.rung).toBe('mirror');
    server.kill();
    const exitCode = await completed;
    expect(exitCode).toBe(0);
    expect(JSON.parse(slowOutput.trim()).rung).toBe('none');
    expect(readFileSync(join(destRoot, 'hono', 'README'), 'utf8')).toBe('hono\n');
  } finally {
    slow?.kill();
    server.kill();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test('a timed-out real git:// mirror transfer falls through to the real upstream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ensure-ref-'));
  const upstream = fixture(root, 'upstream', 'hono');
  // Separate process: ensureRefRepo uses synchronous Git, so an in-process socket would be starved.
  const server = spawn('python3', ['-u', '-c', [
    'import socket, time',
    's = socket.socket()',
    's.bind(("127.0.0.1", 0))',
    's.listen(1)',
    'print(s.getsockname()[1], flush=True)',
    'c, _ = s.accept()',
    'time.sleep(3)',
    'c.close()',
    's.close()',
  ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.stdout.once('data', (data: Buffer) => resolve(Number(data.toString().trim())));
      server.once('exit', (code) => reject(new Error(`slow git server exited: ${code}`)));
    });
    expect(Number.isInteger(port) && port > 0).toBe(true);
    const result = ensureRefRepo('hono', {
      mirrorBase: `git://127.0.0.1:${port}`,
      upstream: pathToFileURL(upstream).href,
      allowFileUpstream: true,
      destRoot: join(root, 'dest'), need: 'code', timeoutMs: 500,
    });
    expect(result.rung).toBe('upstream');
    expect(result.fellThrough).toEqual([{ rung: 'mirror', reason: 'timeout' }]);
    expect(readFileSync(join(result.path!, 'README'), 'utf8')).toBe('hono\n');
  } finally {
    server.kill();
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
