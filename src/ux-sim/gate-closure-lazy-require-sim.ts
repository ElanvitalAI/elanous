import { testsReachingChangedCliLazyRequireShadow, type ClosureTree } from '../../scripts/release-loop/gate-closure.js';
import { selectFormalReceiptRadiusFallback } from '../../scripts/release-loop/formal-receipt-radius.js';

const SPAWN_ELANOUS_FIXTURE = [
  "import { spawn } from 'node:child_process';",
  "const DEFAULT_BIN = '../../bin/elanous.mjs';",
  'export function spawnElanous(args: string[]) { return __SPAWN__(process.execPath, [DEFAULT_BIN, ...args]); }',
].join('\n').replace('__SPAWN__', 'spawn');

export interface GateClosureLazyRequireScenario {
  readonly id: string;
  readonly changedFile: string;
  readonly files: Readonly<Record<string, string>>;
  readonly preload?: readonly string[];
  readonly expectedCurrent: readonly string[];
  readonly expectedProposed: readonly string[] | null;
  readonly expectedSelected: readonly string[] | null;
  readonly expectedCliSpawnTests: readonly string[];
  readonly expectedMeasured: boolean;
  readonly expectedFullGate: boolean;
}

export interface GateClosureLazyRequireResult {
  readonly id: string;
  readonly currentFiles: readonly string[];
  readonly proposedFiles: readonly string[] | null;
  readonly selectedFiles: readonly string[] | null;
  readonly cliSpawnTests: readonly string[];
  readonly measured: boolean;
  readonly fullGate: boolean;
  readonly selectedReason: string | null;
}

const SCENARIOS: readonly GateClosureLazyRequireScenario[] = [
  {
    id: 'function-local-require-module-import-vs-cli-spawn',
    changedFile: 'src/sim-cli.ts',
    files: {
      'bin/elanous.mjs': "import '../src/index.ts';",
      'src/index.ts': "export function runCli() { return require('./sim-cli.ts'); }",
      'src/sim-cli.ts': 'export const simulation = true;',
      'test/module-import.test.ts': "import '../src/index.ts'; test('loads public module', () => true);",
      'test/cli-spawn.test.ts': "import { spawnElanous } from '../src/instance/spawn-elanous.ts'; test('runs CLI', () => spawnElanous(['--version']));",
      'src/instance/spawn-elanous.ts': SPAWN_ELANOUS_FIXTURE,
      'test/unrelated.test.ts': "test('unrelated', () => true);",
    },
    expectedCurrent: ['test/cli-spawn.test.ts', 'test/module-import.test.ts'],
    expectedProposed: ['test/cli-spawn.test.ts'],
    expectedSelected: ['test/cli-spawn.test.ts'],
    expectedCliSpawnTests: ['test/cli-spawn.test.ts'],
    expectedMeasured: true,
    expectedFullGate: false,
  },
  {
    id: 'opaque-lazy-target-keeps-conservative-module-import-radius',
    changedFile: 'src/sim-cli.ts',
    files: {
      'bin/elanous.mjs': "import '../src/index.ts';",
      'test/preload.ts': "import '../src/index.ts';",
      'src/index.ts': "const target = process.env.SIM_MODULE; export function runCli() { return require(target); }",
      'src/sim-cli.ts': 'export const simulation = true;',
      'test/module-import.test.ts': "import '../src/index.ts'; test('loads public module', () => true);",
      'test/cli-spawn.test.ts': "import { spawnElanous } from '../src/instance/spawn-elanous.ts'; test('runs CLI', () => spawnElanous(['--version']));",
      'src/instance/spawn-elanous.ts': SPAWN_ELANOUS_FIXTURE,
    },
    preload: ['test/preload.ts'],
    expectedCurrent: [],
    expectedProposed: null,
    expectedSelected: null,
    expectedCliSpawnTests: ['test/cli-spawn.test.ts'],
    expectedMeasured: false,
    expectedFullGate: true,
  },
];

/** Run the production shadow selector against isolated module graphs; never changes the live test selector. */
export function runGateClosureLazyRequireSimulation(): GateClosureLazyRequireResult[] {
  return SCENARIOS.map((scenario) => {
    const files = Object.keys(scenario.files).sort();
    const tree: ClosureTree = { files, preload: scenario.preload ?? [], read: (path) => scenario.files[path] };
    const testFiles = files.filter((file) => /\.test\.(?:tsx?|jsx?|mts|cts)$/.test(file));
    const comparison = testsReachingChangedCliLazyRequireShadow(tree, [scenario.changedFile], testFiles);
    const selected = selectFormalReceiptRadiusFallback({
      priorCommit: 'a'.repeat(40), tree, changed: [scenario.changedFile], tests: testFiles,
      priorFailures: [], priorErrors: [],
    });
    const measured = comparison.proposed.ok;
    const proposedFiles = measured ? comparison.proposed.tests : null;
    return {
      id: scenario.id,
      currentFiles: comparison.current.ok ? comparison.current.tests : [],
      proposedFiles,
      selectedFiles: selected.fallback?.files ?? null,
      cliSpawnTests: comparison.cliSpawnTests,
      measured,
      fullGate: selected.fallback === null,
      selectedReason: selected.reason,
    };
  });
}

export const GATE_CLOSURE_LAZY_REQUIRE_EXPECTED = SCENARIOS;
