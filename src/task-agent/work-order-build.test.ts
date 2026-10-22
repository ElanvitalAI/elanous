import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerTasksCommands } from '../cli/tasks-cli.js';
import { buildWorkOrder } from './work-order-build.js';

test('ENTRANCE-WORK-ORDER-BUILD core fills the nine fields and lists unknown values', () => {
  const order = buildWorkOrder({ cellId: 'ENTRANCE-WORK-ORDER-BUILD', version: '0.2.35' });
  expect(order).toMatchObject({
    cellId: 'ENTRANCE-WORK-ORDER-BUILD',
    lifeId: '모름',
    version: '0.2.35',
    priority: '모름',
    peers: '모름',
  });
  expect(order).toMatchObject({
    landBy: '모름', identityTags: '모름', verdictSignal: '모름', contract: '모름',
    boundary: '모름', budget: '모름', precedents: '모름', escalation: '모름',
  });
  expect(order.unknownFields).toEqual(['lifeId', 'landBy', 'identityTags', 'priority', 'verdictSignal', 'contract', 'boundary', 'budget', 'peers', 'precedents', 'escalation']);
  expect(Object.keys(order)).toEqual(['cellId', 'lifeId', 'version', 'landBy', 'identityTags', 'priority', 'verdictSignal', 'contract', 'boundary', 'budget', 'peers', 'precedents', 'escalation', 'unknownFields']);
});

test('ENTRANCE-WORK-ORDER-BUILD core preserves caller supplied life identity', () => {
  const order = buildWorkOrder({ cellId: 'CELL', version: '0.2.35', lifeId: 'life-17', priority: 'P0', peers: 'PARENT-A' });
  expect(order).toMatchObject({ lifeId: 'life-17', priority: 'P0', peers: 'PARENT-A' });
  expect(order.unknownFields).not.toContain('lifeId');
  expect(order.unknownFields).not.toContain('priority');
  expect(order.unknownFields).not.toContain('peers');
});

test('tasks work-order build reads the selected checklist and writes normalized fields with missing paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'work-order-cli-'));
  const out = join(dir, 'nested', 'order.work-order.json');
  const missingPath = join(dir, 'absent.ts');
  const lines: string[] = [];
  const program = new Command().name('elanous').exitOverride();
  registerTasksCommands(program, {
    output: (line) => lines.push(line),
    workOrderChecklist: (version) => ({ version, released: '', dev: '', history: [], items: [{
      id: 'ENTRANCE-WORK-ORDER-BUILD', title: `대상 경로: src/task-agent/work-order-build.ts · ${missingPath}`,
      status: 'yellow', priority: 'P0', updatedAt: '', updatedBy: '',
    }] }),
  });
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'elanous', 'tasks', 'work-order', 'build', '--checklist', 'ENTRANCE-WORK-ORDER-BUILD', '--version', '0.2.35', '--out', out]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(lines).toEqual([out]);
    const order = JSON.parse(readFileSync(out, 'utf8'));
    expect(order).toMatchObject({ cellId: 'ENTRANCE-WORK-ORDER-BUILD', version: '0.2.35', priority: 'P0',
      boundary: `대상 경로: src/task-agent/work-order-build.ts · ${missingPath}\nboundary.missing: ${missingPath}`,
      landBy: '모름', identityTags: '모름', verdictSignal: '모름', contract: '모름',
      budget: '모름', peers: '모름', precedents: '모름', escalation: '모름' });
    expect(order.unknownFields).toEqual(['lifeId', 'landBy', 'identityTags', 'verdictSignal', 'contract', 'budget', 'peers', 'precedents', 'escalation']);
    expect(Object.keys(order)).toEqual(Object.keys(buildWorkOrder({ cellId: 'ENTRANCE-WORK-ORDER-BUILD', version: '0.2.35' })));
  } finally { process.exitCode = previous ?? 0; rmSync(dir, { recursive: true, force: true }); }
});

test('isolated production elanous entry reads the on-disk checklist and writes a work order', async () => {
  const repo = resolve(import.meta.dir, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'work-order-entry-'));
  const version = '0.2.35';
  const cellId = 'ENTRANCE-WORK-ORDER-BUILD';
  // Exact first line from the live 0.2.35 checklist; keep its ` · ` path separators under regression.
  const checklistTargetLine = '대상 경로: src/cli/tasks-cli.ts · src/task-agent/work-order-build.ts · src/task-agent/work-order-build.test.ts';
  const missingPath = join(dir, 'absent-work-order-proof.ts');
  const checklistDir = join(dir, 'release', version);
  const out = join(dir, 'orders', 'entry.work-order.json');
  mkdirSync(checklistDir, { recursive: true });
  writeFileSync(join(checklistDir, 'checklist.json'), JSON.stringify({ version, released: '', dev: version, history: [], items: [{
    id: cellId, title: `${checklistTargetLine} · ${missingPath}\n현재 계약: 원문 보존`,
    status: 'yellow', priority: 'P0', updatedAt: '2026-10-20T00:00:00Z', updatedBy: 'OP',
  }] }));
  try {
    const child = Bun.spawn([process.execPath, join(repo, 'bin/elanous.mjs'), `--test=${dir}`, 'tasks', 'work-order', 'build',
      '--checklist', cellId, '--version', version, '--out', out], { cwd: repo, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, ELANOUS_STATE_DIR: dir } });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stdout: stdout.trim() }).toEqual({ exit: 0, stdout: out });
    expect(stderr).not.toContain('Error:');
    const order = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(order)).toEqual(Object.keys(buildWorkOrder({ cellId, version })));
    expect(order).toMatchObject({ cellId, version, priority: 'P0',
      boundary: `${checklistTargetLine} · ${missingPath}\nboundary.missing: ${missingPath}`,
      lifeId: '모름', landBy: '모름', identityTags: '모름', verdictSignal: '모름', contract: '모름',
      budget: '모름', peers: '모름', precedents: '모름', escalation: '모름' });
    expect(order.unknownFields).toEqual(['lifeId', 'landBy', 'identityTags', 'verdictSignal', 'contract', 'budget', 'peers', 'precedents', 'escalation']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);
