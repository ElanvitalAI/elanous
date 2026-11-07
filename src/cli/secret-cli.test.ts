import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { createSecretPrompt } from '../onboarding/secret-prompt.js';
import { registerSecretCommands, runProcess, syncEncryptedBundleOverSsh } from './secret-cli.js';
import { createEmptySecretCliMock } from './secret-cli.test-helpers.js';
import { decryptSecretBundle, encryptSecretBundle } from '../nexus/config/secrets/transfer.js';

function makeProgram(configure?: (fixture: ReturnType<typeof createEmptySecretCliMock>) => void) {
  const fixture = createEmptySecretCliMock();
  configure?.(fixture);
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: (line) => fixture.output.push(line),
    writeErr: (line) => fixture.parserErrors.push(line),
  });
  registerSecretCommands(program, fixture.deps);
  return { ...fixture, program };
}

async function parse(f: ReturnType<typeof makeProgram>, ...args: string[]): Promise<void> {
  await f.program.parseAsync(['node', 'elanous', ...args]);
}

test('secret set prompts hidden input and never renders or logs the submitted value', async () => {
  const f = makeProgram();
  await parse(f, 'secret', 'set', 'exa');
  expect(f.values.get('exa')).toBe('mock-secret-value');
  expect(f.output).toEqual(['saved exa · mock-empty']);
  expect(`${f.output.join('\n')}\n${f.errors.join('\n')}`).not.toContain('mock-secret-value');
  expect(f.exitCodes).toEqual([0]);
});

test('the production prompt returns input without echoing it', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rendered: Buffer[] = [];
  output.on('data', (chunk) => rendered.push(Buffer.from(chunk)));
  const answer = createSecretPrompt(input, output)('Secret value: ');
  input.write('hidden-prompt-marker\n');
  expect(await answer).toBe('hidden-prompt-marker');
  expect(Buffer.concat(rendered).toString('utf8')).not.toContain('hidden-prompt-marker');
  expect(Buffer.concat(rendered).toString('utf8')).toContain('Secret value: ');
  input.destroy();
  output.destroy();
});

test('set redacts a credential-shaped unknown option before prompting or storing', async () => {
  const f = makeProgram();
  await expect(parse(f, 'secret', 'set', 'exa', '--mock-secret-value')).rejects.toMatchObject({ code: 'commander.unknownOption' });
  expect(f.values.size).toBe(0);
  expect(f.output.join('\n')).not.toContain('mock-secret-value');
  expect(f.errors.join('\n')).not.toContain('mock-secret-value');
  expect(f.parserErrors.join('\n')).toBe('secret command failed\n');
  expect(f.parserErrors.join('\n')).not.toContain('mock-secret-value');
});

