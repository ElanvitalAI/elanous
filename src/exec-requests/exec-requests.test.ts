import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { installedGraphs, planExecRequest, seatTitles, type InstalledGraph } from './planner.js';
import { ExecRequestStore } from './store.js';
import { ExecRequestRunner } from './runner.js';
import type { GraphRunState } from '../graph-runner/runner.js';
import { defaultGraphsDir } from '../self-implement/graph-templates.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const wait = async (condition: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await Bun.sleep(5); }
  throw new Error('background graph run did not finish');
};

test('COO only accepts registered seats and installed graphs; missing graph is explicitly failed', async () => {
  const seats = seatTitles();
  expect(seats).toContain('CMO');
  const graphs: InstalledGraph[] = [{ id: 'report', title: 'Report', description: 'Writes a report', path: '/graphs/report.yaml' }];
  const plan = await planExecRequest('한 줄', { seats: () => seats, graphs: async () => graphs, judge: async () => [
    { seat: 'CMO', title: '조사', graphId: 'report', inputs: { subject: '한 줄' } },
    { seat: 'CTO', title: 'PDF', graphId: 'not-installed', inputs: {} },
  ] });
  expect(plan).toHaveLength(2);
  expect(plan[1]!.reason).toContain('설치된 실행 그래프가 없습니다');
  await expect(planExecRequest('x', { seats: () => seats, graphs: async () => graphs,
    judge: async () => [{ seat: 'imagined seat', title: 'x', graphId: 'report', inputs: {} }] })).rejects.toThrow('형식 오류');
});

test('installed graph catalog only exposes runnable YAML with its declared title and description', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-catalog-')));
  roots.push(root);
  const mine = join(root, 'mine');
  mkdirSync(mine);
  const { copyFileSync } = await import('node:fs');
  copyFileSync(join(defaultGraphsDir(), 'plan-loop.yaml'), join(mine, 'sample-exec.yaml'));
  writeFileSync(join(mine, 'sample-exec.yaml'), readFileSync(join(mine, 'sample-exec.yaml'), 'utf8').replace('graph_id: plan-loop', 'graph_id: sample-exec'));
  writeFileSync(join(mine, 'sample-exec.yaml'), readFileSync(join(mine, 'sample-exec.yaml'), 'utf8').replace('graph_id: sample-exec', 'loop:\n  title: Exec sample\n  description: Verified graph\ngraph_id: sample-exec'));
  writeFileSync(join(mine, 'recipes.yaml'), '{}');
  const graphs = await installedGraphs(defaultGraphsDir(), mine);
  expect(graphs.find(graph => graph.id === 'sample-exec')).toEqual({ id: 'sample-exec', title: 'Exec sample', description: 'Verified graph', path: join(mine, 'sample-exec.yaml') });
  expect(graphs.some(graph => graph.id === 'plan-loop')).toBe(false);
});

