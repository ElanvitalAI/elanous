import { expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveUnit } from '../../src/graph-runner/runner.js';
import { observeDialogueNode } from './units/author-dialogue/observe.js';
import { runArrivalElaboration } from '../../src/self-implement/goal-elaborate.js';
import { runFirstRoundRefine } from '../../src/self-implement/goal-refine.js';

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
    expect(state.path).toEqual(['entry', 'author', 'author-dialogue', 'dispatch-pod', 'pr', 'harvest', 'land', 'reflect', 'green', 'remember', 'done']);
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
  expect(calls.map(node => node.node_id)).toEqual(['entry', 'author', 'author-dialogue', 'dispatch-pod', 'pr', 'harvest', 'land', 'reflect', 'green', 'remember']);
  for (const node of calls) {
    const edge = graph.edges.find(candidate => candidate.from === node.node_id);
    expect(edge).toBeDefined();
    expect(Object.keys(edge!.map)).toEqual(node.node_id === 'reflect'
      ? ['done', 'wait', 'needs-human']
      : node.node_id === 'author-dialogue' ? ['done', 'needs-human', 'failed'] : ['done', 'rework', 'needs-human', 'failed']);
    for (const target of Object.values(edge!.map)) expect(nodeIds.has(target)).toBe(true);
    if (node.node_id === 'reflect') {
      expect(edge!.map.wait).toBe('reflect');
      expect(node.max_visits).toBe(3);
      expect(edge!.map.failed).toBeUndefined();
    } else if (node.node_id === 'author-dialogue') {
      // The dialogue unit has no rework exit: findings loop back to author inside the unit (RFC §7 edge ④).
      expect(edge!.map.rework).toBeUndefined();
      expect(edge!.map.failed).toBe('failed');
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
      for (const id of ['entry', 'author', 'author-dialogue', 'dispatch-pod', 'pr', 'harvest', 'land', 'reflect', 'green', 'remember']) {
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

test('author-dialogue sits between author and dispatch-pod and declares the four dialogue edges', async () => {
  const graph = parseYaml(await Bun.file(graphPath).text()) as {
    nodes: Array<{ node_id: string; call?: string }>;
    edges: Array<{ from: string; map: Record<string, string> }>;
  };
  expect(graph.edges.find(edge => edge.from === 'author')!.map.done).toBe('author-dialogue');
  expect(graph.edges.find(edge => edge.from === 'author-dialogue')!.map.done).toBe('dispatch-pod');
  const caller = graph.nodes.find(node => node.node_id === 'author-dialogue')!;
  expect(caller.call).toBe('author-dialogue@1');
  const resolved = resolveUnit(caller.call!, graphPath);
  expect(resolved.path).toBe(join(import.meta.dir, 'units', 'author-dialogue', 'author-dialogue.yaml'));
  const unit = parseYaml(readFileSync(resolved.path, 'utf8')) as {
    unit: { exits: string[] };
    entry_node: string;
    nodes: Array<{ node_id: string; max_visits: number }>;
    edges: Array<{ from: string; map: Record<string, string> }>;
  };
  expect(unit.unit.exits).toEqual(['done', 'needs-human', 'failed']);
  expect(unit.entry_node).toBe('author');
  const map = (from: string) => unit.edges.find(edge => edge.from === from)!.map;
  expect(map('author').deliver).toBe('implement'); // ① vN · ③ vN+1
  expect(map('implement').ask).toBe('author'); // ② discovery / question
  expect(map('implement').done).toBe('judge'); // ④ into judge
  expect(map('judge').findings).toBe('author'); // ④ findings re-enter the dialogue
  expect(map('author')['needs-human']).toBe('needs-human'); // direction/KPI change goes to a human
  for (const id of ['author', 'implement', 'judge']) expect(unit.nodes.find(node => node.node_id === id)!.max_visits).toBe(5);
});

test('author-dialogue observer reads the real E1 events emitted by runArrivalElaboration', async () => {
  const goal = '바꿀 것: 카드를 붙인다.\n판정 신호: goal-elaborated 사건.\n경계: 저작기(goal-author.ts)는 바꾸지 않는다.';
  const card = (files: string[]) => JSON.stringify({ files, newFiles: files, requirements: ['r'],
    firstTest: { path: files[0], name: 't', redReason: 'missing' }, stage: 'unit', level: 'L2' });
  const run = async (responses: string[] | undefined) => {
    const observations: Record<string, { data: Record<string, unknown> }> = {};
    await runArrivalElaboration({
      goal, prompt: 'ROUND0', fileExists: () => false,
      ...(responses ? { callLLM: async () => { const next = responses.shift(); if (next === undefined) throw new Error('exhausted'); return next; } } : {}),
      observe: (event, data) => { observations[event] = { data }; },
    });
    return observeDialogueNode('author', { observations });
  };
  // (1) E1 inside the fixed layer -> deliver the card to implement.
  expect((await run([card(['src/a.ts']), '{"consistent":true,"violations":[]}'])).outcome).toBe('deliver');
  // Outside the fixed layer twice -> needs-human.
  expect((await run([card(['src/goal-author.ts']), card(['src/goal-author.ts'])])).outcome).toBe('needs-human');
  // No provider -> skipped -> the dialogue lets today's implementation through.
  const skipped = await run(undefined);
  expect(skipped.outcome).toBe('deliver');
  expect(skipped.result.event).toBe('goal-elaboration-skipped');
  // No supplied event -> missing evidence, never inferred success.
  expect(observeDialogueNode('author', {}).result.reason).toBe('missing-observation:goal-elaborated');
  expect(observeDialogueNode('author', {}).outcome).toBe('needs-human');
});

test('author-dialogue declared-only nodes map supplied values and never infer success', () => {
  expect(observeDialogueNode('implement', { observations: { implement: { outcome: 'ask' } } }).outcome).toBe('ask');
  // Declared-only edges have no observation supplier yet: they pass through with the reason recorded.
  expect(observeDialogueNode('implement', {}).outcome).toBe('done');
  expect(observeDialogueNode('implement', {}).result).toMatchObject({ observed: false, reason: 'declared-only:pass-through' });
  expect(observeDialogueNode('judge', {}).outcome).toBe('done');
  expect(observeDialogueNode('judge', { observations: { judge: { outcome: 'findings' } } }).outcome).toBe('findings');
  expect(observeDialogueNode('judge', { observations: { judge: { outcome: 'weird' } } }).outcome).toBe('needs-human');
});

test('graph runner executes author-dialogue: E1 success reaches dispatch-pod with zero needs-human', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ta-journey-dialogue-run-'));
  const repoRoot = resolve(import.meta.dir, '../..');
  const graphDir = join(temp, 'graphs', 'journey');
  const unitsDir = join(graphDir, 'units');
  mkdirSync(unitsDir, { recursive: true });
  try {
    // Real E1 payload: the events runArrivalElaboration emits for a card inside the fixed layer.
    const observations: Record<string, { data: Record<string, unknown> }> = {};
    const card = JSON.stringify({ files: ['src/a.ts'], newFiles: ['src/a.ts'], requirements: ['r'],
      firstTest: { path: 'src/a.ts', name: 't', redReason: 'missing' }, stage: 'unit', level: 'L2' });
    const responses = [card, '{"consistent":true,"violations":[]}'];
    await runArrivalElaboration({
      goal: '바꿀 것: 카드를 붙인다.\n판정 신호: goal-elaborated 사건.', prompt: 'ROUND0', fileExists: () => false,
      callLLM: async () => responses.shift()!, observe: (event, data) => { observations[event] = { data }; },
    });
    expect(Object.keys(observations)).toEqual(['goal-elaborated']);

    // The real journey node and the real unit (recipes + observer) run; neighbours are one-line stubs.
    const journey = parseYaml(readFileSync(graphPath, 'utf8')) as {
      graph_id: string; version: number; launcher: string; terminal_nodes: string[];
      nodes: Array<Record<string, unknown> & { node_id: string }>;
      edges: Array<{ from: string; on: string; map: Record<string, string> }>;
    };
    const dialogueNode = journey.nodes.find(node => node.node_id === 'author-dialogue')!;
    const dialogueEdge = journey.edges.find(edge => edge.from === 'author-dialogue')!;
    expect(dialogueEdge.map.done).toBe('dispatch-pod');
    const stub = (id: string) => ({ node_id: id, kind: 'agent', recipe: `cmd:${id}`, max_visits: 1, contract: { inputs: ['ask', 'context'], tools: 'read-only', outputs: ['result', 'evidence'] } });
    const graph = {
      ...journey,
      entry_node: 'seed',
      nodes: [stub('seed'), dialogueNode, stub('dispatch-pod'), ...journey.nodes.filter(node => journey.terminal_nodes.includes(node.node_id))],
      edges: [
        { from: 'seed', on: 'outcome', map: { done: 'author-dialogue' } },
        dialogueEdge,
        { from: 'dispatch-pod', on: 'outcome', map: { done: 'done' } },
      ],
    };
    writeFileSync(join(graphDir, 'ta-journey.yaml'), stringifyYaml(graph));
    const done = (id: string) => `${id}:\n  command: "printf '{\\"outcome\\":\\"done\\",\\"result\\":{\\"stub\\":\\"${id}\\"},\\"evidence\\":{}}'"\n`;
    writeFileSync(join(graphDir, 'recipes.yaml'), done('seed') + done('dispatch-pod'));
    cpSync(join(repoRoot, 'graphs', 'journey', 'units', 'author-dialogue'), join(unitsDir, 'author-dialogue'), { recursive: true });

    const cli = spawnSync(Bun.which('bun')!, [
      join(repoRoot, 'bin/elanous.mjs'), `--test=${join(temp, 'config')}`,
      'graph', 'run', join(graphDir, 'ta-journey.yaml'), '--json',
      '--input', JSON.stringify({ ask: 'E1 dialogue run', context: { observations }, prior: {} }),
    ], { cwd: temp, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', HOME: temp }, timeout: 60_000 });
    const state = JSON.parse(cli.stdout || JSON.stringify({ stderr: cli.stderr })) as {
      status: string; path: string[];
      unitCalls?: Array<{ nodeId: string; exit?: string; path?: string[] }>;
      nodes: Array<{ nodeId: string; output?: string }>;
    };
    expect(cli.status, `${cli.stderr} ${cli.stdout}`).toBe(0);
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['seed', 'author-dialogue', 'dispatch-pod', 'done']);
    // No goal-refined / judge rounds: one pass, no refine back-edge (author → implement → judge → done).
    expect((state.unitCalls as unknown as Array<{ node: string; steps?: number }> | undefined)?.find(unitCall => unitCall.node === 'author-dialogue')?.steps).toBe(4);
    expect(state.path).not.toContain('needs-human');
    expect(JSON.stringify(state)).not.toContain('"outcome":"needs-human"');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('author-dialogue refine re-entry: judge findings -> author reads the real E3 goal-refined event', async () => {
  const goal = '대상 경로: src/a.ts\n바꿀 것: 카드를 붙인다.\n- 완료 경계 코드: 결과가 적절하다.\n판정 신호: goal-refined 사건.';
  const observations: Record<string, { data: Record<string, unknown> }> = {};
  await runFirstRoundRefine({
    goal, round: 1, visit: 1, evidence: { findings: '- 수용선이 모호하다' },
    callLLM: async () => JSON.stringify({ edits: [{ from: '- 완료 경계 코드: 결과가 적절하다.', to: '- 완료 경계 코드: a() 가 1 을 돌려준다.', reason: '모호' }] }),
    observe: (event, data) => { observations[event] = { data }; },
  });
  expect(Object.keys(observations)).toEqual(['goal-refined']);
  const findings = { judge: { outcome: 'findings', result: { round: 1 } } };
  const reentry = observeDialogueNode('author', { observations }, findings);
  expect(reentry).toMatchObject({ outcome: 'deliver', result: { event: 'goal-refined', observed: true, value: 'refined' } });
  // A kept event (v1 retained, e.g. no provider) is still a real E3 observation -> deliver v1, not needs-human.
  const kept: Record<string, { data: Record<string, unknown> }> = {};
  await runFirstRoundRefine({ goal, round: 1, visit: 1, evidence: {}, observe: (event, data) => { kept[event] = { data }; } });
  expect(kept['goal-refined']!.data).toMatchObject({ outcome: 'kept', kept: 'no-provider' });
  expect(observeDialogueNode('author', { observations: kept }, findings)).toMatchObject({ outcome: 'deliver', result: { event: 'goal-refined', observed: true, value: 'kept' } });
  // Re-entry without the E3 event is unresolved evidence, never inferred success.
  expect(observeDialogueNode('author', {}, findings)).toMatchObject({ outcome: 'needs-human', result: { reason: 'missing-observation:goal-refined' } });
  // judge reads one value per round.
  const rounds = { judge: { data: { rounds: ['findings', 'pass'] } } };
  expect(observeDialogueNode('judge', { observations: rounds })).toMatchObject({ outcome: 'findings', result: { round: 1 } });
  expect(observeDialogueNode('judge', { observations: rounds }, findings)).toMatchObject({ outcome: 'done', result: { round: 2 } });
});

test('graph runner executes the refine back-edge once: first-round findings -> author (goal-refined) -> implement -> judge pass -> dispatch-pod', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'ta-journey-refine-run-'));
  const repoRoot = resolve(import.meta.dir, '../..');
  const graphDir = join(temp, 'graphs', 'journey');
  const unitsDir = join(graphDir, 'units');
  mkdirSync(unitsDir, { recursive: true });
  try {
    const observations: Record<string, { data: Record<string, unknown> }> = {};
    const card = JSON.stringify({ files: ['src/a.ts'], newFiles: ['src/a.ts'], requirements: ['r'],
      firstTest: { path: 'src/a.ts', name: 't', redReason: 'missing' }, stage: 'unit', level: 'L2' });
    const responses = [card, '{"consistent":true,"violations":[]}'];
    const goal = '대상 경로: src/a.ts\n바꿀 것: 카드를 붙인다.\n- 완료 경계 코드: 결과가 적절하다.\n판정 신호: goal-refined 사건.';
    const observe = (event: string, data: Record<string, unknown>) => { observations[event] = { data }; };
    await runArrivalElaboration({ goal, prompt: 'ROUND0', fileExists: () => false, callLLM: async () => responses.shift()!, observe });
    await runFirstRoundRefine({ goal, round: 1, visit: 1, evidence: { findings: '- 수용선이 모호하다' }, observe,
      callLLM: async () => JSON.stringify({ edits: [{ from: '- 완료 경계 코드: 결과가 적절하다.', to: '- 완료 경계 코드: a() 가 1 을 돌려준다.', reason: '모호' }] }) });
    // First-round review reports findings, the second round passes.
    const context = { observations: { ...observations, judge: { data: { rounds: ['findings', 'pass'] } } } };
    expect(Object.keys(observations)).toEqual(['goal-elaborated', 'goal-refined']);

    const journey = parseYaml(readFileSync(graphPath, 'utf8')) as {
      terminal_nodes: string[];
      nodes: Array<Record<string, unknown> & { node_id: string }>;
      edges: Array<{ from: string; on: string; map: Record<string, string> }>;
    };
    const stub = (id: string) => ({ node_id: id, kind: 'agent', recipe: `cmd:${id}`, max_visits: 1, contract: { inputs: ['ask', 'context'], tools: 'read-only', outputs: ['result', 'evidence'] } });
    const graph = {
      ...journey,
      entry_node: 'seed',
      nodes: [stub('seed'), journey.nodes.find(node => node.node_id === 'author-dialogue')!, stub('dispatch-pod'), ...journey.nodes.filter(node => journey.terminal_nodes.includes(node.node_id))],
      edges: [
        { from: 'seed', on: 'outcome', map: { done: 'author-dialogue' } },
        journey.edges.find(edge => edge.from === 'author-dialogue')!,
        { from: 'dispatch-pod', on: 'outcome', map: { done: 'done' } },
      ],
    };
    writeFileSync(join(graphDir, 'ta-journey.yaml'), stringifyYaml(graph));
    const done = (id: string) => `${id}:\n  command: "printf '{\\"outcome\\":\\"done\\",\\"result\\":{\\"stub\\":\\"${id}\\"},\\"evidence\\":{}}'"\n`;
    writeFileSync(join(graphDir, 'recipes.yaml'), done('seed') + done('dispatch-pod'));
    cpSync(join(repoRoot, 'graphs', 'journey', 'units', 'author-dialogue'), join(unitsDir, 'author-dialogue'), { recursive: true });

    const cli = spawnSync(Bun.which('bun')!, [
      join(repoRoot, 'bin/elanous.mjs'), `--test=${join(temp, 'config')}`,
      'graph', 'run', join(graphDir, 'ta-journey.yaml'), '--json',
      '--input', JSON.stringify({ ask: 'E3 refine run', context, prior: {} }),
    ], { cwd: temp, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', HOME: temp }, timeout: 60_000 });
    const state = JSON.parse(cli.stdout || JSON.stringify({ stderr: cli.stderr })) as {
      status: string; path: string[]; unitCalls?: Array<{ node: string; exit?: string; steps?: number }>;
    };
    expect(cli.status, `${cli.stderr} ${cli.stdout}`).toBe(0);
    expect(state.status).toBe('done');
    expect(state.path).toEqual(['seed', 'author-dialogue', 'dispatch-pod', 'done']);
    // 7 steps = author → implement → judge(findings) → author(goal-refined) → implement → judge(pass) → done
    //   (the E1-only pass is 4: author → implement → judge → done).
    expect(state.unitCalls?.find(unitCall => unitCall.node === 'author-dialogue'), JSON.stringify(state.unitCalls)).toMatchObject({ exit: 'done', steps: 7 });
    expect(JSON.stringify(state)).not.toContain('"outcome":"needs-human"');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
