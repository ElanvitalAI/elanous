import { setTestStateRoot } from '../src/nexus/paths.js';
import { executeWorldScenario, loadWorld } from '../src/ux-sim/world.js';

const root = process.env.ELANOUS_SIM_WORLD_STATE_ROOT;
const worldId = process.env.ELANOUS_SIM_WORLD_ID;
const scenarioFile = process.env.ELANOUS_SIM_WORLD_SCENARIO;
if (process.env.ELANOUS_SIM_WORLD_OS_SANDBOXED !== '1' || !root || !worldId || !scenarioFile) {
  console.error('sim-world-runner requires state root, world id, and scenario path');
  process.exit(2);
}

setTestStateRoot(root);
try {
  if (process.env.ELANOUS_SIM_WORLD_NETWORK_PROBE === '1') {
    try {
      await fetch('https://example.com');
      console.log(JSON.stringify({ networkBlocked: false }));
      process.exitCode = 1;
    } catch {
      console.log(JSON.stringify({ networkBlocked: true }));
    }
  } else {
    const world = loadWorld(worldId);
    const result = await executeWorldScenario(world, scenarioFile);
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(`sim world run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
