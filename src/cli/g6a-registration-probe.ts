import { Command } from 'commander';
import { registerLogsCommands } from './logs-cli.js';
import { registerDocsCommands } from './docs-cli.js';
import { registerFleetCommands } from './fleet-cli.js';

const root = new Command();
registerLogsCommands(root);
registerDocsCommands(root);
registerFleetCommands(root);
console.log(JSON.stringify(root.commands.map(command => ({
  name: command.name(),
  flags: command.options.map(option => option.flags),
  children: command.commands.map(child => ({
    name: child.name(), flags: child.options.map(option => option.flags),
  })),
}))));
