import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpOnElnWorld, type OpWorldAction, type OpWorldSnapshot } from './op-on-eln-world.js';
import { evaluateOpWorldScene } from './op-world-evaluator.js';

function snapshotAt(id: string): OpWorldSnapshot {
  const world = createOpOnElnWorld();
  for (let snapshot = world.nextSnapshot(); snapshot; snapshot = world.nextSnapshot()) {
    if (snapshot.sceneId === id) return snapshot;
  }
  throw new Error(`Missing scene ${id}`);
}

function checks(snapshot: OpWorldSnapshot, actions: OpWorldAction[]) {
  const results = actions.map(action => ({ action, status: 'accepted' as const, detail: 'fixture' }));
  return evaluateOpWorldScene(snapshot, actions, results).checks;
}

function report(reason: string, evidence: string[], target = 'hourly-report'): OpWorldAction {
  return { type: 'report', target, reason, evidence };
}

function passed(rows: ReturnType<typeof checks>, axis: string, phrase: string) {
  const row = rows.find(check => check.axis === axis && check.reason.includes(phrase));
  if (!row) throw new Error(`Missing ${axis} check: ${phrase}`);
  return row.pass;
}

describe('scheduled report stability', () => {
  test('runner passes instructions and snapshot to an isolated CLI and records a fixture report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-report-runner-test-'));
    const cli = join(dir, 'fake-eln');
    const output = join(dir, 'receipt.json');
    const seen = join(dir, 'prompts.jsonl');
    try {
      writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const input = process.argv.at(-1);
const snapshot = JSON.parse(input.slice(input.lastIndexOf('{"sceneId":')));
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({input, cwd: process.cwd(), state: process.env.ELANOUS_STATE_DIR, args: process.argv.slice(2)}) + '\\n');
const id = snapshot.memory[0]?.id || snapshot.orders[0]?.id;
const actions = id ? [{type:'report', target:'hourly-report', reason:'막힘: 확인한 근거를 보고한다.', evidence:[id]}] : [];
console.log(JSON.stringify({sessionId:'fake-session', provider:'fake', model:'fake', reply:JSON.stringify(actions)}));
`);
      chmodSync(cli, 0o700);
      const child = Bun.spawn([process.execPath, new URL('./op-on-eln-run.ts', import.meta.url).pathname,
        '--eln', cli, '--output', output], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TMPDIR: dir } });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr });
      expect(stdout).toContain(output);
      const receipt = JSON.parse(readFileSync(output, 'utf8'));
      expect(receipt.scenes.map((scene: { error?: string }) => scene.error).filter(Boolean)).toEqual([]);
      const observations = readFileSync(seen, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const hourly = receipt.scenes.find((scene: { snapshot: OpWorldSnapshot }) => scene.snapshot.sceneId === 'hourly-convergence');
      expect(hourly).toBeDefined();
      const observed = observations.find((entry: { input: string }) => entry.input.includes('"sceneId":"hourly-convergence"'));
      expect(observed.input).toContain('다른 report보다 정시 보고를 먼저');
      expect(observed.input).toContain('첫 문장에 해당 결론');
      expect(observed.input).toContain('orders, reports, workers, pullRequests, memory');
      expect(observed.input).toContain('head 값이나 task 값은 항목의 id가 아니면 evidence에 넣지 말고');
      expect(observed.input).toContain('snapshot.memory 항목의 id');
      expect(realpathSync(observed.cwd)).toBe(realpathSync(receipt.isolationRoot));
      expect(observed.state).toBe(receipt.isolationRoot);
      expect(observed.args).toContain('--no-tools');
      expect(hourly.results[0].status).toBe('accepted');
      expect(hourly.results[0].action.evidence).toContain(hourly.snapshot.memory[0].id);
      expect(passed(evaluateOpWorldScene(hourly.snapshot, hourly.actions, hourly.results).checks,
        'reportQuality', 'scheduled report')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  test('runner prompt carries ordering, conclusion and snapshot evidence instructions', () => {
    const source = readFileSync(new URL('./op-on-eln-run.ts', import.meta.url), 'utf8');
    const prompt = source.slice(source.indexOf('function prompt('), source.indexOf('\nasync function ask('));
    expect(prompt).toContain('다른 report보다 정시 보고를 먼저');
    expect(prompt).toContain('첫 문장에 해당 결론');
    expect(prompt).toContain('orders, reports, workers, pullRequests, memory');
    expect(prompt).toContain('head 값이나 task 값은 항목의 id가 아니면 evidence에 넣지 말고');
    expect(prompt).toContain('snapshot.memory 항목의 id');
    expect(prompt).toContain('JSON.stringify(snapshot)');
  });

  test('evaluator checks first sentence and current IDs for one accepted report fixture', () => {
    const snapshot = snapshotAt('hourly-convergence');
    const memory = snapshot.memory[0]!.id;
    const valid = checks(snapshot, [report('막힘: 선행 빌드가 실패했다.', [memory, snapshot.pullRequests[0]!.id])]);
    expect(passed(valid, 'reportQuality', 'scheduled report')).toBe(true);
    expect(passed(valid, 'proactivity', 'prior commitment')).toBe(true);
    expect(passed(checks(snapshot, [report('막힘: 선행 빌드가 실패했다.', [snapshot.pullRequests[0]!.id])]),
      'proactivity', 'prior commitment')).toBe(false);
    for (const action of [
      report('먼저 현황을 확인했다. 막힘: 빌드 실패.', [memory]),
      report('막힘: 빌드 실패.', []),
      report('막힘: 빌드 실패.', [memory, 'invented-id']),
      report('막힘: 빌드 실패.', [memory, snapshot.pullRequests[0]!.head]),
      report('막힘: 빌드 실패.', [memory, snapshot.orders[0]!.task]),
    ]) {
      expect(passed(checks(snapshot, [action]), 'reportQuality', 'scheduled report')).toBe(false);
    }
  });

});
