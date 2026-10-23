import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSiWarmRunnerFrame, parseSiWarmCredentialBundle, parseSiWarmRunnerPayload,
  siWarmRunnerIdentity, installSiWarmCodexAccounts, stageSiWarmCredentials } from './pod-si-warm-runner.js';
import { siWarmSha256, type SiWarmCommand } from './pod-si-warm-protocol.js';
import { encodeSiWarmPrivateStdin } from './pod-si-warm-transport.js';

const payload = Buffer.from(JSON.stringify({ mode: 'self', feature: 'small test feature', args: ['--no-auto-merge'] }));
const credentials = Buffer.from(JSON.stringify({ files: { 'gh-token': 'fixture' } }));
const command: SiWarmCommand = {
  protocol: 'si-v1', runId: 'run-a', attemptId: 'attempt-a', executionKey: 'a'.repeat(64),
  sourceSha: 'b'.repeat(40), leaseId: 'lease-a', generation: 2, workerId: 'worker-a',
  podUid: 'uid-a', key: { context: 'node-b', imageDigest: `sha256:${'c'.repeat(64)}`,
    lockHash: 'd'.repeat(64), architecture: 'arm64' },
  envProfile: 'si-standard-v1', deadlineAt: Date.now() + 60_000,
  payloadSha256: siWarmSha256(payload), credentialBundleSha256: siWarmSha256(credentials),
};

