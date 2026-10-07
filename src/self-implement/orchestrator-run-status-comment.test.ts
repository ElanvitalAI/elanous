import { describe, expect, test } from 'bun:test';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';
import type { RunLedgerEntry } from './run-ledger.js';

const marker = '<!-- elanous:run-status -->';

function runWithComments(existing?: { id: number; body: string }, lookupError = false) {
  const posts: string[] = [];
  const edits: Array<{ id: number; body: string }> = [];
  let lookups = 0;
  const modes: string[] = [];
  const run = runSelfImplement({
    feature: 'round status comment',
    runId: 'run-status-comment-test',
    maxReworkRounds: 1,
    seams: seams({
      gateResults: [false, true],
      writeRunLedger: (entry: RunLedgerEntry) => { if (entry.event === 'pr.comment.mode') modes.push(String(entry.data.mode)); },
      findPrComment: async ({ marker: search }) => {
        lookups++;
        expect(search).toBe(marker);
        if (lookupError) throw new Error('lookup unavailable');
        return existing;
      },
      editPrComment: async ({ id, body }) => { edits.push({ id, body }); },
      postPrComment: async ({ body }) => { posts.push(body); },
    }),
  });
  return { run, posts, edits, modes, lookups: () => lookups };
}

describe('PR run-status comment', () => {
  test('creates one marked status with round history in details, without duplicate round comments', async () => {
    const { run, posts, edits, modes, lookups } = runWithComments();
    expect((await run).stage).toBe('pr-opened');
    expect(lookups()).toBe(1);
    expect(edits).toEqual([]);
    expect(posts.filter((body) => body.includes(marker))).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(modes).toEqual(['status-created']);
    const status = posts[0]!;
    expect(status).toContain('<details>');
    expect(status).toContain('</details>');
    expect(status).toContain('Round 0: child implementation completed.');
    expect(status).toContain('Round 0: gate failed and requested rework.');
    expect(status).toContain('Round 1: child implementation completed.');
    expect(status.indexOf('Round 0:')).toBeLessThan(status.indexOf('Round 1:'));
    expect(posts.slice(1).every((body) => !body.includes(marker))).toBe(true);
  });

  test('appends to an existing marked status without creating another one', async () => {
    const previous = `${marker}\n<details>\n<summary>Round history</summary>\n\nEarlier round\n</details>`;
    const { run, posts, edits, modes } = runWithComments({ id: 42, body: previous });
    expect((await run).stage).toBe('pr-opened');
    expect(posts).toHaveLength(0);
    expect(modes).toEqual(['status-updated']);
    expect(posts.every((body) => !body.includes(marker))).toBe(true);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.id).toBe(42);
    expect(edits[0]!.body).toStartWith(previous.slice(0, -'</details>'.length));
    expect(edits[0]!.body).toContain('Earlier round\n\n');
    expect(edits[0]!.body.indexOf('Earlier round')).toBeLessThan(edits[0]!.body.indexOf('Round 0:'));
    expect(edits[0]!.body.match(/<details>/g)).toHaveLength(1);
    expect(edits[0]!.body.match(/<\/details>/g)).toHaveLength(1);
  });

  test('unknown lookup outcome does not create a duplicate status, but posts separate round comments', async () => {
    const { run, posts, edits, modes } = runWithComments(undefined, true);
    expect((await run).stage).toBe('pr-opened');
    expect(posts).toHaveLength(3);
    expect(modes).toEqual(['individual-fallback']);
    expect(posts.every((body) => !body.includes(marker))).toBe(true);
    expect(edits).toEqual([]);
  });

  test('missing status seams fall back to individual comments without a status comment', async () => {
    const posts: string[] = [];
    const modes: string[] = [];
    const result = await runSelfImplement({
      feature: 'missing status seams',
      runId: 'run-status-missing-seams',
      maxReworkRounds: 1,
      seams: seams({
        gateResults: [false, true],
        writeRunLedger: (entry) => { if (entry.event === 'pr.comment.mode') modes.push(String(entry.data.mode)); },
        postPrComment: async ({ body }) => { posts.push(body); },
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(posts).toHaveLength(3);
    expect(posts.every((body) => !body.includes(marker))).toBe(true);
    expect(modes).toEqual(['individual-fallback']);
  });

  test('failed status creation falls back to individual comments without retrying the marker', async () => {
    const posts: string[] = [];
    const modes: string[] = [];
    const result = await runSelfImplement({
      feature: 'failed status creation',
      runId: 'run-status-create-failure',
      maxReworkRounds: 1,
      seams: seams({
        gateResults: [false, true],
        writeRunLedger: (entry) => { if (entry.event === 'pr.comment.mode') modes.push(String(entry.data.mode)); },
        findPrComment: async () => undefined,
        editPrComment: async () => { throw new Error('unexpected edit'); },
        postPrComment: async ({ body }) => {
          posts.push(body);
          if (body.includes(marker)) throw new Error('status transport failed');
        },
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(posts).toHaveLength(4);
    expect(posts.filter((body) => body.includes(marker))).toHaveLength(1);
    expect(modes).toEqual(['individual-fallback']);
  });

  test('a failed status creation is not retried when launched salvage flushes again', async () => {
    const posts: string[] = [];
    const modes: string[] = [];
    const goalFile = 'src/self-implement/orchestrator-run-status-comment.test.ts';
    const result = await runSelfImplement({
      feature: 'failed status then salvage',
      goalFile,
      writeGoalExecutionRecord: () => {},
      writeGoalRunRecord: () => {},
      runId: 'run-status-create-salvage',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        diagnose: async () => 'BUDGET: EXTEND\nREASON: retry',
        readReworkSalvageEvidence: async () => ({ clean: true, aheadCommits: 1 }),
        launchReworkSalvage: async () => {},
        writeRunLedger: (entry) => { if (entry.event === 'pr.comment.mode') modes.push(String(entry.data.mode)); },
        findPrComment: async () => undefined,
        editPrComment: async () => { throw new Error('unexpected edit'); },
        postPrComment: async ({ body }) => {
          posts.push(body);
          if (body.includes(marker)) throw new Error('status transport uncertain');
        },
      }),
    });
    expect(result.stage).toBe('gate-failed');
    expect(result.salvage).toBe('launched');
    expect(posts.filter((body) => body.includes(marker))).toHaveLength(1);
    expect(posts.some((body) => body.includes('Rework salvage status: launched.'))).toBe(true);
    expect(modes).toEqual(['individual-fallback', 'individual-fallback']);
  });

  test('launched salvage edits the marked status without posting a new round comment', async () => {
    const posts: string[] = [];
    const edits: string[] = [];
    const modes: string[] = [];
    let status: { id: number; body: string } | undefined;
    const result = await runSelfImplement({
      feature: 'launched salvage status update',
      goalFile: 'src/self-implement/orchestrator-run-status-comment.test.ts',
      writeGoalExecutionRecord: () => {},
      writeGoalRunRecord: () => {},
      runId: 'run-status-salvage-update',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        diagnose: async () => 'BUDGET: EXTEND\nREASON: retry',
        readReworkSalvageEvidence: async () => ({ clean: true, aheadCommits: 1 }),
        launchReworkSalvage: async () => {},
        writeRunLedger: (entry) => { if (entry.event === 'pr.comment.mode') modes.push(String(entry.data.mode)); },
        findPrComment: async () => status,
        editPrComment: async ({ id, body }) => { expect(id).toBe(42); edits.push(body); status = { id, body }; },
        postPrComment: async ({ body }) => { posts.push(body); if (body.includes(marker)) status = { id: 42, body }; },
      }),
    });
    expect(result.salvage).toBe('launched');
    expect(posts).toHaveLength(1);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('Rework salvage status: launched.');
    expect(modes).toEqual(['status-created', 'status-updated']);
  });

  test('launched salvage retains its hard-cap reason in the flushed status edit', async () => {
    const posts: string[] = [];
    const edits: string[] = [];
    let status: { id: number; body: string } | undefined;
    const result = await runSelfImplement({
      feature: 'hard-cap salvage status',
      goalFile: 'src/self-implement/orchestrator-run-status-comment.test.ts',
      writeGoalExecutionRecord: () => {},
      writeGoalRunRecord: () => {},
      runId: 'run-status-hard-cap-salvage',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        diagnose: async () => 'BUDGET: EXTEND\nREASON: retry',
        readReworkSalvageEvidence: async () => ({ clean: true, aheadCommits: 1 }),
        launchReworkSalvage: async () => {},
        findPrComment: async () => status,
        editPrComment: async ({ id, body }) => { edits.push(body); status = { id, body }; },
        postPrComment: async ({ body }) => { posts.push(body); if (body.includes(marker)) status = { id: 42, body }; },
      }),
    });
    expect(result.salvage).toBe('launched');
    expect(posts).toHaveLength(1);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('Rework salvage status: launched.\n\n- reason: hard-cap-extend');
  });

  test('uncertain individual posts are attempted once, not replayed on the next flush', async () => {
    const posts: string[] = [];
    const result = await runSelfImplement({
      feature: 'uncertain individual transport',
      goalFile: 'src/self-implement/orchestrator-run-status-comment.test.ts',
      writeGoalExecutionRecord: () => {},
      writeGoalRunRecord: () => {},
      runId: 'run-status-uncertain-individual',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        diagnose: async () => 'BUDGET: EXTEND\nREASON: retry',
        readReworkSalvageEvidence: async () => ({ clean: true, aheadCommits: 1 }),
        launchReworkSalvage: async () => {},
        findPrComment: async () => { throw new Error('lookup unavailable'); },
        editPrComment: async () => { throw new Error('unexpected edit'); },
        postPrComment: async ({ body }) => {
          posts.push(body);
          if (body.includes('Round 0: child implementation completed.')) throw new Error('response lost after posting');
        },
      }),
    });
    expect(result.salvage).toBe('launched');
    expect(posts.filter((body) => body.includes('Round 0: child implementation completed.'))).toHaveLength(1);
    expect(posts.some((body) => body.includes('Rework salvage status: launched.'))).toBe(true);
  });

  test('parked salvage remains a separate comment after a successful status flush', async () => {
    const posts: string[] = [];
    const result = await runSelfImplement({
      feature: 'parked salvage comment',
      runId: 'run-status-parked-salvage',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        diagnose: async () => 'BUDGET: EXTEND\nREASON: retry',
        findPrComment: async () => undefined,
        editPrComment: async () => { throw new Error('unexpected edit'); },
        postPrComment: async ({ body }) => { posts.push(body); },
      }),
    });
    expect(result.salvage).toBe('parked');
    expect(posts.filter((body) => body.includes(marker))).toHaveLength(1);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain('Rework salvage status: parked.\n\n- reason: no-goal-file');
  });

  test('a stale lookup after successful creation never creates a second marked status', async () => {
    const posts: string[] = [];
    const modes: string[] = [];
    const result = await runSelfImplement({
      feature: 'stale status lookup',
      goalFile: 'src/self-implement/orchestrator-run-status-comment.test.ts',
      writeGoalExecutionRecord: () => {},
      writeGoalRunRecord: () => {},
      runId: 'run-status-stale-lookup',
      maxReworkRounds: 0,
      seams: seams({
        gateResults: [false],
        diagnose: async () => 'BUDGET: EXTEND\nREASON: retry',
        readReworkSalvageEvidence: async () => ({ clean: true, aheadCommits: 1 }),
        launchReworkSalvage: async () => {},
        writeRunLedger: (entry) => { if (entry.event === 'pr.comment.mode') modes.push(String(entry.data.mode)); },
        findPrComment: async () => undefined,
        editPrComment: async () => { throw new Error('unexpected edit'); },
        postPrComment: async ({ body }) => { posts.push(body); },
      }),
    });
    expect(result.salvage).toBe('launched');
    expect(posts.filter((body) => body.includes(marker))).toHaveLength(1);
    expect(posts.some((body) => body.includes('Rework salvage status: launched.'))).toBe(true);
    expect(modes).toEqual(['status-created', 'individual-fallback']);
  });

  test('failed edit does not create a second marked comment or discard separate round comments', async () => {
    const posts: string[] = [];
    const modes: string[] = [];
    const result = await runSelfImplement({
      feature: 'failed status edit',
      runId: 'run-status-edit-failure',
      maxReworkRounds: 1,
      seams: seams({
        gateResults: [false, true],
        writeRunLedger: (entry) => { if (entry.event === 'pr.comment.mode') modes.push(String(entry.data.mode)); },
        findPrComment: async () => ({ id: 42, body: marker }),
        editPrComment: async () => { throw new Error('edit unavailable'); },
        postPrComment: async ({ body }) => { posts.push(body); },
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(posts).toHaveLength(3);
    expect(posts.every((body) => !body.includes(marker))).toBe(true);
    expect(modes).toEqual(['individual-fallback']);
  });
});
