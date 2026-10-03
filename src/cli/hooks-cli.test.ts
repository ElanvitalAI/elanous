import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setElanousConfigDir, resetElanousConfigDir } from '../elanous-config-dir.js';
import { asanaEnabled, registerHooksCommands } from './hooks-cli.js';
import { HOOK_EXPOSURE_REF, hookExposurePlan, startPublicHookIngress } from '../hooks/expose.js';
import { startHookReceiver } from '../hooks/receiver.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';

test('hooks serve exposes defaults and status reports empty isolated queue', async () => {
  const program = new Command();
  registerHooksCommands(program);
  const hooks = program.commands.find(command => command.name() === 'hooks');
  expect(hooks?.commands.map(command => command.name())).toEqual(['serve', 'expose', 'status']);
  expect(hooks?.commands[1]?.commands.map(command => command.name())).toEqual(['plan', 'on', 'off', 'status']);
  expect(hooks?.commands[0]?.opts()).toEqual({ host: '127.0.0.1', port: '31480' });
  const root = mkdtempSync(join(tmpdir(), 'hooks-cli-'));
  const original = console.log;
  const output: string[] = [];
  try {
    setElanousConfigDir(root);
    console.log = (...args: unknown[]) => { output.push(args.join(' ')); };
    await program.parseAsync(['hooks', 'status'], { from: 'user' });
    expect(JSON.parse(output[0]!)).toEqual({ queued: 0, lastDelivered: null });
    await program.parseAsync(['hooks', 'expose', 'plan'], { from: 'user' });
    expect(JSON.parse(output[1]!)).toEqual(hookExposurePlan());
    await program.parseAsync(['hooks', 'expose', 'status'], { from: 'user' });
    expect(JSON.parse(output[2]!)).toBeNull();
    await expect(program.parseAsync(['hooks', 'expose', 'on'], { from: 'user' }))
      .rejects.toThrow('valid --decision');
    await expect(program.parseAsync(['hooks', 'expose', 'on', '--decision', 'D-20261003-99'], { from: 'user' }))
      .rejects.toThrow('decision not found or unreadable');
  } finally { console.log = original; resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});

test('hooks expose CLI on/off/status uses a fake executor and a scoped owner decision', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hooks-cli-expose-'));
  const calls: string[] = [];
  const output: string[] = [];
  const program = new Command();
  const original = console.log;
  const receiver = startHookReceiver({ port: 0, root, secrets: { linear: 'test-secret' }, forward: async () => 503 });
  const ingress = startPublicHookIngress(receiver.url, 0, root);
  try {
    registerHooksCommands(program, { stateDir: root, ingressPort: Number(new URL(ingress.url).port), now: () => new Date('2026-10-03T00:00:00Z'),
      execute: (binary, args) => { calls.push([binary, ...args].join(' ')); } });
    const ledger = new DecisionLedger({ stateDir: root, now: () => new Date('2026-10-03T00:00:00Z'),
      resolveVersion: () => ({ released: null, dev: null, codename: null }) });
    const entry = ledger.raise({ title: 'Expose hook?', category: 'security', scqa: { s: 'Receiver is local.', c: 'Owner must decide.' },
      options: [{ key: 'a', label: '켬', consequence: 'Public' }, { key: 'b', label: '끔', consequence: 'Private' }],
      recommendation: { skipped: true, reason: 'Owner decides' }, raisedBy: { agent: 'test' }, refs: [HOOK_EXPOSURE_REF] });
    ledger.decide(entry.id, 'a', { kind: 'human' });
    console.log = (...args: unknown[]) => { output.push(args.join(' ')); };
    await program.parseAsync(['hooks', 'expose', 'on', '--decision', entry.id], { from: 'user' });
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ path: '/hooks/linear', decisionId: entry.id });
    await program.parseAsync(['hooks', 'expose', 'status'], { from: 'user' });
    expect(JSON.parse(output.at(-1)!)).toEqual({ path: '/hooks/linear', decisionId: entry.id, openedAt: '2026-10-03T00:00:00.000Z' });
    await program.parseAsync(['hooks', 'expose', 'off'], { from: 'user' });
    expect(calls).toEqual([hookExposurePlan().on, hookExposurePlan().off]);
    await program.parseAsync(['hooks', 'expose', 'status'], { from: 'user' });
    expect(JSON.parse(output.at(-1)!)).toBeNull();
  } finally { ingress.stop(); receiver.stop(); console.log = original; rmSync(root, { recursive: true, force: true }); }
});

test('Asana handshake saving is armed only by tox.external.asana.enabled === true', () => {
  expect(asanaEnabled({ tox: { external: { asana: { enabled: true } } } })).toBe(true);
  expect(asanaEnabled({ tox: { external: { asana: { enabled: 'yes' } } } })).toBe(false);
  expect(asanaEnabled({})).toBe(false);
  expect(asanaEnabled(undefined)).toBe(false);
});
