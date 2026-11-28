import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry = new URL('./cli.ts', import.meta.url).pathname;

describe('definition CLI', () => {
  test('schema reports its limited agent scope and rejects unsupported kinds', () => {
    const run = (kind: string) => Bun.spawnSync([process.execPath, '-e', `import { Command } from 'commander'; import { registerDefinitionCommands } from ${JSON.stringify(entry)}; const program = new Command(); registerDefinitionCommands(program); await program.parseAsync(['node', 'eln', 'def', 'schema', ${JSON.stringify(kind)}]);`], { stdout: 'pipe', stderr: 'pipe' });
    const agent = run('agent');
    expect(agent.exitCode).toBe(0);
    expect(JSON.parse(agent.stdout.toString())).toMatchObject({ kind: 'agent', apiVersion: 'elanous/loop-agent@3', scope: 'root keys only', keys: expect.arrayContaining(['apiVersion', 'manifest', 'policies']) });
    const policy = run('policy');
    expect(policy.exitCode).toBe(1);
    expect(policy.stderr.toString()).toContain('schema unavailable for policy');
  });
  test('check-bundle reports valid units and rejects an unsupported role', () => {
    const root = mkdtempSync(join(tmpdir(), 'def-bundle-cli-'));
    const manifest = join(root, 'elanous.package.yaml');
    writeFileSync(join(root, 'policy.yaml'), 'version: 1\ncaps:\n  codex:\n    harness: 75\n');
    const run = () => Bun.spawnSync([process.execPath, '-e', `import { Command } from 'commander'; import { registerDefinitionCommands } from ${JSON.stringify(entry)}; const program = new Command(); registerDefinitionCommands(program); await program.parseAsync(['node', 'eln', 'def', 'check-bundle', ${JSON.stringify(root)}]);`], { stdout: 'pipe', stderr: 'pipe' });
    writeFileSync(manifest, 'name: test\nversion: 1.0.0\nprovides:\n  policies: [./policy.yaml]\n');
    const valid = run();
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout.toString()).units).toEqual(['policies:./policy.yaml']);
    writeFileSync(manifest, 'name: test\nversion: 1.0.0\nprovides:\n  roles: [./role.yaml]\n');
    const invalid = run();
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString()).toContain('roles: unsupported category');
  });
  test('simulate-bundle installs to a temporary universe without starting a runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'def-sim-cli-'));
    writeFileSync(join(root, 'elanous.package.yaml'), 'name: test\nversion: 1.0.0\nprovides:\n  policies: [./policy.yaml]\n');
    writeFileSync(join(root, 'policy.yaml'), 'version: 1\ncaps:\n  codex:\n    harness: 75\n');
    const result = Bun.spawnSync([process.execPath, '-e', `import { Command } from 'commander'; import { registerDefinitionCommands } from ${JSON.stringify(entry)}; const program = new Command(); registerDefinitionCommands(program); await program.parseAsync(['node', 'eln', 'def', 'simulate-bundle', ${JSON.stringify(root)}]);`], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    const installed = JSON.parse(result.stdout.toString());
    expect(installed.installed).toEqual(['policies:./policy.yaml']);
    expect(JSON.parse(readFileSync(join(installed.root, 'defs/installed.json'), 'utf8')).simulation).toBe(true);
  });
  test('simulate-judge runs the real judge on installed policy with synthetic transport and fails closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'def-judge-cli-'));
    writeFileSync(join(root, 'elanous.package.yaml'), 'name: test\nversion: 1.0.0\nprovides:\n  policies: [./policy.yaml]\n');
    const policy = join(root, 'policy.yaml');
    const run = () => Bun.spawnSync([process.execPath, '-e', `import { Command } from 'commander'; import { registerDefinitionCommands } from ${JSON.stringify(entry)}; const program = new Command(); registerDefinitionCommands(program); await program.parseAsync(${JSON.stringify(['node', 'eln', 'def', 'simulate-judge', root, '--response', 'fixture', '--prompt', 'probe'])});`], { stdout: 'pipe', stderr: 'pipe' });
    writeFileSync(policy, 'version: 1\nroles:\n  classify:\n    provider: anthropic\n    model: fixture-model\n');
    const valid = run();
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout.toString())).toMatchObject({ transport: 'synthetic', runtime: 'judge-only', result: { ok: true, provider: 'anthropic', model: 'fixture-model', value: 'fixture' } });
    writeFileSync(policy, 'version: 1\nroles:\n  classify:\n    provider: anthropic\n');
    const invalid = run();
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString()).toContain('simulation requires an explicit classify provider and model');
    expect(invalid.stdout.toString()).toBe('');
  });
  test('install requires explicit simulation and never touches the bundle on refusal', () => {
    const root = mkdtempSync(join(tmpdir(), 'def-install-cli-'));
    const manifest = 'name: test\nversion: 1.0.0\nprovides:\n  policies: [./policy.yaml]\n';
    writeFileSync(join(root, 'elanous.package.yaml'), manifest);
    writeFileSync(join(root, 'policy.yaml'), 'version: 1\ncaps:\n  codex:\n    harness: 75\n');
    const cli = (extra: string[]) => Bun.spawnSync([process.execPath, '-e', `import { Command } from 'commander'; import { registerDefinitionCommands } from ${JSON.stringify(entry)}; const program = new Command(); registerDefinitionCommands(program); await program.parseAsync(${JSON.stringify(['node', 'eln', 'def', 'install', root, ...extra])});`], { stdout: 'pipe', stderr: 'pipe' });
    const refused = cli([]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain('Production installation is unavailable');
    expect(readFileSync(join(root, 'elanous.package.yaml'), 'utf8')).toBe(manifest);
    const installed = cli(['--simulation']);
    expect(installed.exitCode).toBe(0);
    expect(JSON.parse(installed.stdout.toString()).installed).toEqual(['policies:./policy.yaml']);
  });
  test('show and diff expose validated policy values and reject invalid input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'def-inspect-'));
    const a = join(dir, 'a.yaml'), b = join(dir, 'b.yaml'), bad = join(dir, 'bad.yaml');
    writeFileSync(a, 'caps:\n  codex:\n    harness: 50\n');
    writeFileSync(b, 'caps:\n  codex:\n    harness: 75\n');
    writeFileSync(bad, 'caps:\n  codex:\n    harness: 101\n');
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, '-e', `import { Command } from 'commander'; import { registerDefinitionCommands } from ${JSON.stringify(entry)}; const program = new Command(); registerDefinitionCommands(program); await program.parseAsync(['node', 'eln', 'def', ...${JSON.stringify(args)}]);`], { stdout: 'pipe', stderr: 'pipe' });
    const show = run('show', a);
    expect(show.exitCode).toBe(0);
    expect(JSON.parse(show.stdout.toString()).caps.codex.harness).toBe(50);
    const diff = run('diff', a, b);
    expect(diff.exitCode).toBe(0);
    expect(diff.stdout.toString().trim()).toBe('caps.codex.harness');
    const refused = run('diff', a, bad);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout.toString()).toBe('');
    expect(refused.stderr.toString()).toContain(`${bad}:3:`);
  });
  test('lint accepts a valid versioned policy', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'def-cli-')), 'policy.yaml');
    writeFileSync(path, 'version: 1\ncaps:\n  codex:\n    harness: 75\n');
    const script = `import { Command } from 'commander'; import { registerDefinitionCommands } from ${JSON.stringify(entry)}; const program = new Command(); registerDefinitionCommands(program); await program.parseAsync(['node', 'eln', 'def', 'lint', ${JSON.stringify(path)}]);`;
    const result = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(`${path}: OK`);
  });
  test.each([
    ['invalid policy field', 'version: 1\ncaps:\n  codex:\n    harness: 101\n', 4, 'policy.caps.codex.harness is invalid'],
    ['unknown policy field', 'version: 1\ncaps:\n  codex:\n    unknown: 1\n', 4, 'unknown field policy.caps.codex.unknown'],
    ['unknown key', 'apiVersion: elanous/loop-agent@3\nunknown_key: 1\n', 2, 'unknown agent key unknown_key'],
    ['literal host', 'apiVersion: elanous/loop-agent@3\nhost: node-b\n', 2, 'literal host name is not portable'],
    ['missing fact', 'apiVersion: elanous/loop-agent@3\npolicies:\n  limit:\n    fact: absent_fact\n', 4, 'policies.limit: fact absent_fact is not declared in manifest.requires.facts'],
  ])('lint rejects %s with its source line and exit 1', (_name, yaml, line, message) => {
    const path = join(mkdtempSync(join(tmpdir(), 'def-cli-')), 'definition.yaml');
    writeFileSync(path, yaml);
    const script = `import { Command } from 'commander'; import { registerDefinitionCommands } from ${JSON.stringify(entry)}; const program = new Command(); registerDefinitionCommands(program); await program.parseAsync(['node', 'eln', 'def', 'lint', ${JSON.stringify(path)}]);`;
    const result = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`${path}:${line}: ${message}`);
    expect(result.stdout.toString()).not.toContain(': OK');
  });
});