test('persistent request changes waiting → running → done from real run states and serves only run-owned artifacts', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-requests-')));
  roots.push(root);
  const store = new ExecRequestStore(root);
  const graphs = [
    { id: 'report', title: 'report', description: 'report', path: join(root, 'report.yaml') },
    { id: 'film', title: 'film', description: 'film', path: join(root, 'film.yaml') },
  ];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const run = async (path: string, opts: { runId?: string; deps?: { root?: string } }): Promise<GraphRunState> => {
    const graphId = path.endsWith('report.yaml') ? 'report' : 'film';
    const dir = join(opts.deps!.root!, 'graph-runs', graphId);
    mkdirSync(dir, { recursive: true });
    const name = graphId === 'report' ? 'report.pdf' : 'film.mp4';
    const file = join(dir, `${opts.runId}.json.${name}`);
    const statePath = join(dir, `${opts.runId}.json`);
    const state: GraphRunState = { graphId, runId: opts.runId!, status: 'running', path: [], nodes: [], executed: 0, dryRun: false, statePath };
    writeFileSync(statePath, JSON.stringify(state));
    await barrier;
    writeFileSync(file, graphId);
    state.status = 'done';
    state.nodes = [{ nodeId: 'make', ok: true, exit: 0, executed: true, output: JSON.stringify({ file, title: graphId, summary: '실제 그래프 산출' }) }];
    writeFileSync(statePath, JSON.stringify(state));
    return state;
  };
  const transitions: string[][] = [];
  const originalSave = store.save.bind(store);
  store.save = item => { transitions.push(item.seats.map(seat => seat.status)); originalSave(item); };
  const runner = new ExecRequestRunner({ store, root, graphs: async () => graphs, plan: async () => [
    { seat: 'CMO', title: '보고서', graphId: 'report', inputs: {} },
    { seat: 'CTO', title: '영상', graphId: 'film', inputs: {} },
  ], run: run as typeof import('../graph-runner/runner.js').runGraph });
  const submitted = runner.submit('한 줄');
  expect(submitted.status).toBe('planning');
  await wait(() => store.get(submitted.id)?.seats.every(seat => seat.status === 'running') === true && store.get(submitted.id)!.seats.length === 2);
  expect(store.get(submitted.id)!.seats.map(seat => seat.status)).toEqual(['running', 'running']);
  expect(statSync(join(store.dir, `${submitted.id}.json`)).mode & 0o777).toBe(0o600);
  expect(new ExecRequestStore(root).list().map(item => item.id)).toContain(submitted.id);
  release();
  await wait(() => runner.get(submitted.id)?.status === 'done');
  const done = runner.get(submitted.id)!;
  expect(done.seats.map(seat => seat.status)).toEqual(['done', 'done']);
  expect(transitions).toContainEqual(['waiting', 'waiting']);
  expect(transitions).toContainEqual(['running', 'running']);
  expect(transitions).toContainEqual(['done', 'done']);
  expect(done.results.map(result => result.kind)).toEqual(['pdf', 'video']);
  const reportName = decodeURIComponent(done.results[0]!.url.split('/').at(-1)!);
  expect(runner.file(done.id, reportName)).toBe(join(root, 'graph-runs', 'report', `${done.seats[0]!.runId}.json.report.pdf`));
  const unrelated = join(root, 'graph-runs', 'report', 'unrelated.pdf');
  writeFileSync(unrelated, 'not this run');
  expect(runner.file(done.id, `${done.seats[0]!.runId}--unrelated.pdf`)).toBeNull();
  expect(runner.file(done.id, '../report.pdf')).toBeNull();
  expect(runner.file(done.id, `${done.seats[0]!.runId}--..\\report.pdf`)).toBeNull();
  expect(runner.file(done.id, 'other.pdf')).toBeNull();
  const forged = join(root, 'graph-runs', 'report', `${done.seats[0]!.runId}.json.forged.pdf`);
  writeFileSync(forged, 'not emitted');
  const row = store.get(done.id)!;
  const forgedName = `${done.seats[0]!.runId}--${createHash('sha256').update(forged).digest('hex')}--${done.seats[0]!.runId}.json.forged.pdf`;
  row.results.push({ seat: 'CMO', kind: 'pdf', title: 'forged', url: `/v1/exec-requests/${done.id}/files/${encodeURIComponent(forgedName)}` });
  store.save(row);
  expect(runner.file(done.id, forgedName)).toBeNull();
  expect(readFileSync(join(store.dir, `${done.id}.json`), 'utf8')).toContain('실제 그래프 산출');
});

