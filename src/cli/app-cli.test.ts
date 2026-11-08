import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { createAppSourceSnapshot } from '../nexus/apps/app-source-snapshot.js';
import { createAppLifecycleEvent } from '../nexus/apps/app-lifecycle-ledger.js';
import { createAppLifecycleStore } from '../nexus/apps/app-db.js';
import { createObjectStore } from '../storage/object-store.js';
import { registerAppCommands, renderAppOpenApi } from './app-cli.js';

const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'app-openapi-cli-'));
  roots.push(root);
  const appDir = join(root, 'voice-note');
  mkdirSync(appDir);
  writeFileSync(join(appDir, 'app.yaml'), `apiVersion: elanous.app/v0\nslug: voice-note\ntitle: Voice notes\nfrontend: { kind: static-export }\nrpc: { ping: { sql: SELECT 1, allow: [owner] } }\nroles: { owner: { via: nexus-session } }\n`);
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('app openapi CLI', () => {
  test('reads only the requested app contract and emits OpenAPI JSON', () => {
    const output = renderAppOpenApi('voice-note', fixture());
    expect(JSON.parse(output).paths['/rpc/ping'].post.operationId).toBe('rpc_ping');
  });

  test('registers app openapi and writes deterministic JSON through the CLI action', async () => {
    const output: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerAppCommands(program, { appsRoot: fixture(), write: text => output.push(text) });
    await program.parseAsync(['node', 'eln', 'app', 'openapi', 'voice-note'], { from: 'node' });
    expect(JSON.parse(output.join('')).paths['/rpc/ping'].post.operationId).toBe('rpc_ping');
  });

  test('app build command snapshots then builds from the immutable source revision path', async () => {
    const appsRoot = fixture();
    const appSource = join(appsRoot, 'voice-note');
    mkdirSync(join(appSource, 'src'));
    writeFileSync(join(appSource, 'src', 'index.ts'), 'export const buildInput = "snapshot";\n');
    const output: string[] = [];
    const failures: string[] = [];
    const builds: Array<{ sourcePath: string; sourceRevisionId: string; content: string }> = [];
    const program = new Command();
    program.exitOverride();
    registerAppCommands(program, {
      appsRoot,
      objectStore: createObjectStore({ provider: 'local', localDir: join(appsRoot, 'objects'), bucket: '', publicBucket: '', prefix: 'apps' }),
      write: text => output.push(text),
      error: text => failures.push(text),
      recordSnapshotEvent: () => {},
      setExitCode: code => { if (code !== 0) failures.push(`exit ${code}`); },
      buildFromSource: source => { builds.push({ sourcePath: source.sourcePath, sourceRevisionId: source.sourceRevisionId,
        content: readFileSync(join(source.sourcePath, 'src', 'index.ts'), 'utf8') }); },
    });

    await program.parseAsync(['node', 'eln', 'app', 'build', 'voice-note', '--deployment-id', 'deploy-001'], { from: 'node' });

    const result = JSON.parse(output.join('')) as { sourcePath: string; sourceRevisionId: string; fingerprint: string };
    expect(failures).toEqual([]);
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ sourcePath: result.sourcePath, sourceRevisionId: 'deploy-001', content: 'export const buildInput = "snapshot";\n' });
    expect(result.sourcePath).toContain(join('.app-source-revisions', 'voice-note', 'deploy-001', result.fingerprint));
    expect(readFileSync(join(appSource, 'src', 'index.ts'), 'utf8')).toBe('export const buildInput = "snapshot";\n');
  });

  test('app build validates and builds the selected snapshot even if the live contract has changed', async () => {
    const appsRoot = fixture();
    const appSource = join(appsRoot, 'voice-note');
    const store = createObjectStore({ provider: 'local', localDir: join(appsRoot, 'objects'), bucket: '', publicBucket: '', prefix: 'apps' });
    const snapshot = createAppSourceSnapshot({ appSlug: 'voice-note', deploymentId: 'deploy-pinned', sourceRoot: appSource,
      objectStore: store, record() {} });
    writeFileSync(join(appSource, 'app.yaml'), 'invalid current contract');
    const builds: string[] = [];
    const failures: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerAppCommands(program, { appsRoot, objectStore: store, buildFromSource: source => { builds.push(source.sourcePath); },
      write() {}, error: text => failures.push(text), setExitCode: code => { if (code) failures.push(`exit ${code}`); }, recordSnapshotEvent() {} });

    await program.parseAsync(['node', 'eln', 'app', 'build', 'voice-note', '--deployment-id', 'deploy-pinned', '--fingerprint', snapshot.fingerprint], { from: 'node' });

    expect(failures).toEqual([]);
    expect(builds).toHaveLength(1);
    expect(readFileSync(join(builds[0]!, 'app.yaml'), 'utf8')).toContain('slug: voice-note');
  });

  test('app build rejects an explicitly empty fingerprint and does not run the builder', async () => {
    const appsRoot = fixture();
    const builds: string[] = [];
    const failures: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerAppCommands(program, { appsRoot,
      objectStore: createObjectStore({ provider: 'local', localDir: join(appsRoot, 'objects'), bucket: '', publicBucket: '', prefix: 'apps' }),
      buildFromSource: source => { builds.push(source.sourcePath); }, write() {}, error: text => failures.push(text),
      setExitCode: code => { if (code) failures.push(`exit ${code}`); }, recordSnapshotEvent() {} });

    await program.parseAsync(['node', 'eln', 'app', 'build', 'voice-note', '--deployment-id', 'deploy-empty', '--fingerprint', ''], { from: 'node' });

    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('expected source fingerprint is invalid');
    expect(builds).toEqual([]);
  });

  test('app build reports build failures and does not emit a success result', async () => {
    const output: string[] = [];
    const failures: string[] = [];
    const program = new Command();
    program.exitOverride();
    const appsRoot = fixture();
    registerAppCommands(program, { appsRoot,
      objectStore: createObjectStore({ provider: 'local', localDir: join(appsRoot, 'objects'), bucket: '', publicBucket: '', prefix: 'apps' }),
      buildFromSource: () => { throw new Error('builder failed'); }, write: text => output.push(text),
      error: text => failures.push(text), setExitCode: code => { if (code) failures.push(`exit ${code}`); }, recordSnapshotEvent() {} });

    await program.parseAsync(['node', 'eln', 'app', 'build', 'voice-note', '--deployment-id', 'deploy-failed'], { from: 'node' });

    expect(output).toEqual([]);
    expect(failures).toEqual(['app build: builder failed\n', 'exit 1']);
  });

  test('rejects traversal and directory/contract slug mismatch', () => {
    expect(() => renderAppOpenApi('../secrets', fixture())).toThrow('invalid app slug');
    const root = fixture();
    writeFileSync(join(root, 'voice-note', 'app.yaml'), `apiVersion: elanous.app/v0\nslug: other\ntitle: Other\nfrontend: { kind: static-export }\n`);
    expect(() => renderAppOpenApi('voice-note', root)).toThrow('does not match');
  });

  test('app lifecycle CLI reads the persisted history and tile projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'app-cli-lifecycle-'));
    roots.push(root);
    const store = createAppLifecycleStore(join(root, 'lifecycle.sqlite'));
    store.appendEvent(createAppLifecycleEvent({ appId: 'voice-note', action: 'created', environment: 'simulation', actor: 'system' }, { id: () => 'created-1' }));
    const output: string[] = [];
    const program = new Command();
    program.exitOverride();
    registerAppCommands(program, { lifecycleStore: store, write: text => output.push(text) });
    await program.parseAsync(['node', 'eln', 'app', 'lifecycle', 'voice-note'], { from: 'node' });
    expect(JSON.parse(output.join(''))).toMatchObject({
      appSlug: 'voice-note', events: [{ id: 'created-1', action: 'created' }],
      snapshot: { appId: 'voice-note', status: 'draft', eventCount: 1 },
    });
    store.close();
  });
});
