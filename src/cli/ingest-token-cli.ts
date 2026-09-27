import type { Command } from 'commander';
import { issueIngestToken, listIngestTokens, revokeIngestToken } from '../nexus/api/ingest-token.js';

export function registerIngestTokenCommands(nexus: Command): void {
  const token = nexus.command('ingest-token').description('Manage POST /v1/tasks-only bearer tokens');
  token.command('issue <name>').description('Issue a token; print its secret exactly once')
    .action((name: string) => {
      try { process.stdout.write(`${issueIngestToken(name).token}\n`); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });
  token.command('revoke <name>').description('Revoke a token by name')
    .action((name: string) => {
      try { if (!revokeIngestToken(name)) throw new Error(`ingest token not found: ${name}`); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });
  token.command('list').description('List token names and issuance times (never secrets)')
    .action(() => {
      try { for (const row of listIngestTokens()) process.stdout.write(`${row.name}\t${row.createdAt}\n`); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
    });
}
