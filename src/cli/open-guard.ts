import type { Inventory } from '../pr-tool/census.js';
import { posix } from 'node:path';

export interface HotspotApproval {
  commentUrl: string;
  files: string[];
  prs: { number: number; headSha: string }[];
}

export interface HotspotApprovalSource {
  commentId: number;
  author: string;
  body: string;
}

export interface HotspotStartVerdict {
  status: 'allow' | 'refuse' | 'unknown';
  hotspots: { file: string; prs: { number: number; headSha: string }[] }[];
  reason?: string;
  approval?: string;
}

const APPROVAL_KIND = 'HOTSPOT-FILE-LEASE-APPROVAL';
const TRUSTED_APPROVER = 'ElanvitalAI';

export function hotspotApprovalCommentId(commentUrl: unknown): number | null {
  if (typeof commentUrl !== 'string') return null;
  try {
    const url = new URL(commentUrl);
    if (url.origin !== 'https://github.com' || !/^\/ElanvitalAI\/elanous-agent\/issues\/\d+$/.test(url.pathname)) return null;
    const match = /^#issuecomment-(\d+)$/.exec(url.hash);
    if (!match) return null;
    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch { return null; }
}

function canonicalFiles(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(file => typeof file === 'string')) return null;
  return [...value].sort();
}

function canonicalPrs(value: unknown): { number: number; headSha: string }[] | null {
  if (!Array.isArray(value) || !value.every(pr => pr !== null && typeof pr === 'object'
    && Number.isSafeInteger((pr as { number?: unknown }).number) && (pr as { number: number }).number > 0
    && typeof (pr as { headSha?: unknown }).headSha === 'string'
    && /^[a-f0-9]{40}$/i.test((pr as { headSha: string }).headSha))) return null;
  const rows = value as { number: number; headSha: string }[];
  if (new Set(rows.map(pr => pr.number)).size !== rows.length) return null;
  return rows.map(pr => ({ number: pr.number, headSha: pr.headSha })).sort((a, b) => a.number - b.number);
}

function approvalMatches(approval: HotspotApproval | null | undefined, source: HotspotApprovalSource | null | undefined,
  expectedFiles: string[], expectedPrs: { number: number; headSha: string }[]): boolean {
  const commentId = hotspotApprovalCommentId(approval?.commentUrl);
  if (!approval || !source || commentId === null || source.commentId !== commentId || source.author !== TRUSTED_APPROVER) return false;
  let payload: unknown;
  try { payload = JSON.parse(source.body); } catch { return false; }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as { kind?: unknown; files?: unknown; prs?: unknown };
  const approvalFiles = canonicalFiles(approval.files);
  const approvalPrs = canonicalPrs(approval.prs);
  const sourceFiles = canonicalFiles(record.files);
  const sourcePrs = canonicalPrs(record.prs);
  return record.kind === APPROVAL_KIND && approvalFiles !== null && approvalPrs !== null
    && sourceFiles !== null && sourcePrs !== null
    && JSON.stringify(approvalFiles) === JSON.stringify(expectedFiles)
    && JSON.stringify(approvalPrs) === JSON.stringify(expectedPrs)
    && JSON.stringify(sourceFiles) === JSON.stringify(expectedFiles)
    && JSON.stringify(sourcePrs) === JSON.stringify(expectedPrs);
}

/** Check planned edits before work begins. An approval must resolve to an OP-authored GitHub comment. */
export function guardHotspotStart(files: readonly string[] | null, inventory: Inventory,
  approval?: HotspotApproval | null, approvalSource?: HotspotApprovalSource | null): HotspotStartVerdict {
  if (!files?.length || files.some(file => !file || file.includes('\\') || posix.isAbsolute(file)
    || posix.normalize(file) !== file || file === '.' || file.split('/').includes('..')))
    return { status: 'unknown', hotspots: [], reason: 'planned-files-unknown' };
  if (inventory.status === 'unknown')
    return { status: 'unknown', hotspots: [], reason: `inventory-unknown: ${inventory.reason}` };

  const hotspots = [...new Set(files)].sort().flatMap(file => {
    const prs = inventory.prs.filter(pr => pr.files.includes(file))
      .map(pr => ({ number: pr.number, headSha: pr.headSha })).sort((a, b) => a.number - b.number);
    return prs.length >= 2 ? [{ file, prs }] : [];
  });
  if (!hotspots.length) return { status: 'allow', hotspots };

  const expectedFiles = hotspots.map(row => row.file);
  const expectedPrs = [...new Map(hotspots.flatMap(row => row.prs).map(pr => [pr.number, pr])).values()]
    .sort((a, b) => a.number - b.number);
  return approvalMatches(approval, approvalSource, expectedFiles, expectedPrs)
    ? { status: 'allow', hotspots, approval: approval!.commentUrl }
    : { status: 'refuse', hotspots, reason: 'hotspot-op-approval-required' };
}
