import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, test } from 'bun:test';
import { PatentLedger } from '../src/patents/ledger.js';
import { lintPublicCopy, run, scanPublicCopy, type PublicCopyInput } from './public-copy-lint.js';

const stateDir = mkdtempSync(join(tmpdir(), 'public-copy-lint-'));
afterAll(() => rmSync(stateDir, { recursive: true, force: true }));

describe('public copy warning-only shadow lint', () => {
  test('warns on unmeasured or unstated one-click claims only in README and docs/marketing', () => {
    const unsafe = scanPublicCopy([
      { label: 'README.md', text: 'One click starts the entire workflow.' },
      { label: 'docs/marketing/one-click.md', text: '원 클릭으로 모두 처리합니다.' },
      { label: 'docs/usage/howto.md', text: 'One click starts the entire workflow.' },
    ], () => []);
    expect(unsafe.findings.map(({ source, rule }) => `${source}:${rule}`)).toEqual([
      'docs/marketing/one-click.md:ONE-CLICK-APPROVAL-STATUS', 'docs/marketing/one-click.md:ONE-CLICK-MEASURED-SCOPE',
      'README.md:ONE-CLICK-APPROVAL-STATUS', 'README.md:ONE-CLICK-MEASURED-SCOPE',
    ]);

    const adversarial = scanPublicCopy([
      { label: 'README.md', text: 'One click completes the entire workflow; scope is not measured. A separate release is approved for publication.' },
      { label: 'docs/marketing/one-click.md', text: '원 클릭으로 모두 처리합니다. 측정 범위 없음. 별도 문서는 게시 승인됨.' },
    ], () => []);
    expect(adversarial.findings.map(({ source, rule }) => `${source}:${rule}`)).toEqual([
      'docs/marketing/one-click.md:ONE-CLICK-APPROVAL-STATUS', 'docs/marketing/one-click.md:ONE-CLICK-MEASURED-SCOPE',
      'README.md:ONE-CLICK-APPROVAL-STATUS', 'README.md:ONE-CLICK-MEASURED-SCOPE',
    ]);

    const explicitHold = scanPublicCopy([
      { label: 'README.md', text: 'One click: publication scope is unmeasured and not approved for publication.' },
    ], () => []);
    expect(explicitHold.findings).toEqual([
      { source: 'README.md', line: 1, rule: 'ONE-CLICK-MEASURED-SCOPE' },
    ]);

    const outOfScopeCopy = scanPublicCopy([{ label: 'docs/usage/howto.md', text: 'One click starts the entire workflow. 곧 출시' }], () => []);
    expect(outOfScopeCopy.findings.filter(({ rule }) => rule.startsWith('ONE-CLICK-'))).toEqual([]);
    expect(outOfScopeCopy.findings).toContainEqual({ source: 'docs/usage/howto.md', line: 1, rule: 'BRAND-SOON' });
    expect(scanPublicCopy([{ label: 'README.md', text: '`elanous login openai-codex`' }], () => []).findings).toEqual([]);

    const multipleClaims = scanPublicCopy([{
      label: 'README.md',
      text: 'One click: measured scope limited to 1 job, approved for publication. One click completes every workflow.',
    }], () => []);
    expect(multipleClaims.findings).toContainEqual({ source: 'README.md', line: 1, rule: 'ONE-CLICK-MEASURED-SCOPE' });
    expect(multipleClaims.findings).toContainEqual({ source: 'README.md', line: 1, rule: 'ONE-CLICK-APPROVAL-STATUS' });

    const unrelatedMeasurement = scanPublicCopy([{
      label: 'README.md',
      text: 'One click completes every workflow, measured scope limited to 1 demo, approved for publication.',
    }], () => []);
    expect(unrelatedMeasurement.findings).toContainEqual({ source: 'README.md', line: 1, rule: 'ONE-CLICK-MEASURED-SCOPE' });

    const mismatchedMeasuredUnit = scanPublicCopy([{
      label: 'README.md',
      text: 'One click completes 1 workflow, measured scope limited to 1 demo, approved for publication.',
    }], () => []);
    expect(mismatchedMeasuredUnit.findings).toContainEqual({ source: 'README.md', line: 1, rule: 'ONE-CLICK-MEASURED-SCOPE' });

    const validClaim = scanPublicCopy([{
      label: 'README.md',
      text: 'One click completes 1 job, measured scope limited to 1 job, approved for publication.',
    }], () => []);
    expect(validClaim.findings.filter(({ rule }) => rule.startsWith('ONE-CLICK-'))).toEqual([]);

    const loginAndCompetitor = scanPublicCopy([{
      label: 'README.md', text: '`elanous login openai-codex`; OpenClaw is faster than Elanous',
    }], () => []);
    expect(loginAndCompetitor.findings).toContainEqual({ source: 'README.md', line: 1, rule: 'BRAND-UNSUPPORTED-COMPARISON' });
    expect(scanPublicCopy([{
      label: 'README.md', text: '`elanous login openai-codex`',
    }], () => []).findings.filter(({ rule }) => rule === 'BRAND-UNSUPPORTED-COMPARISON')).toEqual([]);
    expect(scanPublicCopy([{
      label: 'README.md', text: 'OpenClaw is faster than Elanous; source: example; measured on the same workload.',
    }], () => []).findings.filter(({ rule }) => rule === 'BRAND-UNSUPPORTED-COMPARISON')).toEqual([]);
  });

  test('flags existing timing, competitor, and unsourced-number rules without echoing matched text', () => {
    const doc: PublicCopyInput = {
      label: 'docs/marketing/BLOG-shadow-test.md',
      text: '곧 출시\nOpenClaw보다 낫습니다\n420 PRs',
    };
    const findings = lintPublicCopy([doc], () => []);
    expect(findings.map(({ line, rule }) => `${line}:${rule}`)).toEqual([
      '1:BRAND-SOON', '2:BRAND-UNSUPPORTED-COMPARISON', '3:B4-NUMBER-SOURCE',
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

  test('limits competitor scans to visible prose and returns per-document company and placeholder counts', () => {
    const result = scanPublicCopy([
      { label: 'docs/marketing/BLOG-public.md', text: [
        '---', 'evidence: ChatGPT', '---',
        'Claude Code is in this sentence; another coding agent is a placeholder.',
        '`--backend codex`',
        'See [source](https://openai.com/ChatGPT).',
        '<!-- Grok -->',
        '```sh', 'elanous login openai-codex', '```',
      ].join('\n') },
    ], () => []);
    expect(result.findings.filter(({ rule }) => rule === 'BRAND-UNSUPPORTED-COMPARISON')).toEqual([]);
    expect(result.findings).toContainEqual({ source: 'docs/marketing/BLOG-public.md', line: 4, rule: 'PUBLIC-COPY-PLACEHOLDER' });
    expect(result.documents).toEqual([{ source: 'docs/marketing/BLOG-public.md', findings: 1, companyNameMentions: 1, placeholderMentions: 1 }]);
  });

  test('counts a mechanical synonym list as a placeholder without flagging ordinary provider language', () => {
    const result = scanPublicCopy([{
      label: 'docs/marketing/DRAFT-launch.md',
      text: 'A model provider handles sign-in.\nA coding tool, the coding CLI, an AI model, a model provider.',
    }], () => []);
    expect(result.findings).toContainEqual({ source: 'docs/marketing/DRAFT-launch.md', line: 2, rule: 'PUBLIC-COPY-PLACEHOLDER' });
    expect(result.documents).toEqual([{ source: 'docs/marketing/DRAFT-launch.md', findings: 1, companyNameMentions: 0, placeholderMentions: 1 }]);
  });

  test('excludes internal research and asset manifests with a reason while scanning publishable drafts', () => {
    const result = scanPublicCopy([
      { label: 'docs/marketing/RESEARCH-landscape.md', text: 'OpenAI ChatGPT source research' },
      { label: 'docs/marketing/teaser-v4/MANIFEST.md', text: 'Codex source asset' },
      { label: 'docs/marketing/BLOG-02-the-agent-drives-the-agent-2026-09-29.md', text: 'Published Codex and ChatGPT record' },
      { label: 'docs/marketing/DRAFT-0.2.7-announcement-2026-10-01.md', text: 'Historical Grok release note' },
      { label: 'docs/marketing/SCRIPT-ax-demo-1008-2026-10-08.md', text: 'Historical visitor demo script' },
      { label: 'docs/marketing/launch/0.2.8-loop-final/blog.md', text: 'Published release blog' },
      { label: 'docs/marketing/DRAFT-launch.md', text: 'We coordinate coding work.' },
      { label: 'docs/usage/BLOG-02-example.md', text: 'A published usage note.' },
    ], () => []);
    expect(result.excludedSources).toEqual([
      { source: 'docs/marketing/RESEARCH-landscape.md', reason: 'internal-marketing-source' },
      { source: 'docs/marketing/teaser-v4/MANIFEST.md', reason: 'asset-manifest' },
      { source: 'docs/marketing/BLOG-02-the-agent-drives-the-agent-2026-09-29.md', reason: 'internal-marketing-source' },
      { source: 'docs/marketing/DRAFT-0.2.7-announcement-2026-10-01.md', reason: 'internal-marketing-source' },
      { source: 'docs/marketing/SCRIPT-ax-demo-1008-2026-10-08.md', reason: 'internal-marketing-source' },
      { source: 'docs/marketing/launch/0.2.8-loop-final/blog.md', reason: 'internal-marketing-source' },
    ]);
    expect(result.documents).toEqual([
      { source: 'docs/marketing/DRAFT-launch.md', findings: 0, companyNameMentions: 0, placeholderMentions: 0 },
      { source: 'docs/usage/BLOG-02-example.md', findings: 0, companyNameMentions: 0, placeholderMentions: 0 },
    ]);
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
    expect(result).toEqual({ findings: [], excludedSources: [], documents: [{ source: 'posts/draft.md', findings: 0, companyNameMentions: 0, placeholderMentions: 0 }], brandRulesAvailable: false, patentLedgerAvailable: false });
    expect(existsSync(missingLedger.path)).toBe(false);
  });

  test('marks an empty scan as unmeasured', () => {
    expect(scanPublicCopy([], () => [])).toEqual({
      findings: [], excludedSources: [], documents: [], brandRulesAvailable: false, patentLedgerAvailable: false,
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

  test('CLI recursively scans the requested marketing directory and measures its patent ledger', () => {
    const root = join(stateDir, 'directory-cli-root');
    mkdirSync(join(root, 'docs', 'marketing', 'nested'), { recursive: true });
    writeFileSync(join(root, 'docs', 'marketing', 'nested', 'BLOG-public.md'), 'private rotor phrase');
    const ledger = new PatentLedger({ stateDir: join(root, '.state') });
    ledger.add({ id: 'PRIVATE-CANDIDATE', title: 'private rotor phrase', track: '비공개' });
    let output = '';
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { output += `${args.join(' ')}\n`; };
    try { expect(run(['--files', 'docs/marketing', '--json'], root, ledger)).toBe(0); }
    finally { console.log = originalLog; }
    const result = JSON.parse(output) as {
      findings: Array<{ source: string; line: number; rule: string }>;
      patentLedgerAvailable: boolean;
    };
    expect(result.patentLedgerAvailable).toBe(true);
    expect(result.findings).toContainEqual({
      source: 'docs/marketing/nested/BLOG-public.md', line: 1, rule: 'PRIVATE-PATENT-CANDIDATE',
    });
  });

  test('production CLI scans the actual README and changed pitch deck', () => {
    const root = process.cwd();
    const deck = 'docs/marketing/decks/elanous-pitch-2026-10.html';
    expect(existsSync(join(root, deck))).toBe(true);
    const ledger = new PatentLedger({ stateDir: join(stateDir, 'actual-documents-ledger') });
    let output = '';
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { output += `${args.join(' ')}\n`; };
    try {
      expect(run(['--files', 'README.md', deck, '--json'], root, ledger)).toBe(0);
    } finally { console.log = originalLog; }
    const result = JSON.parse(output) as {
      documentsScanned: number;
      findings: Array<{ source: string; line: number; rule: string }>;
      documents: Array<{ source: string; companyNameMentions: number }>;
    };
    expect(result.documentsScanned).toBe(2);
    expect(result.documents.reduce((sum, document) => sum + document.companyNameMentions, 0)).toBeGreaterThan(0);
    expect(result.findings.filter(({ rule }) => rule.startsWith('ONE-CLICK-'))).toEqual([]);
  });

  test('production CLI keeps approval and measurement scope on one README claim and scans only requested marketing paths', () => {
    const root = join(stateDir, 'requested-public-copy-root');
    mkdirSync(join(root, 'docs', 'marketing', 'nested'), { recursive: true });
    mkdirSync(join(root, 'docs', 'usage'), { recursive: true });
    writeFileSync(join(root, 'README.md'), 'One click completes 2 tasks, measured scope limited to 2 tasks, approved for publication.[^src]\n\n[^src]: fixture measurement');
    writeFileSync(join(root, 'docs', 'marketing', 'nested', 'draft.md'), 'One click completes the entire workflow. private rotor phrase');
    writeFileSync(join(root, 'docs', 'usage', 'out-of-scope.md'), 'One click completes the entire workflow.');
    const ledger = new PatentLedger({ stateDir: join(root, '.state') });
    ledger.add({ id: 'PRIVATE-CANDIDATE', title: 'private rotor phrase', track: '비공개' });
    let output = '';
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { output += `${args.join(' ')}\n`; };
    try { expect(run(['--files', 'README.md', 'docs/marketing', '--json'], root, ledger)).toBe(0); }
    finally { console.log = originalLog; }
    const result = JSON.parse(output) as {
      mode: string;
      documentsScanned: number;
      findings: Array<{ source: string; line: number; rule: string }>;
      documents: Array<{ source: string }>;
    };
    expect(result.mode).toBe('warning-only');
    expect(result.documentsScanned).toBe(2);
    expect(result.documents.map(({ source }) => source).sort()).toEqual(['README.md', 'docs/marketing/nested/draft.md']);
    expect(result.findings.filter(({ source, rule }) => source === 'README.md' && rule.startsWith('ONE-CLICK-'))).toEqual([]);
    expect(result.findings).toContainEqual({ source: 'docs/marketing/nested/draft.md', line: 1, rule: 'ONE-CLICK-MEASURED-SCOPE' });
    expect(result.findings).toContainEqual({ source: 'docs/marketing/nested/draft.md', line: 1, rule: 'ONE-CLICK-APPROVAL-STATUS' });
    expect(result.findings).toContainEqual({ source: 'docs/marketing/nested/draft.md', line: 1, rule: 'PRIVATE-PATENT-CANDIDATE' });
    expect(result.documents.some(({ source }) => source.includes('out-of-scope'))).toBe(false);
    expect(output).not.toContain('private rotor phrase');
  });

  test('counts names and catches unsupported comparisons from a scratch README', () => {
    const root = join(stateDir, 'unsupported-comparison-root');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'README.md'), 'OpenClaw is faster than Elanous.');
    let output = '';
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { output += `${args.join(' ')}\n`; };
    try {
      expect(run(['--files', 'README.md', '--json'], root,
        new PatentLedger({ stateDir: join(stateDir, 'unsupported-comparison-ledger') }))).toBe(0);
    } finally { console.log = originalLog; }

    const result = JSON.parse(output) as {
      documents: Array<{ source: string; companyNameMentions: number }>;
      findings: Array<{ source: string; line: number; rule: string }>;
    };
    expect(result.documents).toEqual([{ source: 'README.md', findings: 1, companyNameMentions: 1, placeholderMentions: 0 }]);
    expect(result.findings).toContainEqual({ source: 'README.md', line: 1, rule: 'BRAND-UNSUPPORTED-COMPARISON' });
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
