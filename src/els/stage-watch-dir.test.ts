// GOAL-ORCHESTRATION-NL review r1: the bare els window's run lookup scans the real runs folder — the newest ACTIVE els
// run wins; a newer finished or headless run does not hide it. Literal expectations.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestrationStageWatch } from '../cli/els-cli.js';

const saved = process.env.ELANOUS_STATE_DIR;
let dir = '';
afterEach(() => { if (saved === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = saved; if (dir) rmSync(dir, { recursive: true, force: true }); });

const run = (id: string, backend: string, done = false): void => {
  const d = join(dir, 'orchestrations', id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'run.json'), JSON.stringify({ backend, workspace: `ws-${id.slice(-2)}` }));
  writeFileSync(join(d, 'feed.jsonl'), '{"phase":"work"}\n');
  if (done) writeFileSync(join(d, 'report.json'), '{}');
};

test('newest active els run is picked over a newer finished one and a newer headless one', () => {
  dir = mkdtempSync(join(tmpdir(), 'orch-watch-'));
  process.env.ELANOUS_STATE_DIR = dir;
  run('orch-20261126000001-aa', 'els');
  run('orch-20261126000002-bb', 'els', true);
  run('orch-20261126000003-cc', 'headless');
  const found = orchestrationStageWatch(['ws-aa', 'ws-bb', 'ws-cc']);
  expect(found?.key).toBe('orch-20261126000001-aa');
  expect(found?.ws).toBe('ws-aa');
  expect(found?.readFeed()).toBe('{"phase":"work"}\n');
});

test('an active run in a workspace this window does not show is not picked', () => {
  dir = mkdtempSync(join(tmpdir(), 'orch-watch-'));
  process.env.ELANOUS_STATE_DIR = dir;
  run('orch-20261126000001-aa', 'els');
  run('orch-20261126000002-dd', 'els');
  expect(orchestrationStageWatch(['ws-aa'])?.key).toBe('orch-20261126000001-aa');
  expect(orchestrationStageWatch(['ws-zz'])).toBeUndefined();
});

test('no runs folder → nothing', () => {
  dir = mkdtempSync(join(tmpdir(), 'orch-watch-'));
  process.env.ELANOUS_STATE_DIR = dir;
  expect(orchestrationStageWatch(['ws-aa'])).toBeUndefined();
});
