#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { debug } from '../src/debug/log.js';

const DOCS = 'release/public/docs';
const LEDGER = 'release/public/expose-rubric.yaml';
const CRITERIA = ['maturity', 'value', 'reproducible', 'evidence', 'confidential', 'brand', 'support'] as const;
type Criterion = { status: 'pass' | 'fail' | 'n/a'; reason: string };
type Entry = {
  path: string;
  verdict: 'public' | 'beta' | 'internal';
  criteria: Record<(typeof CRITERIA)[number], Criterion>;
  judge: string;
  techReview?: string;
  at: string;
};
type RubricResult = { docs: number; missing: string[]; orphan: string[]; failing: Array<{ path: string; criteria: string[]; verdict?: 'beta' }>; internal: string[]; unreviewed: string[]; unjudged: string[] };

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<Entry>;
  if (typeof entry.path !== 'string' || !/^release\/public\/docs\/[^/]+\.md$/.test(entry.path)
    || !['public', 'beta', 'internal'].includes(entry.verdict ?? '')
    // The exposure judge is the CMO seat (EXPOSE-RUBRIC); any other non-empty name is not a judgement.
    || entry.judge !== 'MK'
    || (entry.techReview !== undefined && (typeof entry.techReview !== 'string' || !entry.techReview.trim()))
    || typeof entry.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(entry.at)
    || !Number.isFinite(Date.parse(entry.at)) || !entry.criteria || typeof entry.criteria !== 'object') return false;
  const criteria = entry.criteria as Record<string, unknown>;
  if (Object.keys(criteria).length !== CRITERIA.length) return false;
  return CRITERIA.every((key) => {
    const item = criteria[key] as Partial<Criterion> | undefined;
    return item && ['pass', 'fail', 'n/a'].includes(item.status ?? '')
      && typeof item.reason === 'string' && !!item.reason.trim() && !item.reason.includes('\n');
  });
}

function selectedPath(input: string, root: string): string | undefined {
  const path = relative(root, resolve(root, input)).split(sep).join('/');
  return /^release\/public\/docs\/[^/]+\.md$/.test(path) ? path : undefined;
}

export function checkExposeRubric(root: string, files?: readonly string[]): RubricResult {
  const data = parse(readFileSync(join(root, LEDGER), 'utf8')) as unknown;
  if (!data || typeof data !== 'object' || !('entries' in data) || !Array.isArray(data.entries)) throw new Error(`invalid ledger: ${LEDGER}`);
  const entries = new Map<string, Entry>();
  for (const value of data.entries as unknown[]) {
    if (!validEntry(value) || entries.has(value.path)) throw new Error(`invalid or duplicate ledger entry: ${JSON.stringify(value)}`);
    entries.set(value.path, value);
  }
  const scope = files === undefined ? undefined : new Set(files.map((file) => selectedPath(file, root)).filter((path): path is string => path !== undefined));
  const docs = readdirSync(join(root, DOCS)).filter((name) => name.endsWith('.md'))
    .map((name) => `${DOCS}/${name}`).filter((path) => !scope || scope.has(path)).sort();
  const missing = docs.filter((path) => !entries.has(path));
  const orphan: string[] = [];
  const failing: RubricResult['failing'] = [];
  const internal: string[] = [];
  const unreviewed: string[] = [];
  const unjudged: string[] = [];
  for (const entry of entries.values()) {
    if (scope && !scope.has(entry.path)) continue;
    if (!existsSync(join(root, entry.path))) {
      orphan.push(entry.path);
      continue;
    }
    if (entry.verdict === 'internal') internal.push(entry.path);
    if (entry.verdict === 'public' || entry.verdict === 'beta') {
      const failed = entry.verdict === 'public'
        ? CRITERIA.filter((key) => entry.criteria[key].status === 'fail')
        : (entry.criteria.confidential.status === 'fail' ? ['confidential'] : []);
      if (failed.length) failing.push({ path: entry.path, criteria: failed, ...(entry.verdict === 'beta' ? { verdict: 'beta' as const } : {}) });
      if (entry.verdict === 'public' && entry.techReview !== 'TC') unreviewed.push(entry.path);
      // An outward verdict with no criterion actually passed is a placeholder, not a judgement (all n/a = never checked).
      if (!CRITERIA.some((key) => entry.criteria[key].status === 'pass')) unjudged.push(entry.path);
    }
  }
  orphan.sort();
  failing.sort((a, b) => a.path.localeCompare(b.path));
  internal.sort();
  unreviewed.sort();
  unjudged.sort();
  const result = { docs: docs.length, missing, orphan, failing, internal, unreviewed, unjudged };
  debug.log('expose.rubric', 'checked', { docs: result.docs, missing: missing.length, orphan: orphan.length, failing: failing.length, unjudged: unjudged.length });
  return result;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log('Usage: bun scripts/expose-rubric-check.ts [--strict] [--json] [--files <path...>]');
    } else {
      const options = new Set(['--strict', '--json', '--files']);
      const index = args.indexOf('--files');
      const beforeFiles = args.slice(0, index < 0 ? args.length : index);
      const files = index < 0 ? undefined : args.slice(index + 1);
      if (beforeFiles.some((arg) => !options.has(arg) || arg === '--files')
        || (files && (!files.length || files.some((file) => file.startsWith('--'))))) throw new Error('invalid arguments: use --files <path...> last');
      const result = checkExposeRubric(process.cwd(), files);
      if (args.includes('--json')) console.log(JSON.stringify(result));
      else {
        for (const path of result.missing) console.error(`경고: 원장 없음: ${path}`);
        for (const path of result.orphan) console.error(`경고: 파일 없음: ${path}`);
        for (const item of result.failing) console.error(`경고: ${item.verdict ?? 'public'} 인데 fail (${item.criteria.join(', ')}): ${item.path}`);
        for (const path of result.internal) console.error(`경고: internal 인데 공개 경로: ${path}`);
        for (const path of result.unreviewed) console.error(`경고: public 기술 정확성 TC 미검토: ${path}`);
        for (const path of result.unjudged) console.error(`경고: 미판정(일곱 기준 중 pass 0): ${path}`);
        console.error(`expose-rubric — docs=${result.docs} missing=${result.missing.length} orphan=${result.orphan.length} failing=${result.failing.length} internal=${result.internal.length} unreviewed=${result.unreviewed.length} unjudged=${result.unjudged.length}`);
      }
      if (args.includes('--strict') && (result.missing.length || result.orphan.length || result.failing.length || result.internal.length || result.unjudged.length)) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
