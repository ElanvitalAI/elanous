import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SelfDevDecomposition } from './decompose.js';
import {
  approveFabricPlan,
  createFabricPlan,
  listFabricExecutionCandidates,
  loadFabricPlan,
  reviseFabricPlan,
} from './fabric-plan-core.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const input = '경쟁 조사 → 기능 → 배포 → 영상';
const arcTitles = ['경쟁 조사', '기능 개발', '배포', '영상 제작'];
const workTitles = ['경쟁사를 조사한다', '기능을 개발한다', '서비스를 배포한다', '영상을 제작한다'];
const outputs = ['경쟁 분석 보고서', '작동하는 기능', '배포된 서비스', '홍보 영상'];
const authored = [
  '# RFC — 복합 요청',
  '```work-breakdown',
  ...arcTitles.flatMap((heading, i) => [
    `### 아크 ${i + 1}: ${heading}`,
    `- title: ${workTitles[i]}`,
    `  detail: ${outputs[i]}`,
  ]),
  '```',
].join('\n');

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'fabric-plan-core-'));
  roots.push(path);
  return path;
}

function options(calls: string[]) {
  return {
    ground: async () => ({
      documentLines: ['Grounding for the requested work.'],
      memoryCount: 0,
      localSourceCount: 1,
      repositorySourceCount: 0,
      genericSearchScope: false,
      localReferenceAttempts: [],
      externalCount: 0,
      externalStatus: 'unavailable' as const,
    }),
    resolve: async () => authored,
    decomposeGoal: async (feature: string): Promise<SelfDevDecomposition> => {
      calls.push(feature);
      return {
        goals: [{ id: 'work', feature: 'Update src/self-dev/fabric-decompose-adapter.ts' }],
        decomposition: { recommendedMaxTasks: 6, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
      };
    },
  };
}

describe('fabric plan core', () => {
  test('reuses the authored fabric arcs for a typed task tree and persists draft without an execution candidate', async () => {
    const path = root();
    const calls: string[] = [];
    const plan = await createFabricPlan(path, input, options(calls));

    expect(calls).toHaveLength(4);
    expect(calls.map((feature) => arcTitles.find((title) => feature.includes(`## Fabric arc: ${title}`)))).toEqual(arcTitles);
    expect(plan.request).toBe(input);
    expect(plan.status).toBe('draft');
    expect(plan.nodes.map((node) => ({ title: node.title, kind: node.kind, dependsOn: node.dependsOn, expectedOutput: node.expectedOutput }))).toEqual([
      { title: '경쟁 조사', kind: 'search', dependsOn: [], expectedOutput: outputs[0] },
      { title: '기능 개발', kind: 'dev', dependsOn: ['arc-1:task-1'], expectedOutput: outputs[1] },
      { title: '배포', kind: 'deploy', dependsOn: ['arc-2:task-1'], expectedOutput: outputs[2] },
      { title: '영상 제작', kind: 'media', dependsOn: ['arc-3:task-1'], expectedOutput: outputs[3] },
    ]);
    expect(plan.nodes.map((node) => node.children.map((child) => ({ title: child.title, kind: child.kind, dependsOn: child.dependsOn, expectedOutput: child.expectedOutput })))).toEqual([
      [{ title: workTitles[0], kind: 'search', dependsOn: ['arc-1'], expectedOutput: outputs[0] }],
      [{ title: workTitles[1], kind: 'dev', dependsOn: ['arc-2'], expectedOutput: outputs[1] }],
      [{ title: workTitles[2], kind: 'deploy', dependsOn: ['arc-3'], expectedOutput: outputs[2] }],
      [{ title: workTitles[3], kind: 'media', dependsOn: ['arc-4'], expectedOutput: outputs[3] }],
    ]);
    expect(loadFabricPlan(path, plan.id)).toEqual(plan);
    expect(listFabricExecutionCandidates(path)).toEqual([]);
    expect(readFileSync(join(path, 'fabric', 'plans.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).type)).toEqual(['plan']);
  });

  test('keeps non-code arcs even when the self-dev executable-goal filter omits every goal', async () => {
    const path = root();
    const plan = await createFabricPlan(path, input, {
      ...options([]),
      decomposeGoal: async () => ({
        goals: [{ id: 'not-a-repository-file', feature: 'Research a market and produce a report' }],
        decomposition: { recommendedMaxTasks: 6, actualTaskCount: 1, truncatedAtHardMax: false, exceededRecommendedMax: false, outcome: 'decomposed' },
      }),
    });
    expect(plan.nodes).toHaveLength(4);
    expect(plan.nodes[0]?.kind).toBe('search');
    expect(plan.status).toBe('draft');
    expect(listFabricExecutionCandidates(path)).toEqual([]);
  });

  test('applies human edits to the persisted draft and records one candidate only after approval', async () => {
    const path = root();
    const plan = await createFabricPlan(path, input, options([]));
    const edited = reviseFabricPlan(path, plan.id, [
      { id: 'arc-4:task-1', title: '직접 편집한 영상', kind: 'media', expectedOutput: '승인된 편집본', dependsOn: ['arc-3:task-1'] },
    ]);

    expect(edited.nodes[3]?.children[0]).toMatchObject({
      title: '직접 편집한 영상', kind: 'media', expectedOutput: '승인된 편집본', dependsOn: ['arc-3:task-1'],
    });
    expect(edited.status).toBe('draft');
    expect(listFabricExecutionCandidates(path)).toEqual([]);
    const candidate = approveFabricPlan(path, plan.id);
    expect(candidate.nodes).toEqual(edited.nodes);
    expect(listFabricExecutionCandidates(path)).toEqual([candidate]);
    expect(loadFabricPlan(path, plan.id)?.status).toBe('approved');
    expect(readFileSync(join(path, 'fabric', 'plans.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).type))
      .toEqual(['plan', 'plan', 'approved']);
    expect(() => approveFabricPlan(path, plan.id)).toThrow('already approved');
    expect(listFabricExecutionCandidates(path)).toHaveLength(1);
    expect(() => reviseFabricPlan(path, plan.id, [{ id: 'arc-1', title: '새 제목' }])).toThrow('cannot be revised');
  });

  test('serializes concurrent process approvals and revisions across the same ledger', async () => {
    const path = root();
    const plan = await createFabricPlan(path, input, options([]));
    const modulePath = fileURLToPath(new URL('./fabric-plan-core.ts', import.meta.url));
    const script = `import { approveFabricPlan, reviseFabricPlan } from ${JSON.stringify(modulePath)};
      const [root, id, action] = process.argv.slice(1);
      try {
        if (action === 'approve') approveFabricPlan(root, id);
        else reviseFabricPlan(root, id, [{ id: 'arc-1', title: '사람이 변경한 조사' }]);
        console.log('accepted');
      } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }`;
    const commands = ['approve', 'revise', 'approve', 'revise', 'approve', 'revise'].map((action) => Bun.spawn(
      [process.execPath, '-e', script, path, plan.id, action], { stdout: 'pipe', stderr: 'pipe' },
    ));
    const results = await Promise.all(commands.map(async (process) => ({
      exit: await process.exited,
      output: await new Response(process.stdout).text(),
      error: await new Response(process.stderr).text(),
    })));
    expect(results.map((result) => result.error)).toEqual(Array(6).fill(''));
    expect(results.map((result) => result.exit)).toEqual(Array(6).fill(0));
    expect(results.filter((result, index) => index % 2 === 0 && result.output.trim() === 'accepted')).toHaveLength(1);
    expect(loadFabricPlan(path, plan.id)?.status).toBe('approved');
    expect(listFabricExecutionCandidates(path).filter((candidate) => candidate.planId === plan.id)).toHaveLength(1);
    expect(() => reviseFabricPlan(path, plan.id, [{ id: 'arc-1', title: '뒤늦은 수정' }])).toThrow('cannot be revised');
    expect(() => approveFabricPlan(path, plan.id)).toThrow('already approved');
  });

  test('reclaims an exited owner lock for reads, edits and approval without recording a candidate early', async () => {
    const path = root();
    const plan = await createFabricPlan(path, input, options([]));
    const lock = join(path, 'fabric', 'plans.lock');
    const exitedOwner = Bun.spawnSync([process.execPath, '-e', `import { writeFileSync } from 'node:fs';
      writeFileSync(process.argv[1], String(process.pid));`, lock]);
    expect(exitedOwner.exitCode).toBe(0);
    expect(existsSync(lock)).toBe(true);
    expect(loadFabricPlan(path, plan.id)).toEqual(plan);
    expect(existsSync(lock)).toBe(false);

    writeFileSync(lock, String(exitedOwner.pid));
    const edited = reviseFabricPlan(path, plan.id, [{ id: 'arc-1', title: '사람이 고친 조사' }]);
    expect(edited.nodes[0]?.title).toBe('사람이 고친 조사');
    expect(listFabricExecutionCandidates(path)).toEqual([]);

    writeFileSync(lock, String(exitedOwner.pid));
    const candidate = approveFabricPlan(path, plan.id);
    expect(candidate.nodes[0]?.title).toBe('사람이 고친 조사');
    expect(listFabricExecutionCandidates(path)).toEqual([candidate]);
    expect(existsSync(lock)).toBe(false);
  });

  test('keeps a live owner lock while other processes wait for an approval', async () => {
    const path = root();
    const plan = await createFabricPlan(path, input, options([]));
    const lock = join(path, 'fabric', 'plans.lock');
    const holder = Bun.spawn([process.execPath, '-e', `import { writeFileSync, unlinkSync } from 'node:fs';
      writeFileSync(process.argv[1], String(process.pid), { flag: 'wx' });
      console.log('locked');
      await new Response(Bun.stdin.stream()).text();
      unlinkSync(process.argv[1]);`, lock], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const reader = holder.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('locked\n');
      const modulePath = fileURLToPath(new URL('./fabric-plan-core.ts', import.meta.url));
      const contender = Bun.spawn([process.execPath, '-e', `import { approveFabricPlan } from ${JSON.stringify(modulePath)};
        approveFabricPlan(process.argv[1], process.argv[2]);
        console.log('approved');`, path, plan.id], { stdout: 'pipe', stderr: 'pipe' });
      await Bun.sleep(100);
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(lock, 'utf8')).toBe(String(holder.pid));
      expect(readFileSync(join(path, 'fabric', 'plans.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
      holder.stdin.end();
      expect(await holder.exited).toBe(0);
      expect(await contender.exited).toBe(0);
      expect((await new Response(contender.stdout).text()).trim()).toBe('approved');
      expect((await new Response(contender.stderr).text()).trim()).toBe('');
      expect(listFabricExecutionCandidates(path)).toHaveLength(1);
    } finally {
      holder.stdin.end();
      await holder.exited;
      reader.releaseLock();
    }
  });

  test('holds read and transition behind a different process lock rather than reading a stale draft', async () => {
    const path = root();
    const plan = await createFabricPlan(path, input, options([]));
    const lock = join(path, 'fabric', 'plans.lock');
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, String(process.pid));
    const modulePath = fileURLToPath(new URL('./fabric-plan-core.ts', import.meta.url));
    const child = Bun.spawn([process.execPath, '-e', `import { approveFabricPlan } from ${JSON.stringify(modulePath)};
      console.log('ready');
      try { approveFabricPlan(process.argv[1], process.argv[2]); console.log('accepted'); }
      catch (error) { console.log(error instanceof Error ? error.message : String(error)); }`, path, plan.id], { stdout: 'pipe', stderr: 'pipe' });
    const reader = child.stdout.getReader();
    try {
      const started = await reader.read();
      expect(new TextDecoder().decode(started.value)).toBe('ready\n');
      await Bun.sleep(80);
      expect(existsSync(lock)).toBe(true);
      expect(readFileSync(join(path, 'fabric', 'plans.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
    expect(await child.exited).toBe(0);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('accepted\n');
    reader.releaseLock();
    expect((await new Response(child.stderr).text()).trim()).toBe('');
    expect(listFabricExecutionCandidates(path)).toHaveLength(1);
  });

  test('rejects invalid edits and decomposition failures without recording execution candidates', async () => {
    const path = root();
    const plan = await createFabricPlan(path, input, options([]));
    expect(() => reviseFabricPlan(path, plan.id, [{ id: 'missing', title: '없음' }])).toThrow('unknown');
    expect(() => reviseFabricPlan(path, plan.id, [{ id: 'arc-1', dependsOn: ['arc-4'] }])).toThrow('cyclic');
    expect(() => reviseFabricPlan(path, plan.id, [{ id: 'arc-1', kind: 'invalid' as never }])).toThrow('invalid fabric plan node kind');
    expect(loadFabricPlan(path, plan.id)).toEqual(plan);
    await expect(createFabricPlan(path, 'no arcs', { ...options([]), resolve: async () => '# RFC — Empty' })).rejects.toThrow('authored-empty');
    expect(listFabricExecutionCandidates(path)).toEqual([]);
  });

  test('a lock left by a dead owner whose pid is now reused by a live process is reclaimed (start time differs)', async () => {
    const path = root();
    const plan = await createFabricPlan(path, input, options([]));
    // process.pid is alive, but the recorded start time is not this process's — exactly the pid-reuse case.
    writeFileSync(join(path, 'fabric', 'plans.lock'), `${process.pid}|Thu Jan  1 00:00:00 1970`);
    expect(loadFabricPlan(path, plan.id)?.id).toBe(plan.id);
    expect(existsSync(join(path, 'fabric', 'plans.lock'))).toBe(false);
  });

  test('a torn last line is cut back to the last whole line and the ledger stays usable', async () => {
    const path = root();
    const plan = await createFabricPlan(path, input, options([]));
    const ledger = join(path, 'fabric', 'plans.jsonl');
    const whole = readFileSync(ledger, 'utf8');
    writeFileSync(ledger, whole + '{"type":"approved","plan":{"id"');
    expect(loadFabricPlan(path, plan.id)?.status).toBe('draft');
    expect(readFileSync(ledger, 'utf8')).toBe(whole);
    expect(approveFabricPlan(path, plan.id).planId).toBe(plan.id);
    expect(listFabricExecutionCandidates(path)).toHaveLength(1);
  });

  test('a corrupt line in the middle is refused, not silently skipped', async () => {
    const path = root();
    const plan = await createFabricPlan(path, input, options([]));
    const ledger = join(path, 'fabric', 'plans.jsonl');
    const whole = readFileSync(ledger, 'utf8');
    writeFileSync(ledger, 'not json\n' + whole);
    expect(() => loadFabricPlan(path, plan.id)).toThrow('corrupt at line 1');
  });
});
