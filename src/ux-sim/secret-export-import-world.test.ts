import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { parseSimWorld } from './world.js';
import { issueSecretCanary, scanSecretCanaries } from './secret-canary.js';
import { SERVICE_KEY_CATALOG } from '../setup/service-key-catalog.js';
import { registerSecretCommands, type SecretCliDeps } from '../cli/secret-cli.js';

function fakeCli(values: Map<string, string>, prompts: string[], artifact: { text: string }, envFile = '') {
  const output: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const deps: SecretCliDeps = {
    isInteractive: () => true,
    promptSecret: async () => prompts.shift(),
    saveSecret: async (id, value) => { values.set(id, value); },
    getSecret: async (id) => values.get(id),
    listSecrets: async () => [...values.keys()].sort(),
    removeSecret: async (id) => values.delete(id),
    importSecrets: async (secrets, overwrite, expectedConflicts) => {
      const conflicts = Object.keys(secrets).filter((id) => values.has(id)).sort();
      if (expectedConflicts && (conflicts.length !== expectedConflicts.length || conflicts.some((id, index) => id !== [...expectedConflicts].sort()[index]))) {
        return { imported: false, conflicts, changedSinceConfirmation: true };
      }
      if (conflicts.length && !overwrite) return { imported: false, conflicts, changedSinceConfirmation: false };
      for (const [id, value] of Object.entries(secrets)) values.set(id, value);
      return { imported: true, conflicts, changedSinceConfirmation: false };
    },
    readBundleFile: async () => artifact.text,
    readEnvFile: async () => envFile,
    writeBundleFile: async (_path, contents) => { artifact.text = contents; },
    storageBackend: () => 'fake-sim',
    initializeBackend: () => {},
    output: { log: (line) => { output.push(line); }, error: (line) => { errors.push(line); } },
    setExitCode: (code) => { exitCodes.push(code); },
  };
  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, deps);
  return {
    output, errors, exitCodes,
    run: (...args: string[]) => program.parseAsync(['node', 'elanous', ...args]),
  };
}

test('SECRET-EXPORT-IMPORT world runs real CLI transfer for twelve fake keys and rejects a modified artifact', async () => {
  const world = parseSimWorld(await Bun.file(`${import.meta.dir}/worlds/secret-export-import.yaml`).text());
  expect(world.world).toBe('secret-export-import');
  expect(world.devices).toContain('sim-mailbox');
  expect(world.injections?.map((injection) => injection.logs?.[0]?.event)).toEqual([
    'export-created', 'import-completed', 'tamper-rejected',
  ]);

  const ids = SERVICE_KEY_CATALOG.filter((entry) => entry.kind === 'api-key').slice(0, 12).map((entry) => entry.id);
  const canaries = ids.map((_, index) => issueSecretCanary('exa', `fakekey-${String(index).padStart(4, '0')}`));
  const source = new Map(ids.map((id, index) => [id, canaries[index]!.value]));
  source.set('codex-refresh-token', 'fake-refresh-canary');
  source.set('claude-auth', 'fake-claude-canary');
  source.set('access_token', 'fake-access-canary');
  const artifact = { text: '' };
  const passphrase = 'fake-world-transfer-passphrase';
  const exporter = fakeCli(source, [passphrase, passphrase], artifact);
  await exporter.run('secret', 'export', '--to', 'fake-bundle');
  expect(exporter.output[0]).toContain('exported 12 secrets · encrypted');
  expect(artifact.text).not.toContain(canaries[0]!.value);
  expect(artifact.text).not.toContain('fake-refresh-canary');
  expect(artifact.text).not.toContain('fake-claude-canary');
  expect(artifact.text).not.toContain('fake-access-canary');

  const destination = new Map<string, string>();
  const importer = fakeCli(destination, [passphrase], artifact);
  await importer.run('secret', 'import', 'fake-bundle');
  expect(destination.size).toBe(12);
  expect(importer.output).toEqual(['imported 12 secrets · values hidden']);

  const scan = scanSecretCanaries(canaries, [
    { path: 'transfer.bundle', content: artifact.text, kind: 'evidence' },
    { path: 'source-output', content: exporter.output.join('\n'), kind: 'log' },
    { path: 'destination-output', content: importer.output.join('\n'), kind: 'log' },
  ]);
  expect(scan.verdict).toBe('clean');
  expect(scan.matches).toEqual([]);

  const bundle = JSON.parse(artifact.text) as { cipher: { ciphertext: string } };
  bundle.cipher.ciphertext = `${bundle.cipher.ciphertext.slice(0, -4)}AAAA`;
  artifact.text = JSON.stringify(bundle);
  const tampered = fakeCli(new Map(), [passphrase], artifact);
  await tampered.run('secret', 'import', 'fake-bundle');
  expect(tampered.errors).toEqual(['secret import failed']);
  expect(tampered.exitCodes).toEqual([1]);

  const leaked = scanSecretCanaries(canaries, [{ path: 'debug.log', content: canaries[0]!.value, kind: 'log' }]);
  expect(leaked.verdict).toBe('leaked');
});

test('SECRET-ZSH-KEYS-ABSORB world absorbs a fake plaintext file, transfers encrypted, then restores only requested names', async () => {
  const world = parseSimWorld(await Bun.file(`${import.meta.dir}/worlds/secret-zsh-keys-absorb.yaml`).text());
  expect(world.world).toBe('secret-zsh-keys-absorb');
  expect(world.devices).toContain('sim-mailbox');
  expect(world.injections?.map((injection) => injection.logs?.[0]?.event)).toEqual([
    'plaintext-absorbed', 'encrypted-destination-import', 'requested-environment-restored',
  ]);

  const canaries = [issueSecretCanary('exa', 'fake-env-absorb-01'), issueSecretCanary('tavily', 'fake-env-absorb-02')];
  const plaintext = `export EXA_API_KEY='${canaries[0]!.value}'\nexport TAVILY_KEY='${canaries[1]!.value}'`;
  const source = new Map<string, string>();
  const artifact = { text: '' };
  const absorber = fakeCli(source, [], artifact, plaintext);
  await absorber.run('secret', 'import-env', 'legacy.zsh');
  expect([...source.entries()]).toEqual([['EXA_API_KEY', canaries[0]!.value], ['TAVILY_KEY', canaries[1]!.value]]);
  expect(absorber.output).toEqual(['absorbed 2 environment names · values hidden · back up then empty the plaintext file']);

  const passphrase = 'fake-world-transfer-passphrase';
  const exporter = fakeCli(source, [passphrase, passphrase], artifact);
  await exporter.run('secret', 'export', '--to', 'fake-bundle');
  expect(artifact.text).not.toContain(canaries[0]!.value);
  expect(artifact.text).not.toContain(canaries[1]!.value);
  const destination = new Map<string, string>();
  const importer = fakeCli(destination, [passphrase], artifact);
  await importer.run('secret', 'import', 'fake-bundle');
  const shell = fakeCli(destination, [], artifact);
  await shell.run('secret', 'env', '--names', 'EXA_API_KEY');
  expect(shell.output).toEqual([`export EXA_API_KEY='${canaries[0]!.value}'`]);
  expect(shell.output.join('\n')).not.toContain(canaries[1]!.value);

  const scan = scanSecretCanaries(canaries, [
    { path: 'export-output', content: absorber.output.join('\n'), kind: 'log' },
    { path: 'encrypted-bundle', content: artifact.text, kind: 'evidence' },
  ]);
  expect(scan.verdict).toBe('clean');
});
