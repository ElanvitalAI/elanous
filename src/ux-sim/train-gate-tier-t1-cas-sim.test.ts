import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trainGateCasLane, type GateFilePlanLike } from '../../scripts/release-loop/gate-train-cas-adapter.js';
import { GATE_ISOLATED_TIMEOUT_MS, parseOptions } from '../../scripts/release-loop/gate-node.js';

const SNAPSHOT = join(import.meta.dir, '..', '..', 'scripts', 'ux-sim', 'fixtures', 'train-gate-tier-1109');
const SNAPSHOT_SHA256 = {
  'gate-tier.py': '16fdf3514801b540b72eedfa122e374affe73205286c48bc5ce4a0067210263c',
  'train-batch-live.py': 'c8835cbc55040ef84bcf4af7b389780b2f77d5d8aabf51c1b4f192d3dda37874',
  'train-memory.py': '6a3705dcb3962c97bfd1c70e310e85d7bf810b5f8c0c399403d716b95b891064',
} as const;
const PYTHON = String.raw`
import importlib.util, json, sys
source, repo, base, head = sys.argv[1:]
spec = importlib.util.spec_from_file_location('train_batch_snapshot', source)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
row = module.Row('987', head, repo, '/fake/evidence.json')
tier, decisions = module.classify_batch_gate(repo, base, [row], {'987': ['src/feature.ts']})
command = module.build_remote_gate_command(base, head, '/fake/integration.bundle', '/fake/tree',
    '/fake/artifacts', '/fake/remeasure.py', 600, 4, '/usr/bin:/bin', '/fake/private-tmp', tier)
print(json.dumps({'tier': tier, 'decisions': decisions, 'command': command}))
`;

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

