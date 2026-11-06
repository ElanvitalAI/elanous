import { expect, test } from 'bun:test';
import { createHiggsfieldBackend } from './higgsfield-backend.js';
import type { ShootCommand } from './shoot-run.js';
import { createFakeHiggsfieldRunner } from '../ux-sim/fake-higgsfield.js';

const command: ShootCommand = {
  beatIndex: 0,
  jobType: 'seedance_2_0',
  durationSeconds: 5,
  args: ['--prompt', 'isolated integration'],
};

test('SIM-FAKE-HIGGSFIELD: factory runner injection completes an isolated create and poll flow', async () => {
  const runner = createFakeHiggsfieldRunner({ seed: 'integration-seed', deviceOptIn: true });
  const backend = createHiggsfieldBackend({ runner, allowSpend: true });

  const jobId = await backend.submit(command);
  expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  await expect(backend.poll(jobId)).resolves.toEqual({ status: 'queued' });
  await expect(backend.poll(jobId)).resolves.toEqual({ status: 'in_progress' });
  await expect(backend.poll(jobId)).resolves.toEqual({
    status: 'completed',
    resultUrl: `https://fake-higgsfield.invalid/${jobId}.mp4`,
  });
  expect(runner.ledger.submissions).toBe(1);
  expect(runner.ledger.polls).toBe(3);
});

test('SIM-FAKE-HIGGSFIELD: spend gate rejects before calling even an opted-in fake runner', async () => {
  const runner = createFakeHiggsfieldRunner({ seed: 'blocked-seed', deviceOptIn: true });
  const backend = createHiggsfieldBackend({ runner });

  await expect(backend.submit(command)).rejects.toThrow('Higgsfield spending is disabled');
  expect(runner.ledger.calls).toHaveLength(0);
});

test('SIM-FAKE-HIGGSFIELD: unknown expiry metadata from a real runner does not hide its result URL', async () => {
  const backend = createHiggsfieldBackend({ allowSpend: true, runner: {
    run: async () => ({ stdout: JSON.stringify({ status: 'completed', result_url: 'https://media.example/result.mp4',
      result_url_expired: 'provider-extension' }), stderr: '', exitCode: 0 }),
  } });

  await expect(backend.poll('job-id')).resolves.toEqual({ status: 'completed', resultUrl: 'https://media.example/result.mp4' });
});
