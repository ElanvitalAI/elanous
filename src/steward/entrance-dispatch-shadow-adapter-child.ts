import { setElanousConfigDir } from '../elanous-config-dir.js';
import { runOrchestratorNode } from '../loops/orchestrator/tick.js';

async function main(): Promise<void> {
  const [root, configDir, runId, at, rawRecords, inventoryMode, failInventory] = process.argv.slice(2);
  if (!root || !configDir || !runId || !at || !rawRecords || !inventoryMode) throw new Error('missing graph shadow child arguments');
  const records = JSON.parse(rawRecords) as Array<{ command: string; elapsedSeconds: number; cwd: string; seat: 'OP' | 'MK' | 'TC' | 'UX' }>;
  setElanousConfigDir(configDir);
  const state = await runOrchestratorNode('launch', {
    root, runId, mode: 'shadow', window: '08', now: new Date(at),
    launchProcesses: () => {
      if (failInventory === 'true') throw new Error('mock launch inventory failure');
      return inventoryMode === 'incomplete' ? { status: 'incomplete' } : { status: 'ok', records };
    },
    coordinatorInbox: () => ({ replied: 0, acknowledged: 0 }),
    observe: () => {}, print: () => {},
  });
  process.stdout.write(JSON.stringify({ nodeStatus: state.nodes.launch ?? 'missing', launched: state.launched ?? [] }));
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
