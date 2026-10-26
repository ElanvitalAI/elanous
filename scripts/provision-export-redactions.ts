#!/usr/bin/env bun
import { provisionExportRedactions } from '../src/task-agent/export-redactions-provision.js';

const host = process.argv[2];
if (!host || process.argv.length !== 3) {
  console.error('usage: bun scripts/provision-export-redactions.ts <train-host>');
  process.exit(2);
}
try {
  provisionExportRedactions(host);
  console.log(`EXPORT_REDACTIONS_PROVISIONED host=${host}`);
} catch (error) {
  console.error(`EXPORT_REDACTIONS_UNMEASURED host=${host}: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
