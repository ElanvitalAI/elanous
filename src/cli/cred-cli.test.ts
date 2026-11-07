import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { createEmptySecretCliMock } from './secret-cli.test-helpers.js';
import { registerSecretCommands } from './secret-cli.js';
import { encryptSecretBundle, decryptSecretBundle } from '../nexus/config/secrets/transfer.js';

test('cred inventory uses metadata only and reports each source-specific transfer rule', async () => {
  const fixture = createEmptySecretCliMock();
  const secretValue = 'DO-NOT-PRINT-cred-inventory-value';
  const output: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  let environmentValueReads = 0;
  let secretValueReads = 0;
  let verificationCalls = 0;
  fixture.deps.listSecrets = async () => ['exa', 'orphan-secret-id'];
  fixture.deps.getSecret = async () => { secretValueReads++; return secretValue; };
  fixture.deps.verifySecret = async () => { verificationCalls++; return { result: 'verified' }; };
  const environment: Record<string, string | undefined> = {};
  Object.defineProperty(environment, 'OPENAI_API_KEY', {
    enumerable: true,
    get: () => { environmentValueReads++; return secretValue; },
  });
  fixture.deps.environment = environment;
  fixture.deps.output = { log: (line) => output.push(line), error: (line) => errors.push(line) };
  fixture.deps.setExitCode = (code) => exitCodes.push(code);

  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'inventory', '--json']);

  const result = JSON.parse(output.join('\n')) as {
    storage: string;
    credentials: Array<{ id: string; status: string; source: string[]; transfer: string; type: string }>;
  };
  const byId = new Map(result.credentials.map((row) => [row.id, row]));
  expect(result.storage).toBe('mock-empty');
  expect(byId.get('exa')).toMatchObject({ status: 'present', transfer: 'encrypted-bundle', type: 'static-key' });
  expect(byId.get('openai-api')).toMatchObject({ status: 'present', transfer: 'store-before-transfer' });
  expect(byId.get('openai-api')?.source).toEqual(['env:OPENAI_API_KEY']);
  expect(byId.get('orphan-secret-id')).toMatchObject({ type: 'unknown', transfer: 'manual-review', status: 'present' });
  expect(byId.get('codex')).toMatchObject({ type: 'subscription-login', transfer: 're-login', status: 'provider-managed' });
  expect(byId.get('video-render')).toMatchObject({ type: 'local-tool', transfer: 'none', status: 'local-only' });
  expect(environmentValueReads).toBe(0);
  expect(secretValueReads).toBe(0);
  expect(verificationCalls).toBe(0);
  expect(`${output.join('\n')}\n${errors.join('\n')}`).not.toContain(secretValue);
  expect(errors).toEqual([]);
  expect(exitCodes).toEqual([0]);
});

test('cred export reuses encrypted static-key bundles and never reads rotating login entries', async () => {
  const fixture = createEmptySecretCliMock();
  fixture.values.set('exa', 'static-exa-secret');
  fixture.values.set('codex', 'rotating-codex-secret');
  fixture.values.set('access_token', 'rotating-access-token');
  const answers = ['long-credential-bundle-passphrase', 'long-credential-bundle-passphrase'];
  fixture.deps.promptSecret = async () => answers.shift();
  const readIds: string[] = [];
  fixture.deps.getSecret = async id => { readIds.push(id); return fixture.values.get(id); };
  let artifact = '';
  fixture.deps.writeBundleFile = async (_path, contents) => { artifact = contents; };

  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'export', '--to', '/tmp/cred-bundle']);

  expect(readIds).toEqual(['exa']);
  expect((await decryptSecretBundle(artifact, 'long-credential-bundle-passphrase')).secrets).toEqual({ exa: 'static-exa-secret' });
  expect(fixture.output).toEqual(['exported 1 static credentials · encrypted · rotating login credentials excluded; sign in on destination']);
  expect(fixture.output.join('\n')).not.toMatch(/static-exa-secret|rotating-codex-secret|rotating-access-token/);
  expect(fixture.exitCodes).toEqual([0]);
});

test('cred import rejects rotating login credentials in encrypted bundles before store writes', async () => {
  const fixture = createEmptySecretCliMock();
  fixture.deps.promptSecret = async () => 'long-credential-bundle-passphrase';
  fixture.deps.readBundleFile = async () => encryptSecretBundle({ version: 1, secrets: {
    exa: 'static-exa-secret', codex: 'rotating-codex-secret',
  } }, 'long-credential-bundle-passphrase');
  let writes = 0;
  fixture.deps.importSecrets = async () => { writes += 1; return { imported: true, conflicts: [], changedSinceConfirmation: false }; };

  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'import', '/tmp/cred-bundle']);

  expect(writes).toBe(0);
  expect(fixture.errors).toEqual(['bundle contains unsupported secret names: codex']);
  expect(`${fixture.output.join('\n')}\n${fixture.errors.join('\n')}`).not.toContain('rotating-codex-secret');
  expect(fixture.exitCodes).toEqual([1]);
});

test('cred export rejects mismatched passphrases before creating a bundle', async () => {
  const fixture = createEmptySecretCliMock();
  fixture.values.set('exa', 'static-exa-secret');
  const answers = ['first-long-passphrase', 'different-long-passphrase'];
  fixture.deps.promptSecret = async () => answers.shift();
  let writes = 0;
  fixture.deps.writeBundleFile = async () => { writes += 1; };

  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'export', '--to', '/tmp/cred-bundle']);

  expect(writes).toBe(0);
  expect(fixture.errors).toEqual(['bundle passphrase was not accepted']);
  expect(fixture.exitCodes).toEqual([1]);
});

