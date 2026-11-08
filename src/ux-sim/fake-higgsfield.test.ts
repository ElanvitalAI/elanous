import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createHiggsfieldBackend } from '../ad-pipeline/higgsfield-backend.js';
import type { ShootCommand } from '../ad-pipeline/shoot-run.js';
import { createFakeHiggsfieldRunner } from './fake-higgsfield.js';

const command: ShootCommand = {
  beatIndex: 0,
  jobType: 'seedance_2_0',
  durationSeconds: 5,
  args: ['--prompt', 'fake device test'],
};

test('SIM-FAKE-HIGGSFIELD: deterministic IDs and queued → in_progress → completed results use backend argv', async () => {
  const makeRunner = () => createFakeHiggsfieldRunner({ seed: 'stable-seed', deviceOptIn: true });
  const firstRunner = makeRunner();
  const secondRunner = makeRunner();
  const firstBackend = createHiggsfieldBackend({ runner: firstRunner, allowSpend: true });
  const secondBackend = createHiggsfieldBackend({ runner: secondRunner, allowSpend: true });

  const id = await firstBackend.submit(command);
  expect(await secondBackend.submit(command)).toBe(id);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  await expect(firstBackend.poll(id)).resolves.toEqual({ status: 'queued' });
  await expect(firstBackend.poll(id)).resolves.toEqual({ status: 'in_progress' });
  await expect(firstBackend.poll(id)).resolves.toEqual({ status: 'completed', resultUrl: `https://fake-higgsfield.invalid/${id}.mp4` });
  expect(firstRunner.ledger.calls.map(({ argv }) => argv)).toEqual([
    ['higgsfield', 'generate', 'create', 'seedance_2_0', '--prompt', 'fake device test', '--duration', '5'],
    ['higgsfield', 'generate', 'get', id, '--json'],
    ['higgsfield', 'generate', 'get', id, '--json'],
    ['higgsfield', 'generate', 'get', id, '--json'],
  ]);
  expect(firstRunner.ledger).toMatchObject({ submissions: 1, polls: 3 });
});

test('SIM-FAKE-HIGGSFIELD: deterministic job IDs remain distinct across many submissions', async () => {
  const runner = createFakeHiggsfieldRunner({ seed: 'many-jobs', deviceOptIn: true, maxSubmissions: 4096 });
  const ids = new Set<string>();
  for (let index = 0; index < 4096; index++) {
    const result = await runner.run(['higgsfield', 'generate', 'create', String(index)]);
    expect(result.exitCode).toBe(0);
    ids.add(result.stdout);
  }
  expect(ids.size).toBe(4096);
});

test('SIM-FAKE-HIGGSFIELD: backend create and poll trigger no process or network boundary', () => {
  const fakeModule = new URL('./fake-higgsfield.ts', import.meta.url).href;
  const backendModule = new URL('../ad-pipeline/higgsfield-backend.ts', import.meta.url).href;
  const probe = [
    'const calls = [];',
    'const forbid = name => (..._args) => { calls.push(name); throw new Error("unexpected external call: " + name); };',
    'globalThis.fetch = forbid("fetch"); Bun.spawn = forbid("Bun.spawn"); Bun.spawnSync = forbid("Bun.spawnSync");',
    'const child = require("node:child_process");',
    'for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) child[key] = forbid("child." + key);',
    'const http = require("node:http"); const https = require("node:https"); const net = require("node:net");',
    'http.request = forbid("http.request"); http.get = forbid("http.get"); https.request = forbid("https.request"); https.get = forbid("https.get"); net.connect = forbid("net.connect"); net.createConnection = forbid("net.createConnection");',
    'require("node:module").syncBuiltinESMExports();',
    `const { createFakeHiggsfieldRunner } = await import(${JSON.stringify(fakeModule)});`,
    `const { createHiggsfieldBackend } = await import(${JSON.stringify(backendModule)});`,
    'const backend = createHiggsfieldBackend({ runner: createFakeHiggsfieldRunner({ seed: "no-io", deviceOptIn: true }), allowSpend: true });',
    'const id = await backend.submit({ beatIndex: 0, jobType: "seedance_2_0", durationSeconds: 5, args: ["--prompt", "probe"] });',
    'await backend.poll(id); await backend.poll(id); const result = await backend.poll(id);',
    'console.log(JSON.stringify({ calls, result }));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 15_000 });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ calls: [], result: {
    status: 'completed', resultUrl: expect.stringMatching(/^https:\/\/fake-higgsfield\.invalid\//),
  } });
});

