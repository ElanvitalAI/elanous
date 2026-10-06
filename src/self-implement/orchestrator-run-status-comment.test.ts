import { describe, expect, test } from 'bun:test';
import { runSelfImplement } from './orchestrator.js';
import { seams } from './test-seams.js';

const marker = '<!-- elanous:run-status -->';

function runWithComments(existing?: { id: number; body: string }, lookupError = false) {
  const posts: string[] = [];
  const edits: Array<{ id: number; body: string }> = [];
  let lookups = 0;
  const run = runSelfImplement({
    feature: 'round status comment',
    runId: 'run-status-comment-test',
    maxReworkRounds: 1,
    seams: seams({
      gateResults: [false, true],
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
  return { run, posts, edits, lookups: () => lookups };
}

describe('PR run-status comment', () => {
  test('creates one marked status with round history in details, retaining separate round comments', async () => {
    const { run, posts, edits, lookups } = runWithComments();
    expect((await run).stage).toBe('pr-opened');
    expect(lookups()).toBe(1);
    expect(edits).toEqual([]);
    expect(posts.filter((body) => body.includes(marker))).toHaveLength(1);
    expect(posts).toHaveLength(4);
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
    const { run, posts, edits } = runWithComments({ id: 42, body: previous });
    expect((await run).stage).toBe('pr-opened');
    expect(posts).toHaveLength(3);
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
    const { run, posts, edits } = runWithComments(undefined, true);
    expect((await run).stage).toBe('pr-opened');
    expect(posts).toHaveLength(3);
    expect(posts.every((body) => !body.includes(marker))).toBe(true);
    expect(edits).toEqual([]);
  });

  test('failed edit does not create a second marked comment or discard separate round comments', async () => {
    const posts: string[] = [];
    const result = await runSelfImplement({
      feature: 'failed status edit',
      runId: 'run-status-edit-failure',
      maxReworkRounds: 1,
      seams: seams({
        gateResults: [false, true],
        findPrComment: async () => ({ id: 42, body: marker }),
        editPrComment: async () => { throw new Error('edit unavailable'); },
        postPrComment: async ({ body }) => { posts.push(body); },
      }),
    });
    expect(result.stage).toBe('pr-opened');
    expect(posts).toHaveLength(3);
    expect(posts.every((body) => !body.includes(marker))).toBe(true);
  });
});