test('cred export keeps an existing bundle unchanged', async () => {
  const fixture = createEmptySecretCliMock();
  fixture.values.set('exa', 'static-exa-secret');
  fixture.deps.promptSecret = async () => 'long-credential-bundle-passphrase';
  fixture.deps.writeBundleFile = async () => { throw new Error('destination exists'); };

  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'export', '--to', '/tmp/cred-bundle']);

  expect(fixture.errors).toEqual(['credential export failed']);
  expect(fixture.exitCodes).toEqual([1]);
  expect(`${fixture.output.join('\n')}\n${fixture.errors.join('\n')}`).not.toContain('static-exa-secret');
});

test('cred import applies a static bundle and requires exact overwrite confirmation', async () => {
  const fixture = createEmptySecretCliMock();
  fixture.values.set('exa', 'old-static-secret');
  fixture.deps.readBundleFile = async () => encryptSecretBundle({ version: 1, secrets: {
    exa: 'new-static-secret',
  } }, 'long-credential-bundle-passphrase');
  const answers = ['long-credential-bundle-passphrase', 'REPLACE exa'];
  fixture.deps.promptSecret = async () => answers.shift();

  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'import', '/tmp/cred-bundle', '--overwrite']);

  expect(fixture.values.get('exa')).toBe('new-static-secret');
  expect(fixture.output).toContain('imported 1 static credentials · values hidden');
  expect(fixture.output.join('\n')).not.toMatch(/old-static-secret|new-static-secret/);
  expect(fixture.exitCodes).toEqual([0]);
});

test('cred import leaves stored credentials unchanged when overwrite confirmation is wrong', async () => {
  const fixture = createEmptySecretCliMock();
  fixture.values.set('exa', 'old-static-secret');
  fixture.deps.readBundleFile = async () => encryptSecretBundle({ version: 1, secrets: {
    exa: 'new-static-secret',
  } }, 'long-credential-bundle-passphrase');
  const answers = ['long-credential-bundle-passphrase', 'REPLACE other'];
  fixture.deps.promptSecret = async () => answers.shift();

  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'import', '/tmp/cred-bundle', '--overwrite']);

  expect(fixture.values.get('exa')).toBe('old-static-secret');
  expect(fixture.errors).toEqual(['credential import cancelled']);
  expect(fixture.exitCodes).toEqual([1]);
});

test('cred import aborts if stored names change during overwrite confirmation', async () => {
  const fixture = createEmptySecretCliMock();
  fixture.deps.readBundleFile = async () => encryptSecretBundle({ version: 1, secrets: {
    exa: 'new-static-secret',
  } }, 'long-credential-bundle-passphrase');
  const answers = ['long-credential-bundle-passphrase', 'REPLACE exa'];
  fixture.deps.promptSecret = async () => answers.shift();
  let imports = 0;
  fixture.deps.importSecrets = async () => {
    imports += 1;
    return imports === 1
      ? { imported: false, conflicts: ['exa'], changedSinceConfirmation: false }
      : { imported: false, conflicts: ['exa'], changedSinceConfirmation: true };
  };

  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'import', '/tmp/cred-bundle', '--overwrite']);

  expect(imports).toBe(2);
  expect(fixture.errors).toEqual(['secret names changed during import confirmation']);
  expect(fixture.exitCodes).toEqual([1]);
});

test('cred import cancellation does not read or write a bundle', async () => {
  const fixture = createEmptySecretCliMock();
  fixture.deps.promptSecret = async () => undefined;
  let reads = 0;
  let writes = 0;
  fixture.deps.readBundleFile = async () => { reads += 1; return ''; };
  fixture.deps.importSecrets = async () => {
    writes += 1;
    return { imported: true, conflicts: [], changedSinceConfirmation: false };
  };

  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'import', '/tmp/cred-bundle']);

  expect(reads).toBe(0);
  expect(writes).toBe(0);
  expect(fixture.errors).toEqual(['credential import cancelled']);
  expect(fixture.exitCodes).toEqual([1]);
});

test('cred check verifies one catalog service and never exposes its value', async () => {
  const fixture = createEmptySecretCliMock();
  const secretValue = 'DO-NOT-PRINT-cred-check-value';
  fixture.values.set('exa', secretValue);
  const verified: Array<[string, string]> = [];
  fixture.deps.verifySecret = async (id, value) => {
    verified.push([id, value]);
    return { result: 'verified', httpStatus: 200 };
  };

  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'check', 'exa']);

  expect(verified).toEqual([['exa', secretValue]]);
  expect(fixture.output).toEqual(['check exa · verified · HTTP 200']);
  expect((fixture.output.join('\n') + '\n' + fixture.errors.join('\n'))).not.toContain(secretValue);
  expect(fixture.exitCodes).toEqual([0]);
});

test('cred check refuses non-static credentials without reading values', async () => {
  const fixture = createEmptySecretCliMock();
  fixture.values.set('codex', 'DO-NOT-READ-rotating-credential');
  let reads = 0;
  fixture.deps.getSecret = async (id) => { reads += 1; return fixture.values.get(id); };
  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, fixture.deps);
  await program.parseAsync(['node', 'eln', 'cred', 'check', 'codex']);
  expect(reads).toBe(0);
  expect(fixture.errors).toEqual(['credential check is unsupported for this id']);
  expect(fixture.exitCodes).toEqual([2]);
});