describe('fixed si-v1 Pod runner boundary', () => {
  test('decodes the transport frame and binds both private fields to the command', () => {
    const decoded = decodeSiWarmRunnerFrame(encodeSiWarmPrivateStdin(command, payload, credentials));
    expect(decoded.command).toEqual(command);
    expect(parseSiWarmRunnerPayload(JSON.parse(Buffer.from(decoded.payloadBytes).toString()))).toEqual(JSON.parse(payload.toString()));
    expect(parseSiWarmCredentialBundle(JSON.parse(Buffer.from(decoded.credentialBytes).toString()))).toEqual(JSON.parse(credentials.toString()));
  });

  test('rejects changed secret bytes, truncation and appended bytes', () => {
    const wire = encodeSiWarmPrivateStdin(command, payload, credentials);
    const changed = Buffer.from(wire);
    changed[changed.length - 1] ^= 1;
    expect(() => decodeSiWarmRunnerFrame(changed)).toThrow();
    expect(() => decodeSiWarmRunnerFrame(wire.subarray(0, wire.length - 1))).toThrow();
    expect(() => decodeSiWarmRunnerFrame(Buffer.concat([wire, Buffer.from('x')]))).toThrow();
  });

  test('rejects arbitrary command and credential paths before execution', () => {
    expect(() => parseSiWarmRunnerPayload({ mode: 'shell', feature: 'x', args: [] })).toThrow();
    expect(() => parseSiWarmRunnerPayload({ mode: 'ask', feature: 'x', args: [] })).toThrow();
    expect(() => parseSiWarmCredentialBundle({ files: { '../escape': 'secret' } })).toThrow();
    expect(() => parseSiWarmCredentialBundle({ files: {}, env: { PATH: '/tmp/x' } })).toThrow();
  });

  test('accepts a valid known credential bundle and rejects an arbitrary skillenv-foo member before run', () => {
    // A valid known-file bundle still parses through the same seam as a real run.
    const valid = parseSiWarmCredentialBundle({ files: { 'gh-token': 'fixture' } });
    expect(valid.files['gh-token']).toBe('fixture');
    for (const name of ['elanous-auth.json', 'codex-auth.json', 'grok-auth.json',
      'grok-api-key', 'llm-fallback-config.json'])
      expect(parseSiWarmCredentialBundle({ files: { [name]: '{}' } }).files[name]).toBe('{}');
    expect(() => parseSiWarmCredentialBundle({ files: { 'codex-0.json': '{}' } })).toThrow();
    // The unused skillenv-* wildcard is gone: an arbitrary member is rejected before any run.
    expect(() => parseSiWarmCredentialBundle({ files: { 'skillenv-foo': 'secret' } })).toThrow();
    expect(() => parseSiWarmCredentialBundle({ files: { 'gh-token': 'ok', 'skillenv-foo': 'secret' } })).toThrow();
  });

  test('keeps credential material out of the warm run directory', () => {
    const source = readFileSync(new URL('./pod-si-warm-runner.ts', import.meta.url), 'utf8');
    // The unconsumed plaintext credentials directory write is removed from the runner.
    expect(source).not.toMatch(/credentialDir/);
    expect(source).not.toMatch(/['"`]credentials['"`]/);
    expect(source).not.toMatch(/skillenv-/);
  });

  test('named broker accounts rebuild the cold Pod store in a private HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'si-broker-home-'));
    const pair = (token: string) => JSON.stringify({
      elanousAuth: JSON.stringify({ version: 1, providers: { 'openai-codex': {
        tokens: { accessToken: token } } } }),
      codexAuth: JSON.stringify({ tokens: { access_token: token } }),
    });
    try {
      const bundle = parseSiWarmCredentialBundle({ accounts: ['team', 'backup'], files: {
        'codex-0.json': pair('first'), 'codex-1.json': pair('second'),
      } });
      const env = installSiWarmCodexAccounts(home, bundle)!;
      expect(env.ELANOUS_CODEX_ACCOUNT).toBe('team');
      expect(env.CODEX_HOME).toBe(join(home, '.elanous', 'codex-accounts', '0'));
      const auth = JSON.parse(readFileSync(join(home, '.elanous', 'auth.json'), 'utf8'));
      expect(auth.providers['openai-codex:team'].codexHome).toBe(env.CODEX_HOME);
      expect(auth.providers['openai-codex:backup'].tokens.accessToken).toBe('second');
      expect(() => readFileSync(join(home, '.codex', 'auth.json'), 'utf8')).toThrow();
      expect(() => parseSiWarmCredentialBundle({ accounts: ['team'], files: {
        'codex-0.json': pair('first'), 'codex-99.json': pair('unused'),
      } })).toThrow();
      expect(() => parseSiWarmCredentialBundle({ accounts: ['team', 'team'], files: {
        'codex-0.json': pair('first'), 'codex-1.json': pair('second'),
      } })).toThrow();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('the runner staging step leaves only consumed named credentials in private HOME', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'si-warm-stage-'));
    const pair = JSON.stringify({ elanousAuth: JSON.stringify({ version: 1, providers: {
      'openai-codex': { tokens: { accessToken: 'elanous-token' } } } }),
    codexAuth: JSON.stringify({ tokens: { access_token: 'codex-token' } }) });
    try {
      const bundle = parseSiWarmCredentialBundle({ accounts: ['team'], files: {
        'codex-0.json': pair, 'gh-token': 'gh-fixture',
        'llm-fallback-config.json': '{"llm":{"fallbackChain":["codex-rotate"]}}',
      } });
      const env = stageSiWarmCredentials(runDir, { mode: 'self', feature: 'fixture', args: [] }, bundle);
      const home = join(runDir, 'home');
      expect(readdirSync(runDir)).toEqual(['home']);
      expect(env.HOME).toBe(home);
      expect(env.ELANOUS_STATE_DIR).toBe(join(home, '.elanous'));
      expect(env.ELANOUS_STATE_DIR_SOURCE).toBe('explicit');
      expect(env.CODEX_HOME).toBe(join(home, '.elanous', 'codex-accounts', '0'));
      expect(readFileSync(join(env.CODEX_HOME!, 'auth.json'), 'utf8')).toContain('codex-token');
      expect(readFileSync(join(home, '.elanous', 'auth.json'), 'utf8')).toContain('elanous-token');
      expect(existsSync(join(home, '.codex', 'auth.json'))).toBe(false);
      expect(existsSync(join(runDir, 'credentials'))).toBe(false);
      expect(existsSync(join(runDir, 'codex-0.json'))).toBe(false);
    } finally { rmSync(runDir, { recursive: true, force: true }); }
  });

  test('requires the exact Pod and source identity', () => {
    const env = { WARM_WORKER_ID: command.workerId, WARM_POD_UID: command.podUid,
      WARM_CUT_SHA: command.sourceSha, WARM_CONTEXT: command.key.context,
      WARM_IMAGE_DIGEST: command.key.imageDigest, WARM_LOCK_HASH: command.key.lockHash,
      WARM_ARCHITECTURE: command.key.architecture };
    expect(siWarmRunnerIdentity(command, env, command.sourceSha, command.key.lockHash)).toBe(true);
    expect(siWarmRunnerIdentity(command, { ...env, WARM_POD_UID: 'replacement' }, command.sourceSha, command.key.lockHash)).toBe(false);
    expect(siWarmRunnerIdentity(command, env, 'e'.repeat(40), command.key.lockHash)).toBe(false);
  });
});