test('same-named run artifacts in distinct directories stay distinct and validated; graph links are returned', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-duplicates-')));
  roots.push(root);
  const store = new ExecRequestStore(root);
  const runner = new ExecRequestRunner({ store, root,
    graphs: async () => [{ id: 'report', title: 'report', description: '', path: join(root, 'report.yaml') }],
    plan: async () => [{ seat: 'CMO', title: '보고', graphId: 'report', inputs: {} }],
    run: (async (_path: string, opts: { runId: string }) => {
      const dir = join(root, 'graph-runs', 'report');
      const artifactDir = join(dir, `${opts.runId}.json.artifacts`);
      mkdirSync(join(artifactDir, 'a'), { recursive: true });
      mkdirSync(join(artifactDir, 'b'), { recursive: true });
      const first = join(artifactDir, 'a', 'report.pdf');
      const second = join(artifactDir, 'b', 'report.pdf');
      writeFileSync(first, 'first pdf');
      writeFileSync(second, 'second pdf');
      const statePath = join(dir, `${opts.runId}.json`);
      const state: GraphRunState = { graphId: 'report', runId: opts.runId, status: 'done', statePath,
        path: ['make'], executed: 1, dryRun: false,
        nodes: [{ nodeId: 'make', ok: true, exit: 0, executed: true, output: JSON.stringify({ artifacts: [
          { file: first, title: '첫째' }, { file: second, title: '둘째' },
          { url: 'https://example.org/reports/real', title: '원본 링크' },
          { url: 'file:///etc/passwd', title: '금지된 링크' },
        ] }) }] };
      writeFileSync(statePath, JSON.stringify(state));
      return state;
    }) as typeof import('../graph-runner/runner.js').runGraph,
  });
  const item = runner.submit('보고');
  await wait(() => store.get(item.id)?.status === 'done');
  const results = runner.get(item.id)!.results;
  expect(results.map(result => result.kind)).toEqual(['pdf', 'pdf', 'link']);
  expect(results[2]).toMatchObject({ kind: 'link', title: '원본 링크', url: 'https://example.org/reports/real' });
  expect(results[0]!.url).not.toBe(results[1]!.url);
  const names = results.slice(0, 2).map(result => decodeURIComponent(result.url.split('/').at(-1)!));
  expect(names.map(name => readFileSync(runner.file(item.id, name)!, 'utf8'))).toEqual(['first pdf', 'second pdf']);
  expect(new ExecRequestRunner({ store: new ExecRequestStore(root), root }).get(item.id)?.results).toHaveLength(3);
  expect(runner.file(item.id, names[0]!.replace('report.pdf', 'other.pdf'))).toBeNull();
});

test('a symlinked run artifact directory cannot publish files outside the graph run', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-artifact-link-')));
  roots.push(root);
  const store = new ExecRequestStore(root);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const secret = join(outside, 'secret.pdf');
  writeFileSync(secret, 'outside');
  const runner = new ExecRequestRunner({ store, root,
    graphs: async () => [{ id: 'report', title: 'report', description: '', path: join(root, 'report.yaml') }],
    plan: async () => [{ seat: 'CMO', title: '보고', graphId: 'report', inputs: {} }],
    run: (async (_path: string, opts: { runId: string }) => {
      const dir = join(root, 'graph-runs', 'report');
      mkdirSync(dir, { recursive: true });
      const artifactDir = join(dir, `${opts.runId}.json.artifacts`);
      symlinkSync(outside, artifactDir, 'dir');
      const statePath = join(dir, `${opts.runId}.json`);
      const state: GraphRunState = { graphId: 'report', runId: opts.runId, status: 'done', statePath,
        path: ['make'], executed: 1, dryRun: false,
        nodes: [{ nodeId: 'make', ok: true, exit: 0, executed: true,
          output: JSON.stringify({ file: join(artifactDir, 'secret.pdf') }) }] };
      writeFileSync(statePath, JSON.stringify(state));
      return state;
    }) as typeof import('../graph-runner/runner.js').runGraph,
  });
  const item = runner.submit('보고');
  await wait(() => store.get(item.id)?.status === 'done');
  expect(runner.get(item.id)?.results).toEqual([]);
});

test('a run artifact directory linked to a sibling run cannot publish or download its files', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-sibling-run-')));
  roots.push(root);
  const store = new ExecRequestStore(root);
  const runner = new ExecRequestRunner({ store, root,
    graphs: async () => [{ id: 'report', title: 'report', description: '', path: join(root, 'report.yaml') }],
    plan: async () => [{ seat: 'CMO', title: '보고', graphId: 'report', inputs: {} }],
    run: (async (_path: string, opts: { runId: string }) => {
      const dir = join(root, 'graph-runs', 'report');
      const sibling = join(dir, 'another-run.json.artifacts');
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'secret.pdf'), 'other run');
      const artifactDir = join(dir, `${opts.runId}.json.artifacts`);
      symlinkSync(sibling, artifactDir, 'dir');
      const statePath = join(dir, `${opts.runId}.json`);
      const state: GraphRunState = { graphId: 'report', runId: opts.runId, status: 'done', statePath,
        path: ['make'], executed: 1, dryRun: false,
        nodes: [{ nodeId: 'make', ok: true, exit: 0, executed: true,
          output: JSON.stringify({ file: join(artifactDir, 'secret.pdf') }) }] };
      writeFileSync(statePath, JSON.stringify(state));
      return state;
    }) as typeof import('../graph-runner/runner.js').runGraph,
  });
  const item = runner.submit('보고');
  await wait(() => store.get(item.id)?.status === 'done');
  expect(runner.get(item.id)?.results).toEqual([]);
  const siblingFile = join(root, 'graph-runs', 'report', 'another-run.json.artifacts', 'secret.pdf');
  const forgedName = `${store.get(item.id)!.seats[0]!.runId}--${createHash('sha256').update(siblingFile).digest('hex')}--secret.pdf`;
  const forged = store.get(item.id)!;
  forged.results.push({ seat: 'CMO', kind: 'pdf', title: 'secret', url: `/v1/exec-requests/${item.id}/files/${forgedName}` });
  store.save(forged);
  expect(runner.file(item.id, forgedName)).toBeNull();
});

