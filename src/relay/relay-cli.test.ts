import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerRelayCommand } from './relay-cli.js';

const roots: string[] = [];
function command(databasePath: string, output: string[], errors: string[], exits: number[]): Command {
  const program = new Command();
  program.exitOverride();
  registerRelayCommand(program, { appKillSwitchDatabasePath: databasePath,
    write: (text) => output.push(text), error: (text) => errors.push(text), setExitCode: (code) => exits.push(code) });
  return program;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('relay app kill-switch CLI', () => {
  test('down, status, audit, and operator up use the persistent tenant-scoped switch', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-kill-switch-cli-')));
    roots.push(root);
    const databasePath = join(root, 'relay', 'kill-switch.sqlite');
    const output: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    const program = command(databasePath, output, errors, exits);

    await program.parseAsync(['relay', 'app-kill-switch', 'down', '--user-id', 'tenant-a', '--app-id', 'shop',
      '--incident', 'cost-spike', '--reason', 'cost guard tripped', '--requested-by', 'cost-guard'], { from: 'user' });
    await program.parseAsync(['relay', 'app-kill-switch', 'status', '--user-id', 'tenant-a', '--app-id', 'shop'], { from: 'user' });
    await program.parseAsync(['relay', 'app-kill-switch', 'audit', '--user-id', 'tenant-a', '--app-id', 'shop'], { from: 'user' });
    await program.parseAsync(['relay', 'app-kill-switch', 'up', '--user-id', 'tenant-a', '--app-id', 'shop',
    ], { from: 'user' });
    await program.parseAsync(['relay', 'app-kill-switch', 'audit', '--user-id', 'tenant-a', '--app-id', 'shop'], { from: 'user' });
    await program.parseAsync(['relay', 'app-kill-switch', 'status', '--user-id', 'tenant-a', '--app-id', 'shop'], { from: 'user' });

    expect(output[0]).toContain('state recorded: down · user=tenant-a · app=shop · incident=cost-spike');
    expect(output[0]).toContain('relay-server enforcement hook pending');
    expect(output[1]).toContain('recorded state: down · user=tenant-a · app=shop');
    expect(output[2]).toContain('"reason":"cost guard tripped"');
    expect(output[2]).toContain('"requestedBy":"cost-guard"');
    expect(output[3]).toContain('state reactivated · user=tenant-a · app=shop');
    expect(output[3]).toContain('relay-server enforcement hook pending');
    expect(output[4]).toContain(`"actorId":"uid-${process.getuid?.()}"`);
    expect(output[5]).toContain('recorded state: up · user=tenant-a · app=shop');
    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
  });

  test('invalid incident is reported and exits unsuccessfully without writing state', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-kill-switch-cli-invalid-')));
    roots.push(root);
    const output: string[] = [];
    const errors: string[] = [];
    const exits: number[] = [];
    const program = command(join(root, 'kill-switch.sqlite'), output, errors, exits);

    await program.parseAsync(['relay', 'app-kill-switch', 'down', '--user-id', 'tenant-a', '--app-id', 'shop',
      '--incident', 'other', '--reason', 'invalid', '--requested-by', 'user-a'], { from: 'user' });

    expect(output).toEqual([]);
    expect(errors).toEqual(['relay app-kill-switch: invalid app kill switch incident\n']);
    expect(exits).toEqual([1]);
  });

  test('does not accept a caller-supplied operator identity', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'relay-kill-switch-cli-identity-')));
    roots.push(root);
    const program = command(join(root, 'kill-switch.sqlite'), [], [], []);
    let error: unknown;
    try {
      await program.parseAsync(['relay', 'app-kill-switch', 'up', '--user-id', 'tenant-a', '--app-id', 'shop', '--operator-id', 'forged'], { from: 'user' });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("unknown option '--operator-id'");
  });
});
