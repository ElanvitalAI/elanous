import { Database } from 'bun:sqlite';
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkBrand } from '../../scripts/brand/check.js';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import type { ClaimsLedger, ClaimEvidence } from './claims-ledger.js';

export type ClaimSurface = 'deck' | 'site' | 'notice';
export interface RenderedClaims {
  markdown: string;
  included: string[];
  excluded: Array<{ id: string; reason: 'stale' | 'not-public' | 'retracted' | 'expired' | 'brand' | 'ambiguous-value' }>;
}

const headings: Record<ClaimSurface, string> = {
  deck: '## 왜 엘라누스인가',
  site: '## 엘라누스가 하는 일',
  notice: '### 이번 판에서 확인된 것',
};
const scopes: Record<ClaimSurface, 'deck' | 'site' | 'release-notes'> = {
  deck: 'deck', site: 'site', notice: 'release-notes',
};

function latest(evidence: ClaimEvidence[]): ClaimEvidence | undefined {
  return evidence.reduce<ClaimEvidence | undefined>((best, item) =>
    !best || item.measured_at >= best.measured_at ? item : best, undefined);
}

function commentValue(value: string): string {
  return value.replace(/<!--|-->|\r|\n/g, ' ').replace(/\s+/g, ' ');
}

function firstSentence(claim: string): string {
  const sentence = claim.split(/\r?\n|(?<=[.!?。！？])\s+/u)[0];
  return sentence?.trim() ?? '';
}

/**
 * The big number to show is the one measured value that carries a unit (420만+ 줄 · 37% · 12배 …).
 * Dates, times and bare numbers are not values; the first unit-bearing number wins, none is ambiguous — exclude
 * rather than publish the wrong one (review round 3: «측정일 2026-10-03, 결과 420만+ 줄» used to print 2026).
 */
export function representativeNumber(value: string): string | undefined {
  const withoutDates = value.replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g, ' ').replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ');
  const matches = [...withoutDates.matchAll(/\d[\d,.]*\s*(?:만\+?\s*줄|만\+|만|억|%|배|명|건|줄|개월|lines?\b|PRs?\b|x\b)\+?/gi)].map(match => match[0].trim());
  return matches[0];
}

export function renderClaims(ledger: ClaimsLedger, options: { surface: ClaimSurface; audience?: string }): RenderedClaims {
  const { surface, audience } = options;
  if (!(surface in headings)) throw new Error(`invalid claims surface: ${surface}`);
  const excluded: RenderedClaims['excluded'] = [];
  const candidates: Array<{ id: string; line: string }> = [];
  for (const row of ledger.list()) {
    if (audience && !row.audience.split(',').includes(audience)) continue;
    if (row.status !== 'public') {
      excluded.push({ id: row.id, reason: row.status === 'stale' ? 'stale' : row.status === 'retracted' ? 'retracted' : 'not-public' });
      continue;
    }
    const detail = ledger.get(row.id);
    if (detail.status !== 'public') {
      excluded.push({ id: row.id, reason: 'stale' });
      continue;
    }
    const evidence = latest(detail.evidence);
    if (!evidence) {
      excluded.push({ id: row.id, reason: 'expired' });
      continue;
    }
    const claim = firstSentence(row.claim);
    const number = representativeNumber(evidence.value);
    if (!number) {
      excluded.push({ id: row.id, reason: 'ambiguous-value' });
      continue;
    }
    if (!claim) {
      excluded.push({ id: row.id, reason: 'brand' });
      continue;
    }
    candidates.push({ id: row.id, line: `- ${claim} — ${number} <!-- claim:${row.id} measured:${evidence.measured_at} cmd:${commentValue(evidence.command)}${evidence.source ? ` source:${commentValue(evidence.source)}` : ''} --> <!-- src:${commentValue(evidence.source ?? evidence.command)} -->` });
  }

  const temp = mkdtempSync(join(tmpdir(), 'claims-render-'));
  const file = join(temp, 'claims.md');
  try {
    const probe = (items: typeof candidates): Set<string> => {
      writeFileSync(file, [headings[surface], '', ...items.map(item => item.line)].join('\n').trimEnd() + '\n');
      const result = checkBrand(scopes[surface], [file]);
      if (result.missing) throw new Error('brand rules missing');
      const bad = new Set<string>();
      for (const finding of result.findings) {
        const owner = items[finding.line - 3];
        if (!owner) throw new Error('brand finding outside claim lines');
        bad.add(owner.id);
      }
      return bad;
    };
    let remaining = candidates;
    while (remaining.length) {
      const bad = probe(remaining);
      if (!bad.size) break;
      const next = remaining.filter(item => {
        if (!bad.has(item.id)) return true;
        excluded.push({ id: item.id, reason: 'brand' });
        return false;
      });
      remaining = next;
    }
    const included = remaining.map(item => item.id);
    const markdown = [headings[surface], '', ...remaining.map(item => item.line)].join('\n').trimEnd() + '\n';
    debug.log('claims.render', 'rendered', { surface, included, excluded });
    return { markdown, included, excluded };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function queueStaleRechecks(ledger: ClaimsLedger, options: { root?: string; now?: Date } = {}): number {
  const stale = ledger.list({ status: 'stale' });
  if (!stale.length) {
    debug.log('claims.recheck', 'queued', { count: 0 });
    return 0;
  }
  const now = options.now ?? new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  const path = join(options.root ?? effectiveInstanceRoot(), 'seat-requests', 'requests.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  const lock = new Database(`${path}.loop-checker.lock.sqlite`);
  try {
    lock.exec('PRAGMA busy_timeout = 10000');
    lock.exec('BEGIN EXCLUSIVE');
    try {
      const existing = new Set<string>();
      if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.trim()) {
          const row = JSON.parse(line) as { key?: string };
          if (row.key) existing.add(row.key);
        }
      }
      let count = 0;
      for (const claim of stale) {
        const key = `claims-recheck:${claim.id}:${day}`;
        if (existing.has(key)) continue;
        const command = latest(ledger.get(claim.id).evidence)?.command ?? '없음';
        appendFileSync(path, JSON.stringify({ key, seat: claim.owner, text: `${claim.id} 근거 낡음 — 재측: ${command}`,
          source: 'claims', status: 'queued', queuedAt: now.toISOString() }) + '\n');
        existing.add(key);
        count++;
      }
      lock.exec('COMMIT');
      debug.log('claims.recheck', 'queued', { count });
      return count;
    } catch (error) { lock.exec('ROLLBACK'); throw error; }
  } finally { lock.close(); }
}
