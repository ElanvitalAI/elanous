import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { getElanousConfigDirOverride } from '../elanous-config-dir.js';

export interface PaneDeps {
  readonly run?: (args: readonly string[]) => Promise<number>;
  readonly exit?: (code: number) => void;
  readonly configOverride?: () => string | undefined;
}

/** Keep els as the pane owner. Inherit state env and forward the in-process config override. */
function runEls(args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('els', [...args], { stdio: 'inherit', env: process.env });
    child.once('error', (error) => { process.stderr.write(`pane: els unavailable: ${error.message}\n`); resolve(1); });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

export function registerPaneCommands(program: Command, deps: PaneDeps = {}): void {
  const pane = program.command('pane').description('Pane compatibility entry via els');
  const forward = async (args: readonly string[]): Promise<void> => {
    const configDir = (deps.configOverride ?? getElanousConfigDirOverride)();
    const code = await (deps.run ?? runEls)([...(configDir === undefined ? [] : ['--config-dir', configDir]), 'pane', ...args]);
    (deps.exit ?? ((value) => { process.exitCode = value; }))(code);
  };
  pane.command('list').option('--workspace <id>', 'only this workspace').action((options: { workspace?: string }) =>
    forward(['list', ...(options.workspace === undefined ? [] : ['--workspace', options.workspace])]));
  pane.command('read <ref>').action((ref: string) => forward(['read', ref]));
  pane.command('send <ref> <text>').option('--enter', 'press Enter after sending').action((ref: string, text: string, options: { enter?: boolean }) =>
    forward([options.enter ? 'run' : 'send-text', ref, text]));
}
