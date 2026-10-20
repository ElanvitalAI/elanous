import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveUnit } from '../../src/graph-runner/runner.js';

const graphPath = join(import.meta.dir, 'ta-journey.yaml');
setDefaultTimeout(60_000);

function journeyUnitSource(repoRoot: string, id: string): string {
  if (id === 'harvest') return join(repoRoot, 'graphs', 'units', 'harvest');
  const local = join(repoRoot, 'graphs', 'journey', 'units', id);
  return existsSync(local) ? local : join(repoRoot, 'graphs', 'units', id);
}

test('TA journey dry-run traverses the entire declared success path without effects', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ta-journey-dry-'));
  try {
    const cli = spawnSync(Bun.which('bun')!, [
      join(resolve(import.meta.dir, '../..'), 'bin/elanous.mjs'),
      `--test=${join(temp, 'config')}`, 'graph', 'run', graphPath, '--dry-run', '--json',
    ], { cwd: temp, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', HOME: temp }, timeout: 30_000 });
    expect(cli.status, cli.stderr).toBe(0);
    const state = JSON.parse(cli.stdout) as { status: string; path: string[]; executed: number; dryRun: boolean };
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['entry', 'author', 'dispatch-pod', 'pr', 'harvest', 'land', 'reflect', 'green', 'remember', 'done']);
    expect(state.executed).toBe(0);
    expect(state.dryRun).toBe(true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('every journey unit exit routes forward, to needs-human, or to failed', async () => {
  const graph = parseYaml(await Bun.file(graphPath).text()) as {
    nodes: Array<{ node_id: string; call?: string; max_visits?: number }>;
    terminal_nodes: string[];
    edges: Array<{ from: string; map: Record<string, string> }>;
  };
  const nodeIds = new Set(graph.nodes.map(node => node.node_id));
  const calls = graph.nodes.filter(node => node.call);
  expect(graph.terminal_nodes).toEqual(['done', 'failed', 'needs-human', 'rework']);
  expect(calls.map(node => node.node_id)).toEqual(['entry', 'author', 'dispatch-pod', 'pr', 'harvest', 'land', 'reflect', 'green', 'remember']);
  for (const node of calls) {
    const edge = graph.edges.find(candidate => candidate.from === node.node_id);
    expect(edge).toBeDefined();
    expect(Object.keys(edge!.map)).toEqual(node.node_id === 'reflect'
      ? ['done', 'wait', 'needs-human'] : ['done', 'rework', 'needs-human', 'failed']);
    for (const target of Object.values(edge!.map)) expect(nodeIds.has(target)).toBe(true);
    if (node.node_id === 'reflect') {
      expect(edge!.map.wait).toBe('reflect');
      expect(node.max_visits).toBe(3);
      expect(edge!.map.failed).toBeUndefined();
    } else {
      expect(edge!.map.rework).toBe('rework');
      expect(edge!.map.failed).toBe('failed');
    }
    expect(edge!.map['needs-human']).toBe('needs-human');
  }
});

test('TA journey harvest resolves the shared verb-harvest unit instead of a journey-local stub', async () => {
  const graph = parseYaml(await Bun.file(graphPath).text()) as { nodes: Array<{ node_id: string; call?: string }> };
  const harvest = graph.nodes.find(node => node.node_id === 'harvest');
  expect(harvest?.call).toBe('verb-harvest@1');
  expect(resolveUnit(harvest!.call!, graphPath).path).toBe(join(resolve(import.meta.dir, '../units/harvest'), 'harvest.yaml'));
});

test('TA journey resolves the shared entry and dispatch-pod units with the implement-loop nodes', async () => {
  const graph = parseYaml(await Bun.file(graphPath).text()) as { nodes: Array<{ node_id: string; call?: string }> };
  const expected = [
    { id: 'entry', nodes: ['intake', 'queue', 'launch-gate'], recipes: ['harness-entrance', 'harness-queue', 'pre-launch-gate'] },
    { id: 'dispatch-pod', nodes: ['pool-admit', 'image-sync', 'credential-refresh'], recipes: ['pod-pool-admission', 'pod-pool-image-sync', 'pod-credential-prerefresh'] },
  ];
  for (const item of expected) {
    const caller = graph.nodes.find(node => node.node_id === item.id)!;
    expect(caller.call).toBe(`${item.id}@1`);
    const resolved = resolveUnit(caller.call!, graphPath);
    expect(resolved.path).toBe(join(resolve(import.meta.dir, '../units', item.id), `${item.id}.yaml`));
    expect(resolved.template.nodes.filter(node => node.nodeId !== 'done' && node.nodeId !== 'rework' && node.nodeId !== 'needs-human' && node.nodeId !== 'failed')
      .map(node => node.nodeId)).toEqual(item.nodes);
    expect(resolved.template.nodes.filter(node => item.nodes.includes(node.nodeId)).map(node => node.recipe.replace('cmd:', '')))
      .toEqual(item.recipes);
  }
});

test('entry and dispatch-pod original recipes execute only read-only commands and route unsafe observations to needs-human', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ta-journey-owned-units-'));
  const repoRoot = resolve(import.meta.dir, '../..');
  const pin = '0123456789ab';
  const commandLog = join(temp, 'calls.jsonl');
  const fixtureEln = join(temp, 'bin', 'eln');
  const currentLink = join(temp, 'current');
  const scenarios = [
    { id: 'entry', env: { FIXTURE_GATE: 'proceed' }, path: ['intake', 'queue', 'launch-gate', 'done'], expectedCalls: ['harness doors --json', 'harness queue list', 'harness budget --json'] },
    { id: 'entry', env: { FIXTURE_GATE: 'hold' }, path: ['intake', 'queue', 'launch-gate', 'needs-human'], expectedCalls: ['harness doors --json', 'harness queue list', 'harness budget --json'] },
    { id: 'dispatch-pod', env: { FIXTURE_BUDGET: '1' }, imagePin: pin, path: ['pool-admit', 'image-sync', 'credential-refresh', 'needs-human'], expectedCalls: ['harness queue backpressure --json', 'config get harness.imageCommit', 'provider codex status --json'] },
    { id: 'dispatch-pod', env: { FIXTURE_BUDGET: '0' }, imagePin: pin, path: ['pool-admit', 'needs-human'], expectedCalls: ['harness queue backpressure --json'] },
    { id: 'dispatch-pod', env: { FIXTURE_BUDGET: '1' }, imagePin: '012345678', path: ['pool-admit', 'image-sync', 'needs-human'], expectedCalls: ['harness queue backpressure --json', 'config get harness.imageCommit'] },
  ];
  const expectedCommands = new Set(['harness doors --json', 'harness queue list', 'harness budget --json',
    'harness queue backpressure --json', 'config get harness.imageCommit', 'provider codex status --json']);
  try {
    mkdirSync(join(temp, 'bin'), { recursive: true });
    mkdirSync(join(temp, 'versions'), { recursive: true });
    writeFileSync(fixtureEln, `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);const command=args.join(' ');fs.appendFileSync(process.env.FIXTURE_CALL_LOG,JSON.stringify({command})+'\\n');let out='';if(command==='harness doors --json')out=JSON.stringify({rows:[]});else if(command==='harness queue list')out='queue fixture\\n';else if(command==='harness budget --json')out=JSON.stringify({outcome:process.env.FIXTURE_GATE,launchBudget:1});else if(command==='harness queue backpressure --json')out=JSON.stringify({launchBudget:Number(process.env.FIXTURE_BUDGET),signals:{}});else if(command==='config get harness.imageCommit')out=process.env.FIXTURE_IMAGE_PIN+'\\n';else if(command==='provider codex status --json')out=JSON.stringify({current:{signalFresh:true,hasCredits:true}});else process.exit(64);process.stdout.write(out);\n`);
    chmodSync(fixtureEln, 0o755);
    symlinkSync(join('versions', `0.2.33-dev.0-${pin}`), currentLink);
    for (const [index, fixture] of scenarios.entries()) {
      writeFileSync(commandLog, '');
      const graphDir = join(temp, `${fixture.id}-${index}`);
      mkdirSync(graphDir, { recursive: true });
      const sourceDir = join(repoRoot, 'graphs', 'units', fixture.id);
      const graphPathCopy = join(graphDir, `${fixture.id}.yaml`);
      writeFileSync(graphPathCopy, readFileSync(join(sourceDir, `${fixture.id}.yaml`), 'utf8'));
      cpSync(join(sourceDir, 'recipes.yaml'), join(graphDir, 'recipes.yaml'));
      const cli = spawnSync(Bun.which('bun')!, [
        join(repoRoot, 'bin/elanous.mjs'), `--test=${join(temp, `config-${fixture.id}-${index}`)}`,
        'graph', 'run', graphPathCopy, '--input', JSON.stringify({ ask: 'fixture', context: {}, prior: {} }), '--json',
      ], { cwd: temp, encoding: 'utf8', env: { ...process.env, ...fixture.env, PATH: `${join(temp, 'bin')}:${process.env.PATH}`, FIXTURE_CALL_LOG: commandLog, FIXTURE_IMAGE_PIN: 'imagePin' in fixture ? fixture.imagePin : pin, NODE_ENV: 'test', HOME: temp }, timeout: 30_000 });
      expect(cli.status, `${fixture.id}: ${cli.stderr} ${cli.stdout}`).toBe(0);
      const state = JSON.parse(cli.stdout) as { status: string; path: string[]; executed: number; nodes: Array<{ nodeId: string; output?: string }> };
      expect(state.status, `${fixture.id}/${index}: path=${state.path} calls=${readFileSync(commandLog, 'utf8')}`).toBe('done');
      expect(state.path, `${fixture.id}/${index} expected=${fixture.path} actual=${state.path} calls=${readFileSync(commandLog, 'utf8')}`).toEqual(fixture.path);
      expect(state.executed).toBe(fixture.path.length - 1);
      for (const nodeId of fixture.path.slice(0, -1)) {
        const record = state.nodes.find(node => node.nodeId === nodeId)!;
        expect(record.output).toBeDefined();
        const output = JSON.parse(record.output!) as Record<string, unknown>;
        expect(output.result).toBeDefined();
        expect(output.evidence).toBeDefined();
      }
      const calls = readFileSync(commandLog, 'utf8').trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { command: string }).command);
      expect(calls).toEqual(fixture.expectedCalls);
      expect(calls.every(command => expectedCommands.has(command))).toBe(true);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('entry and dispatch-pod command recipe bodies parse without executing observations', async () => {
  for (const id of ['entry', 'dispatch-pod']) {
    const recipes = parseYaml(await Bun.file(join(resolve(import.meta.dir, '../units', id), 'recipes.yaml')).text()) as Record<string, { command: string }>;
    for (const [name, recipe] of Object.entries(recipes)) {
      const match = /^bun -e '([\s\S]*)'$/.exec(recipe.command);
      expect(match, `${id}/${name} uses the existing Bun command entry`).toBeDefined();
      expect(() => new Function(match![1]!)).not.toThrow();
    }
  }
});

test('journey branch scenarios preserve harvest done, rework, and needs-human outcomes in isolated test runs', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ta-journey-scenarios-'));
  const repoRoot = resolve(import.meta.dir, '../..');
  const fixtures = [
    { id: 'harvest', exit: 'done', suffix: ['harvest', 'done'] },
    { id: 'harvest', exit: 'rework', suffix: ['harvest', 'rework'], reason: 'rework' },
    { id: 'harvest', exit: 'needs-human', suffix: ['harvest', 'needs-human'], reason: 'needs-human' },
    { id: 'land', exit: 'needs-human', suffix: ['land', 'needs-human'], reason: 'needs-human' },
    { id: 'reflect', exit: 'needs-human', suffix: ['reflect', 'needs-human'], reason: 'needs-human' },
    { id: 'green', exit: 'rework', suffix: ['green', 'rework'], reason: 'rework' },
    { id: 'entry', exit: 'needs-human', suffix: ['entry', 'needs-human'], reason: 'needs-human' },
  ];
  try {
    for (const [index, fixture] of fixtures.entries()) {
      const graphDir = join(temp, `case-${index}`, 'graphs', 'journey');
      const unitsDir = join(graphDir, 'units');
      mkdirSync(unitsDir, { recursive: true });
      const graph = parseYaml(readFileSync(graphPath, 'utf8')) as {
        entry_node: string;
        nodes: Array<{ node_id: string }>;
        edges: Array<{ from: string; map: Record<string, string> }>;
      };
      if (fixture.id === 'harvest') {
        graph.entry_node = 'harvest';
        graph.nodes = graph.nodes.filter(node => ['harvest', 'done', 'failed', 'needs-human', 'rework'].includes(node.node_id));
        graph.edges = [{ from: 'harvest', on: 'outcome', map: { done: 'done', rework: 'rework', 'needs-human': 'needs-human', failed: 'failed' } }];
      }
      writeFileSync(join(graphDir, 'ta-journey.yaml'), stringifyYaml(graph));
      writeFileSync(join(graphDir, 'recipes.yaml'), '{}\n');
      for (const id of ['entry', 'author', 'dispatch-pod', 'pr', 'harvest', 'land', 'reflect', 'green', 'remember']) {
        cpSync(journeyUnitSource(repoRoot, id), join(unitsDir, id), { recursive: true });
      }
      if (fixture.id === 'harvest') {
        const recipePath = join(unitsDir, 'harvest', 'recipes.yaml');
        const recipes = parseYaml(readFileSync(recipePath, 'utf8')) as Record<string, { dry_run_command?: string }>;
        recipes['harvest-review']!.command = `printf '{"outcome":"${fixture.exit}","result":{"scenario":"${fixture.exit}"},"evidence":{"fixture":true}}'`;
        writeFileSync(recipePath, stringifyYaml(recipes));
      }
      if (fixture.id !== 'harvest') {
        const unitPath = join(unitsDir, fixture.id, `${fixture.id}.yaml`);
        const unit = parseYaml(readFileSync(unitPath, 'utf8')) as { unit: { exits: string[] } };
        unit.unit.exits = [fixture.exit, ...unit.unit.exits.filter(exit => exit !== fixture.exit)];
        writeFileSync(unitPath, stringifyYaml(unit));
      }

      const cli = spawnSync(Bun.which('bun')!, [
        join(repoRoot, 'bin/elanous.mjs'), `--test=${join(temp, `config-${index}`)}`,
        'graph', 'run', join(graphDir, 'ta-journey.yaml'), ...(fixture.id === 'harvest' ? ['--input', JSON.stringify({ ask: 'isolated harvest exit fixture', context: {}, prior: {} })] : ['--dry-run']), '--json',
      ], { cwd: temp, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', HOME: temp }, timeout: 30_000 });
      expect(cli.status, `${fixture.id}/${fixture.exit}: ${cli.stderr} ${cli.stdout}`).toBe(fixture.exit === 'done' ? 0 : 1);
      const state = JSON.parse(cli.stdout) as { status: string; reason?: string; path: string[]; executed: number };
      expect(state.status).toBe(fixture.exit === 'done' ? 'done' : 'failed');
      if (fixture.reason) expect(state.reason).toBe(fixture.reason);
      expect(state.path.slice(-fixture.suffix.length)).toEqual(fixture.suffix);
      expect(state.executed).toBe(fixture.id === 'harvest' ? 1 : 0);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('reflect wait re-enters with prior result attempts and reaches needs-human at the cap', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ta-journey-reflect-retry-'));
  const repoRoot = resolve(import.meta.dir, '../..');
  const graphDir = join(temp, 'graphs', 'journey');
  const unitsDir = join(graphDir, 'units');
  const tracePath = join(temp, 'reflect-attempts.jsonl');
  const fixtureScript = join(temp, 'journey-unit-fixture.ts');
  mkdirSync(unitsDir, { recursive: true });
  const graph = parseYaml(readFileSync(graphPath, 'utf8')) as {
    entry_node: string;
    nodes: Array<{ node_id: string; kind: string; recipe: string; max_visits: number; budget?: { inner_steps: number }; contract?: Record<string, unknown> }>;
    edges: Array<{ from: string; on: string; map: Record<string, string> }>;
  };
  graph.entry_node = 'seed';
  graph.nodes = graph.nodes.filter(node => ['reflect', 'done', 'failed', 'needs-human', 'rework'].includes(node.node_id));
  graph.nodes.unshift({ node_id: 'seed', kind: 'agent', recipe: 'cmd:seed', max_visits: 1, contract: { inputs: [ 'ask', 'context' ], tools: 'read-only', outputs: [ 'result', 'evidence' ] } });
  graph.nodes.find(node => node.node_id === 'reflect')!.budget = { inner_steps: 30 };
  graph.edges = graph.edges.filter(edge => edge.from === 'reflect');
  graph.edges.unshift({ from: 'seed', on: 'outcome', map: { done: 'reflect' } });
  graph.edges.find(edge => edge.from === 'reflect')!.map.done = 'needs-human';
  writeFileSync(join(graphDir, 'ta-journey.yaml'), stringifyYaml(graph));
  writeFileSync(join(graphDir, 'recipes.yaml'), `seed:\n  command: "printf '{\\\"outcome\\\":\\\"done\\\",\\\"result\\\":{\\\"attempts\\\":0},\\\"evidence\\\":{}}'"\n`);
  writeFileSync(fixtureScript, `
import { appendFileSync, readFileSync } from 'node:fs';
const context = JSON.parse(readFileSync(process.env.ELANOUS_GRAPH_CONTEXT!, 'utf8'));
const [unit, trace] = process.argv.slice(2);
if (unit === 'reflect') {
  const attempts = Number(context.input.prior?.attempts ?? 0) + 1;
  appendFileSync(trace, JSON.stringify({ attempts, prior: context.input.prior ?? null }) + '\\n');
  const outcome = attempts < 3 ? 'wait' : 'needs-human';
  console.log(JSON.stringify({ outcome, result: { attempts }, evidence: { attempts } }));
} else {
  console.log(JSON.stringify({ outcome: 'done', result: { unit }, evidence: {} }));
}
`);
  try {
    const unitDir = join(unitsDir, 'reflect');
    cpSync(journeyUnitSource(repoRoot, 'reflect'), unitDir, { recursive: true });
    const reflectUnit = parseYaml(readFileSync(join(unitDir, 'reflect.yaml'), 'utf8')) as {
      entry_node: string;
      nodes: Array<{ node_id: string; recipe: string }>;
    };
    const commandRecipe = reflectUnit.nodes.find(node => node.node_id === reflectUnit.entry_node)!.recipe.replace(/^cmd:/, '');
    writeFileSync(join(unitDir, 'recipes.yaml'), `${commandRecipe}:\n  command: bun ${fixtureScript} reflect ${tracePath}\n`);

    const cli = spawnSync(Bun.which('bun')!, [
      join(repoRoot, 'bin/elanous.mjs'), `--test=${join(temp, 'config')}`,
      'graph', 'run', join(graphDir, 'ta-journey.yaml'), '--json', '--input', JSON.stringify({ ask: 'fixture request', context: {} }),
    ], { cwd: temp, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', HOME: temp }, timeout: 30_000 });
    expect(cli.status, cli.stderr).toBe(1);
    const state = JSON.parse(cli.stdout || JSON.stringify({ stderr: cli.stderr })) as { status: string; reason?: string; path: string[]; nodes: Array<{ nodeId: string; output?: string }> };
    expect(state.status, cli.stderr + JSON.stringify(state)).toBe('failed');
    expect(state.reason, cli.stdout).toBe('needs-human');
    expect(state.path.slice(-4)).toEqual(['reflect', 'reflect', 'reflect', 'needs-human']);
    const attempts = readFileSync(tracePath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { attempts: number; prior: { attempts?: number } | null });
    expect(attempts.map(call => call.attempts)).toEqual([1, 2, 3]);
    expect(attempts.map(call => call.prior?.attempts ?? null)).toEqual([0, 1, 2]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