test('daemon restart reconciles planning and interrupted running requests without inventing results', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-restart-')));
  roots.push(root);
  const store = new ExecRequestStore(root);
  const planning = store.create('plan interrupted');
  const running = store.create('run interrupted');
  running.status = 'running';
  running.seats = [
    { seat: 'CMO', title: '보고', status: 'waiting', graphId: 'report', runId: 'waiting-run' },
    { seat: 'CTO', title: '영상', status: 'running', graphId: 'film', runId: 'running-run' },
  ];
  store.save(running);
  const dir = join(root, 'graph-runs', 'film');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'running-run.json'), JSON.stringify({ graphId: 'film', runId: 'running-run', status: 'running', path: [], nodes: [] }));
  const restarted = new ExecRequestRunner({ root, store: new ExecRequestStore(root) });
  restarted.reconcileInterrupted();
  expect(restarted.get(planning.id)?.status).toBe('failed');
  expect(restarted.get(planning.id)?.summary).toContain('데몬 재시작');
  const interrupted = restarted.get(running.id)!;
  expect(interrupted.status).toBe('failed');
  expect(interrupted.seats.map(seat => seat.status)).toEqual(['failed', 'failed']);
  expect(interrupted.seats.every(seat => seat.reason?.includes('데몬 재시작'))).toBe(true);
  expect(interrupted.results).toEqual([]);
  expect(new ExecRequestStore(root).list().map(item => item.status)).toEqual(['failed', 'failed']);
});

test('restart recovers a completed graph run and leaves an approval-pending run available for decision', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-restart-recover-')));
  roots.push(root);
  const store = new ExecRequestStore(root);
  const item = store.create('approved and completed');
  item.status = 'running';
  item.seats = [
    { seat: 'CMO', title: '보고', status: 'running', graphId: 'report', runId: 'finished-run' },
    { seat: 'CTO', title: '승인', status: 'running', graphId: 'publish', runId: 'approval-run' },
  ];
  store.save(item);
  const reportDir = join(root, 'graph-runs', 'report');
  const approvalDir = join(root, 'graph-runs', 'publish');
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(approvalDir, { recursive: true });
  const report = join(reportDir, 'finished-run.json.report.pdf');
  writeFileSync(report, '%PDF-completed');
  writeFileSync(join(reportDir, 'finished-run.json'), JSON.stringify({ graphId: 'report', runId: 'finished-run',
    status: 'done', path: ['make'], nodes: [{ output: JSON.stringify({ file: report }) }] }));
  writeFileSync(join(approvalDir, 'approval-run.json'), JSON.stringify({ graphId: 'publish', runId: 'approval-run',
    status: 'awaiting-approval', path: ['approve'], nodes: [],
    pending: { nodeId: 'approve', message: '게시할까요?', since: new Date().toISOString() } }));
  const restarted = new ExecRequestRunner({ root, store: new ExecRequestStore(root) });
  restarted.reconcileInterrupted();
  const recovered = restarted.get(item.id)!;
  expect(recovered.status).toBe('running');
  expect(recovered.seats.map(seat => seat.status)).toEqual(['done', 'running']);
  expect(recovered.results.map(result => result.kind)).toEqual(['pdf']);
  expect(recovered.approvals).toEqual([{ graphId: 'publish', runId: 'approval-run', message: '게시할까요?' }]);
  expect(readFileSync(restarted.file(item.id, decodeURIComponent(recovered.results[0]!.url.split('/').at(-1)!))!, 'utf8')).toBe('%PDF-completed');
});

