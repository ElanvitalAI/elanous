import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createSecretPrompt } from '../onboarding/secret-prompt.js';
import { registerSecretCommands } from './secret-cli.js';
import { createEmptySecretCliMock } from './secret-cli.test-helpers.js';

function makeProgram() {
  const fixture = createEmptySecretCliMock();
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
