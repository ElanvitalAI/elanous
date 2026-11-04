import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { registerFleetCommands } from './fleet-cli.js';

async function runResourcesCli(json: boolean): Promise<{ stdout: string; lines: string[] }> {
  const root = mkdtempSync(join(tmpdir(), 'fleet-cli-cloud-'));
  const bin = join(root, 'bin');
  const originalPath = process.env.PATH;
  const originalStateDir = process.env.ELANOUS_STATE_DIR;
  const originalWrite = process.stdout.write;
  const lines: string[] = [];
  let stdout = '';
  const log = console.log;
  try {
    mkdirSync(bin);
    writeFileSync(join(bin, 'aws'), `#!/bin/sh\nprintf '%s\\n' '{"Reservations":[{"Instances":[{"InstanceId":"i-cli-orphan","State":{"Name":"running"},"Tags":[{"Key":"Name","Value":"cli-orphan-aws"}]},{"InstanceId":"i-stopped","State":{"Name":"stopped"}}]}]}'\n`);
    writeFileSync(join(bin, 'gcloud'), `#!/bin/sh\nprintf '%s\\n' '[{"id":"123456","name":"cli-orphan-gcp","status":"RUNNING","zone":"https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a","selfLink":"https://compute.googleapis.com/compute/v1/projects/p/zones/us-central1-a/instances/cli-orphan-gcp"}]'\n`);
    chmodSync(join(bin, 'aws'), 0o755);
    chmodSync(join(bin, 'gcloud'), 0o755);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    process.env.ELANOUS_STATE_DIR = join(root, 'state');
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      stdout += String(chunk);
      if (typeof encodingOrCallback === 'function') encodingOrCallback();
      else callback?.();
      return true;
    }) as typeof process.stdout.write;
    const program = new Command();
    registerFleetCommands(program);
    await program.parseAsync(['fleet', 'resources', ...(json ? ['--json'] : [])], { from: 'user' });
    return { stdout, lines };
  } finally {
    process.stdout.write = originalWrite;
    console.log = log;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = originalStateDir;
    rmSync(root, { recursive: true, force: true });
  }
}

test('fleet resources CLI connects stubbed cloud discovery to JSON alerts and provider status', async () => {
  const result = await runResourcesCli(true);
  const output = JSON.parse(result.stdout) as { alerts: Array<{ id: string; reason: string; message: string }>; discovery: Array<{ provider: string; status: string; resources: number }> };
  expect(output.discovery).toEqual([
    { provider: 'aws', status: 'measured', resources: 1 },
    { provider: 'gcp', status: 'measured', resources: 1 },
  ]);
  expect(output.alerts).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'i-cli-orphan', reason: 'unregistered', message: 'aws resource cli-orphan-aws (i-cli-orphan) is outside the inventory' }),
    expect.objectContaining({ id: '123456', reason: 'unregistered', message: 'gcp resource cli-orphan-gcp (123456) is outside the inventory' }),
  ]));
});

test('fleet resources human output shows provider states and named orphan alerts', async () => {
  const result = await runResourcesCli(false);
  const output = result.lines.join('\n');
  expect(output).toContain('aws: measured · 1 running');
  expect(output).toContain('gcp: measured · 1 running');
  expect(output).toContain('unregistered: aws resource cli-orphan-aws (i-cli-orphan) is outside the inventory');
  expect(output).toContain('unregistered: gcp resource cli-orphan-gcp (123456) is outside the inventory');
});