test('actual runGraph produces a file and the request returns only that run output', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-real-run-')));
  roots.push(root);
  const mine = join(root, 'mine');
  mkdirSync(mine);
  writeFileSync(join(mine, 'sample-exec.yaml'), 'graph_id: sample-exec\nversion: 1\nentry_node: done\nterminal_nodes: [done]\nnodes:\n  - { node_id: done, kind: agent, recipe: "cmd:artifact", max_visits: 1 }\nedges: []\n');
  writeFileSync(join(mine, 'recipes.yaml'), `artifact:\n  command: 'out="${'${ELANOUS_GRAPH_CONTEXT%.contexts/*}'}"; printf "real pdf" > "$out.artifact.pdf"; printf "{\\"file\\":\\"%s\\",\\"summary\\":\\"real\\"}\\n" "$out.artifact.pdf"'\n`);
  const store = new ExecRequestStore(root);
  const runner = new ExecRequestRunner({ store, root, graphs: () => installedGraphs(defaultGraphsDir(), mine),
    plan: async () => [{ seat: 'CMO', title: '한 장', graphId: 'sample-exec', inputs: {} }] });
  const item = runner.submit('실제 산출');
  await wait(() => runner.get(item.id)?.status === 'done');
  const done = runner.get(item.id)!;
  expect(done.results).toHaveLength(1);
  const name = decodeURIComponent(done.results[0]!.url.split('/').at(-1)!);
  expect(readFileSync(runner.file(item.id, name)!, 'utf8')).toBe('real pdf');
  expect(done.summary).toBe('real');
  expect(new ExecRequestStore(root).get(item.id)?.results).toHaveLength(1);
});

test('missing graph fails its seat without inventing results; graph approval is surfaced and resumed after decision', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-approval-')));
  roots.push(root);
  const store = new ExecRequestStore(root);
  const dir = join(root, 'graph-runs', 'publish');
  mkdirSync(dir, { recursive: true });
  let resumed = 0;
  const runner = new ExecRequestRunner({ store, root,
    graphs: async () => [{ id: 'publish', title: 'publish', description: '', path: join(root, 'publish.yaml') }],
    plan: async () => [
      { seat: 'CMO', title: '검토', graphId: 'publish', inputs: {} },
      { seat: 'CTO', title: '없는 능력', graphId: '', inputs: {}, reason: '설치된 실행 그래프가 없습니다' },
    ],
    run: (async (_path: string, opts: { runId?: string; resumeRunId?: string }) => {
      const runId = opts.runId ?? opts.resumeRunId!;
      const statePath = join(dir, `${runId}.json`);
      const state: GraphRunState = { graphId: 'publish', runId, statePath, status: opts.resumeRunId ? 'done' : 'awaiting-approval',
        path: ['approve'], nodes: [], executed: 0, dryRun: false,
        ...(opts.resumeRunId ? {} : { pending: { nodeId: 'approve', message: '게시할까요?', since: new Date().toISOString() } }) };
      writeFileSync(statePath, JSON.stringify(state));
      if (opts.resumeRunId) resumed++;
      return state;
    }) as typeof import('../graph-runner/runner.js').runGraph,
  });
  const item = runner.submit('게시 전 승인');
  await wait(() => runner.get(item.id)?.approvals.length === 1);
  const pending = runner.get(item.id)!;
  expect(pending.approvals).toEqual([{ graphId: 'publish', runId: pending.seats[0]!.runId, message: '게시할까요?' }]);
  expect(pending.seats.map(seat => seat.status)).toEqual(['running', 'failed']);
  expect(pending.results).toEqual([]);
  expect(pending.seats[1]!.reason).toBe('설치된 실행 그래프가 없습니다');
  writeFileSync(join(dir, `${pending.seats[0]!.runId}.json.1.decision.json`), JSON.stringify({ decision: 'approved' }));
  runner.get(item.id);
  await wait(() => resumed === 1 && runner.get(item.id)?.approvals.length === 0);
  expect(runner.get(item.id)?.seats.map(seat => seat.status)).toEqual(['done', 'failed']);
  expect(runner.get(item.id)?.status).toBe('failed');
});

