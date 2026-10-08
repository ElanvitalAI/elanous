import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';

const run = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

// DRAFT-NOT-ARCHIVE (RFC-draft-pr-accumulation-root-fix R1) — `tools.selfImplement.draftOnStop`.
describe('DRAFT-NOT-ARCHIVE — draftOnStop', () => {
  const capture = () => {
    const original = debug.log;
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    (debug as { log: typeof debug.log }).log = ((category, event, data) => {
      events.push({ category, event, data: data as Record<string, unknown> });
    }) as typeof debug.log;
    return { events, restore: () => { (debug as { log: typeof debug.log }).log = original; } };
  };
  const harness = () => {
    const openings: Array<{ head: string; labels?: string[] }> = [];
    const pushes: string[] = [];
    const messages: string[] = [];
    const common = {
      preservationHasChanges: () => true,
      persistPrBodyArtifact: () => ({ path: '/tmp/draft-not-archive-body.md' }),
      preserveBlockedBranch: async ({ branch }: { branch: string }) => { pushes.push(branch); return true; },
      openPr: async ({ head, labels }: { head: string; labels?: string[] }) => { openings.push({ head, ...(labels ? { labels } : {}) }); return { url: `https://pr/${head}`, number: 11 }; },
      onProgress: ({ message }: { message: string }) => { messages.push(message); },
    };
    return { openings, pushes, messages, common };
  };

  test('needs-owner-only: an abandoned (implementation-deficit) run → salvage branch ⊕ stop card on the ledger, no PR', async () => {
    const { events, restore } = capture();
    const { openings, pushes, messages, common } = harness();
    try {
      const result = await runSelfImplement({
        feature: 'harvestable stopped work', maxReworkRounds: 0,
        seams: seams({ ...common, draftOnStopMode: () => 'needs-owner-only', gate: async () => ({ passed: false, log: 'gate red' }) }),
      });
      expect(result.abandonedClassification?.classification).toBe('implementation-deficit');
      expect(openings).toHaveLength(0);
      expect(result.prNumber).toBeUndefined();
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toMatch(/^salvage\/run-[0-9a-z]+\//);
      const salvaged = events.find((e) => e.category === 'self-implement.draft-not-archive' && e.event === 'salvaged');
      expect(salvaged?.data).toMatchObject({
        stopClass: 'harvestable', mode: 'needs-owner-only', classification: 'implementation-deficit',
        salvageBranch: pushes[0], branch: result.branch,
      });
      expect(String(salvaged?.data.reason)).toContain('gate');
      expect(String(salvaged?.data.nextMove)).toContain('수확 가지');
      expect(messages.some((m) => m.includes(`수확 가지로 보존: ${pushes[0]}`) && m.includes('다음 수:'))).toBe(true);
    } finally {
      restore();
    }
  });

  test('needs-owner-only: a salvage push failure falls back to the draft PR (output is never lost)', async () => {
    const { events, restore } = capture();
    const { openings, common } = harness();
    try {
      await runSelfImplement({
        feature: 'harvestable push failure', maxReworkRounds: 0,
        seams: seams({ ...common, draftOnStopMode: () => 'needs-owner-only', preserveBlockedBranch: async () => { throw new Error('remote rejected'); }, gate: async () => ({ passed: false, log: 'gate red' }) }),
      });
      expect(openings).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({ category: 'self-implement.draft-not-archive', event: 'salvage-failed', data: expect.objectContaining({ error: 'remote rejected', fallback: 'open-draft' }) }));
    } finally {
      restore();
    }
  });

  test('needs-owner-only: a contract-conflict stop keeps the draft PR with the owner seat label', async () => {
    const { events, restore } = capture();
    const { openings, pushes, common } = harness();
    const previousSeat = process.env.ELANOUS_HARNESS_SEAT;
    const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
    process.env.ELANOUS_HARNESS_SEAT = 'MK';
    delete process.env.ELANOUS_SUBSTRATE;
    try {
      const result = await runSelfImplement({
        feature: 'needs owner stop', maxReworkRounds: 1, reworkBudgetShadowStop: false, memory: false,
        seams: seams({
          ...common,
          draftOnStopMode: () => 'needs-owner-only',
          gate: async () => ({ passed: false, log: 'criterion A contradicts criterion B' }),
          diagnose: async () => 'BUDGET: CONTRACT-CONFLICT\nREASON: two criteria cannot hold together',
          judgmentCallLLM: async () => 'CONTRACT-CONFLICT',
        }),
      });
      expect(result.abandonedClassification?.classification).toBe('contract-conflict');
      expect(pushes.filter((b) => b.startsWith('salvage/'))).toHaveLength(0);
      expect(openings).toHaveLength(1);
      expect(openings[0]!.labels).toEqual(expect.arrayContaining(['elanous:seat-MK', 'elanous:needs-owner']));
      expect(events).toContainEqual(expect.objectContaining({ category: 'self-implement.draft-not-archive', event: 'needs-owner-draft', data: expect.objectContaining({ stopClass: 'needs-owner', ownerLabel: 'elanous:seat-MK' }) }));
    } finally {
      if (previousSeat === undefined) delete process.env.ELANOUS_HARNESS_SEAT;
      else process.env.ELANOUS_HARNESS_SEAT = previousSeat;
      if (previousSubstrate !== undefined) process.env.ELANOUS_SUBSTRATE = previousSubstrate;
      restore();
    }
  });

  test('needs-owner-only: an unknown launch seat gets no guessed seat label — only elanous:needs-owner', async () => {
    const { events, restore } = capture();
    const { openings, common } = harness();
    const previousSeat = process.env.ELANOUS_HARNESS_SEAT;
    const previousSubstrate = process.env.ELANOUS_SUBSTRATE;
    delete process.env.ELANOUS_HARNESS_SEAT;
    delete process.env.ELANOUS_SUBSTRATE;
    try {
      await runSelfImplement({
        feature: 'needs owner unknown seat', maxReworkRounds: 1, reworkBudgetShadowStop: false, memory: false,
        launch: { entrance: 'unknown', actor: '', viaQueue: false },
        seams: seams({
          ...common,
          draftOnStopMode: () => 'needs-owner-only',
          gate: async () => ({ passed: false, log: 'criterion A contradicts criterion B' }),
          diagnose: async () => 'BUDGET: CONTRACT-CONFLICT\nREASON: two criteria cannot hold together',
          judgmentCallLLM: async () => 'CONTRACT-CONFLICT',
        }),
      });
      expect(openings).toHaveLength(1);
      expect(openings[0]!.labels).toEqual(['elanous:needs-owner']);
      expect(events).toContainEqual(expect.objectContaining({ event: 'needs-owner-draft', data: expect.objectContaining({ ownerSeat: 'unknown' }) }));
    } finally {
      if (previousSeat !== undefined) process.env.ELANOUS_HARNESS_SEAT = previousSeat;
      if (previousSubstrate !== undefined) process.env.ELANOUS_SUBSTRATE = previousSubstrate;
      restore();
    }
  });

  test('needs-owner-only without a push seam really creates the salvage ref on origin (commit ⊕ push)', async () => {
    const { events, restore } = capture();
    const root = mkdtempSync(join(tmpdir(), 'draft-not-archive-'));
    const work = join(root, 'work');
    const origin = join(root, 'origin.git');
    let opened = 0;
    try {
      run(root, 'init', '--bare', '-b', 'main', origin);
      run(root, 'init', '-b', 'main', work);
      run(work, 'config', 'user.email', 'test@example.com');
      run(work, 'config', 'user.name', 'Test');
      writeFileSync(join(work, 'README.md'), 'base\n');
      run(work, 'add', 'README.md');
      run(work, 'commit', '-m', 'base');
      run(work, 'remote', 'add', 'origin', origin);
      run(work, 'checkout', '-b', 'self-impl/real-push-r0abc12');
      const result = await runSelfImplement({
        feature: 'real salvage push', maxReworkRounds: 0,
        seams: seams({
          createWorktree: async () => ({ path: work, branch: 'self-impl/real-push-r0abc12', resolvedBase: run(work, 'rev-parse', 'main') }),
          implement: async () => { writeFileSync(join(work, 'change.ts'), 'export const salvaged = true;\n'); return { ok: true, summary: 'implemented' }; },
          changedFilesForGateRoute: () => ['change.ts'],
          preservationHasChanges: () => true,
          persistPrBodyArtifact: () => ({ path: '/tmp/draft-not-archive-real.md' }),
          draftOnStopMode: () => 'needs-owner-only',
          gate: async () => ({ passed: false, log: 'gate red' }),
          openPr: async () => { opened++; return { url: 'https://pr/unexpected', number: 1 }; },
        }),
      });
      expect(['implementation-deficit', 'report-deficit']).toContain(result.abandonedClassification?.classification as string);
      expect(opened).toBe(0);
      const salvaged = events.find((e) => e.event === 'salvaged');
      expect(salvaged?.data.stopClass).toBe('harvestable');
      const salvageBranch = String(salvaged?.data.salvageBranch);
      expect(salvageBranch).toMatch(/^salvage\/run-[0-9a-z]+\/self-impl-real-push-r0abc12$/);
      expect(run(origin, 'show', `${salvageBranch}:change.ts`)).toContain('salvaged = true');
      // 원래 가지 이름은 원격에 안 올라간다 — 같은 칸 재발사가 가지 이름에 부딪히지 않는다.
      expect(run(origin, 'branch', '--list', 'self-impl/*')).toBe('');
    } finally {
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("'always' keeps the draft PR without new labels or salvage branches (current behavior)", async () => {
    const { events, restore } = capture();
    const { openings, pushes, common } = harness();
    try {
      const result = await runSelfImplement({
        feature: 'always mode stop', maxReworkRounds: 0,
        seams: seams({ ...common, draftOnStopMode: () => 'always', gate: async () => ({ passed: false, log: 'gate red' }) }),
      });
      expect(result.abandonedClassification?.classification).toBe('implementation-deficit');
      expect(openings).toEqual([{ head: result.branch! }]);
      expect(pushes).toHaveLength(0);
      expect(events.filter((e) => e.category === 'self-implement.draft-not-archive')).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
