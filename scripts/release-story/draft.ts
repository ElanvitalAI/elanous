#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BRAND_RULES_UNMEASURED, checkBrand } from '../brand/check.js';
import { ClaimsLedger } from '../../src/claims/claims-ledger.js';
import { debug } from '../../src/debug/log.js';
import { effectiveInstanceRoot } from '../../src/instance/resolve.js';
import { listChecklist, type ChecklistItem } from '../../src/release-loop/checklist.js';
import { appendSeatRequestRows, listSeatRequests, withSeatRequestLedgerLock } from '../../src/seat-dispatch/seat-request-ledger.js';
import { finishNode, readGraphContext, type GraphContext } from '../release-loop/node-verdict.js';

const repoRoot = resolve(import.meta.dir, '../..');

type DraftOptions = {
  version: string;
  nextPath?: string;
  outDir?: string;
  checklistRoot?: string;
  stateDir?: string;
  manualRoot?: string;
  rulesPath?: string;
};

type DraftResult = {
  version: string;
  status: 'drafted' | 'skipped: no-user-facing-change';
  userLines: number;
  internalDropped: number;
  greenCells: number;
  claims: number;
  manualCandidates: number;
  brandFindings: number;
  brandUnmeasured?: string;
  files: string[];
};

function userFacingLines(markdown: string): { lines: string[]; internalDropped: number } {
  let internal = false;
  let internalDropped = 0;
  const lines = markdown.split(/\r?\n/).flatMap((line) => {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { internal = heading[1]!.toLowerCase() === 'internal'; return []; }
    if (/^#\s/.test(line) || /^#{3,}\s/.test(line)) return [];
    const text = line.trim().replace(/^[-*+]\s+/, '').trim();
    if (internal || /^internal\s*(?:—|-|:)/i.test(text)) {
      if (text) internalDropped++;
      return [];
    }
    const publicText = text.replace(/\s+["'“]?Target:\s*next\.["'”]?\s*$/i, '')
      .replace(/\s+["'“]?Documentation:\s*.*\.["'”]?\s*$/i, '').trim()
      .replace(/^(?:feat|fix)\s*—\s*/i, '');
    return publicText ? [publicText] : [];
  });
  return { lines, internalDropped };
}

function firstPhrase(title: string): string {
  let quote: '»' | '"' | '`' | undefined;
  let angleStart = -1;
  for (let i = 0; i < title.length; i++) {
    const char = title[i]!;
    if (quote) {
      if (char === quote) { quote = undefined; angleStart = -1; }
      continue;
    }
    if (char === '«') { quote = '»'; angleStart = i; continue; }
    if (char === '"' || char === '`') { quote = char; continue; }
    if (/[:：]/.test(char) || (/[—·–]/.test(char) && /\s/.test(title[i - 1] ?? '') && /\s/.test(title[i + 1] ?? ''))) {
      return title.slice(0, i).trim();
    }
  }
  return (angleStart < 0 ? title : title.slice(0, angleStart) + title.slice(angleStart + 1)).trim();
}

function manualTexts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const texts: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) texts.push(readFileSync(file, 'utf8'));
    }
  };
  visit(dir);
  return texts;
}

function linkedClaims(stateDir: string, version: string, ids: Set<string>): { sentences: string[]; error?: string } {
  const ledger = new ClaimsLedger({ stateDir });
  try {
    if (!existsSync(stateDir)) return { sentences: [], error: '상태 경로 없음' };
    if (!statSync(stateDir).isDirectory()) return { sentences: [], error: '상태 경로가 폴더가 아님' };
    if (!existsSync(ledger.path)) return { sentences: [], error: '원장 없음' };
    const sentences = [...ledger.list({ status: 'verified' }), ...ledger.list({ status: 'public' })]
      .filter((row) => ledger.get(row.id).links.some((link) => link.version === version && ids.has(link.cell)))
      .map((row) => row.claim);
    return { sentences };
  } catch (error) {
    return { sentences: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function draftReleaseStory(options: DraftOptions): DraftResult {
  const { version } = options;
  const items = listChecklist(version, options.checklistRoot ?? effectiveInstanceRoot()).items;
  const { lines: userLines, internalDropped } = userFacingLines(readFileSync(options.nextPath ?? join(repoRoot, 'release/next.md'), 'utf8'));
  const green = items.filter((item) => item.status === 'green' || item.status === 'done');
  const publicCells = green.filter((item) => !['internal', 'operations', 'ops'].includes(item.kind as string ?? ''));
  const skipped = userLines.length === 0 && green.length === 0;
  if (skipped) {
    debug.log('release.story', 'skipped', { version, userLines: 0, internalDropped, greenCells: 0, claims: 0, manualCandidates: 0, brandFindings: 0 });
    return { version, status: 'skipped: no-user-facing-change', userLines: 0, internalDropped, greenCells: 0, claims: 0, manualCandidates: 0, brandFindings: 0, files: [] };
  }

  const mentions = manualTexts(options.manualRoot ?? join(repoRoot, 'docs/manual'));
  const candidates = green.filter((item) => !mentions.some((text) => text.includes(item.id)));
  const evidence = linkedClaims(options.stateDir ?? effectiveInstanceRoot(), version, new Set(publicCells.map((item) => item.id)));
  const changes = [...userLines, ...publicCells.map((item) => firstPhrase(item.title))];
  const announcement = [
    `# ${version} 판 공지 초안`, '', '## 무엇이 달라졌나',
    ...(changes.length ? changes.map((line) => `- ${line}`) : ['- 사용자 쪽 변경 없음']),
    '', '## 근거',
    ...(evidence.error ? [`근거: 소구점 원장 못 읽음(${evidence.error})`] : evidence.sentences.length ? evidence.sentences.map((claim) => `- ${claim}`) : ['근거: 연결된 소구점 없음']),
    '',
  ].join('\n');
  const siteChanges = [...userLines, ...publicCells.map((item) => firstPhrase(item.title)).filter((title) => !/[가-힣]/.test(title))];
  const siteNews = [`# What's new in ${version}`, '', ...siteChanges.slice(0, 3).map((line) => `- ${line}`), '', `Release: ${version}`, ''].join('\n');
  const manual = [`# ${version} 매뉴얼 갱신 후보`, '', ...candidates.map((item: ChecklistItem) => `- ${item.id} · ${firstPhrase(item.title)} · 매뉴얼 언급 없음`), ''].join('\n');
  const outDir = options.outDir ?? join(effectiveInstanceRoot(), 'release', version, 'story');
  mkdirSync(outDir, { recursive: true });
  let brandFindings = 0;
  let brandUnmeasured: string | undefined;
  const files: string[] = [];
  for (const [name, body, scope] of [
    ['announcement.md', announcement, 'release-notes'],
    ['site-news.md', siteNews, 'site'],
    ['manual-candidates.md', manual, 'release-notes'],
  ] as const) {
    const file = join(outDir, name);
    writeFileSync(file, body);
    const checked = checkBrand(scope, [file], options.rulesPath);
    if (checked.missing) {
      brandUnmeasured = checked.message ?? BRAND_RULES_UNMEASURED;
      writeFileSync(file, `> ⚠ ${brandUnmeasured}\n\n${body}`);
    } else {
      brandFindings += checked.findings.length;
      if (checked.findings.length) writeFileSync(file, checked.findings.map(({ id, match }) => `> ⚠ 브랜드 규칙: ${id} «${match}»`).join('\n') + '\n\n' + body);
    }
    files.push(file);
  }
  const result: DraftResult = { version, status: 'drafted', userLines: userLines.length, internalDropped, greenCells: green.length,
    claims: evidence.sentences.length, manualCandidates: candidates.length, brandFindings, ...(brandUnmeasured ? { brandUnmeasured } : {}), files };
  debug.log('release.story', 'drafted', { version, userLines: result.userLines, internalDropped, greenCells: result.greenCells,
    claims: result.claims, manualCandidates: result.manualCandidates, brandFindings, ...(brandUnmeasured ? { brandUnmeasured } : {}) });
  return result;
}

export function runReleaseStory(context: GraphContext = readGraphContext(), draft: typeof draftReleaseStory = draftReleaseStory) {
  const version = context.input.version;
  try {
    if (context.outputs.publish?.outcome !== 'ok' || context.outputs.verify?.outcome !== 'ok')
      throw new Error('published release and verification required');
    const result = draft({ version });
    if (result.status === 'drafted') {
      const root = effectiveInstanceRoot();
      const requestsPath = join(root, 'seat-requests', 'requests.jsonl');
      const key = `release-story:${version}`;
      const storyDir = dirname(result.files[0]!);
      withSeatRequestLedgerLock(requestsPath, () => {
        if (listSeatRequests(root).some((row) => row.key === key)) return;
        appendSeatRequestRows(requestsPath, [{ key, seat: 'MK', source: 'release-story', version, status: 'pending',
          text: `${version} 공지 초안 준비됨: ${storyDir}`, queuedAt: new Date().toISOString() }]);
      });
    }
    return { outcome: 'ok' as const, verdict: 'pass' as const, summary: result.status,
      files: result.files, status: result.status };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    debug.log('release.story', 'draft-failed', { version, reason });
    return { outcome: 'fail' as const, verdict: 'fail' as const, summary: `release story failed: ${reason}`, reason };
  }
}

if (import.meta.main) {
  if (process.argv.includes('--graph')) {
    let version = '';
    try {
      if (process.argv.length !== 3) throw new Error('usage: bun scripts/release-story/draft.ts --graph');
      const context = readGraphContext();
      version = context.input.version;
      process.exitCode = finishNode('release-story', version, runReleaseStory(context));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debug.log('release.story', 'draft-failed', { version, reason });
      process.exitCode = finishNode('release-story', version, { outcome: 'fail', verdict: 'fail', summary: `release story failed: ${reason}`, reason });
    }
  } else try {
    const args = process.argv.slice(2);
    let version: string | undefined;
    let nextPath: string | undefined;
    let outDir: string | undefined;
    let json = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--version') version = args[++i];
      else if (arg === '--next') nextPath = args[++i];
      else if (arg === '--out') outDir = args[++i];
      else if (arg === '--json') json = true;
      else throw new Error(`unknown option: ${arg}`);
    }
    if (!version || (args.includes('--next') && !nextPath) || (args.includes('--out') && !outDir))
      throw new Error('usage: bun scripts/release-story/draft.ts --version <v> [--next <path>] [--out <dir>] [--json]');
    const result = draftReleaseStory({ version, ...(nextPath ? { nextPath } : {}), ...(outDir ? { outDir } : {}) });
    console.log(json ? JSON.stringify(result) : result.status === 'drafted' ? `drafted: ${result.files.join(', ')}${result.brandUnmeasured ? ` · ${result.brandUnmeasured}` : ''}` : result.status);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
