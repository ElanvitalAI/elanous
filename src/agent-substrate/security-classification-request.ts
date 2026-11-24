/** Explicit reclassification request from a saved review. Never changes the review or its gate. */
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnElanousSync } from '../instance/spawn-elanous.js';
import { pathToFileURL } from 'node:url';
import { isUncategorizedSecurityHold } from './security-hold-policy.js';

type Post = (args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };
type Audit = { version: 1; status: 'attempting' | 'stored' | 'unknown'; pr: string; headCommit: string; from: string; to: string; reviewSha256: string; startedAt: string; messageId?: number; error?: string };
const seat = /^[A-Z][A-Z0-9_-]{0,63}$/;

/** One explicit attempt per review/recipient. A crash or ambiguous transport result requires manual inspection. */
export function requestSecurityClassification(path: string, from: string, to: string, post: Post = args => {
  const result = spawnElanousSync(args, { executable: 'eln', encoding: 'utf8', timeout: 30000 });
  return { ...result, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}) {
  if (!seat.test(from) || !seat.test(to) || from === to || from === 'ALL' || to === 'ALL') throw new Error('from and to must name distinct explicit seats');
  const raw = readFileSync(path, 'utf8');
  const row: unknown = JSON.parse(raw);
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('review must be an object');
  const review = row as Record<string, unknown>;
  const pr = String(review.pr ?? '');
  const head = review.headCommit;
  if (review.reviewed !== true || review.stale === true || typeof head !== 'string' || !/^[a-f0-9]{40}$/i.test(head)
      || review.currentHeadCommit !== head || !/^[1-9][0-9]*$/.test(pr) || !isUncategorizedSecurityHold(review)) {
    throw new Error('requires an eligible, completed, current-head saved review');
  }
  const reviewSha256 = createHash('sha256').update(raw).digest('hex');
  const key = createHash('sha256').update(JSON.stringify([pr, head, review.mustFix, from, to])).digest('hex');
  const auditDir = join(dirname(path), 'classification-requests');
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const auditPath = join(auditDir, `${key}.json`);
  const audit: Audit = { version: 1, status: 'attempting', pr, headCommit: head, from, to, reviewSha256, startedAt: new Date().toISOString() };
  // wx is both a durable pre-send record and a permanent duplicate guard; no timeout unlock.
  const fd = openSync(auditPath, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(audit) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  const body = `PR #${pr} head ${head}: please classify the existing security-only findings into the four security classes or explain the correct functional classification. Preserve the current verdict and blockers until an authorized decision. Review SHA256 ${reviewSha256}.`;
  let response: ReturnType<Post>;
  try {
    response = post(['msg', 'post', '--from', from, '--to', to, '--reject-undeclared', '--kind', 'security-classification', '--body', body, '--json']);
    if (response.status !== 0 || response.error) throw new Error(response.error?.message ?? `post exited ${response.status}: ${response.stderr.slice(0, 500)}`);
    const msg: unknown = JSON.parse(response.stdout);
    if (!msg || typeof msg !== 'object' || !Number.isSafeInteger((msg as { id?: unknown }).id) || Number((msg as { id: number }).id) <= 0
        || (msg as { from?: unknown }).from !== from || (msg as { to?: unknown }).to !== to || (msg as { body?: unknown }).body !== body) throw new Error('post returned no matching durable message receipt');
    audit.status = 'stored';
    audit.messageId = (msg as { id: number }).id;
  } catch (error) {
    audit.status = 'unknown';
    audit.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }
  writeFileSync(auditPath, JSON.stringify(audit) + '\n', { mode: 0o600 });
  return { auditPath, ...audit };
}

export function runSecurityClassificationRequestCli(args: string[]): number {
  try {
    if (args.length !== 3) throw new Error('usage: security-classification-request <saved-review.json> <from-seat> <reviewer-seat>');
    const result = requestSecurityClassification(args[0]!, args[1]!, args[2]!);
    console.log(JSON.stringify(result));
    return result.status === 'stored' ? 0 : 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runSecurityClassificationRequestCli(process.argv.slice(2));
