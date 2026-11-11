import { expect, test } from 'bun:test';
import { withSimClock } from '../ux-sim/fake-clock.js';
import { createFakeCloudVm } from '../ux-sim/fake-cloud-vm.js';
import { createCommandCloudVmAdapter, type CloudVmCommandRunner } from './cloud-vm-adapter.js';

const EPOCH = Date.parse('2026-11-10T00:00:00Z');

test('configured argv adapter resumes and stops only aws1 through fake-cloud-vm', async () => {
  await withSimClock(EPOCH, async () => {
    const fleet = createFakeCloudVm();
    fleet.createFromImage({ id: 'aws1', imageDigest: 'sha256:rehearsal', hourlyCost: 1 });
    fleet.stop('aws1');
    const calls: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
    const runner: CloudVmCommandRunner = (command, args, timeoutMs) => {
      calls.push({ command, args, timeoutMs });
      const [action, host] = args;
      if (host !== 'aws1') return { status: 2, stdout: '', stderr: 'wrong host' };
      if (action === 'start') fleet.resume(host);
      if (action === 'stop') fleet.stop(host);
      if (action === 'status') {
        const vm = fleet.status(host);
        const state = vm.state === 'ready' || vm.state === 'warming' ? 'running' : vm.state === 'parked' ? 'stopped' : vm.state;
        return { status: 0, stderr: '', stdout: `aws1 aws elanous-aws1 i-test r8g.4xlarge ${state} $1/h\n` };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const adapter = createCommandCloudVmAdapter('/hq/op-tools/cloud-vm.sh', runner);

    await adapter.start('aws1');
    expect(await adapter.status('aws1')).toEqual({ host: 'aws1', state: 'running' });
    await adapter.stop('aws1');
    expect(await adapter.status('aws1')).toEqual({ host: 'aws1', state: 'stopped' });

    expect(calls.map(call => call.args.slice(0, 2))).toEqual([
      ['start', 'aws1'], ['status', 'aws1'], ['stop', 'aws1'], ['status', 'aws1'],
    ]);
    expect(calls.every(call => call.command === '/hq/op-tools/cloud-vm.sh')).toBe(true);
    expect(calls.every(call => call.args.includes('--source') && call.args.at(-1) === 'release.rehearsal')).toBe(true);
    expect(fleet.events().filter(event => event.type === 'resume' || event.type === 'stop')).toHaveLength(3);
    expect(fleet.events().some(event => event.type === 'forbidden-terminate')).toBe(false);
  });
});

test('cloud command failure is surfaced and cannot be mistaken for local execution', async () => {
  const adapter = createCommandCloudVmAdapter('/configured/cloud-vm', () => ({ status: 3, stdout: '', stderr: 'aws1 stop hold' }));
  await expect(adapter.stop('aws1')).rejects.toThrow('cloud-vm stop aws1 failed: aws1 stop hold');
});

test('cloud VM command carries the configured fleet burst reason and source', async () => {
  const calls: string[][] = [];
  const adapter = createCommandCloudVmAdapter('/configured/cloud-vm', (_command, args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  }, { reason: 'budgeted Pod federation capacity burst', source: 'fleet.cloudBurst' });
  await adapter.stop('aws1');
  expect(calls[0]).toContain('fleet.cloudBurst');
  expect(calls[0]).toContain('budgeted Pod federation capacity burst');
});
