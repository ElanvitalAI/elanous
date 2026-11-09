#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';

function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Remove legal comments and reduce CDATA before tag parsing, without accepting markup inside tags. */
function stripCommentsAndCdata(xml: string): string | null {
  let source = '';
  let inMarkup = false;
  let quote: '"' | "'" | undefined;
  const offset = xml.startsWith('\uFEFF') ? 1 : 0;
  for (let index = offset; index < xml.length;) {
    if (xml.startsWith('<!--', index)) {
      if (inMarkup) return null;
      const end = xml.indexOf('-->', index + 4);
      if (end < 0 || xml.slice(index + 4, end).includes('--')) return null;
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2);
      if (inMarkup || index !== offset || end < 0) return null;
      const declaration = xml.slice(index, end + 2);
      if (!/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["'][A-Za-z][A-Za-z0-9._-]*["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>$/.test(declaration)) return null;
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<![CDATA[', index)) {
      if (inMarkup) return null;
      const end = xml.indexOf(']]>', index + 9);
      if (end < 0) return null;
      source += xml.slice(index + 9, end).trim() ? '__CDATA_TEXT__' : ' ';
      index = end + 3;
      continue;
    }
    const character = xml[index]!;
    if (inMarkup) {
      if (quote) {
        if (character === quote) quote = undefined;
        else if (character === '<') return null;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>') inMarkup = false;
      else if (character === '<') return null;
    } else if (character === '<') inMarkup = true;
    source += character;
    index++;
  }
  return source;
}

type JunitCase = { file?: string; id?: string; failures: number; errors: number; skipped: number };
type JunitDocument = { cases: JunitCase[]; suiteFailed: boolean; unattributedSuiteFailure: boolean };

export type GateInterferencePair = { files: [string, string] };
export type GateInterferenceRetry = { id: string; cause: string; peers?: readonly string[] };

/** A clean standalone retry of one member of a failed multi-file part is evidence to sweep it with its co-runners. */
export function interferencePairsFromRetries(rows: readonly GateInterferenceRetry[]): GateInterferencePair[] {
  const pairs = new Map<string, GateInterferencePair>();
  for (const row of rows) {
    if (row.cause !== 'isolation' || !Array.isArray(row.peers)) continue;
    const file = row.id.split(' > ', 1)[0]!;
    if (!file || !/^(?:[\w.-]+\/)*[\w.-]+\.test\.[cm]?[jt]sx?$/.test(file)) continue;
    for (const peer of row.peers) {
      if (typeof peer !== 'string' || peer === file || !/^(?:[\w.-]+\/)*[\w.-]+\.test\.[cm]?[jt]sx?$/.test(peer)) continue;
      const files = [file, peer].sort() as [string, string];
      pairs.set(files.join('\0'), { files });
    }
  }
  return [...pairs.values()].sort((a, b) => a.files[0].localeCompare(b.files[0]) || a.files[1].localeCompare(b.files[1]));
}

/** Expand a dirty selection only by recorded pair neighbors, keeping the recorded edges for same-process grouping. */
export function planInterferenceSupplement(dirtyFiles: readonly string[], inventory: readonly string[], pairs: readonly GateInterferencePair[]): {
  files: string[]; pairs: GateInterferencePair[]; groups: string[][];
} {
  const allowed = new Set(inventory);
  const dirty = new Set(dirtyFiles.filter((file) => allowed.has(file)));
  const selected = new Set(dirty);
  const validPairs = pairs.filter(({ files }) => files.length === 2 && files[0] !== files[1]
    && files.every((file) => allowed.has(file)) && (dirty.has(files[0]) || dirty.has(files[1])));
  for (const { files } of validPairs) { selected.add(files[0]); selected.add(files[1]); }
  const files = inventory.filter((file) => selected.has(file));
  const parent = new Map(files.map((file) => [file, file]));
  const find = (file: string): string => {
    const p = parent.get(file)!;
    if (p === file) return file;
    const root = find(p); parent.set(file, root); return root;
  };
  for (const { files: pair } of validPairs) {
    const left = find(pair[0]), right = find(pair[1]);
    if (left !== right) parent.set(right, left);
  }
  const byRoot = new Map<string, string[]>();
  for (const file of files) {
    const root = find(file), group = byRoot.get(root) ?? [];
    group.push(file); byRoot.set(root, group);
  }
  return { files, pairs: validPairs, groups: [...byRoot.values()] };
}

/** Keep every recorded pair in one sweep shard; this does not add a Pod or raise the shard concurrency. */
export function coLocateInterferencePairs<T extends { files: string[] }>(shards: readonly T[], pairs: readonly GateInterferencePair[]): T[] {
  const result = shards.map((shard) => ({ ...shard, files: [...shard.files] }));
  const parent = new Map<string, string>();
  const find = (file: string): string => {
    const current = parent.get(file);
    if (!current) { parent.set(file, file); return file; }
    if (current === file) return file;
    const root = find(current); parent.set(file, root); return root;
  };
  for (const { files } of pairs) {
    if (files.length !== 2 || files[0] === files[1]) continue;
    const left = find(files[0]), right = find(files[1]);
    if (left !== right) parent.set(right, left);
  }
  const components = new Map<string, Set<string>>();
  for (const file of parent.keys()) {
    const root = find(file), members = components.get(root) ?? new Set<string>();
    members.add(file); components.set(root, members);
  }
  for (const component of components.values()) {
    if (component.size < 2) continue;
    const indexes = result.map((shard, index) => shard.files.some((file) => component.has(file)) ? index : -1).filter((index) => index >= 0);
    if (indexes.length < 2) continue;
    const targetIndex = indexes.reduce((best, index) => {
      const bestCount = result[best]!.files.filter((file) => component.has(file)).length;
      const count = result[index]!.files.filter((file) => component.has(file)).length;
      return count > bestCount ? index : best;
    }, indexes[0]!);
    const kept = result[targetIndex]!.files.filter((file) => component.has(file));
    for (const shard of result) shard.files = shard.files.filter((file) => !component.has(file));
    result[targetIndex]!.files.push(...[...component].filter((file) => !kept.includes(file)), ...kept);
  }
  return result.filter((shard) => shard.files.length > 0);
}
function parseJunit(xml: string): JunitDocument | null {
  if (/<!DOCTYPE/i.test(xml)) return null;
  for (const character of xml) {
    const codepoint = character.codePointAt(0)!;
    const xml10Character = codepoint === 0x9 || codepoint === 0xa || codepoint === 0xd
      || (codepoint >= 0x20 && codepoint <= 0xd7ff) || (codepoint >= 0xe000 && codepoint <= 0xfffd)
      || (codepoint >= 0x10000 && codepoint <= 0x10ffff);
    if (!xml10Character) return null;
  }
  const source = stripCommentsAndCdata(xml);
  if (source === null) return null;
  if (/<\?|\?>/.test(source)) return null;
  if (/<!--|-->|<!\[CDATA\[|\]\]>/.test(source)) return null;
  const stack: Array<{
    name: string;
    file?: string;
    suiteTitle?: string;
    declaredTests?: number;
    declaredFailures?: number;
    declaredErrors?: number;
    testCount: number;
    caseStart: number;
  }> = [];
  const cases: JunitCase[] = [];
  let roots = 0;
  let sawSuite = false;
  let suiteFailed = false;
  let unattributedSuiteFailure = false;
  let rootName: string | undefined;
  let cursor = 0;
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(source)) return null;
  for (const entity of source.matchAll(/&#(x[\da-f]+|\d+);/gi)) {
    const codepoint = entity[1]!.startsWith('x') ? Number.parseInt(entity[1]!.slice(1), 16) : Number.parseInt(entity[1]!, 10);
    const xml10Character = codepoint === 0x9 || codepoint === 0xa || codepoint === 0xd
      || (codepoint >= 0x20 && codepoint <= 0xd7ff) || (codepoint >= 0xe000 && codepoint <= 0xfffd)
      || (codepoint >= 0x10000 && codepoint <= 0x10ffff);
    if (!Number.isInteger(codepoint) || !xml10Character) return null;
  }
  for (const match of source.matchAll(/<([^<>]+)>/g)) {
    const between = source.slice(cursor, match.index);
    if (between.includes('<') || between.includes(']]>') || (!stack.length && between.trim())) return null;
    cursor = match.index! + match[0].length;
    const body = match[1]!.trim();
    // Comments and CDATA have already been stripped above, and the one XML declaration was
    // removed before tokenization. Every other declaration is unsupported and invalid here.
    if (!body || body.startsWith('!')) return null;
    const close = body.startsWith('/');
    const selfClose = body.endsWith('/');
    const tagMatch = /^\/?([A-Za-z_:][\w:.-]*)/.exec(body);
    if (!tagMatch) return null;
    const name = tagMatch[1]!;
    const attrsText = body.slice(tagMatch[0].length, body.length - (selfClose ? 1 : 0));
    const attrs: Record<string, string> = {};
    const attrPattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const attr of attrsText.matchAll(attrPattern)) {
      if (attrs[attr[1]!] !== undefined) return null;
      attrs[attr[1]!] = decodeXml(attr[2] ?? attr[3] ?? '');
    }
    if (!close && attrsText.replace(attrPattern, '').trim()) return null;
    if (close && attrsText.trim()) return null;
    if (close) {
      if (selfClose) return null;
      const closed = stack.pop();
      if (!closed || closed.name !== name || (closed.declaredTests !== undefined && closed.declaredTests !== closed.testCount)) return null;
      if (closed.declaredFailures !== undefined
        && closed.declaredFailures !== cases.slice(closed.caseStart).reduce((count, testcase) => count + testcase.failures, 0)) return null;
      if (closed.declaredErrors !== undefined
        && closed.declaredErrors !== cases.slice(closed.caseStart).reduce((count, testcase) => count + testcase.errors, 0)) return null;
      continue;
    }
    if (name === 'testcase' && stack.at(-1)?.name !== 'testsuite') return null;
    if ((name === 'failure' || name === 'error') && stack.at(-1)?.name !== 'testcase') return null;
    if (!stack.length) { roots++; rootName = name; }
    let file = attrs.file;
    let declaredTests: number | undefined;
    let declaredFailures: number | undefined;
    let declaredErrors: number | undefined;
    if ((name === 'testsuite' || name === 'testsuites') && attrs.tests !== undefined) {
      declaredTests = Number(attrs.tests);
      if (!Number.isSafeInteger(declaredTests) || declaredTests < 0) return null;
    }
    if (name === 'testsuite' || name === 'testsuites') {
      for (const [attribute, set] of [['failures', (value: number) => { declaredFailures = value; }], ['errors', (value: number) => { declaredErrors = value; }]] as const) {
        const count = attrs[attribute];
        if (count === undefined) continue;
        if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) return null;
        set(Number(count));
      }
    }
    if (name === 'testsuite') {
      file ??= attrs.name;
      sawSuite = true;
      if ((declaredFailures ?? 0) > 0 || (declaredErrors ?? 0) > 0) suiteFailed = true;
      const inherited = [...stack].reverse().find((entry) => entry.name === 'testsuite')?.file;
      if (!file && inherited) file = inherited;
    } else {
      const inherited = [...stack].reverse().find((entry) => entry.name === 'testsuite')?.file;
      if (!file && inherited) file = inherited;
      if (name === 'testsuites' && ((declaredFailures ?? 0) > 0 || (declaredErrors ?? 0) > 0)) suiteFailed = true;
    }
    if (name === 'testcase') {
      for (const ancestor of stack) if (ancestor.name === 'testsuite' || ancestor.name === 'testsuites') ancestor.testCount++;
      const suiteEntries = stack.filter((entry) => entry.name === 'testsuite');
      // Some JUnit writers repeat the file path as the outer suite name. Keep the
      // remaining hierarchy so sibling suites with the same testcase name stay distinct.
      const identitySuites = suiteEntries[0]?.suiteTitle === file ? suiteEntries.slice(1) : suiteEntries;
      const suiteNames = identitySuites.map((entry) => entry.suiteTitle ?? '').filter(Boolean);
      const testcaseName = attrs.name;
      const idName = [...suiteNames, ...(testcaseName ? [testcaseName] : [])].filter(Boolean).join(' > ');
      cases.push({ file, ...(file && idName ? { id: `${file} > ${idName}` } : {}), failures: 0, errors: 0, skipped: 0 });
    }
    if (name === 'failure' || name === 'error' || name === 'skipped') {
      if (stack.some((entry) => entry.name === 'testcase')) {
        const current = cases.at(-1);
        if (current) current[name === 'failure' ? 'failures' : name === 'error' ? 'errors' : 'skipped']++;
      } else if (stack.some((entry) => entry.name === 'testsuite')) { suiteFailed = true; unattributedSuiteFailure = true; }
    }
    if (!selfClose) stack.push({ name, file, ...(name === 'testsuite' && attrs.name ? { suiteTitle: attrs.name } : {}), ...(declaredTests !== undefined ? { declaredTests } : {}),
      ...(declaredFailures !== undefined ? { declaredFailures } : {}), ...(declaredErrors !== undefined ? { declaredErrors } : {}),
      testCount: 0, caseStart: cases.length });
    else if ((declaredTests !== undefined && declaredTests !== 0) || (declaredFailures !== undefined && declaredFailures !== 0)
      || (declaredErrors !== undefined && declaredErrors !== 0)) return null;
  }
  const trailingText = source.slice(cursor);
  if (trailingText.includes('<') || trailingText.includes(']]>') || trailingText.trim() || stack.length || roots !== 1
    || !['testsuite', 'testsuites'].includes(rootName ?? '') || !sawSuite || cases.length === 0) return null;
  return { cases, suiteFailed, unattributedSuiteFailure };
}

/** A null count means the XML was malformed or incomplete. */
export function junitTestcaseCount(xml: string): number | null {
  return parseJunit(xml)?.cases.length ?? null;
}

/** Unique file attribution for every testcase; null means malformed, incomplete, or unattributed evidence. */
export function junitTestcaseFiles(xml: string): string[] | null {
  const parsed = parseJunit(xml);
  if (!parsed || parsed.unattributedSuiteFailure || parsed.cases.some((testcase) => !testcase.file)) return null;
  return [...new Set(parsed.cases.map((testcase) => testcase.file!))].sort();
}

/** Named failing/error cases, preserving duplicate identities so a retry must rerun each occurrence. */
export function junitFailedCaseIds(xml: string): string[] | null {
  const parsed = parseJunit(xml);
  if (!parsed || parsed.unattributedSuiteFailure) return null;
  const failed = parsed.cases.filter((testcase) => testcase.failures > 0 || testcase.errors > 0);
  if (failed.some((testcase) => !testcase.id)) return null;
  const identityCounts = new Map<string, number>();
  for (const testcase of parsed.cases) if (testcase.id) identityCounts.set(testcase.id, (identityCounts.get(testcase.id) ?? 0) + 1);
  // A duplicate testcase identity cannot show which occurrence failed. Treat it as
  // ambiguous evidence instead of allowing a passing sibling to clear the failure.
  if (failed.some((testcase) => identityCounts.get(testcase.id!)! > 1)) return null;
  return failed.map((testcase) => testcase.id!).sort();
}

/** Named cases that completed without failure, error, or skip. */
export function junitPassedCaseIds(xml: string): string[] | null {
  const parsed = parseJunit(xml);
  if (!parsed) return null;
  return parsed.cases.flatMap((testcase) => testcase.id && !testcase.failures && !testcase.errors && !testcase.skipped ? [testcase.id] : []).sort();
}

/** Attribute files for testcases that have a failure/error node; malformed XML returns null (fail closed). */
export function failedJunitFiles(xml: string, allowed: readonly string[]): string[] | null {
  const allow = new Set(allowed);
  const parsed = parseJunit(xml);
  if (!parsed || parsed.unattributedSuiteFailure || parsed.cases.some((testcase) => !testcase.file || !allow.has(testcase.file))) return null;
  return [...new Set(parsed.cases.filter((testcase) => testcase.failures > 0 || testcase.errors > 0).map((testcase) => testcase.file!))].sort();
}

interface RetryVerdict { clean: boolean; tests: number; failures: number; errors: number; }
export function cleanRetryVerdict(rc: number | undefined, log: string | undefined, junit: string | undefined, file: string, expectedFailureIds?: readonly string[]): RetryVerdict {
  const summary = log?.match(/Ran (\d+) tests? across ([1-9]\d*) files?\.?/);
  const pass = Number(log?.match(/^\s*(\d+)\s+pass\s*$/m)?.[1] ?? NaN);
  const failures = Number(log?.match(/^\s*(\d+)\s+fail\s*$/m)?.[1] ?? NaN);
  const errors = Number(log?.match(/^\s*(\d+)\s+errors?\s*$/m)?.[1] ?? 0);
  const tests = Number(summary?.[1] ?? 0);
  const parsed = junit ? parseJunit(junit) : null;
  const cases = parsed?.cases;
  const exactFile = cases?.every((testcase) => testcase.file === file) ?? false;
  const hasFailure = parsed?.suiteFailed || (cases?.some((testcase) => testcase.failures > 0 || testcase.errors > 0 || testcase.skipped > 0) ?? true);
  const rerunIds = junitPassedCaseIds(junit ?? '') ?? [];
  const rerunCounts = new Map<string, number>();
  for (const id of rerunIds) rerunCounts.set(id, (rerunCounts.get(id) ?? 0) + 1);
  const expectedCounts = new Map<string, number>();
  for (const id of expectedFailureIds ?? []) expectedCounts.set(id, (expectedCounts.get(id) ?? 0) + 1);
  const reranOriginalFailures = expectedFailureIds === undefined
    || (expectedFailureIds.length > 0 && [...expectedCounts].every(([id, count]) => (rerunCounts.get(id) ?? 0) >= count));
  const clean = rc === 0 && tests > 0 && Number(summary?.[2]) === 1 && pass === tests && failures === 0 && errors === 0
    && cases?.length === tests && exactFile && !hasFailure && reranOriginalFailures && !/^# Unhandled error between tests/m.test(log ?? '');
  return { clean, tests, failures: Number.isFinite(failures) ? failures : -1, errors: Number.isFinite(errors) ? errors : -1 };
}

if (import.meta.main) {
  const [xmlPath, outputPath, manifestPath] = process.argv.slice(2);
  if (!xmlPath || !outputPath || !manifestPath) process.exit(2);
  let result: string[] | null = null;
  try { result = failedJunitFiles(readFileSync(xmlPath, 'utf8'), readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean)); } catch { /* fail closed */ }
  if (!result) process.exit(1);
  writeFileSync(outputPath, result.length ? `${result.join('\n')}\n` : '');
}
