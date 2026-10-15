import { createHash } from 'node:crypto';
import { isGoalAuthorFileName } from './goal-document.js';

const MAX_FILENAME_BYTES = 255;
// Goal files are listed and reviewed in ASCII-only terminals, so keep the meaningful
// prefix portable and short even when the request title is Korean.
const MAX_GOAL_SLUG_BYTES = 64;
const GOAL_FINGERPRINT_LENGTH = 8;

function localDate(now: Date): string {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

function asciiGoalSlug(title: string): string {
  return title.normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugWithinUtf8Budget(normalizedSlug: string, byteBudget: number): string {
  let slug = '';
  let bytes = 0;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalizedSlug);
  for (const { segment } of graphemes) {
    const segmentBytes = Buffer.byteLength(segment, 'utf8');
    if (bytes + segmentBytes > byteBudget) break;
    slug += segment;
    bytes += segmentBytes;
  }
  return slug.replace(/-+$/g, '');
}

function goalFingerprint(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex').slice(0, GOAL_FINGERPRINT_LENGTH);
}

export interface GoalFileNameSource {
  /** Human-readable generated goal title used for the ASCII slug. */
  title: string;
  /** Complete generated artifact used to distinguish semantically different results from one ask. */
  document: string;
  /** Repository identifiers from the original ask, retained before a generated title slug. */
  repositoryIdentifiers?: readonly string[];
}

export function buildGoalFileName(source: GoalFileNameSource, now: Date, collisionSuffix = ''): string {
  const date = localDate(now);
  const fingerprint = goalFingerprint(source.document);
  const fixed = `GOAL--${fingerprint}${collisionSuffix}-${date}.md`;
  const byteBudget = Math.min(
    MAX_GOAL_SLUG_BYTES,
    MAX_FILENAME_BYTES - Buffer.byteLength(fixed, 'utf8'),
  );
  const identifierPrefix = source.repositoryIdentifiers?.map(asciiGoalSlug).filter(Boolean).join('-');
  const titleSlug = asciiGoalSlug(source.title);
  const slug = slugWithinUtf8Budget([identifierPrefix, titleSlug].filter(Boolean).join('-'), byteBudget) || 'goal';
  return `GOAL-${slug}-${fingerprint}${collisionSuffix}-${date}.md`;
}

/** Single filename contract shared by helper callers and the filesystem writer. */
export function goalFileName(source: GoalFileNameSource, now: Date): string {
  const fileName = buildGoalFileName(source, now);
  if (!isGoalAuthorFileName(fileName)) throw new Error(`goal filename violates document contract: ${fileName}`);
  return fileName;
}
