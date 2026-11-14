import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialSlotWizardPlan, runCredentialSlotWizard } from './cred-slot-wizard.js';
import { registerSecretCommands } from '../../../cli/secret-cli.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../../../elanous-config-dir.js';
import { currentBackendId, getSecretAsync, useBackend } from './index.js';

test('wizard plans catalogued canonical slots, excluding optional market account fields', () => {
  expect(credentialSlotWizardPlan('toss')?.slots).toEqual(['cred:toss.client_id', 'cred:toss.client_secret']);
  expect(credentialSlotWizardPlan('kis')?.slots).toEqual(['cred:kis.app_key', 'cred:kis.app_secret']);
  expect(credentialSlotWizardPlan('firecrawl')?.slots).toEqual(['cred:firecrawl.api_key']);
  expect(credentialSlotWizardPlan('eodhd')?.slots).toEqual(['cred:eodhd.api_key']);
  expect(credentialSlotWizardPlan('twelvedata')?.slots).toEqual(['cred:twelvedata.api_key']);
  expect(credentialSlotWizardPlan('fds')?.slots).toEqual(['cred:fds.api_key']);
  expect(credentialSlotWizardPlan('krx')?.slots).toEqual(['cred:krx.api_key']);
  expect(credentialSlotWizardPlan('higgsfield')).toBeUndefined();
  expect(credentialSlotWizardPlan('openai-api')).toBeUndefined();
  expect(credentialSlotWizardPlan('unknown')).toBeUndefined();
});

test('wizard simulation prompts for every field and writes one batch, returning names only', async () => {
  const plan = credentialSlotWizardPlan('toss')!;
  const prompted: string[] = [];
  const writes: Array<Record<string, string>> = [];
  const values = ['simulated-private-id', 'simulated-private-secret'];
  const result = await runCredentialSlotWizard(plan, {
    prompt: async (name) => { prompted.push(name); return values.shift(); },
    saveBatch: async (batch) => { writes.push({ ...batch }); },
  });
  expect(prompted).toEqual([...plan.slots]);
  expect(writes).toEqual([{ 'cred:toss.client_id': 'simulated-private-id', 'cred:toss.client_secret': 'simulated-private-secret' }]);
  expect(result).toEqual({ service: 'toss', slots: plan.slots });
  expect(JSON.stringify(result)).not.toContain('simulated-private');
});

test('wizard cancellation or an invalid second field makes no partial write', async () => {
  const plan = credentialSlotWizardPlan('kis')!;
  for (const second of [undefined, '', 'bad\0value']) {
    let writes = 0;
    const values = ['simulated-private-key', second];
    await expect(runCredentialSlotWizard(plan, {
      prompt: async () => values.shift(), saveBatch: async () => { writes++; },
    })).rejects.toThrow('credential slot input cancelled or invalid');
    expect(writes).toBe(0);
  }
});

test('secret slot setup CLI prints names and success only; failures redact backend details', async () => {
  const output: string[] = []; const errors: string[] = []; const exits: number[] = [];
  const values = ['simulated-private-id', 'simulated-private-secret'];
  const writes: Array<Record<string, string>> = [];
  const program = new Command(); program.exitOverride();
  registerSecretCommands(program, {
    isInteractive: () => true, promptSecret: async () => values.shift(), initializeBackend: () => {},
    saveCredentialSlotBatch: async (batch) => { writes.push({ ...batch }); }, storageBackend: () => 'file',
    output: { log: (line) => output.push(line), error: (line) => errors.push(line) }, setExitCode: (code) => exits.push(code),
  });
  await program.parseAsync(['node', 'elanous', 'secret', 'slot', 'setup', 'toss']);
  expect(writes).toHaveLength(1);
  expect(exits.at(-1)).toBe(0);
  expect(output.join('\n')).toContain('cred:toss.client_id');
  expect(output.join('\n')).toContain('cred:toss.client_secret');
  expect([...output, ...errors].join('\n')).not.toContain('simulated-private');
  expect(errors).toEqual([]);

  const failed: string[] = []; const failedProgram = new Command(); failedProgram.exitOverride();
  registerSecretCommands(failedProgram, {
    isInteractive: () => true, promptSecret: async () => 'simulated-private', initializeBackend: () => {},
    saveCredentialSlotBatch: async () => { throw new Error('simulated-private backend detail'); },
    output: { log: () => {}, error: (line) => failed.push(line) }, setExitCode: () => {},
  });
  await failedProgram.parseAsync(['node', 'elanous', 'secret', 'slot', 'setup', 'eodhd']);
  expect(failed).toEqual(['credential slot setup failed']);
});

test('secret slot setup CLI stores a multi-field service through the typed file batch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cred-slot-wizard-'));
  const priorBackend = currentBackendId();
  const output: string[] = []; const errors: string[] = [];
  const values = ['simulated-private-app-key', 'simulated-private-app-secret'];
  try {
    setElanousConfigDir(root); useBackend('file');
    const program = new Command(); program.exitOverride();
    registerSecretCommands(program, {
      isInteractive: () => true, promptSecret: async () => values.shift(),
      initializeBackend: () => {}, output: { log: (line) => output.push(line), error: (line) => errors.push(line) },
      setExitCode: () => {},
    });
    await program.parseAsync(['node', 'elanous', 'secret', 'slot', 'setup', 'kis']);
    expect(await getSecretAsync('cred:kis.app_key')).toBe('simulated-private-app-key');
    expect(await getSecretAsync('cred:kis.app_secret')).toBe('simulated-private-app-secret');
    expect(output).toEqual(['saved cred:kis.app_key, cred:kis.app_secret · success']);
    expect(errors).toEqual([]);
    expect(output.join('\n')).not.toContain('simulated-private');
  } finally { useBackend(priorBackend); resetElanousConfigDir(); rmSync(root, { recursive: true, force: true }); }
});
