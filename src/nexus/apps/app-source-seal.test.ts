import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { reopenSealedAppSource, sealAppSource } from './app-source-seal.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'app-source-seal-')));
  roots.push(parent);
  const appRoot = join(parent, 'source');
  const sealRoot = join(parent, 'sealed');
  mkdirSync(appRoot, { mode: 0o700 });
  mkdirSync(sealRoot, { mode: 0o700 });
  mkdirSync(join(appRoot, 'backend'), { mode: 0o700 });
  mkdirSync(join(appRoot, 'frontend'), { mode: 0o700 });
  const contents = {
    'ARCHITECTURE.md': '# synthetic architecture\n',
    'backend/server.ts': 'export default { fetch: () => new Response("synthetic") };\n',
    'frontend/index.html': '<html>synthetic frontend</html>\n',
  };
  for (const [path, content] of Object.entries(contents)) writeFileSync(join(appRoot, path), content, { mode: 0o600 });
  const artifact = {
    schemaVersion: 'source-artifact@1', root: appRoot,
    files: Object.fromEntries(Object.entries(contents).map(([path, content]) => [path, hash(content)])),
    metadata: { runtime: { startCommand: ['bun', 'backend/server.ts'], port: 31540, healthPath: '/health' }, frontendRoot: 'frontend', apiPrefix: '/api' },
    executed: false, published: false,
  };
  const save = () => writeFileSync(join(appRoot, 'source-artifact.json'), JSON.stringify(artifact), { mode: 0o600 });
  save();
  const input = { sourceRoot: appRoot, sealRoot, ownerId: 'owner-1', runId: 'run-1', stillAuthorized: () => true };
  return { appRoot, sealRoot, artifact, save, input };
}

test('verified source-artifact@1 bytes are copied into a private atomic seal without execution', async () => {
  const { input, appRoot } = fixture();
  let checks = 0;
  const sealed = await sealAppSource({ ...input, stillAuthorized: () => { checks++; return true; } });
  expect(checks).toBe(2);
  expect(sealed.ownerId).toBe('owner-1');
  expect(sealed.runId).toBe('run-1');
  expect(sealed.files).toBe(3);
  expect(sealed.frontendAssets?.get('index.html')?.toString('utf8')).toBe('<html>synthetic frontend</html>\n');
  expect(sealed.runtime).toEqual({ startCommand: ['bun', 'backend/server.ts'], port: 31540, healthPath: '/health' });
  expect(readFileSync(join(sealed.sealPath, 'backend/server.ts'), 'utf8')).toBe(readFileSync(join(appRoot, 'backend/server.ts'), 'utf8'));
  expect(existsSync(join(sealed.sealPath, '.elanous', 'seal.json'))).toBe(true);
  expect(existsSync(join(sealed.sealPath, 'seal.json'))).toBe(false);
  expect(existsSync(join(sealed.sealPath, 'source-artifact.json'))).toBe(false);
});

test('sealed bytes reopen after source removal without a new build authority or reseal', async () => {
  const { input, appRoot, sealRoot } = fixture();
  const sealed = await sealAppSource(input);
  const reopen = () => reopenSealedAppSource({ sealRoot, sealPath: sealed.sealPath,
    sourceRoot: appRoot, ownerId: sealed.ownerId, runId: sealed.runId, artifactDigest: sealed.artifactDigest });
  rmSync(appRoot, { recursive: true });
  const restored = reopen();
  expect(restored.artifactDigest).toBe(sealed.artifactDigest);
  expect(restored.runtime).toEqual(sealed.runtime);
  expect(restored.frontendAssets?.get('index.html')?.toString('utf8')).toBe('<html>synthetic frontend</html>\n');
  expect(readdirSync(sealRoot)).toEqual([basename(sealed.sealPath)]);
  expect(() => reopenSealedAppSource({ sealRoot, sealPath: sealed.sealPath,
    sourceRoot: join(sealRoot, 'forged'), ownerId: sealed.ownerId, runId: sealed.runId,
    artifactDigest: sealed.artifactDigest })).toThrow('app source seal refused');
});

test('reopen refuses changed sealed bytes, undeclared paths and missing private manifest', async () => {
  const { input, appRoot, sealRoot } = fixture();
  const sealed = await sealAppSource(input);
  const reopen = () => reopenSealedAppSource({ sealRoot, sealPath: sealed.sealPath,
    sourceRoot: appRoot, ownerId: sealed.ownerId, runId: sealed.runId, artifactDigest: sealed.artifactDigest });
  expect(reopen().files).toBe(sealed.files);
  const entry = join(sealed.sealPath, 'backend/server.ts');
  const original = readFileSync(entry);
  writeFileSync(entry, 'tampered');
  expect(reopen).toThrow('app source seal refused');
  writeFileSync(entry, original);
  writeFileSync(join(sealed.sealPath, 'extra.txt'), 'extra', { mode: 0o600 });
  expect(reopen).toThrow('app source seal refused');
  rmSync(join(sealed.sealPath, 'extra.txt'));
  chmodSync(join(sealed.sealPath, 'frontend'), 0o755);
  expect(reopen).toThrow('app source seal refused');
  chmodSync(join(sealed.sealPath, 'frontend'), 0o700);
  rmSync(join(sealed.sealPath, '.elanous', 'source-artifact.json'));
  expect(reopen).toThrow();
});

