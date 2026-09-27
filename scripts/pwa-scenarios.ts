#!/usr/bin/env bun
/**
 * 1. Start isolated daemon: bun bin/elanous.mjs nexus run --test --tool-cwd <empty-folder>
 * 2. Run: bun scripts/pwa-scenarios.ts --base-url http://127.0.0.1:31455 --shots ./shots
 * 3. Stop: bun bin/elanous.mjs nexus run --test --stop
 * Compare operational daemon PIDs before and after the run; they must remain identical.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createCdpPageDriver } from './lib/pwa-scenarios/cdp-driver.js';
import { runScenarios, summarize, type CellResult, type SaveShot } from './lib/pwa-scenarios/runner.js';
import { createScenarios, selectScenarios, validateBaseUrl } from './lib/pwa-scenarios/scenarios.js';

interface CliOptions {
  baseUrl: string;
  only?: string[];
  json: boolean;
  cdpPort?: number;
  shots?: string;
  headed: boolean;
  allowPort: boolean;
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { baseUrl: '', json: false, headed: false, allowPort: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--allow-port') options.allowPort = true;
    else if (['--base-url', '--only', '--cdp-port', '--shots'].includes(arg ?? '')) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--base-url') options.baseUrl = value;
      if (arg === '--only') options.only = value.split(',').map((id) => id.trim());
      if (arg === '--shots') options.shots = value;
      if (arg === '--cdp-port') {
        const port = Number(value);
        if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid CDP port: ${value}`);
        options.cdpPort = port;
      }
    } else throw new Error(`unknown option: ${arg}`);
  }
  if (!options.baseUrl) throw new Error('--base-url <http://127.0.0.1:PORT> is required');
  options.baseUrl = validateBaseUrl(options.baseUrl, options.allowPort);
  if (options.only?.some((id) => !id)) throw new Error('--only requires comma-separated scenario IDs');
  return options;
}

async function freeCdpPort(requested?: number): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(requested ?? 0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no free CDP port');
    return address.port;
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function formatCell(result: CellResult): string {
  return `${result.id} ${result.title} ${result.blocked ? `blocked: ${result.blocked}` : result.pass ? 'pass' : 'fail'} (${result.ms}ms)${result.chipMs === undefined ? '' : ` chipMs=${result.chipMs}ms`}${result.failure ? ` — ${result.failure}` : ''}`;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try { options = parseArgs(args); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
  const all = createScenarios();
  const { selected, unknown } = selectScenarios(all, options.only);
  if (unknown.length > 0) { console.error(`unknown scenario ID: ${unknown.join(',')}`); return 2; }
  let driver: Awaited<ReturnType<typeof createCdpPageDriver>> | undefined;
  try {
    const port = await freeCdpPort(options.cdpPort);
    driver = await createCdpPageDriver(port, options.headed, options.baseUrl);
    const saveShot: SaveShot | undefined = options.shots ? async (id, image) => {
      await mkdir(options.shots!, { recursive: true });
      const path = join(options.shots!, `${id}.png`);
      await writeFile(path, image);
      return path;
    } : undefined;
    const results = await runScenarios(driver, selected, options.baseUrl, saveShot);
    const summary = summarize(results, options.baseUrl);
    if (options.json) console.log(JSON.stringify({ results, summary }));
    else {
      for (const result of results) {
        console.log(formatCell(result));
        for (const line of result.evidence) console.log(`  ${line}`);
      }
      console.log(summary);
    }
    return results.some((r) => !r.pass && !r.blocked) ? 1 : 0;
  } catch (error) {
    console.error(`pwa-scenarios: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await driver?.close();
  }
}

if (import.meta.main) process.exitCode = await main();
