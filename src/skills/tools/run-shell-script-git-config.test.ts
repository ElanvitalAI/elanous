import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchRunShell } from './shell.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

test('signed Git log and show do not run configured verification or textconv helpers without approval', async () => {
  root = mkdtempSync(join(tmpdir(), 'runshell-signed-git-'));
  const home = join(root, 'gnupg');
  mkdirSync(home, { mode: 0o700 });
  const run = (command: string, args: string[], env?: NodeJS.ProcessEnv) => {
    // 출처: #39514 — 시험의 60초 제한 안에서 로컬 GPG/Git 준비 명령 하나에 허용하는 절반의 시간.
    const result = spawnSync(command, args, { cwd: root, env: env ?? process.env, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0) throw new Error(`${command} setup failed: ${result.stderr}`);
    return result.stdout;
  };
  run('gpg', ['--homedir', home, '--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
    'Synthetic Test <synthetic@example.test>', 'ed25519', 'sign', '0']);
  run('git', ['init', '-q']);
  run('git', ['config', 'user.email', 'synthetic@example.test']);
  run('git', ['config', 'user.name', 'Synthetic Test']);
  writeFileSync(join(root, 'note.txt'), 'synthetic\n');
  writeFileSync(join(root, '.gitattributes'), 'note.txt diff=evil\n');
  run('git', ['add', 'note.txt', '.gitattributes']);
  run('git', ['commit', '-qS', '-m', 'synthetic signed commit'], { ...process.env, GNUPGHOME: home });
  const marker = join(root, 'verification-helper-ran');
  const helper = join(root, 'fake-gpg');
  writeFileSync(helper, `#!/bin/sh\nprintf 'called\\n' >> '${marker}'\nexit 1\n`);
  chmodSync(helper, 0o700);
  run('git', ['config', 'gpg.program', helper]);
  run('git', ['config', 'log.showSignature', 'true']);
  const textconvMarker = join(root, 'textconv-helper-ran');
  const textconv = join(root, 'fake-textconv');
  writeFileSync(textconv, `#!/bin/sh\nprintf 'called\\n' >> '${textconvMarker}'\ncat "$1"\n`);
  chmodSync(textconv, 0o700);
  run('git', ['config', 'diff.evil.textconv', textconv]);

  // The repository setting really does invoke an external helper on an ordinary read.
  run('git', ['log', '--oneline', 'HEAD']);
  expect(existsSync(marker)).toBe(true);
  unlinkSync(marker);
  run('git', ['-c', 'log.showSignature=false', 'show', 'HEAD']);
  expect(existsSync(textconvMarker)).toBe(true);
  unlinkSync(textconvMarker);

  const result = await dispatchRunShell({ cwd: root, script: [
    { id: 'log', command: ['git', 'log', '--oneline', 'HEAD'] },
    { id: 'show', command: ['git', 'show', '--stat', 'HEAD'] },
    { id: 'patch', command: ['git', 'show', 'HEAD'] },
  ] }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
  expect(result.outcome).toBe('exit');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).steps).toHaveLength(3);
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(textconvMarker)).toBe(false);
}, 60_000);

test('worktree diff needs prior human approval before a configured clean filter can run', async () => {
  root = mkdtempSync(join(tmpdir(), 'runshell-clean-filter-'));
  const run = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git setup failed: ${result.stderr}`);
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'synthetic@example.test']);
  run(['config', 'user.name', 'Synthetic Test']);
  const marker = join(root, 'clean-filter-ran');
  const helper = join(root, 'fake-clean-filter');
  writeFileSync(helper, `#!/bin/sh\nprintf 'called\\n' >> '${marker}'\ncat\n`);
  chmodSync(helper, 0o700);
  run(['config', 'filter.evil.clean', helper]);
  writeFileSync(join(root, '.gitattributes'), 'note.txt filter=evil\n');
  writeFileSync(join(root, 'note.txt'), 'original\n');
  run(['add', '.gitattributes', 'note.txt']);
  run(['commit', '-qm', 'synthetic filter fixture']);
  if (existsSync(marker)) unlinkSync(marker);
  writeFileSync(join(root, 'note.txt'), 'modified\n');
  run(['diff', '--', 'note.txt']);
  expect(existsSync(marker)).toBe(true);
  unlinkSync(marker);

  const approvals: string[] = [];
  const result = await dispatchRunShell({ cwd: root, script: [
    { id: 'worktree', command: ['git', 'diff', '--stat'] },
  ] }, { scriptApproval: async (command) => {
    approvals.push(command.join(' '));
    return { allowed: true, priorHumanApproval: false };
  } });
  expect(approvals).toEqual(['git diff --stat']);
  expect(result.outcome).toBe('denied');
  expect(existsSync(marker)).toBe(false);

  const objectDiff = await dispatchRunShell({ cwd: root, script: [
    { id: 'objects', command: ['git', 'diff', 'HEAD', 'HEAD'] },
  ] }, { scriptApproval: async () => ({ allowed: true, priorHumanApproval: false }) });
  expect(objectDiff.outcome).toBe('denied');
  expect(existsSync(marker)).toBe(false);
});
