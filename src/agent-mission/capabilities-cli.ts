import type { Command } from 'commander';
import { buildCapabilityMatrix, pickBackend } from './capability-matrix.js';
import { createCapabilityReaders, type CapabilityRun } from './capability-readers.js';
import { normalizeServiceName, type CapabilityEntry } from './capability-types.js';
import { buildCapabilityIndex, type CapabilityIndexReaders } from '../smart-wizard/capability-index.js';

export interface CapabilitiesCliDeps {
  run?: CapabilityRun;
  write?: (text: string) => void;
  indexReaders?: CapabilityIndexReaders;
}

/** Register the read-only capability inventory under agent-mission (and its codex alias). */
export function registerCapabilitiesCommand(parent: Command, deps: CapabilitiesCliDeps = {}): Command {
  return parent.command('capabilities')
    .description('List codex, claude and grok service capabilities (read only)')
    .option('--service <name>', 'Show observations and selected backend for a service')
    .option('--json', 'Output JSON')
    .option('--index', 'Show provenance and authentication index (read only)')
    .action(async (opts: { service?: string; json?: boolean; index?: boolean }) => {
      if (opts.index) {
        const index = await buildCapabilityIndex(deps.indexReaders);
        const write = deps.write ?? (text => { process.stdout.write(text); });
        if (opts.json) write(JSON.stringify(index) + '\n');
        else {
          write('SOURCE\tSTATUS\n');
          for (const [source, status] of Object.entries(index.sources)) write(`${source}\t${status}\n`);
          write('SOURCE\tID\tKIND\tSTATE\tAUTH\tPROVENANCE\n');
          for (const entry of index.entries) write(`${entry.source}\t${entry.id}\t${entry.kind}\t${entry.state}\t${entry.auth}\t${entry.provenance}\n`);
        }
        return;
      }
      const readers = createCapabilityReaders(deps.run);
      const matrix = buildCapabilityMatrix(readers);
      const entries: CapabilityEntry[] = opts.service
        ? matrix.filter(entry => entry.service === '*' || normalizeServiceName(entry.service) === normalizeServiceName(opts.service!))
        : matrix;
      const selected = opts.service ? pickBackend(matrix, opts.service) : null;
      const write = deps.write ?? (text => { process.stdout.write(text); });
      if (opts.json) {
        write(JSON.stringify({ entries, selected }) + '\n');
      } else {
        write('BACKEND\tSERVICE\tSTATE\tDETAIL\n');
        for (const entry of entries) write(`${entry.backend}\t${entry.service}\t${entry.state}\t${entry.detail ?? ''}\n`);
        if (opts.service) write(`selected\t${selected ?? 'none'}\n`);
      }
    });
}