test('valid source seal.json is preserved beside a private noncolliding receipt', async () => {
  const { input, appRoot, artifact, save } = fixture();
  const source = 'synthetic app-owned seal.json\n';
  writeFileSync(join(appRoot, 'seal.json'), source, { mode: 0o600 });
  artifact.files['seal.json'] = hash(source);
  save();
  const sealed = await sealAppSource(input);
  expect(readFileSync(join(sealed.sealPath, 'seal.json'), 'utf8')).toBe(source);
  const receipt = JSON.parse(readFileSync(join(sealed.sealPath, '.elanous', 'seal.json'), 'utf8'));
  expect(receipt.artifactDigest).toBe(sealed.artifactDigest);
  expect(sealed.files).toBe(4);
});

test('foreign or expired authority never publishes a seal', async () => {
  const { input, sealRoot } = fixture();
  await expect(sealAppSource({ ...input, stillAuthorized: () => false })).rejects.toThrow('app source seal refused');
  let checks = 0;
  await expect(sealAppSource({ ...input, stillAuthorized: () => ++checks === 1 })).rejects.toThrow('app source seal refused');
  expect(checks).toBe(2);
  expect(readdirSync(sealRoot)).toEqual([]);
});

test('unknown schema, public claim, path escape, and undeclared file refuse', async () => {
  const { input, artifact, save, appRoot } = fixture();
  artifact.schemaVersion = 'source-artifact@2'; save();
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
  artifact.schemaVersion = 'source-artifact@1'; artifact.published = true; save();
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
  artifact.published = false; artifact.files['../escape'] = hash('x'); save();
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
  delete artifact.files['../escape']; save();
  writeFileSync(join(appRoot, 'unexpected.txt'), 'x');
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
});

test('digest mismatch, out-of-range port, and symlink refuse before publication', async () => {
  const { input, artifact, save, appRoot } = fixture();
  writeFileSync(join(appRoot, 'backend/server.ts'), 'changed');
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
  artifact.files['backend/server.ts'] = hash('changed'); artifact.metadata.runtime.port = 4000; save();
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
  artifact.metadata.runtime.port = 31540; save();
  rmSync(join(appRoot, 'backend/server.ts'));
  symlinkSync(join(appRoot, 'ARCHITECTURE.md'), join(appRoot, 'backend/server.ts'));
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
});

test('source and seal roots must remain private, separate, and real', async () => {
  const { input, sealRoot, appRoot } = fixture();
  await expect(sealAppSource({ ...input, sealRoot: appRoot })).rejects.toThrow('app source seal refused');
  chmodSync(sealRoot, 0o755);
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
});

test('source replacement before commit cannot publish the other directory', async () => {
  const { input, appRoot, sealRoot } = fixture();
  let checks = 0;
  await expect(sealAppSource({ ...input, stillAuthorized: () => {
    if (++checks === 2) {
      renameSync(appRoot, appRoot + '-old');
      mkdirSync(appRoot, { mode: 0o700 });
    }
    return true;
  } })).rejects.toThrow('app source seal refused');
  expect(readdirSync(sealRoot)).toEqual([]);
});

test('large source file and readable-by-others source refuse before copying', async () => {
  const { input, appRoot } = fixture();
  writeFileSync(join(appRoot, 'backend/server.ts'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
  writeFileSync(join(appRoot, 'backend/server.ts'), 'small');
  chmodSync(join(appRoot, 'backend/server.ts'), 0o644);
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
});

test('TC metadata may omit the port; publication records the later chosen port', async () => {
  const { input, artifact, save } = fixture();
  delete (artifact.metadata.runtime as { port?: number }).port;
  save();
  const sealed = await sealAppSource(input);
  expect(sealed.runtime.port).toBeUndefined();
  expect(sealed.frontendRoot).toBe('frontend');
});

test('declared frontendRoot requires a verified index file', async () => {
  const { input, artifact, save, sealRoot } = fixture();
  artifact.metadata.frontendRoot = 'missing';
  save();
  await expect(sealAppSource(input)).rejects.toThrow('app source seal refused');
  expect(readdirSync(sealRoot)).toEqual([]);
});
