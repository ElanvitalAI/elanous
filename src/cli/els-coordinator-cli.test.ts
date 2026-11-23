import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerCoordinatorCommands, registerElsCommands } from './els-cli.js';

function setup() {
  const requests: unknown[] = [];
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => {} });
  const workspace = program.command('workspace').alias('ws');
  registerCoordinatorCommands(workspace, async request => { requests.push(request); });
  return { program, requests };
}

test('coordinator assigns a workspace name or id, including the literal name none', async () => {
  for (const ref of ['HQ', 'ws-42', 'none']) {
    const { program, requests } = setup();
    await program.parseAsync(['ws', 'coordinator', ref], { from: 'user' });
    expect(requests).toEqual([{ op: 'coordinator', ws: ref }]);
  }
});

test('coordinator accepts an explicit seat without changing the legacy request', async () => {
  const { program, requests } = setup();
  await program.parseAsync(['ws', 'coordinator', 'HQ', 'LEAD'], { from: 'user' });
  expect(requests).toEqual([{ op: 'coordinator', ws: 'HQ', seat: 'LEAD' }]);
});

test('missing or extra arguments do not send a mutation', async () => {
  for (const args of [['ws', 'coordinator'], ['ws', 'coordinator', 'HQ', 'seat', 'extra'], ['ws', 'coordinator-unset']]) {
    const { program, requests } = setup();
    await expect(program.parseAsync(args, { from: 'user' })).rejects.toThrow();
    expect(requests).toEqual([]);
  }
});

test('the real command tree exposes workspace and ws with assignment only', () => {
  const program = new Command();
  registerElsCommands(program);
  const workspace = program.commands.find(c => c.name() === 'side')!.commands.find(c => c.name() === 'workspace')!;
  expect(workspace.aliases()).toContain('ws');
  expect(workspace.helpInformation()).toContain('coordinator <workspace>');
  expect(workspace.helpInformation()).not.toContain('coordinator-unset');
});