test('Unicode and spaced artifact names remain downloadable without allowing unrelated files', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-unicode-')));
  roots.push(root);
  const store = new ExecRequestStore(root);
  const runner = new ExecRequestRunner({ store, root,
    graphs: async () => [{ id: 'report', title: 'report', description: '', path: join(root, 'report.yaml') }],
    plan: async () => [{ seat: 'CMO', title: '한 장', graphId: 'report', inputs: {} }],
    run: (async (_path: string, opts: { runId: string }) => {
      const dir = join(root, 'graph-runs', 'report');
      mkdirSync(dir, { recursive: true });
      const statePath = join(dir, `${opts.runId}.json`);
      const file = `${statePath}.임원 보고 한 장.pdf`;
      writeFileSync(file, '%PDF-unicode');
      const state: GraphRunState = { graphId: 'report', runId: opts.runId, status: 'done', statePath,
        path: ['make'], executed: 1, dryRun: false,
        nodes: [{ nodeId: 'make', ok: true, exit: 0, executed: true, output: JSON.stringify({ file }) }] };
      writeFileSync(statePath, JSON.stringify(state));
      return state;
    }) as typeof import('../graph-runner/runner.js').runGraph,
  });
  const submitted = runner.submit('한 줄');
  await wait(() => store.get(submitted.id)?.status === 'done');
  const result = runner.get(submitted.id)!.results[0]!;
  expect(result.url).toContain('%EC%9E%84%EC%9B%90%20%EB%B3%B4%EA%B3%A0%20%ED%95%9C%20%EC%9E%A5.pdf');
  expect(readFileSync(runner.file(submitted.id, decodeURIComponent(result.url.split('/').at(-1)!))!, 'utf8')).toBe('%PDF-unicode');
  expect(runner.file(submitted.id, '../임원 보고 한 장.pdf')).toBeNull();
});

test('failed approval resume persists its reason and does not retry on read or daemon restart', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-resume-fail-')));
  roots.push(root);
  const store = new ExecRequestStore(root);
  let attempts = 0;
  const deps = { store, root,
    graphs: async () => [{ id: 'publish', title: 'publish', description: '', path: join(root, 'publish.yaml') }],
    plan: async () => [{ seat: 'CMO', title: '게시', graphId: 'publish', inputs: {} }],
    run: (async (_path: string, opts: { runId?: string; resumeRunId?: string }) => {
      if (opts.resumeRunId) { attempts++; throw new Error('resume rejected'); }
      const dir = join(root, 'graph-runs', 'publish');
      mkdirSync(dir, { recursive: true });
      const statePath = join(dir, `${opts.runId}.json`);
      const state: GraphRunState = { graphId: 'publish', runId: opts.runId!, statePath, status: 'awaiting-approval',
        path: ['approve'], nodes: [], executed: 0, dryRun: false,
        pending: { nodeId: 'approve', message: '게시할까요?', since: new Date().toISOString() } };
      writeFileSync(statePath, JSON.stringify(state));
      return state;
    }) as typeof import('../graph-runner/runner.js').runGraph,
  };
  const runner = new ExecRequestRunner(deps);
  const item = runner.submit('게시');
  await wait(() => runner.get(item.id)?.approvals.length === 1);
  const runId = runner.get(item.id)!.seats[0]!.runId;
  writeFileSync(join(root, 'graph-runs', 'publish', `${runId}.json.1.decision.json`), JSON.stringify({ decision: 'approved' }));
  runner.get(item.id);
  await wait(() => store.get(item.id)?.seats[0]?.status === 'failed');
  expect(store.get(item.id)?.seats[0]?.reason).toBe('그래프 재개 실패: resume rejected');
  expect(store.get(item.id)?.status).toBe('failed');
  expect(store.get(item.id)?.approvals).toEqual([]);
  for (let i = 0; i < 3; i++) runner.get(item.id);
  const restarted = new ExecRequestRunner({ ...deps, store: new ExecRequestStore(root) });
  expect(restarted.get(item.id)?.seats[0]?.status).toBe('failed');
  expect(restarted.get(item.id)?.seats[0]?.reason).toBe('그래프 재개 실패: resume rejected');
  expect(attempts).toBe(1);
});

test('constructing a runner (import · tests · CLI) never fails live requests — only reconcileInterrupted() does', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-noimport-')));
  const store = new ExecRequestStore(root);
  const live = store.create('still running elsewhere');
  live.status = 'running';
  live.seats = [{ seat: 'CMO', title: '보고', status: 'running', graphId: 'report', runId: 'live-run' }];
  store.save(live);
  const other = new ExecRequestRunner({ root, store: new ExecRequestStore(root) });
  expect(other.get(live.id)?.status).toBe('running');
  expect(other.get(live.id)?.seats[0]?.status).toBe('running');
  rmSync(root, { recursive: true, force: true });
});

