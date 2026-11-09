import { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { registerReleaseCommands } from '../cli/release-cli.js';
import { debug } from '../debug/log.js';
import { prodInstanceRoot } from '../instance/resolve.js';
import { setElanousConfigDir } from '../elanous-config-dir.js';

const ledgerRoot = process.argv[2];
if (!ledgerRoot) throw new Error('seat guard child requires an isolated ledger root');
mkdirSync(ledgerRoot, { recursive: true });
process.env.ELANOUS_TRACK = 'POD-REUSE-2';
delete process.env.ELANOUS_STATE_DIR;
delete process.env.ELANOUS_CONFIG_DIR;
setElanousConfigDir(prodInstanceRoot());

const previousWrite = process.stdout.write;
const attempts = ['a8cdf30b', '28b034de', '443a89b8'];
type SeatGuardDebugEvent = { category: string; event: string; data: Record<string, unknown> };
const results: Array<{ incidentRunId: string; seat: string; exitCode: number | null;
  output: Record<string, unknown>; stderr: string; error: string | null; debugEvents: SeatGuardDebugEvent[] }> = [];
let graphStarts = 0;
let stdout = '';
const debugEvents: SeatGuardDebugEvent[] = [];
const previousDebugLog = debug.log;
debug.log = ((category: string, event: string, data?: Record<string, unknown>) => {
  debugEvents.push({ category, event, data: data ?? {} });
}) as typeof debug.log;
process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void) => {
  stdout += String(chunk);
  (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.();
  return true;
}) as typeof process.stdout.write;

try {
  for (const incidentRunId of attempts) {
    stdout = '';
    const eventStart = debugEvents.length;
    process.exitCode = 0;
    const cli = new Command();
    registerReleaseCommands(cli, { ledgerRoot, freezeRoot: ledgerRoot,
      graph: (async () => { graphStarts += 1; throw new Error(`incident ${incidentRunId} unexpectedly entered release graph`); }) as never });
    try { await cli.parseAsync(['release', 'run', '--version', '0.3.7', '--json'], { from: 'user' }); }
    catch { /* retain command refusal as evidence */ }
    let output: Record<string, unknown> = {};
    try { output = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>; }
    catch { /* malformed output remains visible as an empty result */ }
    results.push({ incidentRunId, seat: 'POD-REUSE-2', exitCode: process.exitCode ?? 0, output, stderr: '', error: null,
      debugEvents: debugEvents.slice(eventStart) });
  }
} finally {
  process.stdout.write = previousWrite;
  debug.log = previousDebugLog;
  process.exitCode = 0;
}

previousWrite.call(process.stdout, `${JSON.stringify({ graphStarts, results })}\n`);
