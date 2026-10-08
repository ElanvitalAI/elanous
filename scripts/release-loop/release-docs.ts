import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendSeatRequestRows, listSeatRequests, withSeatRequestLedgerLock } from '../../src/seat-dispatch/seat-request-ledger.js';
import { debug } from '../../src/debug/log.js';
import type { ReleaseManifest } from '../../src/release-loop/manifest.js';

type DocsFollowEvidence = { location: string; verifiedAt: string; publishedAt: string };
type DocsFollowExposure = {
  verdict: 'public' | 'beta' | 'internal';
  judge: 'MK';
  rubric: string;
  verifiedAt: string;
};
export type DocsFollowItem = {
  id: string;
  status: string;
  sha?: string;
  exposure?: DocsFollowExposure;
  docs?: DocsFollowEvidence;
  homepage?: { elanous: DocsFollowEvidence; elanvital: DocsFollowEvidence };
  readme?: DocsFollowEvidence;
};
type DocsFollowCoverage = {
  id: string;
  sha: string | null;
  docs: boolean;
  homepage: boolean;
  readme: boolean;
  missing: Array<'docs' | 'homepage' | 'readme'>;
};
type DocsFollowReport = {
  coverage: DocsFollowCoverage[];
  pending: DocsFollowCoverage[];
  unassessed: string[];
  ratio: number | null;
  verdict: 'pass' | 'fail' | 'unmeasured';
};

/** An attestation is not coverage unless it points to a measured, timestamped surface. */
function evidenced(value: DocsFollowEvidence | undefined, measuredAt?: string): boolean {
  const at = value?.verifiedAt ? Date.parse(value.verifiedAt) : NaN;
  const published = value?.publishedAt ? Date.parse(value.publishedAt) : NaN;
  return !!value?.location?.trim() && Number.isFinite(at) && Number.isFinite(published)
    && /(?:Z|[+-]\d\d:\d\d)$/.test(value.verifiedAt)
    && /(?:Z|[+-]\d\d:\d\d)$/.test(value.publishedAt)
    && published <= at && (measuredAt === undefined || at <= Date.parse(measuredAt));
}

/** Unknown exposure/landing never becomes a published claim; it remains visible as an unassessed item. */
export function calculateDocsFollow(manifest: ReleaseManifest, items: readonly DocsFollowItem[], publishedAt?: string, measuredAt?: string): DocsFollowReport {
  const landed = new Set(manifest.in.map((entry) => entry.sha).filter(Boolean));
  const green = items.filter((item) => item.status === 'green');
  const ids = new Set<string>();
  for (const item of items) {
    if (!item.id?.trim() || ids.has(item.id)) throw new Error('invalid or duplicate docs-follow item');
    ids.add(item.id);
  }
  const judged = (item: DocsFollowItem) => item.exposure?.judge === 'MK'
    && !!item.exposure.rubric?.trim() && evidenced({ location: item.exposure.rubric, verifiedAt: item.exposure.verifiedAt,
      publishedAt: item.exposure.verifiedAt }, measuredAt)
    && ['public', 'beta', 'internal'].includes(item.exposure.verdict);
  const unassessed = green.filter((item) => !judged(item) || !item.sha || !landed.has(item.sha))
    .map((item) => item.id);
  const supplied = new Set(items.map((item) => item.sha));
  for (const entry of manifest.in) {
    if (entry.sha && (entry.kind === 'feat' || entry.kind === 'fix' || entry.kind === 'security') && entry.line && !supplied.has(entry.sha)) {
      unassessed.push(`landing:${entry.sha}`);
    }
  }
  const visible = green.filter((item) => judged(item) && (item.exposure?.verdict === 'public' || item.exposure?.verdict === 'beta') && item.sha && landed.has(item.sha));
  const coverage: DocsFollowCoverage[] = visible.map((item) => {
    const docs = evidenced(item.docs, measuredAt);
    const homepage = evidenced(item.homepage?.elanous, measuredAt) && evidenced(item.homepage?.elanvital, measuredAt);
    const readme = evidenced(item.readme, measuredAt);
    return { id: item.id, sha: item.sha!, docs, homepage, readme,
      missing: ([['docs', docs], ['homepage', homepage], ['readme', readme]] as const)
        .filter(([, present]) => !present).map(([surface]) => surface) };
  });
  const pending = coverage.filter((item) => !item.docs || !item.homepage);
  const covered = coverage.filter((item) => item.docs && item.homepage && item.readme).length;
  const start = publishedAt ? Date.parse(publishedAt) : NaN;
  const end = measuredAt ? Date.parse(measuredAt) : NaN;
  const deadline = start + 24 * 60 * 60 * 1000;
  const validWindow = Number.isFinite(start) && Number.isFinite(end) && end >= start
    && /(?:Z|[+-]\d\d:\d\d)$/.test(publishedAt ?? '')
    && /(?:Z|[+-]\d\d:\d\d)$/.test(measuredAt ?? '');
  const atDeadline = validWindow && end > deadline
    ? calculateDocsFollow(manifest, items, publishedAt, new Date(deadline).toISOString()) : null;
  const timely = atDeadline ?? { coverage, pending, unassessed,
    ratio: coverage.length && !unassessed.length ? covered / coverage.length : null };
  const pass = validWindow && timely.coverage.length > 0 && !timely.unassessed.length
    && timely.ratio !== null && timely.ratio >= 0.8 && !timely.pending.length;
  // Missing proof may still establish timely coverage; only a verified late publication rules it out.
  const lateProof = (proof: DocsFollowEvidence | undefined) => evidenced(proof, measuredAt)
    && Date.parse(proof!.publishedAt) > deadline;
  const impossible = validWindow && end > deadline && !pass && !timely.unassessed.length
    && visible.length > 0 && (
      visible.some((item) => lateProof(item.docs) || lateProof(item.homepage?.elanous) || lateProof(item.homepage?.elanvital))
      || visible.filter((item) => ![item.docs, item.homepage?.elanous, item.homepage?.elanvital, item.readme]
        .some(lateProof)).length / visible.length < 0.8
    );
  return { coverage, pending, unassessed,
    ratio: coverage.length && !unassessed.length ? covered / coverage.length : null,
    verdict: pass ? 'pass' as const : impossible ? 'fail' as const : 'unmeasured' as const };
}

