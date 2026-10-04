import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, 'coord-channel-watch.sh');
const line = '[#999999 신규 id=42 2026-10-01T00:00:00Z @peer] hello';
const jq = `#!/bin/bash
case "$*" in
  *'select(.id == $t or .alias == $t)'*) echo '{"id":"TC","alias":"O","mark":"🅞","title":"CTO"}' ;;
  *'.mark // empty'*) echo '🅞' ;;
  *'.id // empty'*) echo 'TC' ;;
  *'.alias // empty'*) echo 'O' ;;
  *'.title // empty'*) echo 'CTO' ;;
  *'.line'*)
    if [ "$4" = 'select(.archive | not) | .line' ]; then exit 0; fi
    sed -n 's/.*"line":"\\([^"]*\\)".*/\\1/p' ;;
esac
`;

async function pollWithGh(gh: string, marker: string, skipReports = false): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'coord-watch-output-'));
  for (const [name, body] of [['jq', jq], ['gh', gh]]) {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  try {
    return await new Promise<string>((resolveOutput, reject) => {
      const child = spawn('bash', [script, 'ensure', '--track', 'TC'], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          TMPDIR: dir,
          CH_PR: '999999',
          CH_INTERVAL: '0.02',
          CH_WATCH_BODY: '0',
          CH_HEARTBEAT_EVERY: '0',
          COORD_WATCH_SKIP_OTHERS_REPORTS: skipReports ? '1' : '0',
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), 5_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes(marker)) child.kill('SIGTERM');
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', () => {
        clearTimeout(timer);
        if (!stdout.includes(marker)) reject(new Error(`missing ${marker}: ${stdout.slice(0, 500)} ${stderr}`));
        else resolveOutput(stdout);
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('successful comment poll still prints the formatted channel line', async () => {
  const output = await pollWithGh(`#!/bin/bash
case "$*" in
  *'/comments?'*) printf '%s\\n' '{"line":"${line}","archive":false}' ;;
  *) exit 1 ;;
esac
`, line);
  expect(output).toContain(line);
});

test('broken upstream comment stream reaches the watcher failure branch', async () => {
  const output = await pollWithGh(`#!/bin/bash
case "$*" in
  *'/comments?'*) for ((i=0; i<10000; i++)); do printf '%s\\n' '{"line":"${line}","archive":false}'; done ;;
  *) exit 1 ;;
esac
`, '조회 «실패»', true);
  expect(output).toContain('연속 1회');
  expect(output).not.toContain('조회 «회복»');
});

test('gh exit 1 on both comment endpoints reaches the watcher failure branch', async () => {
  const output = await pollWithGh('#!/bin/bash\nexit 1\n', '연속 1회');
  expect(output).toContain('조회 «실패»');
  expect(output).toContain('연속 1회');
  expect(output).toContain('마지막 성공=«한 번도 성공 못 함»');
  expect(output).not.toContain('조회 «회복»');
});
