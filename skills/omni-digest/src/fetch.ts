/** Content fetchers: Web (firecrawl → Jina fallback), GitHub (gh CLI), Local files */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runOcr } from './ocr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ── Web: summarize CLI / firecrawl / Jina Reader ── */

/** Check if summarize CLI is available */
function hasSummarize(): boolean {
  try { execSync('which summarize', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }); return true; } catch { return false; }
}

/** Check if firecrawl CLI is available */
function hasFirecrawl(): boolean {
  try { execSync('firecrawl --version', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }); return true; } catch { return false; }
}

/** Scrape via firecrawl CLI */
function fetchWithFirecrawl(url: string): { title: string; content: string } | null {
  console.log('  firecrawl scrape...');
  const tmpFile = join(tmpdir(), `omni-digest-fc-${Date.now()}.md`);
  try {
    execSync(
      `firecrawl scrape "${url}" --only-main-content -f markdown -o "${tmpFile}"`,
      { encoding: 'utf-8', timeout: 60_000, stdio: 'pipe' },
    );
    if (!existsSync(tmpFile)) return null;
    const text = readFileSync(tmpFile, 'utf-8').trim();
    if (text.length < 30) return null;

    let title = 'Web Article';
    const hm = text.match(/^#\s+(.+)$/m);
    if (hm) title = hm[1].trim();
    else { const tm = text.match(/^Title:\s*(.+)$/mi); if (tm) title = tm[1].trim(); }

    console.log(`  firecrawl 성공 (${text.length.toLocaleString()}자)`);
    return { title, content: text };
  } catch (e: any) {
    console.log(`  firecrawl 실패: ${e.message?.split('\n')[0]}`);
    return null;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

/** Scrape via Jina Reader (fallback) */
async function fetchWithJina(url: string): Promise<{ title: string; content: string }> {
  console.log('  Jina Reader 폴백...');
  const res = await fetch(`https://r.jina.ai/${url}`, { headers: { Accept: 'text/markdown', 'X-Return-Format': 'markdown' } });
  if (!res.ok) throw new Error(`Jina Reader error: ${res.status}`);
  const text = await res.text();
  if (!text || text.trim().length < 30) throw new Error('웹 콘텐츠가 너무 짧음');
  let title = 'Web Article';
  const hm = text.match(/^#\s+(.+)$/m);
  if (hm) title = hm[1].trim();
  else { const tm = text.match(/^Title:\s*(.+)$/mi); if (tm) title = tm[1].trim(); }
  return { title, content: text.trim() };
}

/** Extract content via summarize CLI (--extract --format md) */
function fetchWithSummarizeCli(url: string): { title: string; content: string } | null {
  console.log('  summarize CLI 추출...');
  try {
    const text = execSync(
      `summarize "${url}" --extract --format md --lang auto`,
      { encoding: 'utf-8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (!text || text.length < 30) return null;

    let title = 'Web Article';
    const hm = text.match(/^#\s+(.+)$/m);
    if (hm) title = hm[1].trim();
    else { const tm = text.match(/^Title:\s*(.+)$/mi); if (tm) title = tm[1].trim(); }

    console.log(`  summarize CLI 성공 (${text.length.toLocaleString()}자)`);
    return { title, content: text };
  } catch (e: any) {
    console.log(`  summarize CLI 실패: ${e.message?.split('\n')[0]}`);
    return null;
  }
}

/** summarize CLI end-to-end: 추출 + LLM 요약까지 한번에 (Grok 스킵) */
export function summarizeFullWithCli(url: string, length: string = 'xl'): { title: string; content: string } | null {
  console.log(`  summarize CLI end-to-end (--length ${length})...`);
  try {
    const text = execSync(
      `summarize "${url}" --length ${length} --lang auto --model auto`,
      { encoding: 'utf-8', timeout: 180_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (!text || text.length < 50) return null;

    let title = 'Summary';
    const hm = text.match(/^#\s+(.+)$/m);
    if (hm) title = hm[1].trim();

    console.log(`  summarize CLI end-to-end 성공 (${text.length.toLocaleString()}자)`);
    return { title, content: text };
  } catch (e: any) {
    console.log(`  summarize CLI end-to-end 실패: ${e.message?.split('\n')[0]}`);
    return null;
  }
}

/**
 * Fetch web content.
 * preferSummarize=true ("sum" 키워드): summarize CLI → firecrawl → Jina
 * preferSummarize=false (기본):        firecrawl → summarize CLI → Jina
 */
export async function fetchWebContent(url: string, preferSummarize = false): Promise<{ title: string; content: string }> {
  if (preferSummarize && hasSummarize()) {
    const result = fetchWithSummarizeCli(url);
    if (result) return result;
    // fallback to firecrawl → Jina
  }

  if (hasFirecrawl()) {
    const result = fetchWithFirecrawl(url);
    if (result) return result;
  }

  // Default fallback: try summarize CLI before Jina if not already tried
  if (!preferSummarize && hasSummarize()) {
    const result = fetchWithSummarizeCli(url);
    if (result) return result;
  }

  return fetchWithJina(url);
}

/* ── GitHub: gh CLI ── */

export function fetchGitHubRepo(owner: string, repo: string): { title: string; content: string } {
  console.log(`  GitHub 레포 ${owner}/${repo}...`);
  const meta = JSON.parse(execSync(`gh repo view ${owner}/${repo} --json name,description,primaryLanguage,stargazerCount,forkCount,updatedAt`, { encoding: 'utf-8', timeout: 30_000 }));
  let readme = ''; try { readme = execSync(`gh api repos/${owner}/${repo}/readme --header "Accept: application/vnd.github.raw" 2>/dev/null`, { encoding: 'utf-8', timeout: 15_000 }); } catch {}
  let commits = ''; try { commits = execSync(`gh api repos/${owner}/${repo}/commits?per_page=10 --jq '.[] | "- \\(.commit.message | split("\\n") | .[0]) (\\(.commit.author.date | .[0:10]))"'`, { encoding: 'utf-8', timeout: 15_000 }); } catch {}
  const content = [`# ${meta.name}`, meta.description ? `> ${meta.description}` : '', '', `- Language: ${meta.primaryLanguage?.name || 'N/A'}`, `- Stars: ${meta.stargazerCount || 0} | Forks: ${meta.forkCount || 0}`, commits ? `## Recent Commits\n${commits}` : '', readme ? `## README\n${readme}` : ''].filter(Boolean).join('\n');
  return { title: `${owner}/${repo}`, content };
}

export function fetchGitHubPR(owner: string, repo: string, number: string): { title: string; content: string } {
  console.log(`  GitHub PR #${number}...`);
  const data = JSON.parse(execSync(`gh pr view ${number} --repo ${owner}/${repo} --json title,body,state,author,createdAt,changedFiles,additions,deletions,files`, { encoding: 'utf-8', timeout: 30_000 }));
  const files = (data.files || []).map((f: any) => `- ${f.path} (+${f.additions}/-${f.deletions})`).join('\n');
  const content = [`# PR #${number}: ${data.title}`, `- Author: ${data.author?.login} | State: ${data.state} | +${data.additions}/-${data.deletions}`, data.body ? `## Description\n${data.body}` : '', files ? `## Changed Files\n${files}` : ''].filter(Boolean).join('\n');
  return { title: `PR #${number}: ${data.title}`, content };
}

export function fetchGitHubIssue(owner: string, repo: string, number: string): { title: string; content: string } {
  console.log(`  GitHub Issue #${number}...`);
  const data = JSON.parse(execSync(`gh issue view ${number} --repo ${owner}/${repo} --json title,body,state,author,createdAt,labels,comments`, { encoding: 'utf-8', timeout: 30_000 }));
  const labels = (data.labels || []).map((l: any) => l.name).join(', ');
  const comments = (data.comments || []).slice(0, 10).map((c: any) => `### ${c.author?.login} (${c.createdAt?.slice(0, 10)})\n${c.body}`).join('\n\n');
  const content = [`# Issue #${number}: ${data.title}`, `- Author: ${data.author?.login} | State: ${data.state}`, labels ? `- Labels: ${labels}` : '', data.body ? `## Description\n${data.body}` : '', comments ? `## Comments\n${comments}` : ''].filter(Boolean).join('\n');
  return { title: `Issue #${number}: ${data.title}`, content };
}

export function fetchGitHubCommit(owner: string, repo: string, sha: string): { title: string; content: string } {
  console.log(`  GitHub Commit ${sha.slice(0, 7)}...`);
  const data = JSON.parse(execSync(`gh api repos/${owner}/${repo}/commits/${sha}`, { encoding: 'utf-8', timeout: 30_000 }));
  const files = (data.files || []).map((f: any) => `- ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');
  const content = [`# Commit ${sha.slice(0, 7)}`, `- Author: ${data.commit?.author?.name} | Date: ${data.commit?.author?.date?.slice(0, 10)}`, `## Message\n${data.commit?.message}`, files ? `## Changed Files\n${files}` : ''].filter(Boolean).join('\n');
  return { title: `Commit: ${data.commit?.message?.split('\n')[0] || sha.slice(0, 7)}`, content };
}

/* ── omni-crawl 컨텍스트 보강 ── */

const OMNI_CRAWL_SCRIPT = join(__dirname, '..', '..', 'omni-crawl', 'scripts', 'main.ts');

/** omni-crawl을 호출하여 키워드 기반 배경 정보를 수집 */
export function enrichWithOmniCrawl(query: string): string | null {
  const scriptPath = OMNI_CRAWL_SCRIPT;
  if (!existsSync(scriptPath)) {
    console.log('  omni-crawl 스킬을 찾을 수 없음, 건너뜀');
    return null;
  }
  console.log(`  omni-crawl 컨텍스트 보강: "${query}"...`);
  try {
    const output = execSync(
      `npx tsx "${scriptPath}" "${query}" --no-save --print`,
      { encoding: 'utf-8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'], cwd: join(__dirname, '..', '..', 'omni-crawl') },
    );
    const startMarker = '---BEGIN_OMNI_CRAWL_MARKDOWN---';
    const endMarker = '---END_OMNI_CRAWL_MARKDOWN---';
    const si = output.indexOf(startMarker);
    const ei = output.indexOf(endMarker);
    const crawled = (si >= 0 && ei > si) ? output.slice(si + startMarker.length, ei).trim() : output.trim();
    if (crawled.length < 50) return null;
    console.log(`  omni-crawl 보강 완료 (${crawled.length.toLocaleString()}자)`);
    return crawled;
  } catch (e: any) {
    console.log(`  omni-crawl 보강 실패: ${e.message?.split('\n')[0]}`);
    return null;
  }
}

/* ── Local file ── */

export async function fetchLocalFile(filePath: string): Promise<{ title: string; content: string }> {
  console.log(`  로컬 파일 읽기... ${filePath}`);
  if (!existsSync(filePath)) throw new Error(`파일 없음: ${filePath}`);
  const ext = filePath.toLowerCase().split('.').pop() || '';
  const baseName = filePath.split('/').pop() || filePath;

  if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'log'].includes(ext)) return { title: baseName, content: readFileSync(filePath, 'utf-8') };

  if (ext === 'pdf') {
    try { const t = execSync(`pdftotext "${filePath}" -`, { encoding: 'utf-8', timeout: 30_000 }); if (t.trim().length > 50) return { title: baseName, content: t }; } catch {}
    console.log('  pdftotext 실패, OCR 시도...');
    const ocr = await runOcr(filePath);
    if (ocr) return { title: baseName, content: ocr };
    return { title: baseName, content: `[PDF 텍스트 추출 실패. Claude Read 도구로 직접 읽어주세요: ${filePath}]` };
  }

  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'webp'].includes(ext)) {
    console.log('  이미지 OCR 처리...');
    const ocr = await runOcr(filePath);
    if (ocr) return { title: baseName, content: ocr };
    return { title: baseName, content: `[이미지 OCR 실패. Claude Read 도구로 직접 읽어주세요: ${filePath}]` };
  }

  if (ext === 'docx' || ext === 'doc') {
    try { const t = execSync(`textutil -convert txt -stdout "${filePath}"`, { encoding: 'utf-8', timeout: 15_000 }); if (t.trim().length > 30) return { title: baseName, content: t }; } catch {}
    return { title: baseName, content: `[DOCX 추출 실패: ${filePath}]` };
  }

  try { return { title: baseName, content: readFileSync(filePath, 'utf-8') }; } catch {}
  return { title: baseName, content: `[파일을 읽을 수 없습니다: ${filePath}]` };
}
