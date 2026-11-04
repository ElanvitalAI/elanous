import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const installer = join(import.meta.dir, 'install.sh');

test('declining installation leaves the home and prefix unchanged', () => {
  const home = mkdtempSync(join(tmpdir(), 'elanous-consent-'));
  try {
    const startup = join(home, '.bashrc');
    const prefix = join(home, 'install');
    writeFileSync(startup, 'unchanged\n');
    const result = spawnSync('/bin/bash', [installer, '--prefix', prefix], {
      encoding: 'utf8', env: { ...process.env, HOME: home, ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_ANSWER: 'n', ELANOUS_INSTALL_LANG: 'en' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('consent required');
    expect(readFileSync(startup, 'utf8')).toBe('unchanged\n');
    expect(existsSync(prefix)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('consent runs the installed doctor once, reports failure and permits retry', () => {
  const home = mkdtempSync(join(tmpdir(), 'elanous-setup-'));
  try {
    const pkg = join(home, 'package');
    const prefix = join(home, 'install space; touch ' + join(home, 'pwned') + '; #');
    const archive = join(home, 'fixture.tgz');
    const record = join(home, 'doctor-calls');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'elanous', version: '1.0.0' }));
    writeFileSync(join(pkg, 'bin', 'elanous.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.RECORD, JSON.stringify({ args: process.argv.slice(2), prefix: process.env.ELANOUS_INSTALL_PREFIX, path: process.env.PATH }) + '\\n');\nprocess.exit(process.env.FAIL_DOCTOR === '1' ? 1 : 0);\n`);
    const packed = spawnSync('tar', ['-czf', archive, '-C', home, 'package'], { encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    const args = [installer, '--source', archive, '--prefix', prefix, '--no-modify-path', '--no-setup'];
    const env = { ...process.env, HOME: home, ELANOUS_INSTALL_INTERACTIVE: '1', ELANOUS_INSTALL_ANSWER: 'y', ELANOUS_INSTALL_LANG: 'en', RECORD: record };
    const failed = spawnSync('/bin/bash', args, { encoding: 'utf8', env: { ...env, FAIL_DOCTOR: '1' }, timeout: 120_000 });
    expect(failed.status, failed.stderr).toBe(1);
    const retryLine = failed.stderr.split('\n').find(line => line.startsWith('Setup failed; retry:'));
    expect(retryLine).toBeDefined();
    const retryCommand = retryLine!.slice('Setup failed; retry: '.length);
    expect(retryCommand).toContain('doctor --fix --yes --setup-tools');
    expect(existsSync(join(home, 'pwned'))).toBe(false);
    const firstCall = JSON.parse(readFileSync(record, 'utf8').split('\n')[0]);
    expect(firstCall.args).toEqual(['doctor', '--fix', '--yes', '--setup-tools', '--json']);
    expect(firstCall.prefix).toBe(realpathSync(prefix));
    expect(firstCall.path.startsWith(`${realpathSync(prefix)}/bin:`)).toBe(true);
    const retry = spawnSync('/bin/bash', ['-c', retryCommand], { encoding: 'utf8', env, timeout: 120_000 });
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).not.toContain('Setup failed; retry:');
    expect(retry.stderr).not.toContain('harness command missing');
    expect(existsSync(join(home, 'pwned'))).toBe(false);
    const calls = readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map(call => call.args)).toEqual([['doctor', '--fix', '--yes', '--setup-tools', '--json'], ['doctor', '--fix', '--yes', '--setup-tools']]);
    expect(calls[1].prefix).toBe(realpathSync(prefix));
    expect(calls[1].path.startsWith(`${realpathSync(prefix)}/bin:`)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 240_000);
