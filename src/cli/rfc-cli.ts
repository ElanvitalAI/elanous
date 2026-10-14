import type { Command } from 'commander';
import { CliUserError } from './cli-user-error.js';
import { listRfcs, showRfc } from '../rfc-registry/registry.js';

/** RFC-REGISTRY first slice: list/show initialize an empty registry if needed, then only read rows. */
export function registerRfcCommands(program: Command): void {
  const rfc = program.command('rfc').description('RFC registry (list/show initialize the database when absent)');
  rfc.command('list').description('registered RFCs').option('--json', 'JSON rows')
    .action((opts: { json?: boolean }) => {
      const rows = listRfcs();
      if (opts.json) console.log(JSON.stringify(rows));
      else for (const row of rows) console.log(`${row.id} · ${row.status} · ${row.title}`);
    });
  rfc.command('show <id>').description('RFC and its items').option('--json', 'JSON record')
    .action((id: string, opts: { json?: boolean }) => {
      const row = showRfc(id);
      if (!row) throw new CliUserError(`없는 RFC: ${id}`);
      if (opts.json) console.log(JSON.stringify(row));
      else {
        console.log(`${row.id} · ${row.status} · ${row.title}`);
        for (const item of row.items) console.log(`  ${item.id} · ${item.status} · ${item.title}${item.links.length ? ` → ${item.links.map((link) => link.target_item_id).join(', ')}` : ''}`);
      }
    });
}
