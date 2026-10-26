import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, test } from 'bun:test';
import { PatentLedger } from '../src/patents/ledger.js';
import { lintPublicCopy, run, scanPublicCopy, type PublicCopyInput } from './public-copy-lint.js';

const stateDir = mkdtempSync(join(tmpdir(), 'public-copy-lint-'));
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

describe('public copy warning-only shadow lint', () => {
  test('flags existing timing, competitor, and unsourced-number rules without echoing matched text', () => {
    const doc: PublicCopyInput = {
      label: 'docs/marketing/BLOG-shadow-test.md',
      text: '곧 출시\nOpenClaw보다 낫습니다\n420 PRs',
    };
    const findings = lintPublicCopy([doc], () => []);
    expect(findings.map(({ line, rule }) => `${line}:${rule}`)).toEqual([
      '1:BRAND-SOON', '2:BRAND-COMPETITOR-NAME', '3:B4-NUMBER-SOURCE',
    ]);
    expect(JSON.stringify(findings)).not.toContain('OpenClaw');
  });

  test('uses the single private ledger and emits only a redacted warning and line number', () => {
    const ledger = new PatentLedger({ stateDir });
    ledger.add({ id: 'PRIVATE-CANDIDATE', title: 'private rotor phrase', track: '비공개' });
    const text = '일반 문장\nprivate rotor phrase 는 공개하지 않는다';
    const findings = lintPublicCopy([{ label: 'docs/marketing/BLOG-private-test.md', text }],
      (value) => ledger.unapprovedCandidateLineNumbers(value));
    expect(findings).toContainEqual({ source: 'docs/marketing/BLOG-private-test.md', line: 2, rule: 'PRIVATE-PATENT-CANDIDATE' });
    expect(JSON.stringify(findings)).not.toContain('private rotor phrase');
    expect(JSON.stringify(findings)).not.toContain('PRIVATE-CANDIDATE');
  });

  test('rejects paths outside the approved public-copy roots', () => {
    expect(() => lintPublicCopy([{ label: 'src/private.md', text: 'text' }], () => []))
      .toThrow('공개 문면 입력 경로가 허용 목록 밖입니다');
  });

  test('excludes internal goal specs and reports that exclusion while still scanning public copy', () => {
    const result = scanPublicCopy([
      { label: 'docs/goals/GOAL-internal.md', text: '곧 20 PRs — \u{1F451}' },
      { label: 'docs/marketing/BLOG-public.md', text: '곧 20 PRs — \u{1F451}' },
    ], () => []);
    expect(result.excludedSources).toEqual([
      { source: 'docs/goals/GOAL-internal.md', reason: 'internal-goal-document' },
    ]);
    expect(result.findings).toContainEqual({ source: 'docs/marketing/BLOG-public.md', line: 1, rule: 'BRAND-SOON' });
    expect(result.findings).toContainEqual({ source: 'docs/marketing/BLOG-public.md', line: 1, rule: 'B4-NUMBER-SOURCE' });
    expect(result.findings).toContainEqual({ source: 'docs/marketing/BLOG-public.md', line: 1, rule: 'B8' });
  });

  test('normalizes goal paths before exclusion so traversal aliases cannot hide public docs', () => {
    const result = scanPublicCopy([
      { label: './docs/goals/GOAL-internal.md', text: '곧 20 PRs' },
      { label: 'docs/goals/../marketing/BLOG-public.md', text: '곧 20 PRs' },
    ], () => []);
    expect(result.excludedSources).toEqual([
      { source: './docs/goals/GOAL-internal.md', reason: 'internal-goal-document' },
    ]);
    expect(result.findings).toContainEqual({ source: 'docs/goals/../marketing/BLOG-public.md', line: 1, rule: 'BRAND-SOON' });
  });

  test('keeps warning-only measurements when the brand rules or private ledger cannot be read', () => {
    const missingLedger = new PatentLedger({ stateDir: join(stateDir, 'missing-ledger') });
    const result = scanPublicCopy([{ label: 'posts/draft.md', text: '일반 문장' }],
      (text) => missingLedger.unapprovedCandidateLineNumbers(text), join(stateDir, 'missing-rules.yaml'));
    expect(result).toEqual({ findings: [], excludedSources: [], brandRulesAvailable: false, patentLedgerAvailable: false });
    expect(existsSync(missingLedger.path)).toBe(false);
  });

  test('marks an empty scan as unmeasured', () => {
    expect(scanPublicCopy([], () => [])).toEqual({
      findings: [], excludedSources: [], brandRulesAvailable: false, patentLedgerAvailable: false,
    });
  });

  test('CLI scans changed public files and a PR body, emits redacted findings, and remains warning-only', () => {
    const root = join(stateDir, 'cli-root');
    mkdirSync(join(root, 'docs', 'marketing'), { recursive: true });
    mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
    writeFileSync(join(root, 'docs', 'marketing', 'BLOG-test.md'), '곧 출시');
    writeFileSync(join(root, 'docs', 'goals', 'GOAL-test.md'), '곧 20 PRs');
    writeFileSync(join(root, 'body.txt'), 'private rotor phrase');
    const ledger = new PatentLedger({ stateDir: join(root, '.state') });
    ledger.add({ id: 'PRIVATE-CANDIDATE', title: 'private rotor phrase', track: '비공개' });
    let output = '';
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { output += `${args.join(' ')}\n`; };
    let code: number;
    try {
      code = run(['--files', 'docs/marketing/BLOG-test.md', 'docs/goals/GOAL-test.md', '--pr-body-file', 'body.txt', '--json'], root, ledger);
    } finally { console.log = originalLog; }
    const result = JSON.parse(output) as {
      mode: string;
      findings: Array<{ source: string; line: number; rule: string }>;
      excludedSources: Array<{ source: string; reason: string }>;
    };
    expect(code!).toBe(0);
    expect(result.mode).toBe('warning-only');
    expect(result.findings.map(({ rule }) => rule)).toContain('BRAND-SOON');
    expect(result.findings.map(({ rule }) => rule)).toContain('PRIVATE-PATENT-CANDIDATE');
    expect(result.findings).toContainEqual({ source: 'PR-BODY', line: 1, rule: 'PRIVATE-PATENT-CANDIDATE' });
    expect(result.excludedSources).toContainEqual({ source: 'docs/goals/GOAL-test.md', reason: 'internal-goal-document' });
    expect(output).not.toContain('private rotor phrase');
    expect(output).not.toContain('PRIVATE-CANDIDATE');
  });

  test('text CLI reports skipped files separately from scanned document count', () => {
    const root = join(stateDir, 'text-cli-root');
    mkdirSync(join(root, 'docs', 'goals'), { recursive: true });
    writeFileSync(join(root, 'docs', 'goals', 'GOAL-test.md'), '곧 20 PRs');
    let output = '';
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { output += `${args.join(' ')}\n`; };
    try {
      expect(run(['--files', 'docs/goals/GOAL-test.md'], root,
        new PatentLedger({ stateDir: join(root, '.state') }))).toBe(0);
    } finally { console.log = originalLog; }
    expect(output).toContain('docs/goals/GOAL-test.md:SKIP:internal-goal-document');
    expect(output).toContain('documents=0 excluded=1');
    expect(output).toContain('brand-rules=unmeasured patent-ledger=unmeasured');
  });
});
