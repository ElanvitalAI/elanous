import type { Command } from 'commander';
import { inspectBundle } from './bundle.js';
import { installSimulationBundle, judgeSimulationBundle } from './bundle-simulation.js';
import { AGENT_ROOT_KEYS, loadDefinition } from './loader.js';
import { AGENT_API_VERSION } from '../loop-agent/v3/agent-yaml.js';

function load(path: string): unknown | undefined {
  const result = loadDefinition(path);
  for (const issue of result.errors) console.error(`${path}:${issue.line}: ${issue.message}`);
  if (result.errors.length) { process.exitCode = 1; return undefined; }
  return result.value;
}
function changes(a: unknown, b: unknown, prefix = ''): string[] {
  if (Object.is(a, b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap(key => changes(left[key], right[key], prefix ? `${prefix}.${key}` : key));
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  return [prefix || '<root>'];
}
export function registerDefinitionCommands(program: Command): void {
  const def = program.command('def').description('Inspect supported YAML definitions');
  def.command('schema <kind>').description('Show available definition schema information').action((kind: string) => {
    if (kind !== 'agent') {
      console.error(`schema unavailable for ${kind}; supported: agent (root keys only)`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ kind, apiVersion: AGENT_API_VERSION, scope: 'root keys only', keys: AGENT_ROOT_KEYS }, null, 2));
  });
  def.command('check-bundle <path>').description('Preflight supported bundle definitions (does not install or start)').action((path: string) => {
    const result = inspectBundle(path);
    for (const error of result.errors) console.error(error);
    if (result.errors.length) process.exitCode = 1;
    else console.log(JSON.stringify(result));
  });
  def.command('install <path>').option('--simulation', 'install into a newly-created temporary simulation universe only').description('Install a bundle (simulation only; production installation is unavailable)').action((path: string, options: { simulation?: boolean }) => {
    if (!options.simulation) { console.error('Production installation is unavailable; pass --simulation to use an isolated temporary universe.'); process.exitCode = 1; return; }
    try { console.log(JSON.stringify(installSimulationBundle(path))); }
    catch (error) { console.error(String(error)); process.exitCode = 1; }
  });
  def.command('simulate-bundle <path>').description('Install supported units into a new temporary simulation universe (no runtime)').action((path: string) => {
    try { console.log(JSON.stringify(installSimulationBundle(path))); }
    catch (error) { console.error(String(error)); process.exitCode = 1; }
  });
  def.command('simulate-judge <path>')
    .description('Install a bundle and run the judge with a deterministic simulated transport (not a bootstrap)')
    .requiredOption('--response <text>', 'synthetic transport response')
    .option('--prompt <text>', 'judge prompt', 'simulation')
    .action(async (path: string, options: { response: string; prompt: string }) => {
      try {
        const simulation = await judgeSimulationBundle(path, async () => ({ text: options.response }), { prompt: options.prompt });
        console.log(JSON.stringify({ ...simulation, transport: 'synthetic', runtime: 'judge-only' }));
        if (!simulation.result.ok) process.exitCode = 1;
      } catch (error) { console.error(String(error)); process.exitCode = 1; }
    });
  def.command('lint <path>').action((path: string) => { if (load(path) !== undefined) console.log(`${path}: OK`); });
  def.command('show <path>').action((path: string) => { const value = load(path); if (value !== undefined) console.log(JSON.stringify(value, null, 2)); });
  def.command('diff <a> <b>').action((a: string, b: string) => {
    const left = load(a), right = load(b);
    if (left !== undefined && right !== undefined) console.log(changes(left, right).join('\n'));
  });
}
