import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from './msg-store.js';
import { runMsgMirrorTick, type MirrorTarget, type MsgMirrorState, type MsgMirrorStateStore, type MsgMirrorTransport } from './msg-mirror-runner.js';
import { JsonMsgMirrorStateStore } from './msg-mirror-state.js';

const tempDirs: string[] = [];
function diskState(): JsonMsgMirrorStateStore {
  const dir = mkdtempSync(join(tmpdir(), 'msg-mirror-state-'));
  tempDirs.push(dir);
  return new JsonMsgMirrorStateStore(join(dir, 'msg', 'github-mirror-state.json'));
}
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

class MemoryState implements MsgMirrorStateStore {
  value: MsgMirrorState | null;
  writes = 0;
  constructor(value: MsgMirrorState | null = null) { this.value = value; }
  read(): MsgMirrorState | null { return this.value; }
  write(value: MsgMirrorState): void { this.value = structuredClone(value); this.writes++; }
}

class FakeGitHub implements MsgMirrorTransport {
  counts = new Map<string, number>();
  comments = new Map<string, string[]>();
  rotations: Array<{ from: MirrorTarget; to: MirrorTarget; key: string }> = [];
  closed: Array<{ from: MirrorTarget; to: MirrorTarget }> = [];
  private key(target: MirrorTarget): string { return `${target.repo}#${target.issueNumber}`; }
  countComments(target: MirrorTarget): number { return this.counts.get(this.key(target)) ?? 0; }
  hasMarker(target: MirrorTarget, marker: string): boolean {
    return (this.comments.get(this.key(target)) ?? []).some(body => body.includes(marker));
  }
  postComment(target: MirrorTarget, body: string): void {
    const key = this.key(target);
    this.comments.set(key, [...(this.comments.get(key) ?? []), body]);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
  createNextChannel(from: MirrorTarget, idempotencyKey: string): MirrorTarget {
    const to = { repo: from.repo, issueNumber: from.issueNumber + 1 };
    this.rotations.push({ from, to, key: idempotencyKey });
    return to;
  }
  linkAndCloseChannel(from: MirrorTarget, to: MirrorTarget): void { this.closed.push({ from, to }); }
}

function event(id: number, kind: string, createdAt: string): Message {
  return { id, from: 'TC', to: 'OP', kind, body: `event ${id}`, createdAt };
}

describe('seat-message mirror runner', () => {
  test('fails closed with no configured target or persisted pointer', async () => {
    const state = new MemoryState();
    const github = new FakeGitHub();
    const result = await runMsgMirrorTick({ nowMs: Date.parse('2026-10-28T02:00:00.000Z'), state, transport: github,
      source: { listAfter: () => [event(1, 'incident', '2026-10-28T00:30:00.000Z')], listWindow: () => [], latestId: () => 0 } });
    expect(result).toEqual({ status: 'disabled', target: null, scanned: 0, posted: 0, rotated: 0, summaries: 0, sourceCursor: 0 });
    expect(state.writes).toBe(0);
    expect(github.rotations).toEqual([]);
  });

  test('starts a newly configured mirror at the current ledger tail instead of exposing old messages', async () => {
    const state = new MemoryState();
    const github = new FakeGitHub();
    let requestedAfter: number | undefined;
    const result = await runMsgMirrorTick({ configuredTarget: { repo: 'owner/repo', issueNumber: 41 },
      nowMs: Date.parse('2026-10-28T02:00:00.000Z'), state, transport: github,
      source: { latestId: () => 19, listAfter: (after) => { requestedAfter = after; return []; }, listWindow: () => [] } });
    expect(result.sourceCursor).toBe(19);
    expect(requestedAfter).toBe(19);
    expect(result.posted).toBe(0);
    expect(github.comments.size).toBe(0);
  });

  test('rotates at the threshold, links and closes the old issue, mirrors events, and posts a two-hour summary', async () => {
    const oldTarget = { repo: 'owner/repo', issueNumber: 41 };
    const state = diskState();
    state.write({ version: 1, target: oldTarget, messageCursor: 0,
      summaryWindowEnd: '2026-10-27T22:00:00.000Z' });
    const github = new FakeGitHub();
    github.counts.set('owner/repo#41', 2_300);
    const messages = [
      event(1, 'incident', '2026-10-27T23:00:00.000Z'),
      event(2, 'report', '2026-10-27T23:30:00.000Z'),
    ];
    const result = await runMsgMirrorTick({ nowMs: Date.parse('2026-10-28T02:00:00.000Z'), state, transport: github,
      source: {
        listAfter: (after, limit) => messages.filter(message => message.id > after).slice(0, limit),
        listWindow: (start, end) => messages.filter(message => message.createdAt >= start && message.createdAt < end),
        latestId: () => messages.at(-1)?.id ?? 0,
      } });

    expect(result).toEqual({ status: 'synced', target: { repo: 'owner/repo', issueNumber: 42 }, scanned: 2,
      posted: 2, rotated: 1, summaries: 1, sourceCursor: 2 });
    expect(github.rotations).toEqual([{ from: oldTarget, to: { repo: 'owner/repo', issueNumber: 42 },
      key: 'msg-mirror-rotate:owner/repo#41' }]);
    expect(github.closed).toEqual([{ from: oldTarget, to: { repo: 'owner/repo', issueNumber: 42 } }]);
    const comments = github.comments.get('owner/repo#42') ?? [];
    expect(comments).toHaveLength(2);
    expect(comments[0]).toContain('<!-- elanous-msg-mirror:event:1 -->');
    expect(comments[0]).toContain('## incident · #1');
    expect(comments[1]).toContain('<!-- elanous-msg-mirror:summary:2026-10-27T22:00:00.000Z -->');
    expect(comments[1]).toContain('1 mirrored events · incident 1');
    expect(comments.some(body => body.includes('report'))).toBe(false);
    const persisted = state.read();
    expect(persisted?.target).toEqual({ repo: 'owner/repo', issueNumber: 42 });
    expect(persisted?.messageCursor).toBe(2);
    expect(persisted?.summaryWindowEnd).toBe('2026-10-28T02:00:00.000Z');
    expect(persisted?.rotationPending).toBeUndefined();
    expect(JSON.parse(readFileSync(state.path, 'utf8'))).toMatchObject({ version: 1, target: { issueNumber: 42 }, messageCursor: 2 });
    expect(statSync(state.path).mode & 0o777).toBe(0o600);
  });

  test('dry-run inspects but does not write GitHub or advance the durable pointer', async () => {
    const state = new MemoryState();
    const github = new FakeGitHub();
    github.counts.set('owner/repo#41', 2_300);
    const result = await runMsgMirrorTick({ configuredTarget: { repo: 'owner/repo', issueNumber: 41 }, dryRun: true,
      nowMs: Date.parse('2026-10-28T02:00:00.000Z'), state, transport: github,
      source: { listAfter: () => [event(1, 'incident', '2026-10-28T00:30:00.000Z')], listWindow: () => [], latestId: () => 0 } });
    expect(result.status).toBe('dry-run');
    expect(github.rotations).toEqual([]);
    expect(github.comments.size).toBe(0);
    expect(state.writes).toBe(0);
    expect(state.read()).toBeNull();
  });
});