/** Persist a per-release report and queue each missing docs/home item once for MK. */
export function recordDocsFollow(root: string, manifest: ReleaseManifest, items: readonly DocsFollowItem[], now: Date = new Date(), publishedAt?: string) {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid docs-follow time');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('invalid docs-follow version');
  const report = calculateDocsFollow(manifest, items, publishedAt, now.toISOString());
  const path = join(root, 'release', manifest.version, 'docs-follow.json');
  const journal = join(root, 'seat-requests', 'requests.jsonl');
  withSeatRequestLedgerLock(journal, () => {
    const known = new Set(listSeatRequests(root).map((row) => row.key));
    const missing = report.pending.map((item) => ({ id: item.id, text: `문서 반영 대기 목록 v${manifest.version} · ${item.id}: ${item.missing.join(', ')} — 착지 ${item.sha}; docs·홈 실측 뒤 닫기` }));
    const rows = missing.filter((item) => !known.has(`docs-follow:${manifest.version}:${item.id}`)).map((item) => ({
      key: `docs-follow:${manifest.version}:${item.id}`, seat: 'MK', status: 'queued' as const,
      text: item.text, queuedAt: now.toISOString(), ref: `release:${manifest.version}:docs-follow`,
    }));
    mkdirSync(join(root, 'release', manifest.version), { recursive: true });
    const temp = `${path}.${createHash('sha256').update(now.toISOString()).digest('hex').slice(0, 12)}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: manifest.version, measuredAt: now.toISOString(), ...report }, null, 2) + '\n');
      renameSync(temp, path);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
    appendSeatRequestRows(journal, rows);
  });
  return report;
}

/** Render public IN lines only; keep private titles and PR numbers out of release notes. */
export function renderReleaseNotes(manifest: ReleaseManifest, version: string): string {
  const sections = [
    { heading: 'Behavior changes', kinds: ['feat', 'fix'] },
    { heading: 'Security', kinds: ['security'] },
  ] as const;
  const lines = [`# ${version}`, ''];
  let shown = 0;
  for (const section of sections) {
    const entries = manifest.in.filter((entry) => section.kinds.some((kind) => kind === entry.kind) && entry.line);
    if (!entries.length) continue;
    lines.push(`## ${section.heading}`, '');
    for (const entry of entries) {
      lines.push(`- ${entry.line!.replace(/\r?\n/g, ' ').trim()}`);
      shown++;
    }
    lines.push('');
  }
  const omitted = manifest.in.length - shown;
  if (omitted) lines.push(`Plus ${omitted} internal ${omitted === 1 ? 'change' : 'changes'}.`);
  debug.log('release-loop.docs', 'notes-rendered', { version, shown, omitted });
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Mark only the public-doc status indicator, leaving unfinished/design annotations untouched. */
export function flipNextReleaseMarkers(text: string, version: string): string {
  return text.replace(/🟡 on main(?: — next release|, in the next release)?/g, `✅ in v${version.replace(/^v/, '')}`);
}

/**
 * Fold notes that landed before the release loop (a PR appending its own line, a headline paragraph)
 * into the rendered notes instead of refusing or overwriting them. Paragraphs before any section stay
 * under the title (the headline slot); list lines the cutoff did not render keep their own `##` section
 * (lines outside any section go to «Also in this release»). A hand-written link cannot be identified
 * as generator output from its shape alone. Folding its own output again gives the same bytes.
 */
export function foldPreLandedNotes(existing: string, rendered: string): { text: string; folded: number } {
  const key = (line: string) => line.trim().replace(/\s*\(\[#\d+\]\([^)]*\)\)\s*$/, '').trim();
  // Rendered list keys per section — a pre-landed line is «already rendered» only within the same heading
  // (or anywhere, when it sits outside any section).
  const renderedBySection = new Map<string, Set<string>>();
  const renderedAll = new Set<string>();
  { let h = ''; for (const l of rendered.split(/\r?\n/)) { const t = l.trim(); if (/^##\s/.test(t)) { h = t; continue; } if (/^[-*]\s/.test(t)) { renderedAll.add(key(t)); const set = renderedBySection.get(h) ?? new Set<string>(); set.add(key(t)); renderedBySection.set(h, set); } } }
  const alreadyRendered = (line: string, section: string | null) => section === null ? renderedAll.has(key(line)) : (renderedBySection.get(section)?.has(key(line)) ?? false);
  const paragraphs: string[] = [];
  const sections = new Map<string, string[]>();
  const [title, ...rest] = rendered.trimEnd().split('\n');
  const footer = rest.find((line) => /^Plus \d+ internal changes?\.$/.test(line));
  const DEFAULT = '## Also in this release';
  let heading: string | null = null;
  for (const raw of existing.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (/^#\s/.test(trimmed) || /^Plus \d+ internal changes?\.$/.test(trimmed)) continue;
    if (!trimmed) {
      // Keep paragraph breaks (collapse runs of blank lines to one) in the headline block and in sections.
      if (heading === null) { if (paragraphs.length && paragraphs.at(-1) !== '') paragraphs.push(''); }
      else { const list = sections.get(heading)!; if (list.length && list.at(-1) !== '') list.push(''); }
      continue;
    }
    if (/^##\s/.test(trimmed)) { heading = trimmed; if (!sections.has(heading)) sections.set(heading, []); continue; }
    if (/^[-*]\s/.test(trimmed)) {
      if (alreadyRendered(trimmed, heading)) continue;
      const target = heading ?? DEFAULT;
      const list = sections.get(target) ?? [];
      if (!list.some((item) => key(item) === key(trimmed))) list.push(trimmed);
      sections.set(target, list);
    } else if (heading === null) {
      paragraphs.push(line);
    } else {
      // Prose under a section keeps its section.
      const list = sections.get(heading) ?? [];
      list.push(line);
      sections.set(heading, list);
    }
  }
  // Rendered notes = title ⊕ ordered `##` sections. A pre-landed section with the same heading merges into it.
  const renderedSections: Array<{ heading: string; lines: string[] }> = [];
  for (const line of rest) {
    if (line === footer) continue;
    if (/^##\s/.test(line.trim())) renderedSections.push({ heading: line.trim(), lines: [] });
    else if (renderedSections.length && line.trim()) renderedSections.at(-1)!.lines.push(line);
  }
  let folded = paragraphs.filter(Boolean).length;
  for (const lines of sections.values()) while (lines.at(-1) === '') lines.pop();
  for (const section of renderedSections) {
    const extra = sections.get(section.heading);
    if (!extra) continue;
    while (extra[0] === '') extra.shift();
    // A paragraph must not glue onto the rendered list above it — keep one blank line between.
    if (extra.length && !/^[-*]\s/.test(extra[0]!.trim()) && section.lines.length) section.lines.push('');
    section.lines.push(...extra);
    folded += extra.length;
    sections.delete(section.heading);
  }
  const parts = [title!, ''];
  while (paragraphs.at(-1) === '') paragraphs.pop();
  if (paragraphs.length) parts.push(paragraphs.join('\n'), '');
  for (const section of renderedSections) parts.push(section.heading, '', ...section.lines, '');
  for (const [name, lines] of sections) {
    parts.push(name, '', ...lines, '');
    folded += Math.max(lines.filter(Boolean).length, 1);
  }
  if (footer) parts.push(footer);
  return { text: `${parts.join('\n').trimEnd()}\n`, folded };
}
