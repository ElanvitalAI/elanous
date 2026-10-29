import { execFileSync } from 'node:child_process';
import type { MsgMirrorTransport, MirrorTarget } from './msg-mirror-runner.js';

type GhExec = (args: string[]) => string;
type Comment = { body?: unknown };
type Issue = { number?: unknown; title?: unknown; body?: unknown; pull_request?: unknown };
const keyOf = (target: MirrorTarget) => `${target.repo}#${target.issueNumber}`;

function defaultGhExec(args: string[]): string {
  return execFileSync('gh', ['api', ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
}

function flatPages(output: string): unknown[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || !parsed.every(Array.isArray)) throw new Error('GitHub paginated response is malformed');
  return parsed.flat();
}

function firstLine(body: string): string { return body.split(/\r?\n/, 1)[0] ?? ''; }

/** GitHub issue/comment API adapter. Constructed only when the mirror command runs. */
export class GitHubMsgMirrorTransport implements MsgMirrorTransport {
  private readonly comments = new Map<string, { rows: Comment[]; markers: Set<string> }>();

  constructor(private readonly gh: GhExec = defaultGhExec) {}

  beginTick(): void { this.comments.clear(); }

  private loadComments(target: MirrorTarget): { rows: Comment[]; markers: Set<string> } {
    const key = keyOf(target);
    const cached = this.comments.get(key);
    if (cached) return cached;
    const rows = flatPages(this.gh(['--paginate', '--slurp', `repos/${target.repo}/issues/${target.issueNumber}/comments?per_page=100`]))
      .map(row => {
        if (!row || typeof row !== 'object' || typeof (row as Comment).body !== 'string') throw new Error('GitHub comment response is malformed');
        return row as Comment;
      });
    const result = { rows, markers: new Set(rows.map(row => firstLine(row.body as string))) };
    this.comments.set(key, result);
    return result;
  }

  countComments(target: MirrorTarget): number { return this.loadComments(target).rows.length; }

  hasMarker(target: MirrorTarget, marker: string): boolean {
    return this.loadComments(target).markers.has(marker);
  }

  postComment(target: MirrorTarget, body: string): void {
    const comments = this.loadComments(target);
    this.gh(['-X', 'POST', `repos/${target.repo}/issues/${target.issueNumber}/comments`, '-f', `body=${body}`]);
    comments.rows.push({ body });
    comments.markers.add(firstLine(body));
  }

  createNextChannel(target: MirrorTarget, idempotencyKey: string): MirrorTarget {
    const title = `Elanous seat-message mirror · ${idempotencyKey}`;
    const existing = flatPages(this.gh(['--paginate', '--slurp', `repos/${target.repo}/issues?state=all&per_page=100&sort=created&direction=desc`]))
      .find((row): row is Issue => !!row && typeof row === 'object' && typeof (row as Issue).title === 'string'
        && (row as Issue).title === title && (row as Issue).pull_request === undefined);
    if (existing) {
      if (!Number.isSafeInteger(existing.number) || (existing.number as number) < 1) throw new Error('existing mirror issue has invalid number');
      return { repo: target.repo, issueNumber: existing.number as number };
    }
    const body = `Automated seat-message mirror channel.\n\nRotation key: ${idempotencyKey}\n`;
    const output = this.gh(['-X', 'POST', `repos/${target.repo}/issues`, '-f', `title=${title}`, '-f', `body=${body}`]);
    const issue: unknown = JSON.parse(output);
    if (!issue || typeof issue !== 'object' || !Number.isSafeInteger((issue as Issue).number)
      || ((issue as Issue).number as number) < 1) throw new Error('GitHub did not return the new mirror issue number');
    return { repo: target.repo, issueNumber: (issue as Issue).number as number };
  }

  linkAndCloseChannel(from: MirrorTarget, to: MirrorTarget): void {
    const marker = `<!-- elanous-msg-mirror:rotated-to:${to.repo}#${to.issueNumber} -->`;
    if (!this.hasMarker(from, marker)) {
      this.postComment(from, `${marker}\nMirror channel moved to [#${to.issueNumber}](https://github.com/${to.repo}/issues/${to.issueNumber}).`);
    }
    this.gh(['-X', 'PATCH', `repos/${from.repo}/issues/${from.issueNumber}`, '-f', 'state=closed']);
  }
}
