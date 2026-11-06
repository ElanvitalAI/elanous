import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
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

  test('rejects traversal and directory/contract slug mismatch', () => {
    expect(() => renderAppOpenApi('../secrets', fixture())).toThrow('invalid app slug');
    const root = fixture();
    writeFileSync(join(root, 'voice-note', 'app.yaml'), `apiVersion: elanous.app/v0\nslug: other\ntitle: Other\nfrontend: { kind: static-export }\n`);
    expect(() => renderAppOpenApi('voice-note', root)).toThrow('does not match');
  });
});