test('mixed restart recovery: a finished seat summary never hides the failure reason', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-mixed-')));
  const store = new ExecRequestStore(root);
  const item = store.create('mixed');
  item.status = 'running';
  item.summary = '출시 문구를 만들었습니다';
  item.seats = [
    { seat: 'CMO', title: '문구', status: 'done', graphId: 'launch', runId: 'done-run' },
    { seat: 'CXO', title: '영상', status: 'running', graphId: 'film', runId: 'gone-run' },
  ];
  store.save(item);
  const runner = new ExecRequestRunner({ root, store: new ExecRequestStore(root) });
  runner.reconcileInterrupted();
  const after = runner.get(item.id)!;
  expect(after.status).toBe('failed');
  expect(after.summary).toContain('데몬 재시작');
  expect(after.summary).not.toBe('출시 문구를 만들었습니다');
  rmSync(root, { recursive: true, force: true });
});

test('installed plugin graphs join the COO catalog — newest version, plugin.json title, broken plugins skipped', async () => {
  const { installedPluginGraphs } = await import('./planner.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-plugins-')));
  const put = (market: string, name: string, version: string, graph: string | null, meta: string | null) => {
    const dir = join(root, market, name, version, 'graphs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'recipes.yaml'), 'x:\n  command: "true"\n');
    if (graph !== null) writeFileSync(join(dir, `${name}.yaml`), graph);
    if (meta !== null) writeFileSync(join(root, market, name, version, 'plugin.json'), meta);
  };
  put('official', 'card-followup', '0.1.0', 'graph_id: card-followup\nversion: 1\n', '{"name":"card-followup","description":"old"}');
  put('official', 'card-followup', '0.1.10', 'graph_id: card-followup\nversion: 1\n', '{"name":"card-followup","description":"Business card photo to follow-up drafts."}');
  put('official', 'geo-check', '0.1.1', 'graph_id: geo-check\nloop:\n  title: GEO 점검\n  description: 브랜드 AI 노출\n', '{"name":"geo-check","description":"ignored when loop has text"}');
  put('local', 'broken', '1.0.0', 'graph_id: [unclosed', '{"name":"broken"}');
  const { graphs, errors } = installedPluginGraphs(root);
  expect(graphs.map(g => g.id).sort()).toEqual(['card-followup', 'geo-check']);
  const card = graphs.find(g => g.id === 'card-followup')!;
  expect(card.description).toBe('Business card photo to follow-up drafts.');
  expect(card.path).toContain('0.1.10');
  expect(graphs.find(g => g.id === 'geo-check')!.title).toBe('GEO 점검');
  expect(errors.some(e => e.includes('broken'))).toBe(true);
  expect(installedPluginGraphs(join(root, 'missing')).graphs).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test('plugin input keys come from the examples sample and reach the COO prompt catalog', async () => {
  const { installedPluginGraphs, planExecRequest } = await import('./planner.js');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-plugin-keys-')));
  const base = join(root, 'local', 'geo-check', '0.1.1');
  mkdirSync(join(base, 'graphs'), { recursive: true });
  mkdirSync(join(base, 'examples'), { recursive: true });
  writeFileSync(join(base, 'graphs', 'recipes.yaml'), 'x:\n  command: "true"\n');
  writeFileSync(join(base, 'graphs', 'geo-check.yaml'), 'graph_id: geo-check\nversion: 1\n');
  writeFileSync(join(base, 'examples', 'brand-sample.json'), '{"brand":"Moonfern","domain":"moonfern.example"}');
  const { graphs } = installedPluginGraphs(root);
  expect(graphs[0]!.inputKeys).toEqual(['brand', 'domain']);
  let seen: readonly { inputKeys?: string[] }[] = [];
  const plan = await planExecRequest('엘라누스 AI 노출 점검', {
    graphs: async () => graphs, seats: () => ['CMO'],
    judge: async (_t, g) => { seen = g; return [{ seat: 'CMO', title: '점검', graphId: 'geo-check', inputs: { brand: 'Elanous' } }]; },
  });
  expect(seen[0]!.inputKeys).toEqual(['brand', 'domain']);
  expect(plan[0]!.inputs).toEqual({ brand: 'Elanous' });
  rmSync(root, { recursive: true, force: true });
});

test('A5b — a seat with «after» waits for the earlier seat and starts with its result in context; a failed earlier seat stops it', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'exec-after-'))); roots.push(root);
  const store = new ExecRequestStore(root);
  const graphs: InstalledGraph[] = [{ id: 'geo', title: 'GEO', description: 'check', path: '/g/geo.yaml' }, { id: 'doc', title: 'Doc', description: 'draft', path: '/g/doc.yaml' }];
  const report = join(root, 'geo-report.md');
  writeFileSync(report, '# GEO check\n브릴스: 1/4 answers mention the brand.');
  const events: string[] = [];
  const inputsSeen: Record<string, unknown>[] = [];
  let geoOk = true;
  const run = async (path: string, opts: { input?: unknown; runId?: string }) => {
    const graphId = path.includes('geo') ? 'geo' : 'doc';
    events.push(`start:${graphId}`);
    inputsSeen.push((opts.input ?? {}) as Record<string, unknown>);
    await new Promise((resolve) => setTimeout(resolve, graphId === 'geo' ? 40 : 1));
    events.push(`end:${graphId}`);
    const ok = graphId === 'doc' || geoOk;
    return { graphId, runId: opts.runId!, status: ok ? 'done' : 'failed', path: [], executed: 1, dryRun: false, statePath: join(root, `${graphId}.json`),
      nodes: [{ nodeId: 'last', ok, exit: ok ? 0 : 1, executed: true, output: JSON.stringify(graphId === 'geo' ? { summary: '브릴스는 4개 중 1개 답에만 나옴', report } : { summary: '한 장 완료' }) }] } as GraphRunState;
  };
  const plan = async () => [
    { seat: 'CTO', title: 'GEO 점검', graphId: 'geo', inputs: {} },
    { seat: 'CMO', title: '임원 한 장', graphId: 'doc', inputs: { topic: '상장 홍보', context: '행사 직후' }, after: [0] },
  ];
  const runner = new ExecRequestRunner({ store, root, graphs: async () => graphs, plan, run: run as never });
  const first = runner.submit('점검하고 그 결과로 임원 한 장');
  for (let i = 0; i < 100 && store.get(first.id)?.status !== 'done'; i++) await new Promise((r) => setTimeout(r, 10));
  expect(events).toEqual(['start:geo', 'end:geo', 'start:doc', 'end:doc']);
  const docInput = inputsSeen[1]!;
  expect(docInput.topic).toBe('상장 홍보');
  expect(String(docInput.context)).toContain('행사 직후');
  expect(String(docInput.context)).toContain('앞 자리 결과:');
  expect(String(docInput.context)).toContain('[CTO · GEO 점검]');
  expect(String(docInput.context)).toContain('브릴스는 4개 중 1개 답에만 나옴');
  expect(String(docInput.context)).toContain('1/4 answers mention the brand');
  expect(store.get(first.id)!.seats.map((s) => s.after ?? null)).toEqual([null, [0]]);

  geoOk = false; events.length = 0; inputsSeen.length = 0;
  const second = runner.submit('다시');
  for (let i = 0; i < 100 && !['done', 'failed'].includes(store.get(second.id)?.status ?? ''); i++) await new Promise((r) => setTimeout(r, 10));
  expect(events).toEqual(['start:geo', 'end:geo']);
  const seats = store.get(second.id)!.seats;
  expect(seats[1]!.status).toBe('failed');
  expect(seats[1]!.reason).toContain('앞 자리(CTO) 결과가 없어 진행하지 않았습니다');
});

test('A5b — the planner keeps only valid earlier indexes in «after»', async () => {
  const graphs: InstalledGraph[] = [{ id: 'geo', title: 'GEO', description: 'c', path: '/g' }, { id: 'doc', title: 'Doc', description: 'd', path: '/d' }];
  const plan = await planExecRequest('x', { graphs: async () => graphs, seats: () => ['CTO', 'CMO'], judge: async () => [
    { seat: 'CTO', title: 'a', graphId: 'geo', inputs: {}, after: [0, 1, -1] },
    { seat: 'CMO', title: 'b', graphId: 'doc', inputs: {}, after: [0, 0, 1, 5, 'x'] },
  ] });
  expect(plan[0]!.after).toBeUndefined();
  expect(plan[1]!.after).toEqual([0]);
});