test('secret parser writes a generic message to the child process stderr', () => {
  const cliPath = resolve(import.meta.dir, 'secret-cli.js');
  const helperPath = resolve(import.meta.dir, 'secret-cli.test-helpers.js');
  const script = `
    import { Command } from 'commander';
    import { registerSecretCommands } from ${JSON.stringify(cliPath)};
    import { createEmptySecretCliMock } from ${JSON.stringify(helperPath)};
    const program = new Command();
    program.exitOverride();
    const fixture = createEmptySecretCliMock();
    registerSecretCommands(program, fixture.deps);
    try {
      await program.parseAsync(['node', 'elanous', 'secret', 'set', 'exa', '--mock-secret-value']);
    } catch {
      process.exitCode = 1;
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('secret command failed\n');
  expect(`${result.stdout}\n${result.stderr}`).not.toContain('mock-secret-value');
});

test('secret parser redaction leaves sibling command parser errors unchanged', async () => {
  const f = makeProgram();
  f.program.command('other').allowUnknownOption(false);
  await expect(parse(f, 'other', '--mock-secret-value')).rejects.toMatchObject({ code: 'commander.unknownOption' });
  expect(f.parserErrors.join('')).toContain("error: unknown option '--mock-secret-value'");
  expect(f.parserErrors.join('')).not.toContain('secret command failed');
});

test('list prints names and backend metadata only', async () => {
  const f = makeProgram();
  f.values.set('exa', 'mock-secret-value');
  await parse(f, 'secret', 'list');
  expect(f.output).toEqual(['id\tstorage\tlast-test', 'exa\tmock-empty\tunknown']);
  expect(f.output.join('\n')).not.toContain('mock-secret-value');
  expect(f.exitCodes).toEqual([0]);
});

test('rm removes by id and does not render the value', async () => {
  const f = makeProgram();
  f.values.set('exa', 'mock-secret-value');
  await parse(f, 'secret', 'rm', 'exa');
  expect(f.values.size).toBe(0);
  expect(f.output).toEqual(['removed exa']);
  expect(f.output.join('\n')).not.toContain('mock-secret-value');
  expect(f.exitCodes).toEqual([0]);
});

test('rm retains a recovery path for legacy app-prefixed identifiers', async () => {
  const f = makeProgram();
  f.values.set('app/Bad/KEY', 'legacy-secret-value');
  await parse(f, 'secret', 'rm', 'app/Bad/KEY');
  expect(f.values.has('app/Bad/KEY')).toBe(false);
  expect(f.output).toEqual(['removed app/Bad/KEY']);
  expect(f.output.join('\n')).not.toContain('legacy-secret-value');
});

test('app secrets use an isolated namespace and issue/revoke ledger never receives values', async () => {
  const f = makeProgram((fixture) => { fixture.deps.storageBackend = () => 'file'; });
  await parse(f, 'secret', 'app', 'set', 'voice-note', 'ELEVENLABS_API_KEY');
  expect([...f.values.keys()]).toEqual(['app/voice-note/ELEVENLABS_API_KEY']);
  await parse(f, 'secret', 'app', 'revoke', 'voice-note');
  expect(f.values.size).toBe(0);
  expect(f.output.join('\n')).not.toContain('mock-secret-value');
  expect(f.exitCodes).toEqual([0, 0]);
});

test('app secret command reports mutation failures without exposing submitted values', async () => {
  const f = makeProgram((fixture) => {
    fixture.deps.storageBackend = () => 'file';
    fixture.deps.saveAppSecret = async () => { throw new Error('ledger unavailable'); };
  });
  await parse(f, 'secret', 'app', 'set', 'voice-note', 'API_KEY');
  expect(f.errors).toEqual(['app secret could not be issued']);
  expect(f.errors.join('\n')).not.toContain('mock-secret-value');
  expect(f.exitCodes).toEqual([1]);
});

test('app revoke uses its transactional result and treats a repeated exact revoke as successful', async () => {
  let recovered = false;
  const f = makeProgram((fixture) => {
    fixture.deps.storageBackend = () => 'file';
    fixture.deps.revokeAppSecrets = async (app, name) => { expect(app).toBe('voice-note'); expect(name).toBe('API_KEY'); recovered = true; return { revoked: 1, alreadyAbsent: false }; };
  });
  await parse(f, 'secret', 'app', 'revoke', 'voice-note', 'API_KEY');
  expect(recovered).toBe(true);
  expect(f.output).toEqual(['revoked voice-note · 1 secret(s)']);
  expect(f.exitCodes).toEqual([0]);
});

test('app secret commands reject invalid or reserved app names before prompting', async () => {
  const f = makeProgram();
  await parse(f, 'secret', 'app', 'set', 'api', 'KEY');
  expect(f.values.size).toBe(0);
  expect(f.errors).toEqual(['invalid app secret name']);
  expect(f.exitCodes).toEqual([1]);
});

test('app secret mutations fail closed on remote backends before prompting or writing', async () => {
  let prompts = 0;
  let writes = 0;
  let deletes = 0;
  const f = makeProgram((fixture) => {
    fixture.deps.storageBackend = () => 'gcp';
    fixture.deps.promptSecret = async () => { prompts += 1; return 'must-not-be-used'; };
    fixture.deps.saveSecret = async () => { writes += 1; };
    fixture.deps.removeSecret = async () => { deletes += 1; return true; };
    fixture.deps.isInteractive = () => true;
  });
  await parse(f, 'secret', 'app', 'set', 'voice-note', 'API_KEY');
  await parse(f, 'secret', 'app', 'revoke', 'voice-note', 'API_KEY');
  expect(prompts).toBe(0);
  expect(writes).toBe(0);
  expect(deletes).toBe(0);
  expect(f.errors).toEqual(['app secret operations require the file backend', 'app secret operations require the file backend']);
  expect(f.exitCodes).toEqual([1, 1]);
});

test('test on the fixed empty helper makes no verifier call and reports missing only', async () => {
  const f = makeProgram();
  await parse(f, 'secret', 'test', 'exa');
  expect(f.verified).toEqual([]);
  expect(f.output).toEqual(['test exa · missing']);
  expect(f.output.join('\n')).not.toContain('mock-secret-value');
  expect(f.exitCodes).toEqual([1]);
});

test('test reports only the service verification category and status', async () => {
  const f = makeProgram();
  f.values.set('exa', 'mock-secret-value');
  await parse(f, 'secret', 'test', 'exa');
  expect(f.verified).toEqual(['exa']);
  expect(f.output).toEqual(['test exa · verified · HTTP 200']);
  expect(f.output.join('\n')).not.toContain('mock-secret-value');
  expect(f.exitCodes).toEqual([0]);
});

test('secret export command is registered and exposes its encrypted file option', async () => {
  let artifact = '';
  const f = makeProgram((fixture) => {
    fixture.values.set('exa', 'mock-secret-value');
    fixture.values.set('access_token', 'fake-rotating-access-token');
    fixture.values.set('claude-auth', 'fake-claude-auth-token');
    fixture.deps.promptSecret = async () => 'long-mock-passphrase';
    fixture.deps.writeBundleFile = async (_path, contents) => { artifact = contents; };
  });
  await parse(f, 'secret', 'export', '--to', '/tmp/fake-bundle');
  expect(artifact).toContain('elanous-secret-bundle');
  expect(artifact).not.toContain('mock-secret-value');
  expect((await decryptSecretBundle(artifact, 'long-mock-passphrase')).secrets).toEqual({ exa: 'mock-secret-value' });
  expect(f.output).toEqual(['exported 1 secrets · encrypted · non-catalog names and rotating login credentials excluded; sign in on destination']);
  expect(f.output.join('\n')).not.toContain('mock-secret-value');
});

test('default export writes a mode-0600 encrypted file and refuses to replace it', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'secret-export-fake-'));
  const file = resolve(directory, 'bundle.json');
  try {
    const f = makeProgram((fixture) => {
      fixture.values.set('exa', 'fake-file-canary');
      fixture.deps.promptSecret = async () => 'long-mock-passphrase';
    });
    await parse(f, 'secret', 'export', '--to', file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('fake-file-canary');

    const second = makeProgram((fixture) => { fixture.deps.promptSecret = async () => 'long-mock-passphrase'; });
    await parse(second, 'secret', 'export', '--to', file);
    expect(second.errors).toEqual(['secret export failed']);
    expect(readFileSync(file, 'utf8')).not.toContain('fake-file-canary');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('secret import decrypts only after hidden passphrase entry and never prints values', async () => {
  const f = makeProgram((fixture) => {
    fixture.deps.promptSecret = async () => 'long-mock-passphrase';
    fixture.deps.readBundleFile = async () => {
      return encryptSecretBundle({ version: 1, secrets: { exa: 'fake-canary-value' } }, 'long-mock-passphrase');
    };
  });
  await parse(f, 'secret', 'import', '/tmp/fake-bundle');
  expect(f.values.get('exa')).toBe('fake-canary-value');
  expect(f.output).toEqual(['imported 1 secrets · values hidden']);
  expect(f.output.join('\n')).not.toContain('fake-canary-value');
});

test('import-env absorbs literal catalog names but never displays supplied values', async () => {
  const f = makeProgram((fixture) => {
    fixture.deps.readEnvFile = async () => "# fake source\nexport EXA_API_KEY='fake-absorb-canary'\nexport TAVILY_KEY=fake-tavily-canary";
  });
  await parse(f, 'secret', 'import-env', '/tmp/fake-keys');
  expect(f.values.get('EXA_API_KEY')).toBe('fake-absorb-canary');
  expect(f.values.get('TAVILY_KEY')).toBe('fake-tavily-canary');
  expect(f.output).toEqual(['absorbed 2 environment names · values hidden · back up then empty the plaintext file']);
  expect(`${f.output.join('\n')}\n${f.errors.join('\n')}`).not.toContain('fake-absorb-canary');
  expect(f.exitCodes).toEqual([0]);
});

test('import-env rejects non-catalog names without storing values or echoing file contents', async () => {
  const f = makeProgram((fixture) => {
    fixture.deps.readEnvFile = async () => 'export PRIVATE_TEST_CANARY=fake-non-catalog-canary';
  });
  await parse(f, 'secret', 'import-env', '/tmp/fake-keys');
  expect(f.values.size).toBe(0);
  expect(f.errors).toEqual(['unsupported environment variable names: PRIVATE_TEST_CANARY']);
  expect(`${f.output.join('\n')}\n${f.errors.join('\n')}`).not.toContain('fake-non-catalog-canary');
  expect(f.exitCodes).toEqual([1]);
});

test('secret env emits only requested shell-quoted names and suppresses partial output on missing names', async () => {
  const f = makeProgram((fixture) => {
    fixture.values.set('EXA_API_KEY', "fake value's key");
    fixture.values.set('TAVILY_KEY', 'fake-tavily-canary');
  });
  await parse(f, 'secret', 'env', '--names', 'EXA_API_KEY');
  expect(f.output).toEqual(["export EXA_API_KEY='fake value'\\''s key'"]);
  expect(f.output.join('\n')).not.toContain('fake-tavily-canary');

  const missing = makeProgram((fixture) => { fixture.values.set('EXA_API_KEY', 'fake-exa-canary'); });
  await parse(missing, 'secret', 'env', '--names', 'EXA_API_KEY,MISSING_KEY');
  expect(missing.output).toEqual([]);
  expect(missing.errors).toEqual(['missing secrets: MISSING_KEY']);
});

test('secret import refuses name collisions unless overwrite was requested and confirmed', async () => {
  const responses = ['long-mock-passphrase'];
  const f = makeProgram((fixture) => {
    fixture.values.set('exa', 'original-fake-value');
    fixture.deps.promptSecret = async () => responses.shift();
    fixture.deps.readBundleFile = async () => {
      return encryptSecretBundle({ version: 1, secrets: { exa: 'replacement-fake-value' } }, 'long-mock-passphrase');
    };
  });
  await parse(f, 'secret', 'import', '/tmp/fake-bundle');
  expect(f.values.get('exa')).toBe('original-fake-value');
  expect(f.errors).toEqual(['name conflicts: exa · rerun with --overwrite to confirm']);
});

test('secret import fails closed when an encrypted bundle contains a non-catalog credential name', async () => {
  const f = makeProgram((fixture) => {
    fixture.deps.promptSecret = async () => 'long-mock-passphrase';
    fixture.deps.readBundleFile = async () => {
      return encryptSecretBundle({ version: 1, secrets: { exa: 'fake-exa-value', access_token: 'fake-rotating-value' } }, 'long-mock-passphrase');
    };
  });
  await parse(f, 'secret', 'import', 'fake-bundle');
  expect(f.values.size).toBe(0);
  expect(f.errors).toEqual(['bundle contains unsupported secret names: access_token']);
});

test('overwrite confirmation must match every colliding name exactly', async () => {
  const replacement = async (confirmation: string) => {
    const f = makeProgram((fixture) => {
      fixture.values.set('exa', 'fake-old-exa');
      fixture.values.set('tavily', 'fake-old-tavily');
      const answers = ['long-mock-passphrase', confirmation];
      fixture.deps.promptSecret = async () => answers.shift();
      fixture.deps.readBundleFile = async () => {
        const { encryptSecretBundle } = await import('../nexus/config/secrets/transfer.js');
        return encryptSecretBundle({ version: 1, secrets: { exa: 'fake-new-exa', tavily: 'fake-new-tavily' } }, 'long-mock-passphrase');
      };
    });
    await parse(f, 'secret', 'import', 'fake-bundle', '--overwrite');
    return f;
  };
  const rejected = await replacement('REPLACE');
  expect(rejected.values.get('exa')).toBe('fake-old-exa');
  expect(rejected.values.get('tavily')).toBe('fake-old-tavily');
  const accepted = await replacement('REPLACE exa,tavily');
  expect(accepted.values.get('exa')).toBe('fake-new-exa');
  expect(accepted.values.get('tavily')).toBe('fake-new-tavily');
});

test('secret sync sends only an encrypted bundle and rejects shell-shaped hosts', async () => {
  let synced: { host: string; contents: string } | undefined;
  const f = makeProgram((fixture) => {
    fixture.values.set('exa', 'fake-sync-secret');
    fixture.deps.promptSecret = async () => 'long-mock-passphrase';
    fixture.deps.syncBundle = async (host, contents) => { synced = { host, contents }; };
  });
  await parse(f, 'secret', 'sync', 'user@fake-host');
  expect(synced?.host).toBe('user@fake-host');
  expect(synced?.contents).toContain('elanous-secret-bundle');
  expect(synced?.contents).not.toContain('fake-sync-secret');
  expect(f.output[0]).toContain('destination import confirmed');

  const rejected = makeProgram();
  await parse(rejected, 'secret', 'sync', 'host;touch-pwned');
  expect(rejected.errors).toEqual(['invalid SSH host']);
});

test('SSH sync writes through stdin with remote 0600 verification and attempts cleanup after failure', async () => {
  const calls: Array<{ command: string; args: string[]; input?: string; stdio?: string }> = [];
  const runner = async (command: string, args: string[], input?: string, stdio?: 'inherit' | 'ignore') => {
    calls.push({ command, args, ...(input === undefined ? {} : { input }), ...(stdio ? { stdio } : {}) });
    if (args.includes('import')) throw new Error('simulated import failure');
  };
  await expect(syncEncryptedBundleOverSsh('fake-host', 'fake-encrypted-bundle', runner)).rejects.toThrow('credential transfer process failed');
  expect(calls).toHaveLength(3);
  expect(calls[0]?.command).toBe('ssh');
  expect(calls[0]?.args[1]).toContain('umask 077');
  expect(calls[0]?.args[1]).toContain('chmod 600');
  expect(calls[0]?.args[1]).toContain('test "$mode" = 600');
  expect(calls[0]?.input).toBe('fake-encrypted-bundle');
  expect(calls[1]?.stdio).toBe('inherit');
  expect(calls[2]?.args[1]).toBe('rm');
});

test('SSH stdin EPIPE is converted to a rejected operation instead of an uncaught process error', async () => {
  // Close stdin after its first chunk so a remaining payload reliably hits EPIPE.
  const script = 'process.stdin.once("data", () => { process.stdin.destroy(); setTimeout(() => process.exit(0), 50) })';
  await expect(runProcess(process.execPath, ['-e', script], 'fake-ciphertext'.repeat(1_000_000)))
    .rejects.toThrow('credential transfer process failed');
});

test('service errors are suppressed so credential-bearing diagnostics cannot escape', async () => {
  const f = makeProgram();
  f.values.set('exa', 'mock-secret-value');
  f.deps.verifySecret = async () => { throw new Error('diagnostic contains mock-secret-value'); };
  const program = new Command();
  program.exitOverride();
  registerSecretCommands(program, f.deps);
  await program.parseAsync(['node', 'elanous', 'secret', 'test', 'exa']);
  expect(f.output).toEqual([]);
  expect(f.errors).toEqual(['secret test failed']);
  expect(f.errors.join('\n')).not.toContain('mock-secret-value');
  expect(f.exitCodes).toEqual([1]);
});