test('SIM-FAKE-HIGGSFIELD: injected runner accepts absolute and non-default cliPath values', async () => {
  for (const cliPath of ['/opt/tools/higgsfield-cli', 'vendor-hf', 'generate']) {
    const runner = createFakeHiggsfieldRunner({ seed: cliPath, deviceOptIn: true });
    const backend = createHiggsfieldBackend({ runner, allowSpend: true, cliPath });
    const id = await backend.submit(command);

    expect(await backend.poll(id)).toEqual({ status: 'queued' });
    expect(runner.ledger.calls.map(({ argv }) => argv[0])).toEqual([cliPath, cliPath]);
  }
});

test('SIM-FAKE-HIGGSFIELD: configured failed outcome is reached through backend polling', async () => {
  const runner = createFakeHiggsfieldRunner({ seed: 'failed-seed', deviceOptIn: true, outcome: 'failed' });
  const backend = createHiggsfieldBackend({ runner, allowSpend: true });
  const id = await backend.submit(command);

  await backend.poll(id);
  await backend.poll(id);
  await expect(backend.poll(id)).resolves.toEqual({ status: 'failed' });
});

test('SIM-FAKE-HIGGSFIELD: submission limit returns a stable classified nonzero error', async () => {
  const runner = createFakeHiggsfieldRunner({ seed: 'limited-seed', deviceOptIn: true, maxSubmissions: 1 });
  const backend = createHiggsfieldBackend({ runner, allowSpend: true });
  await backend.submit(command);

  await expect(backend.submit(command)).rejects.toThrow('HIGGSFIELD_SUBMISSION_LIMIT: submission limit exceeded');
  expect(runner.ledger.submissions).toBe(1);
  expect(runner.ledger.calls.at(-1)?.argv).toContain('create');
});

test('SIM-FAKE-HIGGSFIELD: image ledger records only accepted image-backed submissions', async () => {
  const imageBytes = Buffer.from('uploaded-image-fixture');
  const runner = createFakeHiggsfieldRunner({ seed: 'image-ledger', deviceOptIn: true, maxSubmissions: 1,
    imageBytes, requireImageBytes: true });
  const argv = ['higgsfield', 'generate', 'create', 'image2video', '--image', 'apps/shop-studio/products/demo.png'];
  expect((await runner.run(argv)).exitCode).toBe(0);
  expect((await runner.run(argv)).exitCode).toBe(1);
  expect(runner.ledger.submissions).toBe(1);
  expect(runner.ledger.imageSha256).toEqual([createHash('sha256').update(imageBytes).digest('hex')]);

  const imageOptionalRunner = createFakeHiggsfieldRunner({ seed: 'image-optional', deviceOptIn: true, imageBytes });
  expect((await imageOptionalRunner.run(['higgsfield', 'generate', 'create', 'text2video'])).exitCode).toBe(0);
  expect(imageOptionalRunner.ledger.imageSha256).toEqual([]);
});

test('SIM-FAKE-HIGGSFIELD: result URL TTL starts at first completion, not submission', async () => {
  let time = 10_000;
  const runner = createFakeHiggsfieldRunner({
    seed: 'expiry-seed',
    deviceOptIn: true,
    now: () => time,
    resultUrlTtlMs: 100,
  });
  const backend = createHiggsfieldBackend({ runner, allowSpend: true });
  const id = await backend.submit(command);
  time += 200;
  await backend.poll(id);
  await backend.poll(id);
  const completed = await backend.poll(id);

  expect(completed).toEqual({ status: 'completed', resultUrl: `https://fake-higgsfield.invalid/${id}.mp4` });
  const raw = await runner.run(['higgsfield', 'generate', 'get', id, '--json']);
  expect(JSON.parse(raw.stdout)).toEqual({ status: 'completed', result_url: `https://fake-higgsfield.invalid/${id}.mp4` });

  time += 100;
  const expired = await backend.poll(id);
  expect(expired).toEqual({ status: 'completed' });
  const rawExpired = await runner.run(['higgsfield', 'generate', 'get', id, '--json']);
  expect(JSON.parse(rawExpired.stdout)).toEqual({ status: 'completed' });
});

test('SIM-FAKE-HIGGSFIELD: unapproved fake device construction is rejected', () => {
  expect(() => createFakeHiggsfieldRunner({ seed: 'no-opt-in', deviceOptIn: false as unknown as true })).toThrow('deviceOptIn: true');
});

test('SIM-FAKE-HIGGSFIELD: backend spend gate rejects before an opted-in fake runner is invoked', async () => {
  const runner = createFakeHiggsfieldRunner({ seed: 'blocked-seed', deviceOptIn: true });
  const backend = createHiggsfieldBackend({ runner, allowSpend: false });

  await expect(backend.submit(command)).rejects.toThrow('Higgsfield spending is disabled');
  expect(runner.ledger).toMatchObject({ submissions: 0, polls: 0, calls: [] });
});