test('TRAIN-GATE-TIER T1 simulation: CAS judgeGate pre-stage runs before the pinned batch self gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'train-gate-tier-t1-cas-sim-'));
  const home = join(root, 'home');
  const tools = join(home, 'elanous-hq', 'seat-state', 'OP', 'tools');
  const repo = join(root, 'repo');
  mkdirSync(tools, { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  try {
    for (const [file, sha] of Object.entries(SNAPSHOT_SHA256)) {
      const bytes = readFileSync(join(SNAPSHOT, file));
      expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(sha);
      if (file !== 'train-batch-live.py') copyFileSync(join(SNAPSHOT, file), join(tools, file));
    }

    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const value = 1;\n');
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Train gate simulator');
    git(repo, 'config', 'user.email', 'train-gate-sim@example.invalid');
    git(repo, 'add', 'src/feature.ts');
    git(repo, 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const value = 2;\n');
    git(repo, 'add', 'src/feature.ts');
    git(repo, 'commit', '-qm', 'T1 candidate');
    const head = git(repo, 'rev-parse', 'HEAD');

    const result = spawnSync(process.env.PYTHON ?? 'python3', ['-c', PYTHON,
      join(SNAPSHOT, 'train-batch-live.py'), repo, base, head], {
      encoding: 'utf8', env: { ...process.env, HOME: home },
      timeout: GATE_ISOLATED_TIMEOUT_MS,
    });
    expect(result.status, result.stderr).toBe(0);
    const batch = JSON.parse(result.stdout.trim()) as { tier: string; decisions: Array<{ tier: string; rules: string[] }>; command: string };
    expect(batch.tier).toBe('T1');
    expect(batch.decisions[0]?.rules).toContain('default-radius-gate');
    expect(batch.command).toContain('ELANOUS_TRAIN_GATE=1');
    expect(batch.command).toContain('self gate --changed --base');
    expect(batch.command).toContain('s.gateTier="T1"');

    const key = (char: string) => char.repeat(64);
    const expectedFiles = ['src/a.test.ts', 'src/b.test.ts'];
    const plan: GateFilePlanLike<{ file: string }, { file: string; key: string; outcome: string }> = {
      reuse: [{ file: expectedFiles[1]!, key: key('a'), outcome: 'pass' }],
      measure: [{ file: expectedFiles[0]! }],
    };
    const lane = trainGateCasLane(plan, expectedFiles);
    expect(lane).toEqual({ action: 'run-uncovered', files: [expectedFiles[0]!],
      receiptKeys: [key('a')], knownNonPassingFiles: [] });
    if (lane.action !== 'run-uncovered') throw new Error('unexpected CAS fallback: ' + lane.reason);

    // The batch command remains the snapshot's self gate; judgeGate is the CAS pre-stage.
    // Run the focused production acceptance test behind a fake gate-node boundary. Its actual warm-Pod
    // requests prove a changed closure (src/a.test.ts) is measured after the preceding CAS receipt.
    const graphContext = { runId: 'train-t1-cas-sim', input: { version: '0.3.8', previousVersion: '0.3.7', gateExecutor: 'pod', gateImagePin: 'cut-commit', gatePodPool: 'pool-mshq@mshq:1' }, outputs: { 'version-release': { commit: head }, cutoff: { baseline: { sha: base } } } };
    const parsedGate = parseOptions(['--json'], { ELANOUS_GRAPH_CONTEXT: JSON.stringify(graphContext) });
    expect(parsedGate).toMatchObject({ commit: head, version: '0.3.8', baselineVersion: '0.3.7', baselineCommit: base, graphRunId: 'train-t1-cas-sim', imagePin: 'cut-commit', executor: 'pod' });
    const events: Array<{ stage: string; command: string; files?: string[] }> = [];
    const preStage = `ELANOUS_GRAPH_CONTEXT=${JSON.stringify(JSON.stringify(graphContext))} bun scripts/release-loop/gate-node.ts --json`;
    const tracePath = join(root, 'actual-judge-gate-trace.jsonl');
    const fakeRemoteBoundary = async (command: string) => {
      if (command.includes('gate-node.ts --json')) {
        const actualJudgeGate = spawnSync(process.execPath, [
          'test', 'scripts/release-loop/gate-node.test.ts',
          '--test-name-pattern', 'M4.5 judgeGate sends only uncovered closures through the production warm Pod replay path',
        ], {
          cwd: join(import.meta.dir, '..', '..'), encoding: 'utf8',
          env: { ...process.env, ELANOUS_TRAIN_CAS_SIM_TRACE: tracePath },
          timeout: GATE_ISOLATED_TIMEOUT_MS,
        });
        const judgeOutput = `${actualJudgeGate.stdout ?? ''}${actualJudgeGate.stderr ?? ''}`;
        expect(actualJudgeGate.status, judgeOutput).toBe(0);
        expect(judgeOutput).toContain('1 pass');
        const trace = JSON.parse(readFileSync(tracePath, 'utf8').trim()) as { warmRequests: string[][] };
        const uncoveredRequests = trace.warmRequests.slice(2);
        expect(uncoveredRequests).toEqual([lane.files]);
        const event = { stage: 'judgeGate-cas', command, files: uncoveredRequests.at(-1)! };
        events.push(event);
        return event;
      }
      if (command.includes('self gate --changed --base')) {
        const event = { stage: 'snapshot-batch-self-gate', command, files: events.at(-1)?.files ?? [] };
        events.push(event);
        return event;
      }
      throw new Error(`unexpected remote boundary command: ${command.slice(0, 120)}`);
    };
    // The only remote boundary is stubbed; both commands originate from the gate-node context and HQ snapshot builder.
    const casEvent = await fakeRemoteBoundary(preStage);
    const batchEvent = await fakeRemoteBoundary(batch.command);
    expect(events.map(({ stage }) => stage)).toEqual(['judgeGate-cas', 'snapshot-batch-self-gate']);
    expect(casEvent.command).toContain('scripts/release-loop/gate-node.ts --json');
    expect(batchEvent.command).toContain('self gate --changed --base');
    expect(batchEvent.files).toEqual(['src/a.test.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
