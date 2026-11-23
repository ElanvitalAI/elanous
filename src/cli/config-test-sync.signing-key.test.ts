import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { APP_AUTH_SIGNING_KEY_ID, getOrCreateAppAuthSigningKey } from '../nexus/apps/app-auth-signing-key.js';
import { createAppAuth } from '../nexus/apps/app-auth.js';
import { getSecretAsync, setSecretAsync } from '../nexus/config/secrets/index.js';
import { setTestStateRoot } from '../nexus/paths.js';
import { syncTestConfig } from './config-test-sync.js';

const operatingKey = 'synthetic-operating-app-auth-key-with-at-least-256-bits';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(() => { resetElanousConfigDir(); setTestStateRoot(null); });

describe('test sync Nexus app authentication boundary', () => {
  it('creates a test-local signing key and the operating verifier rejects its token', async () => {
    const base = mkdtempSync(join(tmpdir(), 'elanous-test-sync-signing-'));
    const operatingDir = join(base, 'operating');
    const testDir = join(base, 'test');
    mkdirSync(operatingDir);
    writeFileSync(join(operatingDir, 'config.json'), '{}');
    writeFileSync(join(operatingDir, 'secrets.json'), JSON.stringify({ version: 1, secrets: {
      [APP_AUTH_SIGNING_KEY_ID]: operatingKey,
      llmKey: 'synthetic-llm-key',
    } }));
    try {
      syncTestConfig(testDir, operatingDir);
      expect(() => readFileSync(join(testDir, 'secrets.json'), 'utf8')).toThrow();

      setTestStateRoot(testDir);
      setElanousConfigDir(testDir);
      const testKey = await getOrCreateAppAuthSigningKey();
      expect(digest(testKey) === digest(operatingKey)).toBe(false);
      expect(await getSecretAsync(APP_AUTH_SIGNING_KEY_ID)).toBeUndefined();
      expect(await getOrCreateAppAuthSigningKey()).toBe(testKey);
      expect(() => readFileSync(join(testDir, 'secrets.json'), 'utf8')).toThrow();
      const keyPath = join(testDir, 'nexus', 'app-auth-test-signing-key');
      expect(digest(readFileSync(keyPath, 'utf8'))).toBe(digest(testKey));
      expect(statSync(keyPath).mode & 0o077).toBe(0);

      const now = () => Date.UTC(2026, 10, 21);
      const testAuth = createAppAuth({ dir: join(testDir, 'app-session-tokens'), key: testKey, now });
      const operatingAuth = createAppAuth({ dir: join(operatingDir, 'app-session-tokens'), key: operatingKey, now });
      const invitation = testAuth.issueInvitation({ appSlug: 'notes', invitedBy: 'synthetic-owner' });
      const accepted = testAuth.acceptInvitation({ appSlug: 'notes', token: invitation.token });
      expect(accepted.status).toBe(200);
      expect(operatingAuth.acceptInvitation({ appSlug: 'notes', token: invitation.token }).status).toBe(401);
      expect(testAuth.verifySession({ appSlug: 'notes', token: accepted.sessionToken! }).status).toBe(200);
      expect(operatingAuth.verifySession({ appSlug: 'notes', token: accepted.sessionToken! }).status).toBe(401);
      const operatingAfter = JSON.parse(readFileSync(join(operatingDir, 'secrets.json'), 'utf8')) as { secrets: Record<string, string> };
      expect(digest(operatingAfter.secrets[APP_AUTH_SIGNING_KEY_ID]!)).toBe(digest(operatingKey));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('rejects tokens from a legacy test root that retained the operating signing key', async () => {
    const base = mkdtempSync(join(tmpdir(), 'elanous-legacy-test-signing-'));
    const testDir = join(base, 'test');
    mkdirSync(testDir);
    writeFileSync(join(testDir, 'secrets.json'), JSON.stringify({ version: 1, secrets: {
      [APP_AUTH_SIGNING_KEY_ID]: operatingKey,
    } }));
    try {
      setTestStateRoot(testDir);
      setElanousConfigDir(testDir);
      const testKey = await getOrCreateAppAuthSigningKey();
      expect(digest(testKey) === digest(operatingKey)).toBe(false);
      const now = () => Date.UTC(2026, 10, 21);
      const testAuth = createAppAuth({ dir: join(testDir, 'app-session-tokens'), key: testKey, now });
      const operatingAuth = createAppAuth({ dir: join(base, 'operating-tokens'), key: operatingKey, now });
      const invitation = testAuth.issueInvitation({ appSlug: 'notes', invitedBy: 'synthetic-owner' });
      expect(testAuth.acceptInvitation({ appSlug: 'notes', token: invitation.token }).status).toBe(200);
      expect(operatingAuth.acceptInvitation({ appSlug: 'notes', token: invitation.token }).status).toBe(401);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('keeps the operating key in its original secret slot', async () => {
    const operatingDir = mkdtempSync(join(tmpdir(), 'elanous-operating-signing-'));
    try {
      setElanousConfigDir(operatingDir);
      await setSecretAsync(APP_AUTH_SIGNING_KEY_ID, operatingKey);
      expect(digest(await getOrCreateAppAuthSigningKey())).toBe(digest(operatingKey));
      expect(await getSecretAsync(APP_AUTH_SIGNING_KEY_ID)).toBe(operatingKey);
    } finally { rmSync(operatingDir, { recursive: true, force: true }); }
  });

  it('publishes one test-local key across concurrent processes', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'elanous-concurrent-test-signing-'));
    const pathsModule = join(import.meta.dir, '../nexus/paths.ts');
    const keyModule = join(import.meta.dir, '../nexus/apps/app-auth-signing-key.ts');
    const script = `const p=await import(${JSON.stringify(pathsModule)});p.setTestStateRoot(process.env.TEST_ROOT);const m=await import(${JSON.stringify(keyModule)});const c=await import('node:crypto');console.log(c.createHash('sha256').update(await m.getOrCreateAppAuthSigningKey()).digest('hex'));`;
    const child = () => new Promise<{ exit: number | null; hash: string }>((resolveRun, reject) => {
      const processChild = spawn(process.execPath, ['-e', script], {
        env: { PATH: process.env.PATH ?? '', HOME: testDir, TEST_ROOT: testDir }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      processChild.stdout.on('data', chunk => { stdout += chunk.toString(); });
      processChild.stderr.on('data', chunk => { stderr += chunk.toString(); });
      processChild.on('error', reject);
      processChild.on('close', exit => {
        if (exit !== 0) reject(new Error(`test key child exited ${exit}: ${stderr}`));
        else resolveRun({ exit, hash: stdout.trim() });
      });
    });
    try {
      const [a, b] = await Promise.all([child(), child()]);
      expect(a.exit).toBe(0);
      expect(b.exit).toBe(0);
      expect(a.hash).toHaveLength(64);
      expect(a.hash).toBe(b.hash);
      expect(a.hash).toBe(digest(readFileSync(join(testDir, 'nexus', 'app-auth-test-signing-key'), 'utf8')));
    } finally { rmSync(testDir, { recursive: true, force: true }); }
  });

  it('refuses a linked test key file instead of reading an operating path', async () => {
    const base = mkdtempSync(join(tmpdir(), 'elanous-linked-test-signing-'));
    const testDir = join(base, 'test');
    const nexusDir = join(testDir, 'nexus');
    mkdirSync(nexusDir, { recursive: true });
    const operatingFile = join(base, 'operating-key');
    writeFileSync(operatingFile, operatingKey);
    symlinkSync(operatingFile, join(nexusDir, 'app-auth-test-signing-key'));
    try {
      setTestStateRoot(testDir);
      setElanousConfigDir(testDir);
      await expect(getOrCreateAppAuthSigningKey()).rejects.toThrow('unsafe');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
