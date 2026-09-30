import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

// Private local ledgers (decisions · directives) are absent from the public export;
// JS-only distributions still register them. Kept out of src/index.ts so the `self`
// block stays free of direct sink registration (see self-cli-sink-surface.test.ts).
export function registerPrivateLedgerCommands(program: Command): void {
  if (existsSync(resolve(import.meta.dir, 'decisions-cli.ts')) || existsSync(resolve(import.meta.dir, 'decisions-cli.js'))) {
    program.command('decisions').description('대표 결정 로컬 원장').allowUnknownOption().allowExcessArguments(true)
      .action(async (_opts: unknown, command: Command) => {
        try { await (await import('../domains/standalone-log-sink.js')).registerStandaloneLogSink('decisions'); }
        catch { /* Logging must not prevent recording a decision. */ }
        const privateDecisionsModule: string = './decisions-cli.js';
        const { registerDecisionsCommands } = await import(privateDecisionsModule) as { registerDecisionsCommands: (program: Command) => void };
        const privateProgram = new Command();
        registerDecisionsCommands(privateProgram);
        await privateProgram.parseAsync(['decisions', ...command.args], { from: 'user' });
      });
  }
  if (existsSync(resolve(import.meta.dir, 'directives-cli.ts')) || existsSync(resolve(import.meta.dir, 'directives-cli.js'))) {
    program.command('directives').description('대표 지시 로컬 색인·검색').allowUnknownOption().allowExcessArguments(true)
      .action(async (_opts: unknown, command: Command) => {
        const privateDirectivesModule: string = './directives-cli.js';
        const { registerDirectivesCommands } = await import(privateDirectivesModule) as { registerDirectivesCommands: (program: Command) => void };
        const privateProgram = new Command();
        registerDirectivesCommands(privateProgram);
        await privateProgram.parseAsync(['directives', ...command.args], { from: 'user' });
      });
  }
}
